import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const defaultAddress = "kQD_O1WeM-icMY8JIoGzgySEQ8ivvoSpgSoglUsaua6YDBtX";
const defaultEndpoint = "https://testnet.toncenter.com/api/v3/transactions";
const defaultStart = {
  source_url:
    "https://testnet.tonviewer.com/transaction/c90aeade342655596b0524e1bfbe58f0a39f2661bce19168d5b7f4ae61ef20b5",
  source_tx_hash_hex: "c90aeade342655596b0524e1bfbe58f0a39f2661bce19168d5b7f4ae61ef20b5",
  source_tx_hash: "yQrq3jQmVVlrBSThv75Y8KOfJmG84ZFo1bf0rmHvILU=",
  source_utime: 1778485075,
  account_start_utime: 1778485076,
  account_start_lt: "68861867000001",
  account_start_tx_hash: "XgFWCo7OhFRHmKek6kj8dU5W9tkbnzV3qyvSTCLWJCo=",
};

const address = process.env.FAUCET_ADDRESS || defaultAddress;
const endpoint = process.env.TONCENTER_ENDPOINT || defaultEndpoint;
const apiKey = process.env.TONCENTER_API_KEY || "";
const overlapSeconds = readIntEnv("COLLECT_OVERLAP_SECONDS", 2 * 60 * 60);
const pageLimit = readIntEnv("COLLECT_PAGE_LIMIT", 1000);
const maxPages = readIntEnv("COLLECT_MAX_PAGES", 25);
const recipientDetailsEnabled = process.env.COLLECT_RECIPIENT_DETAILS !== "0";
const recipientDetailsMaxRecipients = readIntEnv("RECIPIENT_DETAILS_MAX_RECIPIENTS", 0);
const recipientTransactionsPageLimit = readIntEnv("RECIPIENT_TRANSACTIONS_PAGE_LIMIT", 100);
const recipientTransactionsMaxPages = readIntEnv("RECIPIENT_TRANSACTIONS_MAX_PAGES", 10);
const requestDelayMs = readIntEnv("TONCENTER_REQUEST_DELAY_MS", apiKey ? 0 : 1100);
const startBoundary = {
  source_url: process.env.COLLECT_START_SOURCE_URL || defaultStart.source_url,
  source_tx_hash_hex:
    process.env.COLLECT_START_SOURCE_TX_HASH_HEX || defaultStart.source_tx_hash_hex,
  source_tx_hash:
    process.env.COLLECT_START_SOURCE_TX_HASH ||
    hexToBase64(process.env.COLLECT_START_SOURCE_TX_HASH_HEX || "") ||
    defaultStart.source_tx_hash,
  source_utime: readIntEnv("COLLECT_START_SOURCE_UTIME", defaultStart.source_utime),
  account_start_utime: readIntEnv("COLLECT_START_UTIME", defaultStart.account_start_utime),
  account_start_lt: process.env.COLLECT_START_LT || defaultStart.account_start_lt,
  account_start_tx_hash:
    process.env.COLLECT_START_TX_HASH || defaultStart.account_start_tx_hash,
};

const dataDir = path.resolve(process.env.DATA_DIR || path.join(rootDir, "data"));
const eventsFile = path.join(dataDir, "events.jsonl");
const recipientsFile = path.join(dataDir, "recipients.json");
const stateFile = path.join(dataDir, "state.json");

await main();

