# Acton faucet stats

Small static collector for the Acton faucet testnet account:

```text
kQD_O1WeM-icMY8JIoGzgySEQ8ivvoSpgSoglUsaua6YDBtX
```

The GitHub Actions workflow runs every hour, fetches transactions from TON Center testnet API v3, normalizes them, appends new rows to `data/events.jsonl`, updates recipient usage details in `data/recipients.json`, and deploys the latest static site to GitHub Pages.

Collection is explicitly bounded to start at this Tonviewer transaction:

```text
https://testnet.tonviewer.com/transaction/c90aeade342655596b0524e1bfbe58f0a39f2661bce19168d5b7f4ae61ef20b5
```

That transaction funds the faucet. For the faucet account itself, collection starts from `lt=68861867000001` at `2026-05-11T07:37:56Z`.

`index.html` is a plain HTML page. It loads `data/events.jsonl` and `data/recipients.json` directly, then renders text summaries, simple canvas charts, and tables without CSS styling.

## Run locally

```sh
node scripts/collect.mjs
```

Then serve the repository root with any static server and open `index.html`. Opening the file directly may not work in all browsers because `fetch()` can be blocked for local files.

## Optional environment variables

```text
TONCENTER_API_KEY          optional TON Center API key
FAUCET_ADDRESS            account to collect, defaults to the Acton faucet
TONCENTER_ENDPOINT         defaults to https://testnet.toncenter.com/api/v3/transactions
COLLECT_OVERLAP_SECONDS    defaults to 7200
COLLECT_PAGE_LIMIT         defaults to 1000
COLLECT_MAX_PAGES          defaults to 25
COLLECT_RECIPIENT_DETAILS  set to 0 to skip recipient usage refresh
RECIPIENT_DETAILS_MAX_RECIPIENTS
RECIPIENT_TRANSACTIONS_PAGE_LIMIT defaults to 100
RECIPIENT_TRANSACTIONS_MAX_PAGES  defaults to 10
TONCENTER_REQUEST_DELAY_MS defaults to 0 with an API key, 1100 without one
COLLECT_START_SOURCE_URL   Tonviewer/source transaction URL
COLLECT_START_SOURCE_TX_HASH_HEX
COLLECT_START_SOURCE_TX_HASH
COLLECT_START_SOURCE_UTIME defaults to 1778485075
COLLECT_START_UTIME        faucet account start utime, defaults to 1778485076
COLLECT_START_LT           faucet account start lt, defaults to 68861867000001
COLLECT_START_TX_HASH      faucet account start tx hash
DATA_DIR                   defaults to ./data
```

The overlap makes the collector tolerant of delayed GitHub Actions runs. Deduplication uses `lt:tx_hash`, and events before `COLLECT_START_LT` are ignored.

## GitHub Pages

Use GitHub Pages with GitHub Actions as the source. The workflow deploys a small artifact containing `index.html`, `app.js`, `data/events.jsonl`, and `data/recipients.json`.
