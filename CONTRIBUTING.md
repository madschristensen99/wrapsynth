# Contributing to WrapSynth

Thanks for your interest in contributing! This guide covers dev setup, code style, testing, and the PR process.

---

## Development Setup

### Prerequisites

- **Node.js** v18+
- **Foundry** (`forge`, `cast`, `anvil`) — for Solidity compilation and tests
- **Git** — with submodule support (`git clone --recursive`)

### Repository Layout

```
wsFrontendOverhaul/
├── ethereum/          # Solidity contracts (diamond pattern: Hub + Facets)
├── frontend/          # Web app (vanilla ES modules, no bundler)
├── lp-server-js/      # LP node (Node.js/Express, Monero wallet RPC)
├── solana/            # Solana/Anchor program (alternative deployment)
├── docs/              # Architecture docs, sequence diagrams, implementation notes
└── deployment.json    # Canonical contract address manifest
```

### Getting Started

```bash
# Clone with submodules
git clone --recursive <repo-url>
cd wsFrontendOverhaul

# Solidity — install deps and build
cd ethereum
forge install
forge build

# Frontend — install deps, serve locally
cd ../frontend
npm install
npx serve .

# LP Server — install deps, configure
cd ../lp-server-js
npm install
cp .env.example .env  # edit with your keys
```

---

## Code Style Conventions

### Solidity

- **NatSpec on all public/external functions**: Use `@notice`, `@param`, `@return` for user-facing functions. Use `@dev` for internal functions and implementation details.
- **Contract-level NatSpec**: Every contract and interface should have a `@title` and `@notice` describing its role in the diamond.
- **Storage layout**: `wsXmrStorage.sol` defines the shared storage. **Never** reorder, insert, or remove storage variables — only append. See the contract-level comment in `wsXmrStorage.sol` for details.
- **Facet pattern**: Each facet inherits `wsXmrStorage` and implements an interface. Facets communicate via `IwsXmrHub(address(this)).<function>()` calls (internal delegatecall).
- **Reentrancy**: Use the `_reentrancyStatus` guard pattern (check-enter-exit) on all state-changing external functions.
- **Errors**: Use custom errors (not `require` strings) for gas efficiency. Define in the facet or in `wsXmrStorage.sol`.
- **Compiler**: `^0.8.28`. Do not change without a migration plan.
- **Testing**: All new contract logic must have Foundry tests in `ethereum/test/`.

### JavaScript (Frontend)

- **ES modules**: All files use `import`/`export`. No CommonJS, no bundler.
- **No build step**: The app runs as static files. Imports use CDN URLs or relative paths with `?v=` cache-busting.
- **JSDoc on exported functions**: Add `/** @description ... */` headers to all exported functions, especially in state machine files (`mintFlow.js`, `burnFlow.js`, `coLPFlow.js`).
- **Class-based state machines**: Mint, burn, and co-LP flows are classes with a `state` property and step-by-step methods. Follow the existing pattern.
- **Async/await**: Prefer over `.then()/.catch()`. All network calls (RPC, LP server, Monero) are async.
- **Error handling**: Surface errors to the UI via `ui.js` helpers (`showError`, `showBanner`). Don't swallow exceptions silently.

### JavaScript (LP Server)

- **ES modules**: `type: "module"` in `package.json`. Use `import`/`export`.
- **Express routes**: Group by domain (mint routes in `server.js`, burn routes registered via `burnHandler.js`).
- **Environment variables**: All config via `.env`. Document new variables in `.env.example`.
- **Logging**: Use prefixed console logs (`[Mint]`, `[Burn]`, `[Chain]`, etc.) for structured output.
- **Monero wallet mutex**: `monero-wallet-rpc` supports one open wallet at a time. All wallet operations must go through the `serializeMint()` promise chain.

---

## Testing Workflow

### Solidity Tests (Foundry)

```bash
cd ethereum

# Run all tests
forge test

# Run with verbose output
forge test -vvv

# Run a specific test
forge test --match-test testMintHappyPath -vvv

# Run with gas reporting
forge test --gas-report

# Fork mainnet for integration tests
forge test --fork-url https://rpc.gnosischain.com
```

### Frontend

No automated test framework. Manual testing:

1. Start a static server: `npx serve frontend/`
2. Connect a Gnosis-compatible wallet (MetaMask, Rabby)
3. Test mint/burn flows against a local or testnet LP server
4. Verify state persistence (refresh page mid-swap, check `localStorage`)

### LP Server

```bash
cd lp-server-js

# Start in dev mode (auto-restart)
npm run dev

# Run the Ed25519 test vector
node test-ed25519-vector.js

# Manual scripts for testing specific flows
node list-mints.js
node check-mint-keys.js
```

---

## PR Checklist

Before submitting a pull request:

- [ ] **Solidity changes compile**: `forge build` succeeds with no warnings
- [ ] **Solidity tests pass**: `forge test` passes (including fork tests if applicable)
- [ ] **NatSpec added**: New public/external functions have `@notice`/`@param`/`@return`
- [ ] **Storage layout unchanged**: If modifying `wsXmrStorage.sol`, only append new variables — never reorder or insert
- [ ] **JS changes don't break the module graph**: Verify imports resolve (no circular deps, no missing exports)
- [ ] **JSDoc added**: New exported functions have `/** ... */` headers
- [ ] **`.env.example` updated**: If new environment variables were added to the LP server
- [ ] **Sequence diagrams updated**: If protocol flow changed, update `docs/sequenceDiagrams.md`
- [ ] **No secrets committed**: Private keys, mnemonics, RPC URLs with API keys — none in code or commits
- [ ] **Description clear**: PR description explains what changed, why, and how to test

---

## Architecture Resources

- [Root README](README.md) — project overview, deployed contracts, architecture summary
- [Frontend README](frontend/README.md) — module structure, data flow, key concepts
- [LP Server README](lp-server-js/README.md) — API reference, operational runbook
- [Ethereum README](ethereum/README.md) — contract architecture, testing, deployment
- [Sequence Diagrams](docs/sequenceDiagrams.md) — mint, burn, liquidation, yield flows
- [Seed Storage Design](docs/SEED_STORAGE_IMPLEMENTATION.md) — encrypted wallet architecture