async function main() {
  await mkdir(dataDir, { recursive: true });

  const state = await readJson(stateFile, {});
  const existing = await readExistingEvents(eventsFile);
  const lastKnownUtime =
    existing.count > 0
      ? Math.max(Number(state.last_utime || 0), Number(existing.maxUtime || 0))
      : 0;
  const startUtime =
    lastKnownUtime > 0
      ? Math.max(startBoundary.source_utime, lastKnownUtime - overlapSeconds)
      : startBoundary.source_utime;

  const transactions = await fetchTransactions(startUtime);
  const normalized = transactions.map(normalizeTransaction).sort(compareEvents);
  const fresh = normalized.filter(
    (event) => isAtOrAfterStart(event) && !existing.ids.has(event.id),
  );

  if (fresh.length > 0) {
    await appendFile(eventsFile, `${fresh.map((event) => JSON.stringify(event)).join("\n")}\n`);
  }

  const allEvents = [...existing.events, ...fresh].sort(compareEvents);
  const recipientRun = recipientDetailsEnabled
    ? await collectRecipientDetails(allEvents)
    : null;

  const latest = latestCursor(
    [...existing.cursors, ...normalized].filter((event) => isAtOrAfterStart(event)),
  );
  const nextState = {
    address,
    endpoint,
    start: startBoundary,
    last_utime: latest?.utime ?? lastKnownUtime,
    last_lt: latest?.lt ?? String(state.last_lt || "0"),
    last_hash: latest?.tx_hash ?? state.last_hash ?? null,
    updated_at: new Date().toISOString(),
    last_fetch_start_utime: startUtime,
    last_run: {
      fetched_transactions: transactions.length,
      added_events: fresh.length,
      overlap_seconds: overlapSeconds,
      page_limit: pageLimit,
      max_pages: maxPages,
      recipient_details: recipientRun,
    },
  };

  await writeFile(stateFile, `${JSON.stringify(nextState, null, 2)}\n`);

  console.log(
    `Fetched ${transactions.length} transaction(s), added ${fresh.length} event(s), recipients=${recipientRun?.checked_recipients ?? 0}, start_utime=${startUtime}, boundary_lt=${startBoundary.account_start_lt}`,
  );
}

async function fetchTransactions(startUtime) {
  const all = [];

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.append("account", address);
    url.searchParams.set("sort", "asc");
    url.searchParams.set("limit", String(pageLimit));
    url.searchParams.set("offset", String(page * pageLimit));
    if (startUtime > 0) {
      url.searchParams.set("start_utime", String(startUtime));
    }

    const payload = await requestJson(url);
    const transactions = Array.isArray(payload.transactions)
      ? payload.transactions
      : Array.isArray(payload.result)
        ? payload.result
        : [];

    all.push(...transactions);

    if (transactions.length < pageLimit) {
      break;
    }
  }

  return all;
}

async function collectRecipientDetails(events) {
  const recipients = buildRecipientSeeds(events);
  const selectedRecipients =
    recipientDetailsMaxRecipients > 0
      ? recipients.slice(0, recipientDetailsMaxRecipients)
      : recipients;
  const addresses = selectedRecipients.map((recipient) => recipient.address);
  const accountStates = addresses.length > 0 ? await fetchAccountStates(addresses) : new Map();
  const walletStates = addresses.length > 0 ? await fetchWalletStates(addresses) : new Map();
  const details = [];

  for (const recipient of selectedRecipients) {
    const addressKey = normalizeAddressKey(recipient.address);
    const account = accountStates.get(addressKey) || null;
    const wallet = walletStates.get(addressKey) || null;
    const usage = await fetchRecipientUsage(recipient);

    details.push({
      ...recipient,
      wallet: normalizeWalletDetails(account, wallet),
      usage,
    });
  }

  await writeFile(
    recipientsFile,
    `${JSON.stringify(
      {
        schema: "acton-faucet-recipients-v1",
        generated_at: new Date().toISOString(),
        faucet_address: address,
        total_recipients: recipients.length,
        checked_recipients: selectedRecipients.length,
        skipped_recipients: recipients.length - selectedRecipients.length,
        settings: {
          recipient_transactions_page_limit: recipientTransactionsPageLimit,
          recipient_transactions_max_pages: recipientTransactionsMaxPages,
        },
        recipients: details,
      },
      null,
      2,
    )}\n`,
  );

  return {
    total_recipients: recipients.length,
    checked_recipients: selectedRecipients.length,
    skipped_recipients: recipients.length - selectedRecipients.length,
  };
}

