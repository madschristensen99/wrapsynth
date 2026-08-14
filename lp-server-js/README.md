# WrapSynth LP Server (JS)

Automated liquidity provider node for WrapSynth. Monitors on-chain events, processes mints (XMR deposits), handles burns (XMR sends), and exposes a REST API for the frontend.

---

## Quick Start

```bash
cd lp-server-js
npm install
cp .env.example .env
# Edit .env — set PRIVATE_KEY and MONERO_WALLET_RPC_URL (required for real XMR operations)
npm start
```

The server starts on `http://localhost:3001` (configurable via `PORT`).

### Prerequisites

- Node.js v18+
- A Gnosis Chain wallet with xDAI for gas (this is the LP vault wallet)
- `monero-wallet-rpc` running locally (for XMR deposit scanning and burn sends)
- The wallet must have an active vault on wsXmrHub with deposited sDAI collateral

### Starting monero-wallet-rpc

```bash
monero-wallet-rpc --wallet-file /path/to/lp-wallet --password <wallet_password> \
  --rpc-bind-port 18082 --disable-rpc-login \
  --daemon-address node.moneroworld.com:18089
```

If using `--rpc-login user:pass`, set `MONERO_WALLET_RPC_USER` and `MONERO_WALLET_RPC_PASSWORD` in `.env`.

---

## Configuration

All configuration is via environment variables (`.env` file). See `.env.example` for the full list.

### Required

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | LP vault wallet private key (0x-prefixed) |
| `RPC_URL` | Gnosis Chain RPC endpoint (default: `https://rpc.gnosischain.com`) |

### Monero

| Variable | Description |
|----------|-------------|
| `MONERO_WALLET_RPC_URL` | URL of running `monero-wallet-rpc` instance (e.g. `http://localhost:18082`) |
| `MONERO_VIEW_KEY` | LP's Monero private view key (hex, no 0x prefix) — needed for deposit scanning and sweeping |
| `MONERO_DAEMON_ADDRESS` | Monero daemon address for wallet-rpc (default: `xmr-node.cakewallet.com:18081`) |
| `MONERO_WALLET_RPC_USER` | Basic auth username (only if `--rpc-login` enabled) |
| `MONERO_WALLET_RPC_PASSWORD` | Basic auth password (only if `--rpc-login` enabled) |

### Burn Processing

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_PROCESS_BURNS` | `false` | If `true`, automatically propose + finalize burns without manual intervention |
| `BURN_PROPOSE_DELAY_MS` | `5000` | Delay between burn request detection and `proposeHash` |
| `BURN_FINALIZE_DELAY_MS` | `30000` | Delay between user commit and `finalizeBurn` (allows XMR send confirmation) |
| `BURN_LP_PUBLIC_SPEND_KEY` | — | Default LP Ed25519 public spend key for burns (hex, 64 chars) |
| `BURN_LP_PUBLIC_VIEW_KEY` | — | Default LP Ed25519 public view key for burns (hex, 64 chars) |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP server port |

---

## Architecture

```
lp-server-js/
├── server.js              # Main entry — Express server, mint processing, event listener
├── burnHandler.js         # Burn state machine — proposeHash, finalizeBurn, slash resolution
├── moneroWallet.js        # monero-wallet-rpc wrapper — deposit scanning, XMR sends, sweeping
├── moneroCrypto.js        # Ed25519 key generation + shared address computation
├── commitment.js          # Secret hash computation for PTLC commitments
├── oracleUpdate.js        # RedStone oracle price update helper
├── lp-secrets.json        # Persisted LP secrets for mint sweeping (auto-generated)
├── processPastBurns.js    # Script: re-process burns from recent blocks
├── cancel-mint.js         # Script: manually cancel a stuck mint
├── list-mints.js          # Script: list on-chain mint status for this vault
├── check-mint-keys.js     # Script: check LP key provisioning status
├── manual-setMintReady.js # Script: manually call setMintReady for a mint
├── finalize-mint-manual.js# Script: manually finalize a mint
├── create-monero-wallet.js# Script: create a new Monero wallet for the LP
└── test-ed25519-vector.js # Test: Ed25519 compatibility test vectors
```

### Startup Sequence

1. **Load config** — reads `.env`, loads `deployment.json` for contract addresses
2. **Start HTTP server** — Express on configured port
3. **Start event listener** — polls `MintInitiated` events every 15s
4. **Open Monero wallet** — connects to `monero-wallet-rpc`, fetches LP address
5. **Recover mints** — scans last 10,000 blocks for active mints needing `setMintReady`
6. **Resolve stale** — cancels timed-out mints, resolves stuck burn proposals
7. **Sweep finalized** — sweeps XMR from finalized mints where LP secret is persisted
8. **Attach burn handler** — starts listening for `BurnRequested` events

### Mint Processing Flow

```
MintInitiated event detected
  │
  ├── Generate Ed25519 key pair (LP spend key + LP view key)
  ├── provideLPKey() on-chain
  ├── Compute shared deposit address (user pubkey + LP keys)
  ├── Poll monero-wallet-rpc for XMR deposit (15s interval, 10min timeout)
  │     └── Creates view-only wallet for the shared address
  ├── Update oracle prices (required for collateral check)
  ├── Generate LP secret + commitment
  ├── Persist LP secret to lp-secrets.json (for crash recovery)
  └── setMintReady() on-chain with LP commitment + bond
        │
        └── MintFinalized event detected later
              ├── Combine user's revealed secret + LP secret
              └── Sweep XMR from shared address to LP wallet
