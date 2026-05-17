const eventsUrl = "data/events.jsonl";
const recipientsUrl = "data/recipients.json";
const faucetAddress = "kQD_O1WeM-icMY8JIoGzgySEQ8ivvoSpgSoglUsaua6YDBtX";

document.getElementById("reload").addEventListener("click", () => {
  loadAndRender();
});
document.getElementById("openTonviewer").addEventListener("click", () => {
  window.open(`https://testnet.tonviewer.com/${faucetAddress}`, "_blank", "noopener,noreferrer");
});
document.getElementById("openTonscan").addEventListener("click", () => {
  window.open(`https://testnet.tonscan.org/address/${faucetAddress}`, "_blank", "noopener,noreferrer");
});

loadAndRender();

async function loadAndRender() {
  setStatus(`Loading ${eventsUrl}...`);

  try {
    const [events, recipientDetails] = await Promise.all([loadEvents(), loadRecipientDetails()]);
    const stats = buildStats(events, recipientDetails);
    renderSummary(stats);
    renderDailyTable(stats.daily);
    renderWalletInitTable(stats.walletInitialization);
    renderWalletsTable(stats.wallets);
    renderRecipients(stats.topRecipients);
    drawBarChart(document.getElementById("claimsByDay"), stats.daily, "claims", "Claims");
    drawBarChart(document.getElementById("amountByDay"), stats.daily, "amountTon", "TON paid");
    setStatus(`Loaded ${events.length} event(s). Last refresh: ${new Date().toLocaleString()}`);
  } catch (error) {
    console.error(error);
    setStatus(`Failed to load events: ${error.message}`);
  }
}