function buildRecipientSeeds(events) {
  const recipients = new Map();

  for (const event of events) {
    if (!event.recipient || !event.success || nanoBigInt(event.amount) <= 0n) {
      continue;
    }

    const addressKey = normalizeAddressKey(event.recipient);
    const existing = recipients.get(addressKey) || {
      address: event.recipient,
      first_received_utime: Number(event.utime || 0),
      first_received_time: event.time || null,
      last_received_utime: Number(event.utime || 0),
      last_received_time: event.time || null,
      claims: 0,
      amount: "0",
      amount_ton: 0,
    };
    const amount = nanoBigInt(event.amount);

    existing.claims += 1;
    existing.amount = String(nanoBigInt(existing.amount) + amount);
    existing.amount_ton = nanoToTon(existing.amount);

    if (Number(event.utime || 0) < existing.first_received_utime) {
      existing.first_received_utime = Number(event.utime || 0);
      existing.first_received_time = event.time || null;
    }
    if (Number(event.utime || 0) > existing.last_received_utime) {
      existing.last_received_utime = Number(event.utime || 0);
      existing.last_received_time = event.time || null;
    }

    recipients.set(addressKey, existing);
  }

  return [...recipients.values()].sort((left, right) => {
    const rightAmount = nanoBigInt(right.amount);
    const leftAmount = nanoBigInt(left.amount);
    if (rightAmount !== leftAmount) {
      return rightAmount > leftAmount ? 1 : -1;
    }
    return right.claims - left.claims;
  });
}

async function fetchAccountStates(addresses) {
  const states = new Map();

  for (const chunk of chunks(addresses, 1000)) {
    const url = apiUrl("accountStates");
    url.searchParams.set("include_boc", "false");
    for (const accountAddress of chunk) {
      url.searchParams.append("address", accountAddress);
    }

    const payload = await requestJson(url);
    for (const account of payload.accounts || []) {
      states.set(normalizeAddressKey(account.address), account);
    }
  }

  return states;
}

async function fetchWalletStates(addresses) {
  const states = new Map();

  for (const chunk of chunks(addresses, 1000)) {
    const url = apiUrl("walletStates");
    for (const accountAddress of chunk) {
      url.searchParams.append("address", accountAddress);
    }

    const payload = await requestJson(url);
    for (const wallet of payload.wallets || []) {
      states.set(normalizeAddressKey(wallet.address), wallet);
    }
  }

  return states;
}

async function fetchRecipientUsage(recipient) {
  const transactions = [];
  let truncated = false;

  for (let page = 0; page < recipientTransactionsMaxPages; page += 1) {
    const url = apiUrl("transactions");
    url.searchParams.append("account", recipient.address);
    url.searchParams.set("sort", "asc");
    url.searchParams.set("limit", String(recipientTransactionsPageLimit));
    url.searchParams.set("offset", String(page * recipientTransactionsPageLimit));
    url.searchParams.set("start_utime", String(recipient.first_received_utime));

    const payload = await requestJson(url);
    const pageTransactions = Array.isArray(payload.transactions)
      ? payload.transactions
      : Array.isArray(payload.result)
        ? payload.result
        : [];

    transactions.push(...pageTransactions);

    if (pageTransactions.length < recipientTransactionsPageLimit) {
      break;
    }
    if (page === recipientTransactionsMaxPages - 1) {
      truncated = true;
    }
  }

  return {
    ...summarizeRecipientTransactions(transactions, recipient.first_received_utime),
    scanned_transactions: transactions.length,
    scan_truncated: truncated,
  };
}

function summarizeRecipientTransactions(transactions, firstReceivedUtime) {
  const opcodeCounts = new Map();
  let transactionCount = 0;
  let externalRequestCount = 0;
  let outgoingMessageCount = 0;
  let firstExternalUtime = null;
  let lastExternalUtime = null;
  let lastActivityUtime = null;

  for (const tx of transactions) {
    const utime = Number(tx.now || tx.utime || 0);
    if (utime < firstReceivedUtime) {
      continue;
    }

    transactionCount += 1;
    lastActivityUtime = Math.max(lastActivityUtime || 0, utime);
    outgoingMessageCount += Array.isArray(tx.out_msgs) ? tx.out_msgs.length : 0;

    if (isExternalInbound(tx.in_msg)) {
      const opcode = normalizeOpcode(tx.in_msg);
      const current = opcodeCounts.get(opcode.key) || {
        opcode: opcode.opcode,
        decoded_opcode: opcode.decoded_opcode,
        count: 0,
      };

      current.count += 1;
      opcodeCounts.set(opcode.key, current);
      externalRequestCount += 1;
      firstExternalUtime = firstExternalUtime === null ? utime : Math.min(firstExternalUtime, utime);
      lastExternalUtime = lastExternalUtime === null ? utime : Math.max(lastExternalUtime, utime);
    }
  }

  return {
    transactions_after_receive: transactionCount,
    outgoing_messages_after_receive: outgoingMessageCount,
    external_requests_after_receive: externalRequestCount,
    external_opcodes: [...opcodeCounts.values()].sort((left, right) => right.count - left.count),
    first_external_utime: firstExternalUtime,
    first_external_time: unixToIso(firstExternalUtime),
    last_external_utime: lastExternalUtime,
    last_external_time: unixToIso(lastExternalUtime),
    last_activity_utime: lastActivityUtime,
    last_activity_time: unixToIso(lastActivityUtime),
  };
}