```

### Burn Processing Flow

```
BurnRequested event detected
  │
  ├── [If AUTO_PROCESS_BURNS=true]
  │     ├── Generate LP secret + hash
  │     ├── Send XMR to user's Monero destination
  │     ├── proposeHash() on-chain (after BURN_PROPOSE_DELAY_MS)
  │     └── finalizeBurn() on-chain (after BURN_FINALIZE_DELAY_MS)
  │
  └── [If AUTO_PROCESS_BURNS=false]
        └── Wait for manual /burn/propose + /burn/finalize API calls
```

---

## REST API

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health + LP wallet address + hub address |

### Mints

| Method | Endpoint | Params | Description |
|--------|----------|--------|-------------|
| `GET` | `/mints` | — | List all tracked mints (in-memory state) |
| `POST` | `/mint/key` | `requestId`, `lpPublicSpendKey`, `lpPublicViewKey` | Manually provide LP keys + trigger processing |
| `POST` | `/mint/scan` | `requestId` | Manually trigger deposit scan for a mint (skips key provision if already done) |

### Burns

| Method | Endpoint | Params | Description |
|--------|----------|--------|-------------|
| `GET` | `/burns` | — | List all tracked burns (in-memory state) |
| `GET` | `/burns/:requestId` | — | Get single burn status |
| `POST` | `/burn/propose` | `requestId`, `lpPublicSpendKey?`, `lpPublicViewKey?` | Manually propose hash for a burn |
| `POST` | `/burn/finalize` | `requestId` | Manually finalize a burn (reveals LP secret) |
| `POST` | `/burn/slash` | `requestId` | Claim slashed collateral from a timed-out burn |
| `POST` | `/burn/resolve-declined` | `requestId` | Resolve a burn where user declined the LP's proposal |

### Oracle Reports

| Method | Endpoint | Params | Description |
|--------|----------|--------|-------------|
| `GET` | `/reports` | `feedIDs` (comma-separated) | Fetch Chainlink Data Streams signed reports for the frontend |

---

## Operational Notes

### Crash Recovery

- **LP secrets** are persisted to `lp-secrets.json` so mint deposits can be swept even after a server restart
- On startup, the server scans the last 10,000 blocks (~3.5 days) for active mints and stale burns
- Finalized-but-unswept mints are retried on startup

### Mint Processing Mutex

`monero-wallet-rpc` can only have one wallet open at a time. Mint processing (which creates/closes view-only deposit wallets) is serialized via a promise chain (`serializeMint()`). Concurrent mints queue and process one-by-one.

### Manual Intervention Scripts

| Script | Command | Description |
|--------|---------|-------------|
| Cancel a stuck mint | `node cancel-mint.js <requestId>` | Calls `cancelMint()` on-chain |
| List on-chain mints | `node list-mints.js` | Shows status of recent mints for this vault |
| Check LP keys | `node check-mint-keys.js` | Verifies LP key provisioning status |
| Manual setMintReady | `node manual-setMintReady.js <requestId>` | Bypasses deposit scan, calls `setMintReady` directly |
| Manual finalize mint | `node finalize-mint-manual.js <requestId> <secret>` | Calls `finalizeMint()` with a known secret |
| Process past burns | `node processPastBurns.js` | Re-scans recent blocks for unprocessed burns |
| Create Monero wallet | `node create-monero-wallet.js` | Creates a new Monero wallet for the LP |

### Logs

The server logs to stdout with prefixed tags:
- `[Mint]` — mint processing steps
- `[Burn]` — burn processing steps
- `[Chain]` — on-chain transaction submissions and confirmations
- `[Sweep]` — XMR sweep operations
- `[Recovery]` — startup recovery
- `[Resolve]` — stale mint/burn resolution
- `[Event]` — event polling
- `[HTTP]` — incoming API requests

`monero-wallet-rpc` logs are written to `monero-wallet-rpc.log` in the same directory.
