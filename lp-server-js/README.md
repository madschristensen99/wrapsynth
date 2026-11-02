# WrapSynth LP Server (JS)

Automated liquidity provider node for WrapSynth. Monitors on-chain events, processes mints (XMR deposits), handles burns (XMR sends), watches for kicks on its own vault, and exposes a REST API for the frontend.

**The protocol is oracle-free** — the server never pushes prices. Mint/burn settlement uses each vault's declared `thresholdSharesPerWsxmr` (normalized collateral per 1e8 wsXMR), which the LP sets on-chain via `setThreshold`.

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
- The LP vault wallet funded with each chain's native gas token (BNB on BNB Chain, ETH on Base / Robinhood Chain)
- `monero-wallet-rpc` running locally (for XMR deposit scanning and burn sends) — shared across all chains
- The wallet must have an active vault on each chain's wsXmrHub with deposited collateral (QQQB on BNB, cbBTC on Base, SPY on Robinhood) **and a declared threshold** (`setThreshold`)

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
| `PRIVATE_KEY` | LP vault wallet private key (0x-prefixed) — the same key is used on every configured chain |

### Chains (`chains.json`)

The server is multi-chain: `chains.json` lists every chain to run. Each entry
points at that chain's deployment manifest (e.g. `../frontend/deployment.bnb.json`)
and an optional env var overriding its RPC list:

| Entry field | Description |
|-------------|-------------|
| `key` | Short chain label used in logs, secrets files, and `/chains/<key>/` routes |
| `chainId` | EVM chain id |
| `manifest` | Path to the deployment manifest (flat forge output or curated nested shape) |
| `rpcEnv` | Env var holding comma-separated RPC URLs (e.g. `BNB_RPC_URLS`) |
| `rpcUrls` | Fallback RPC URLs when `rpcEnv` is unset |
| `logChunkSize` | `eth_getLogs` block-range cap for event scans |

A chain whose manifest file doesn't exist is skipped with a warning, so
`chains.json` can list BNB, Base, and Robinhood ahead of their deployments —
each activates once its manifest lands. Per-chain state is fully isolated:
provider, nonce manager, `pendingMints`, `pendingBurns`, and secrets files
(`lp-secrets-<key>.json`, `lp-burn-secrets-<key>.json`).

HTTP chain selection: manual endpoints (`/mint/key`, `/mint/scan`, burn routes)
accept a `chain` body/query param, and burn routes are also mounted under
`/chains/<key>/...`. When exactly one chain is running, unprefixed routes keep
working for backward compatibility.

### Monero

| Variable | Description |
|----------|-------------|
| `MONERO_WALLET_RPC_URL` | URL of running `monero-wallet-rpc` instance (e.g. `http://localhost:18082`) |
| `MONERO_VIEW_KEY` | LP's Monero private view key (hex, no 0x prefix) — needed to regenerate the main wallet if lost (mint deposit scanning uses the per-mint lpSecret as the view key) |
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

### Kick Watcher

The server polls `KickStarted` / `ReauctionStarted` / `AuctionOpened` / `AuctionSettled` / `VaultFrozen` / `VaultBackstopped` events on every configured chain.

| Variable | Default | Description |
|----------|---------|-------------|
| `KICK_WATCH` | `1` | Set `0` to disable the watcher entirely |
| `KICK_WATCH_POLL_MS` | `30000` | Event poll interval |
| `KICK_AUTOCANCEL` | `false` | If `true`, when *this server's vault* is kicked during `GRACE`, automatically `depositCollateral` to cancel it (the wrongful-kick bond pays the LP) |
| `KICK_DEPOSIT_RAW` | `10000` | Raw collateral units deposited per auto-cancel call |
| `SEEDED_BIDDER` | `false` | If `true`, act as a seeded keeper: bid on open auctions once the Dutch haircut reaches `SEEDED_BIDDER_MIN_X_BPS` |
| `SEEDED_BIDDER_MIN_X_BPS` | `7000` | Haircut floor (bps) at which the seeded bidder will `bid()` — 70% default |

The seeded bidder is a market-side helper, not consensus — it simply offers to clear the vault's debt in exchange for the offered collateral once the haircut is conservative enough.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP server port |

---

## Architecture