function normalizeWalletDetails(account, wallet) {
  const status = wallet?.status || account?.status || null;
  const isWallet = wallet?.is_wallet ?? Boolean(wallet?.wallet_type);

  return {
    initialized: status === "active",
    status,
    is_wallet: isWallet,
    wallet_type: wallet?.wallet_type || null,
    wallet_id: wallet?.wallet_id ?? null,
    seqno: wallet?.seqno ?? null,
    is_signature_allowed: wallet?.is_signature_allowed ?? null,
    balance: nanoString(wallet?.balance ?? account?.balance),
    balance_ton: nanoToTon(wallet?.balance ?? account?.balance),
    code_hash: wallet?.code_hash || account?.code_hash || null,
    interfaces: account?.interfaces || [],
    last_transaction_lt: wallet?.last_transaction_lt || account?.last_transaction_lt || null,
    last_transaction_hash: wallet?.last_transaction_hash || account?.last_transaction_hash || null,
  };
}

async function readExistingEvents(fileName) {
  let text = "";
  try {
    text = await readFile(fileName, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const ids = new Set();
  const cursors = [];
  const events = [];
  let count = 0;
  let maxUtime = 0;

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid JSONL at ${fileName}:${index + 1}: ${error.message}`);
    }

    if (event.id) {
      ids.add(event.id);
    }
    if (event.tx_hash && event.lt) {
      cursors.push(event);
    }
    events.push(event);
    count += 1;
    maxUtime = Math.max(maxUtime, Number(event.utime || 0));
  }

  return { ids, cursors, events, count, maxUtime };
}

function normalizeTransaction(tx) {
  const inMsg = normalizeMessage(tx.in_msg || null);
  const outMsgs = Array.isArray(tx.out_msgs) ? tx.out_msgs.map(normalizeMessage) : [];
  const paidOutMsgs = outMsgs.filter((message) => nanoBigInt(message.value) > 0n);
  const amountNano = paidOutMsgs.reduce((sum, message) => sum + nanoBigInt(message.value), 0n);
  const success = transactionSucceeded(tx);
  const utime = Number(tx.now || tx.utime || 0);
  const lt = String(tx.lt || "0");
  const txHash = String(tx.hash || "");
  const recipient = paidOutMsgs[0]?.destination || null;

  return {
    schema: "acton-faucet-event-v1",
    id: `${lt}:${txHash}`,
    type: classifyEvent(success, inMsg, paidOutMsgs),
    address: String(tx.account || address),
    utime,
    time: utime > 0 ? new Date(utime * 1000).toISOString() : null,
    lt,
    tx_hash: txHash,
    trace_id: tx.trace_id || null,
    mc_block_seqno: tx.mc_block_seqno ?? null,
    success,
    aborted: Boolean(tx.description?.aborted),
    exit_code: tx.description?.compute_ph?.exit_code ?? tx.description?.compute?.exit_code ?? null,
    action_result_code: tx.description?.action?.result_code ?? null,
    requester: recipient || inMsg?.source || null,
    recipient,
    amount: String(amountNano),
    amount_ton: nanoToTon(amountNano),
    in: inMsg,
    out: outMsgs,
  };
}

function normalizeMessage(message) {
  if (!message) {
    return null;
  }

  return {
    hash: message.hash || null,
    source: message.source || null,
    destination: message.destination || null,
    value: nanoString(message.value),
    value_ton: nanoToTon(message.value),
    opcode: message.opcode === undefined || message.opcode === null ? null : String(message.opcode),
    decoded_opcode: message.decoded_opcode || null,
    bounced: typeof message.bounced === "boolean" ? message.bounced : null,
    bounce: typeof message.bounce === "boolean" ? message.bounce : null,
    body_hash: message.message_content?.hash || null,
    decoded: message.message_content?.decoded || null,
  };
}

function transactionSucceeded(tx) {
  const aborted = Boolean(tx.description?.aborted);
  const computeSuccess = tx.description?.compute_ph?.success ?? tx.description?.compute?.success ?? null;
  const actionSuccess = tx.description?.action?.success ?? null;

  return !aborted && computeSuccess !== false && actionSuccess !== false;
}

function classifyEvent(success, inMsg, paidOutMsgs) {
  if (!success) {
    return "failed";
  }
  if (paidOutMsgs.length > 0) {
    return "claim";
  }
  if (inMsg) {
    return "inbound";
  }
  return "transaction";
}

function latestCursor(events) {
  let latest = null;
  for (const event of events) {
    if (!event?.lt) {
      continue;
    }
    if (!latest || nanoBigInt(event.lt) > nanoBigInt(latest.lt)) {
      latest = event;
    }
  }
  return latest;
}

function compareEvents(left, right) {
  if (left.utime !== right.utime) {
    return left.utime - right.utime;
  }
  const leftLt = nanoBigInt(left.lt);
  const rightLt = nanoBigInt(right.lt);
  return leftLt < rightLt ? -1 : leftLt > rightLt ? 1 : 0;
}

function isAtOrAfterStart(event) {
  const eventLt = nanoBigInt(event?.lt);
  const startLt = nanoBigInt(startBoundary.account_start_lt);

  if (eventLt > 0n && startLt > 0n) {
    return eventLt >= startLt;
  }

  return Number(event?.utime || 0) >= startBoundary.account_start_utime;
}

async function readJson(fileName, fallback) {
  try {
    return JSON.parse(await readFile(fileName, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function requestJson(url) {
  const response = await fetch(url, {
    headers: apiKey ? { "X-API-Key": apiKey } : {},
  });

  if (requestDelayMs > 0) {
    await sleep(requestDelayMs);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`TON Center request failed: ${response.status} ${response.statusText}: ${text}`);
  }

  return response.json();
}

function apiUrl(resourceName) {
  const base = new URL(endpoint);
  const pathParts = base.pathname.split("/").filter(Boolean);
  pathParts[pathParts.length - 1] = resourceName;
  base.pathname = `/${pathParts.join("/")}`;
  base.search = "";
  return base;
}

function chunks(values, chunkSize) {
  const result = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    result.push(values.slice(index, index + chunkSize));
  }
  return result;
}

function isExternalInbound(message) {
  if (!message) {
    return false;
  }

  return message.source === null || message.source === undefined;
}

function normalizeOpcode(message) {
  const opcode = message.opcode === undefined || message.opcode === null ? null : String(message.opcode);
  const decodedOpcode = message.decoded_opcode || message.message_content?.decoded?.["@type"] || null;
  const key = decodedOpcode || opcode || "unknown";

  return {
    key,
    opcode,
    decoded_opcode: decodedOpcode,
  };
}

function normalizeAddressKey(accountAddress) {
  return String(accountAddress || "").toLowerCase();
}

function unixToIso(utime) {
  return utime ? new Date(Number(utime) * 1000).toISOString() : null;
}

function hexToBase64(hex) {
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    return "";
  }
  return Buffer.from(hex, "hex").toString("base64");
}

function readIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function nanoString(value) {
  if (value === undefined || value === null || value === "") {
    return "0";
  }
  return String(value);
}

function nanoBigInt(value) {
  try {
    return BigInt(nanoString(value));
  } catch {
    return 0n;
  }
}

function nanoToTon(value) {
  return Number(nanoBigInt(value)) / 1_000_000_000;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