async function loadEvents() {
  const response = await fetch(`${eventsUrl}?t=${Date.now()}`, { cache: "no-store" });
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL line ${index + 1}: ${error.message}`);
      }
    })
    .sort(compareEvents);
}

async function loadRecipientDetails() {
  const response = await fetch(`${recipientsUrl}?t=${Date.now()}`, { cache: "no-store" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function buildStats(events, recipientDetails) {
  const dailyMap = new Map();
  const recipients = new Map();
  const requesters = new Set();
  const detailsByRecipient = new Map(
    (recipientDetails?.recipients || []).map((recipient) => [
      normalizeAddressKey(recipient.address),
      recipient,
    ]),
  );
  let claims = 0;
  let failed = 0;
  let amountNano = 0n;

  for (const event of events) {
    const day = event.time ? event.time.slice(0, 10) : "unknown";
    const daily = getDaily(dailyMap, day);
    const amount = toBigInt(event.amount);
    const isClaim = event.success && amount > 0n && event.recipient;
    const requester = event.requester || event.recipient;

    daily.events += 1;

    if (isClaim) {
      claims += 1;
      daily.claims += 1;
    }
    if (!event.success || event.type === "failed") {
      failed += 1;
      daily.failed += 1;
    }
    if (isClaim && requester) {
      requesters.add(requester);
      daily.requesters.add(requester);
    }
    if (event.recipient) {
      amountNano += amount;
      daily.amountNano += amount;
      const recipient = recipients.get(event.recipient) || { recipient: event.recipient, claims: 0, amountNano: 0n };
      recipient.claims += 1;
      recipient.amountNano += amount;
      recipients.set(event.recipient, recipient);
    }
  }

  const daily = [...dailyMap.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((day) => ({
      date: day.date,
      events: day.events,
      claims: day.claims,
      failed: day.failed,
      amountTon: nanoToTon(day.amountNano),
      uniqueRequesters: day.requesters.size,
    }));

  const topRecipients = [...recipients.values()]
    .sort((left, right) => {
      if (right.amountNano !== left.amountNano) {
        return right.amountNano > left.amountNano ? 1 : -1;
      }
      return right.claims - left.claims;
    })
    .map((recipient) => ({
      recipient: recipient.recipient,
      claims: recipient.claims,
      amountTon: nanoToTon(recipient.amountNano),
      details: detailsByRecipient.get(normalizeAddressKey(recipient.recipient)) || null,
    }));
  const walletInitialization = buildWalletInitialization(topRecipients);
  const wallets = buildWallets(topRecipients);

  return {
    totalEvents: events.length,
    claims,
    failed,
    amountTon: nanoToTon(amountNano),
    uniqueRequesters: requesters.size,
    firstTime: events[0]?.time || null,
    lastTime: events[events.length - 1]?.time || null,
    daily,
    walletInitialization,
    wallets,
    topRecipients,
  };
}

function getDaily(dailyMap, date) {
  if (!dailyMap.has(date)) {
    dailyMap.set(date, {
      date,
      events: 0,
      claims: 0,
      failed: 0,
      amountNano: 0n,
      requesters: new Set(),
    });
  }
  return dailyMap.get(date);
}

function renderSummary(stats) {
  const summary = document.getElementById("summary");
  summary.replaceChildren();

  addDefinition(summary, "Events", stats.totalEvents);
  addDefinition(summary, "Claims", stats.claims);
  addDefinition(summary, "Failed", stats.failed);
  addDefinition(summary, "Unique requesters", stats.uniqueRequesters);
  addDefinition(summary, "TON paid", formatTon(stats.amountTon));
  addDefinition(summary, "First event", formatTimeWithRelative(stats.firstTime));
  addDefinition(summary, "Last event", formatTimeWithRelative(stats.lastTime));
}

function renderDailyTable(days) {
  const body = document.querySelector("#dailyTable tbody");
  body.replaceChildren();

  for (const day of [...days].reverse()) {
    appendRow(body, [
      day.date,
      day.claims,
      day.failed,
      formatTon(day.amountTon),
      day.uniqueRequesters,
    ]);
  }
}

function renderWalletInitTable(rows) {
  const body = document.querySelector("#walletInitTable tbody");
  body.replaceChildren();

  for (const row of rows) {
    appendRow(body, [row.status, row.recipients, row.claims, formatTon(row.amountTon)]);
  }
}

function renderWalletsTable(rows) {
  const body = document.querySelector("#walletsTable tbody");
  body.replaceChildren();

  for (const row of rows) {
    appendRow(body, [
      row.wallet,
      row.recipients,
      row.claims,
      formatTon(row.amountTon),
      row.withExternalActivity,
    ]);
  }
}

function renderRecipients(recipients) {
  const body = document.querySelector("#recipientsTable tbody");
  body.replaceChildren();

  for (const recipient of recipients) {
    const row = document.createElement("tr");
    const addressCell = document.createElement("td");
    addressCell.append(createTonviewerAddressLink(recipient.recipient));
    row.append(addressCell);
    appendCells(row, [
      recipient.claims,
      formatTon(recipient.amountTon),
      formatInitialized(recipient.details),
      formatWallet(recipient.details),
      formatNullable(recipient.details?.wallet?.seqno),
      formatNullable(recipient.details?.usage?.external_requests_after_receive),
      formatTimeWithRelative(recipient.details?.usage?.last_external_time),
    ]);
    body.append(row);
  }
}

function buildWalletInitialization(recipients) {
  const rows = new Map([
    ["initialized", { status: "initialized", recipients: 0, claims: 0, amountNano: 0n }],
    ["not initialized", { status: "not initialized", recipients: 0, claims: 0, amountNano: 0n }],
    ["unknown", { status: "unknown", recipients: 0, claims: 0, amountNano: 0n }],
  ]);

  for (const recipient of recipients) {
    const status = walletInitializationStatus(recipient.details);
    const row = rows.get(status);
    row.recipients += 1;
    row.claims += recipient.claims;
    row.amountNano += tonToNano(recipient.amountTon);
  }

  return [...rows.values()].map((row) => ({
    status: row.status,
    recipients: row.recipients,
    claims: row.claims,
    amountTon: nanoToTon(row.amountNano),
  }));
}

function walletInitializationStatus(details) {
  if (!details?.wallet) {
    return "unknown";
  }
  return details.wallet.initialized ? "initialized" : "not initialized";
}

function buildWallets(recipients) {
  const rows = new Map();

  for (const recipient of recipients) {
    const wallet = walletLabel(recipient.details);
    const row = rows.get(wallet) || {
      wallet,
      recipients: 0,
      claims: 0,
      amountNano: 0n,
      withExternalActivity: 0,
      externalRequests: 0,
    };
    const externalRequests = Number(recipient.details?.usage?.external_requests_after_receive || 0);

    row.recipients += 1;
    row.claims += recipient.claims;
    row.amountNano += tonToNano(recipient.amountTon);
    row.externalRequests += externalRequests;
    if (externalRequests > 0) {
      row.withExternalActivity += 1;
    }

    rows.set(wallet, row);
  }

  return [...rows.values()]
    .sort((left, right) => {
      if (right.recipients !== left.recipients) {
        return right.recipients - left.recipients;
      }
      return right.externalRequests - left.externalRequests;
    })
    .map((row) => ({
      wallet: row.wallet,
      recipients: row.recipients,
      claims: row.claims,
      amountTon: nanoToTon(row.amountNano),
      withExternalActivity: row.withExternalActivity,
      externalRequests: row.externalRequests,
    }));
}

function walletLabel(details) {
  if (!details?.wallet) {
    return "unknown";
  }
  if (details.wallet.wallet_type) {
    return details.wallet.wallet_type;
  }
  if (details.wallet.is_wallet) {
    return "wallet";
  }
  if (details.wallet.initialized) {
    return "initialized non-wallet";
  }
  return details.wallet.status || "not initialized";
}

function drawBarChart(canvas, rows, key, label) {
  const width = Math.max(320, Math.min(900, document.documentElement.clientWidth - 24 || 900));
  canvas.width = width;
  canvas.height = 260;

  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = "14px sans-serif";
  context.fillText(label, 12, 20);

  if (rows.length === 0) {
    context.fillText("No data yet", 12, 55);
    return;
  }

  const visible = rows.slice(-30);
  const values = visible.map((row) => Number(row[key] || 0));
  const max = Math.max(...values, 1);
  const left = 42;
  const right = 12;
  const top = 34;
  const bottom = 46;
  const chartWidth = canvas.width - left - right;
  const chartHeight = canvas.height - top - bottom;
  const gap = 3;
  const barWidth = Math.max(2, chartWidth / visible.length - gap);

  context.beginPath();
  context.moveTo(left, top);
  context.lineTo(left, top + chartHeight);
  context.lineTo(left + chartWidth, top + chartHeight);
  context.stroke();
  context.fillText(String(max.toFixed(max < 10 ? 2 : 0)), 4, top + 8);
  context.fillText("0", 20, top + chartHeight);

  visible.forEach((row, index) => {
    const value = Number(row[key] || 0);
    const barHeight = Math.round((value / max) * chartHeight);
    const x = left + index * (barWidth + gap);
    const y = top + chartHeight - barHeight;

    context.fillRect(x, y, barWidth, barHeight);

    if (index % Math.ceil(visible.length / 8) === 0) {
      context.save();
      context.translate(x, canvas.height - 8);
      context.rotate(-Math.PI / 5);
      context.fillText(row.date.slice(5), 0, 0);
      context.restore();
    }
  });
}

function addDefinition(parent, term, value) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = String(value);
  parent.append(dt, dd);
}

function appendRow(body, values) {
  const row = document.createElement("tr");
  appendCells(row, values);
  body.append(row);
}

function appendCells(row, values) {
  for (const value of values) {
    const cell = document.createElement("td");
    cell.textContent = String(value);
    row.append(cell);
  }
}

function setStatus(text) {
  document.getElementById("status").textContent = text;
}

function compareEvents(left, right) {
  const leftTime = Number(left.utime || 0);
  const rightTime = Number(right.utime || 0);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  const leftLt = toBigInt(left.lt);
  const rightLt = toBigInt(right.lt);
  return leftLt < rightLt ? -1 : leftLt > rightLt ? 1 : 0;
}

function toBigInt(value) {
  try {
    return BigInt(value || 0);
  } catch {
    return 0n;
  }
}

function nanoToTon(value) {
  return Number(value) / 1_000_000_000;
}

function tonToNano(value) {
  return BigInt(Math.round(Number(value || 0) * 1_000_000_000));
}

function formatTon(value) {
  return `${formatNumber(Number(value || 0), 9)} TON`;
}

function formatNumber(value, maxFractionDigits = 4) {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: maxFractionDigits,
  }).format(value);
}

function normalizeAddressKey(address) {
  return String(address || "").toLowerCase();
}

function createTonviewerAddressLink(address) {
  const link = document.createElement("a");
  link.href = `https://testnet.tonviewer.com/${address}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = address;
  return link;
}

function formatInitialized(details) {
  if (!details?.wallet) {
    return "unknown";
  }
  return details.wallet.initialized ? "yes" : "no";
}

function formatWallet(details) {
  if (!details?.wallet) {
    return "-";
  }

  if (details.wallet.wallet_type) {
    return details.wallet.wallet_type;
  }
  if (details.wallet.is_wallet) {
    return "wallet";
  }
  return details.wallet.status || "-";
}

function formatNullable(value) {
  return value === undefined || value === null || value === "" ? "-" : value;
}

function formatTimeWithRelative(isoTime) {
  if (!isoTime) {
    return "-";
  }

  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) {
    return isoTime;
  }

  return `${isoTime} (${formatRelativeTime(timestamp)})`;
}

function formatRelativeTime(timestamp) {
  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const units = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1],
  ];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  for (const [unit, seconds] of units) {
    if (Math.abs(diffSeconds) >= seconds || unit === "second") {
      return formatter.format(Math.round(diffSeconds / seconds), unit);
    }
  }
}