```
lp-server-js/
├── server.js              # Main entry — Express server, per-chain mint processing + listeners
├── chains.json            # Multi-chain registry: manifests, RPC env vars, log chunking
├── burnHandler.js         # Per-chain burn handler factory — proposeHash, finalizeBurn, slashes
├── kickWatcher.js         # Per-chain kick/auction watcher + optional grace-cancel and seeded bid
├── nonceManager.js        # Per-chain nonce manager factory + withTimeout helper
├── moneroWallet.js        # monero-wallet-rpc wrapper — deposit scanning, XMR sends, sweeping (shared)
├── moneroCrypto.js        # Ed25519 key generation + shared address computation
├── commitment.js          # Secret hash computation for PTLC commitments
├── lp-secrets-<chain>.json      # Persisted LP mint secrets per chain (auto-generated)
├── lp-burn-secrets-<chain>.json # Persisted LP burn secrets per chain (auto-generated)
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

1. **Load config** — reads `.env` + `chains.json`
2. **Start HTTP server** — Express on configured port
3. **Spawn deposit wallet-rpc** — dedicated `monero-wallet-rpc` for per-mint view-only wallets (shared by all chains)
4. **Open Monero wallet** — connects to main `monero-wallet-rpc`, fetches LP address (shared)
5. **Per chain** (independently, so one stalled chain never blocks the others):
   - Build context — provider/fallback RPCs, wallet binding, hub contract, nonce manager, burn handler, kick watcher
   - Start event listener — polls `MintInitiated`/`BurnRequested` events every 15s
   - Recover mints — scans from `deployedAtBlock` (bounded) for active mints needing `setMintReady`
   - Resolve stale — cancels timed-out mints, resolves stuck burn proposals
   - Sweep finalized — sweeps XMR from finalized mints where LP secret is persisted
   - Start periodic jobs — stale-burn check (60s), mint auto-retry (5min), kick watcher (15s)

### Mint Processing Flow

```
MintInitiated event detected
  │
  ├── Generate Ed25519 key pair (LP spend key; view pub = spend pub)
  ├── provideLPKey() on-chain (lpPublicViewKey = lpSpendPub)
  ├── Compute shared deposit address (user pubkey + LP keys)
  ├── Scan for XMR deposit via view-only wallet (view key = lpSecret, 15s interval)
  │     └── Optional fallback: user submits txid+txKey via POST /mint/deposit
  ├── Generate LP secret + commitment
  ├── Persist LP secret to lp-secrets.json (for crash recovery)
  └── setMintReady(requestId) on-chain — locks par × 110% key bond at threshold
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
  │           — settles at par vs thresholdAtRequest, no price push
  │
  └── [If AUTO_PROCESS_BURNS=false]
        └── Wait for manual /burn/propose + /burn/finalize API calls
```

### Kick Watch Flow

```
KickStarted(vault, kicker, bond, auctionEnd) detected
  │
  ├── vault == our LP vault?
  │     ├── yes → log alert; if KICK_AUTOCANCEL && phase == GRACE:
  │     │         repayDebt(partial ok) or depositCollateral → KickCancelled, bond → LP
  │     └── no  → remember auction
  │
  ├── AuctionOpened(vault, offeredCollateral)
  │     └── if SEEDED_BIDDER: watch X(t); when xBps <= SEEDED_BIDDER_MIN_X_BPS,
  │         bid(vault) — pays full wsXMR debt, receives X(t)% of collateral
  │
  └── AuctionSettled / VaultFrozen / VaultBackstopped → final state log
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

---

## Operational Notes

### Vault terms

Every vault must declare `thresholdSharesPerWsxmr` (`setThreshold`) — normalized collateral per 1e8 wsXMR. It is the vault's solvency line, settlement par, and mint capacity bound. `setMaxMintWsxmr` optionally caps total outstanding mints. Keep free collateral comfortably above `(debt + pending) × threshold` — anything below that is kickable in practice, though the protocol itself never judges prices.

### Griefing deposit

Each vault's `mintGriefingDeposit` (set via `setMintGriefingDeposit`) is paid
by minters in the chain's **native gas token** — it's the bond that deters
abandoned mints. Keep it small enough not to be a UX barrier: the suggested
setting on BNB Chain is **0.001 BNB** (~$0.60). On ETH-gas chains prefer
something in the same dollar range, not 0.001 ETH.

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
- `[Kick]` — kick/auction watcher events
- `[Chain]` — on-chain transaction submissions and confirmations
- `[Sweep]` — XMR sweep operations
- `[Recovery]` — startup recovery
- `[Resolve]` — stale mint/burn resolution
- `[Event]` — event polling
- `[HTTP]` — incoming API requests

`monero-wallet-rpc` logs are written to `monero-wallet-rpc.log` in the same directory.
