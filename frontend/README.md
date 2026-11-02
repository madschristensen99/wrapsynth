# WrapSynth Frontend

The web application for trustless XMR ⇄ wsXMR atomic swaps across multiple chains — BNB Chain, Base, and Robinhood Chain. The user picks a chain; there is no default. Live at [wrapsynth.com](https://wrapsynth.com).

**The protocol is oracle-free.** No transaction the frontend sends pushes or depends on a price feed — there is no `updateOraclePrices` step anywhere in mint, burn, or co-LP flows. Off-chain market prices (CoinGecko/Yahoo) appear only as display-only USD context; every protocol number — capacity, coverage, par — is computed from the vault's declared threshold.

---

## Quick Start

```bash
cd frontend
npm install
# Serve locally (any static server works — the app is pure ES modules)
npx serve .
# or
python3 -m http.server 8000
```

Open `http://localhost:8000`, pick a chain in the chain selector, and connect an EVM wallet (MetaMask, Rabby, etc.) — the app will prompt a network switch if needed.

No build step is required. The app uses native ES modules with CDN imports for `viem`.

### Requirements

- Node.js v18+ (for `npm install` of local dependencies)
- A browser with EIP-1193 wallet support (MetaMask, Rabby, etc.)
- Network: whichever chain you select — BNB Chain (56), Base (8453), and Robinhood Chain (4663)

---

## Architecture

### Module Overview

```
frontend/
├── index.html              # Landing page — chain cards, sequence diagrams
├── app.html                # Main swap UI (mint/burn/co-LP tabs)
├── account.html            # Account page (balances + on-chain history)
├── lp-vault.html           # LP vault detail page (coverage, auction state)
├── styles.css              # Global styles
├── app-styles.css          # App-specific styles
├── config.js               # Contract addresses, ABIs, network config (per-chain deployment manifests)
├── deployment.<chain>.json # Per-chain deployment manifests
└── js/
    ├── main.js             # Entry point — orchestrates flows, wallet, tab switching
    ├── ui.js               # DOM controller — all element refs, show/hide/update helpers
    ├── viemClient.js       # Viem public + wallet clients, contract read/write helpers
    ├── mintFlow.js         # Mint state machine (XMR → wsXMR, 4-step atomic swap)
    ├── burnFlow.js         # Burn state machine (wsXMR → XMR, 5-step atomic swap)
    ├── mintFlowTimers.js   # Deadline countdown + status polling for mints
    ├── burnSweep.js        # Post-finalize XMR sweep from shared address (browser WASM)
    ├── prices.js           # Display-only market prices (CoinGecko/Yahoo) — never used for protocol calls
    ├── phantomAgent.js     # Ephemeral Monero wallet — seed-based, EIP-7702 safe
    ├── seedManager.js      # BIP-39 seed generation + Ed25519 key derivation
    ├── seedStorage.js      # Two-layer encrypted seed persistence (IndexedDB + signature)
    ├── seedUI.js           # Seed backup/restore UI modals
    ├── moneroCrypto.js     # Ed25519 point math + Monero address derivation
    ├── moneroRpc.js        # Monero daemon RPC client (height, fee, broadcast)
    ├── monero-ts.js        # Bundled monero-ts WASM wallet library
    ├── coLPFlow.js         # Co-LP position manager (negotiated amounts via hub)
    ├── lpPanel.js          # LP vault panel UI (deposit, withdraw, setThreshold, setMaxMintWsxmr)
    ├── storage.js          # LocalStorage swap state persistence (multi-swap)
    ├── swapHistory.js      # Completed swap history
    ├── activityFeed.js     # Real-time activity feed UI
    ├── protocolStats.js    # Protocol-level stats (supply, debt, threshold-relative coverage)
    ├── dashboard.js        # Dashboard summary widgets
    ├── diagnostics.js      # Connection + config diagnostics
    ├── animations.js       # Mint/burn success animations
    ├── icons.js            # SVG icon set
    └── account.js          # Account page logic (balances + transfer history)
```

### Data Flow

```
User Browser
  │
  ├── viemClient.js ──→ selected chain (wsXmrHub via diamond proxy)
  │                      ├── readHub()  → view calls (balances, vaults, requests, auctionState)
  │                      └── writeHub() → state-changing txs (mint, burn, co-LP)
  │
  ├── phantomAgent.js ──→ Browser WASM Monero wallet (monero-ts)
  │                      ├── Generates Ed25519 key pairs from BIP-39 seed
  │                      ├── Computes shared deposit addresses (user + LP keys)
  │                      └── Sweeps XMR from shared address after finalization
  │
  └── prices.js ──→ Off-chain quote APIs (CoinGecko, Yahoo Finance)
                     └── Display-only USD values. Never feeds a transaction.
```

### Key Concepts

**Phantom Agent** — A deterministic ephemeral Monero wallet generated per-swap from a BIP-39 seed phrase. The seed is encrypted with a non-extractable browser key (IndexedDB) plus a wallet signature, making it EIP-7702 safe. See [Seed Storage Design](../docs/SEED_STORAGE_IMPLEMENTATION.md) for details.

**LP-declared threshold** — Every vault declares `thresholdSharesPerWsxmr`: normalized collateral per 1e8 wsXMR. The UI surfaces it at request time (implied par rate), and all capacity/coverage figures are computed against it — not against any market price. Par settlement is `wsxmr × threshold / 1e8`.

**Mint Flow** (XMR → wsXMR) — 4-step atomic swap:
1. `initiateMint` — user posts Ed25519 commitment + griefing deposit; capacity check is `(debt + pending + mint) × threshold ≤ free collateral`
2. LP provides keys + locks key bond → user sends XMR to shared deposit address
3. LP confirms receipt → `setMintReady` (bond locks `par × 110%` at `thresholdAtReady`)
4. User reveals secret → `finalizeMint` → wsXMR minted

**Burn Flow** (wsXMR → XMR) — 5-step atomic swap:
1. `requestBurn` — user locks wsXMR, posts hash commitment + Monero destination; vault locks proportional par collateral at `thresholdAtRequest` + reward
2. LP proposes hash + sends XMR → `proposeHash`
3. User confirms Monero lock → `confirmMoneroLock`
4. LP reveals secret → `finalizeBurn` → wsXMR burned, collateral released
5. User sweeps XMR from shared address using combined private keys

**Auction liquidation** — Vault cards show `auctionState` (phase: GRACE / OPEN_DELAY / ACTIVE / ENDED, or FROZEN). Kicks are bonded; bids pay the full debt for X(t)% of the offered collateral as the Dutch haircut decays 100%→5%.

**Co-LP** — Users pair wsXMR with LP vault collateral via `userOpenCoLP(vault, wsxmrAmount, collateralAmount, deadline)` — the collateral leg is negotiated (defaulted to the vault's threshold par), and range bounds come from the pool's own `slot0`. The `coLPFlow.js` module handles capacity checks, position opening, fee collection, and unwinding.

---

## Configuration

The frontend is multi-chain: `config.js` holds a registry of supported chains, each lazily loading its own `deployment.<key>.json` manifest (e.g. `deployment.bnb.json`). A chain appears in the picker once its manifest file exists; the chain choice is persisted in localStorage and shareable via `?chain=` deep links.

Contract addresses and ABIs are injected as `window.DEPLOYMENT` by the HTML loaders and resolved per active chain. Per-chain swap state is namespaced so history doesn't bleed across deployments. The prior Gnosis manifest is preserved as `deployment.gnosis.json`; `deployment.json` is the legacy HyperEVM manifest kept for compatibility.

Manifest structure (per chain):

```json
{
  "chainId": 56,
  "contracts": { "wsXmrHub": "0x...", "wsXMR": "0x...", "liquidityRouter": "0x..." },
  "externalContracts": { "collateralToken": "0x..." },
  "pool": { "uniswapV3Pool": "0x..." },
  "lpConfig": { "defaultLpVault": "0x..." }
}
```

---

## LP Server Integration

The frontend is fully on-chain — it makes **no calls to the LP server**. The
LP server watches chain events independently (`lp-server-js/`); the frontend
discovers mint/burn state by reading contracts directly and picks up LP keys
and deposit addresses on-chain. There is no `LP_SERVER_CONFIG` and no
`lpClient.js` — do not reintroduce them.

---

## Pages

| Page | File | Purpose |
|------|------|---------|
| Landing | `index.html` | Chain cards, protocol stats, sequence diagrams |
| Swap | `app.html` | Main interface — mint, burn, co-LP tabs |
| Account | `account.html` | Wallet balances, wsXMR transfer history, pending returns |
| LP Vault | `lp-vault.html` | LP vault detail — threshold-relative coverage, auction state, configuration |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `viem` (via CDN) | EVM client — contract reads/writes, ABI encoding |
| `monero-ts` | Browser WASM Monero wallet — key management, address derivation, sweeping |
| `@noble/ed25519` (via CDN) | Ed25519 point arithmetic for shared address computation |
| `qrcode` | QR code generation for deposit addresses |
| `ethers` | Used by `lp-server-js`; frontend uses viem instead |

All imports are ES module `import` statements — no bundler needed. Viem and noble/ed25519 are loaded from `esm.sh` CDN.

---

## Development Notes

- **No build step**: The app runs directly as static files with native ES modules
- **Cache busting**: UI module imports use `?v=3.x` query params to bust browser cache on updates
- **State persistence**: Active swaps are saved to `localStorage` (key: `wrapsynth_active_swaps_v2`) so users can resume after page refresh
- **Wallet transport**: `viemClient.js` prefers MetaMask for RPC reads (bypasses CORS/rate limits), falls back to HTTP RPCs if wallet is locked
- **Monero WASM**: `monero-ts.js` is a large bundled file (~2.5MB) loaded only when a Monero wallet operation is needed
- **Normalized collateral**: `collateralShares`, `lockedCollateral`, `deployedCollateral`, thresholds, and all hub-returned collateral figures are 18-decimal normalized units — `/1e18` gives human collateral on every chain, regardless of the token's native decimals
