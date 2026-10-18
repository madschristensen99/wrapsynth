# WrapSynth Frontend

The web application for trustless XMR ⇄ wsXMR atomic swaps across multiple chains — BNB Chain, Base, and Robinhood Chain (all live). The user picks a chain; there is no default. Live at [wrapsynth.com](https://wrapsynth.com).

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
- Network: whichever chain you select — BNB Chain (56), Base (8453), and Robinhood Chain (4663) are all live with deployment manifests

---

## Architecture

### Module Overview

```
frontend/
├── index.html              # Main swap UI (mint/burn/co-LP tabs)
├── account.html            # Account page (balances + on-chain history)
├── lp-vault.html           # LP vault management page
├── styles.css              # Global styles
├── app-styles.css          # App-specific styles
├── config.js               # Contract addresses, ABIs, network config (loaded from deployment.json)
├── deployment.json         # Canonical deployment manifest
└── js/
    ├── main.js             # Entry point — orchestrates flows, wallet, tab switching
    ├── ui.js               # DOM controller — all element refs, show/hide/update helpers
    ├── viemClient.js       # Viem public + wallet clients, contract read/write helpers
    ├── mintFlow.js         # Mint state machine (XMR → wsXMR, 4-step atomic swap)
    ├── burnFlow.js         # Burn state machine (wsXMR → XMR, 5-step atomic swap)
    ├── mintFlowTimers.js   # Deadline countdown + status polling for mints
    ├── burnSweep.js        # Post-finalize XMR sweep from shared address (browser WASM)
    ├── phantomAgent.js     # Ephemeral Monero wallet — seed-based, EIP-7702 safe
    ├── seedManager.js      # BIP-39 seed generation + Ed25519 key derivation
    ├── seedStorage.js      # Two-layer encrypted seed persistence (IndexedDB + signature)
    ├── seedUI.js           # Seed backup/restore UI modals
    ├── moneroCrypto.js     # Ed25519 point math + Monero address derivation
    ├── moneroRpc.js        # Monero daemon RPC client (height, fee, broadcast)
    ├── monero-ts.js        # Bundled monero-ts WASM wallet library
    ├── redstoneWrapper.js  # RedStone oracle price fetch + on-chain update helper
    ├── coLPFlow.js         # Co-LP position manager (open/unwind/fees via hub)
    ├── poolFlow.js         # V3 pool swap helper (per-chain DEX)
    ├── lpPanel.js          # LP vault panel UI (deposit, withdraw, configure)
    ├── lpClient.js         # LP server REST client
    ├── storage.js          # LocalStorage swap state persistence (multi-swap)
    ├── swapHistory.js      # Completed swap history
    ├── activityFeed.js     # Real-time activity feed UI
    ├── protocolStats.js    # Protocol-level stats (TVL, debt, collateral ratios)
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
  │                      ├── readHub()  → view calls (balances, vaults, requests)
  │                      └── writeHub() → state-changing txs (mint, burn, co-LP)
  │
  ├── phantomAgent.js ──→ Browser WASM Monero wallet (monero-ts)
  │                      ├── Generates Ed25519 key pairs from BIP-39 seed
  │                      ├── Computes shared deposit addresses (user + LP keys)
  │                      └── Sweeps XMR from shared address after finalization
  │
  ├── lpClient.js ──→ LP Server (lp-server-js, default localhost:3001)
  │                     ├── Notifies LP of new mint/burn requests
  │                     └── Polls mint/burn status
  │
  └── redstoneWrapper.js ──→ RedStone API + on-chain oracle update
                             ├── fetchRedStonePrices() → off-chain price display
                             └── updateOraclePrices()  → on-chain price push
```

### Key Concepts

**Phantom Agent** — A deterministic ephemeral Monero wallet generated per-swap from a BIP-39 seed phrase. The seed is encrypted with a non-extractable browser key (IndexedDB) plus a wallet signature, making it EIP-7702 safe. See [Seed Storage Design](../docs/SEED_STORAGE_IMPLEMENTATION.md) for details.

**Mint Flow** (XMR → wsXMR) — 4-step atomic swap:
1. `initiateMint` — user posts Ed25519 commitment + griefing deposit
2. LP provides keys + locks collateral → user sends XMR to shared deposit address
3. LP confirms receipt → `setMintReady`
4. User reveals secret → `finalizeMint` → wsXMR minted

**Burn Flow** (wsXMR → XMR) — 5-step atomic swap:
1. `requestBurn` — user locks wsXMR, posts hash commitment + Monero destination
2. LP proposes hash + sends XMR → `proposeHash`
3. User confirms Monero lock → `confirmMoneroLock`
4. LP reveals secret → `finalizeBurn` → wsXMR burned, collateral released
5. User sweeps XMR from shared address using combined private keys

**Co-LP** — Users can pair wsXMR with LP vault collateral to create concentrated-liquidity positions on the chain's V3 DEX (PancakeSwap on BNB, Uniswap on Base/Robinhood). The `coLPFlow.js` module handles capacity checks, position opening, fee collection, and unwinding.

---

## Configuration

The frontend is multi-chain: `config.js` holds a registry of supported chains, each lazily loading its own `deployment.<key>.json` manifest (e.g. `deployment.bnb.json`). A chain appears in the picker once its manifest file exists; the chain choice is persisted in localStorage and shareable via `?chain=` deep links.

Contract addresses and ABIs are injected as `window.DEPLOYMENT` by the HTML loaders and resolved per active chain. Per-chain swap state is namespaced so history doesn't bleed across deployments. The prior Gnosis manifest is preserved as `deployment.gnosis.json`; `deployment.json` is the legacy HyperEVM manifest kept for compatibility.

Manifest structure (per chain):

```json
{
  "chainId": 56,
  "contracts": { "wsXmrHub": "0x...", "wsXMR": "0x...", "liquidityRouter": "0x..." },
  "externalContracts": { "stataQQQB": "0x...", "QQQB": "0x..." },
  "pool": { "uniswapV3Pool": "0x..." },
  "lpConfig": { "defaultLpVault": "0x..." }
}
```

---

## LP Server Integration

The frontend communicates with the LP server (`lp-server-js/`) for:
- Notifying the LP when a new mint or burn is initiated
- Polling mint/burn processing status
- Fetching quotes (fees, timeouts)

The LP server URL defaults to `http://localhost:3001` and is configurable in `config.js` → `LP_SERVER_CONFIG`. See the [LP Server README](../lp-server-js/README.md) for API details.

---

## Pages

| Page | File | Purpose |
|------|------|---------|
| Swap | `index.html` | Main interface — mint, burn, co-LP tabs |
| Account | `account.html` | Wallet balances, wsXMR transfer history, pending returns |
| LP Vault | `lp-vault.html` | LP vault management (deposit/withdraw collateral, configure fees) |

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
