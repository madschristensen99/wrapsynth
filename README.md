# ⛴️ WrapSynth

**A trustless cross-chain ferry for Monero. wsXMR is live on HyperEVM (Hyperliquid L1), backed by overcollateralized LP vaults and Ed25519 atomic swap commitments.**

🌐 **[wrapsynth.com](https://wrapsynth.com)** · 📊 **[wsXMR/USDe Pool on DexScreener](https://dexscreener.com/hyperevm/0xfa529dc1b245b3228a172ceb886f47f2127af401)**

WrapSynth brings Monero's anonymity set to DeFi and DeFi liquidity to Monero. Users swap XMR for wsXMR through atomic-swap mechanics enforced on-chain: LPs post USDe collateral (supplied to HyperLend), mint/burn settlement is gated by Ed25519 secret reveals verified on-chain, and timeout-based slashing protects both sides. No custodian, no federation, no trusted intermediary — every swap settles peer-to-peer between a user and an LP vault.

---

## 🚀 Status: Live on HyperEVM

- ✅ Full hub + facet system deployed and **verified on hyperevmscan**
- ✅ **wsXMR/USDe HyperSwap V3 pool live**
- ✅ Complete mint → trade → burn cycle executed end-to-end on mainnet
- ✅ Two rounds of security review completed; all critical findings resolved (see [Security](#-security))
- ✅ 633-line solvency invariant test suite + audit regression suite
-  Solana port in development (`solana/`)

### Deployed Contracts (HyperEVM, ChainID 999)

| Contract | Address |
|---|---|
| wsXMR Token | [`0x25Ed246C3CB273730235A3184aB63aB4DF4f4CF3`](https://hyperevmscan.io/address/0x25Ed246C3CB273730235A3184aB63aB4DF4f4CF3) |
| wsXmrHub | [`0xb901C70F2a49d78c32e88ea1F36290d3F5F21f12`](https://hyperevmscan.io/address/0xb901C70F2a49d78c32e88ea1F36290d3F5F21f12) |
| Liquidity Router | [`0x4619e409c8070042DAC16637F8f883F1C7118aEE`](https://hyperevmscan.io/address/0x4619e409c8070042DAC16637F8f883F1C7118aEE) |
| wsXMR/USDe HyperSwap Pool | [`0xFA529Dc1B245B3228a172CEb886F47F2127AF401`](https://hyperevmscan.io/address/0xFA529Dc1B245B3228a172CEb886F47F2127AF401) |

<details>
<summary>Facet addresses</summary>

| Facet | Address |
|---|---|
| HyperCoreOracleFacet | [`0x2a18BCFf642015E363080072F51DaA34A86A14bD`](https://hyperevmscan.io/address/0x2a18BCFf642015E363080072F51DaA34A86A14bD) |
| VaultFacet | [`0x09444C6Af846b1E9628FDb47ed44185A3f650425`](https://hyperevmscan.io/address/0x09444C6Af846b1E9628FDb47ed44185A3f650425) |
| MintFacet | [`0xfF9D2c2BBd88Ad92ED2Ee5b0CaF3ddFdc7BC6Fee`](https://hyperevmscan.io/address/0xfF9D2c2BBd88Ad92ED2Ee5b0CaF3ddFdc7BC6Fee) |
| BurnFacet | [`0x31D33FF29D147dEf74a5F3959F6302b38aB8bD50`](https://hyperevmscan.io/address/0x31D33FF29D147dEf74a5F3959F6302b38aB8bD50) |
| LiquidationFacet | [`0xfFc6F0F8d5ed6010532EE95646115E0118BAa144`](https://hyperevmscan.io/address/0xfFc6F0F8d5ed6010532EE95646115E0118BAa144) |
| YieldFacet | [`0x8D7DD0A1FD26A2602837B028afB7A1f1b21DA9E7`](https://hyperevmscan.io/address/0x8D7DD0A1FD26A2602837B028afB7A1f1b21DA9E7) |

Full deployment manifest (external contracts, pool config, LP defaults): [`deployment.json`](./deployment.json) · HyperEVM manifest: [`ethereum/deployments/hyperevm-deployment.json`](./ethereum/deployments/hyperevm-deployment.json)
</details>

> Prior beta deployment on Gnosis Chain (ChainID 100) is preserved in [`frontend/deployment.gnosis.json`](./frontend/deployment.gnosis.json).

---

## 🏗️ Architecture

### Hub + Facet (Diamond-style)

All protocol state and collateral live in a single contract, **wsXmrHub**, which dispatches calls to stateless logic facets via a selector → facet table:

- The Hub owns all state (`wsXmrStorage`), holds all collateral, and is the only address authorized to mint/burn wsXMR
- Facets contain logic only and access state through the Hub; only registered facets can mutate state
- Delegate-context is tracked with **EIP-1153 transient storage**, preventing facet logic from being invoked outside the hub's dispatch path

```
                      ┌────────────────────────────┐
                      │         wsXmrHub           │
                      │  state · collateral · token │
                      │  selector → facet dispatch  │
                      └──────────┬─────────────────┘
        ┌──────────┬─────────┬──┴──────┬───────────┬──────────┐
   VaultFacet  MintFacet  BurnFacet  Liquidation  YieldFacet  OracleFacet
   (LP vaults) (XMR→wsXMR)(wsXMR→XMR)  Facet   (USDe yield)(HyperCore)
```

### Key components

- **Ed25519 on-chain verification** — atomic swap secrets are Ed25519 scalars; the contract computes `scalarMultBase(secret)` and checks it against the user's commitment, binding settlement to the same key material used on the Monero side
- **USDe collateral** — LP vaults are denominated in USDe supplied to HyperLend (Aave v3.6 fork), so idle collateral earns supply APY; **YieldFacet** harvests and accounts for vault yield
- **Co-LP liquidity router** — `wsXMRLiquidityRouter` deploys vault collateral as HyperSwap V3 concentrated liquidity paired against user-supplied wsXMR, putting backing capital to work instead of letting it sit idle
- **Oracle facet** — `HyperCoreOracleFacet` reads the native XMR perp's `oraclePx` via the L1-read precompile — validator-maintained, no off-chain price pusher
- **LP node** (`ethereum/lp-node/`, Rust) — monitors events, manages Monero RPC, prices quotes, runs arbitrage, and exposes a REST API for the frontend

---

## 📖 How It Works

### Minting (XMR → wsXMR)

1. **`initiateMint`** — user posts a claim commitment (Ed25519 point) and griefing deposit; the LP vault's capacity is reserved
2. User sends XMR to the LP's Monero address
3. **`setMintReady`** — LP confirms XMR receipt on-chain
4. **`revealSecret`** + **`finalizeMint`** — user reveals the secret scalar; the contract verifies `scalarMultBase(secret)` matches the commitment, then anyone calls `finalizeMint` to mint wsXMR and refund the deposit

### Burning (wsXMR → XMR)

1. **`requestBurn`** — user locks wsXMR and posts a hash commitment with their Monero destination; LP collateral is reserved against the burn and a deadline starts
2. **`confirmMoneroLock`** — LP signals the XMR payment is underway
3. LP sends XMR; **`finalizeBurn`** settles with the secret reveal, burning the wsXMR and releasing the LP's collateral
4. Escape hatches:
   - **`abortBurn`** — clean unwind before settlement, returning wsXMR to the user
   - **`forceSettleBurn`** / **`claimSlashedCollateral`** — if the LP misses the deadline, the user seizes collateral at oracle price; bad outcomes hit the responsible vault, not the system

### For Liquidity Providers

1. Create a vault and deposit USDe via **VaultFacet** (minimum 150% collateral ratio; 180% target)
2. Optionally deploy collateral into the co-LP HyperSwap V3 position via the router
3. Run the LP node to serve mint/burn flow automatically
4. Earn mint/burn fees + USDe yield + LP fees; keep ratio above the 120% liquidation threshold

---

## 🔐 Security

### Review history

The protocol has been through **two rounds of security review**, with all critical and high-severity findings resolved and locked in by regression tests ([`AuditRegressionTest.t.sol`](./ethereum/test/AuditRegressionTest.t.sol)). Notable findings fixed:

- **Delegate-context reentrancy** in the hub dispatch path — closed using EIP-1153 transient-storage context flags
- **Yield harvesting unit mismatch** between collateral shares and underlying amounts in vault accounting
- **Inverted bad-debt socialization** logic in liquidation flow
- **Burn flow redesign** — the original single-path burn was replaced with the `requestBurn` / `abortBurn` / `forceSettleBurn` state machine to remove griefing and stuck-funds paths
- **Open-ended deployer privileges** — the hub/token deployer held two permanent admin hooks
  (`wsXMR.replaceHub()`, `wsXmrHub.addSelectors()` / `removeSelectors()`) that could repoint the
  token at an arbitrary minter or add/brick facet routes at any time after launch. Both are now
  closed by a **one-way `lockHub()` / `lockDeployer()`** pair that the deployment script calls as
  its final step, so the admin key is permanently powerless once setup completes.

### Admin surface

| Power | Holder | Reachable after `lockDeployer()` / `lockHub()` |
|---|---|---|
| `registerFacets` | hub `deployer` | ❌ no (and already one-time) |
| `addSelectors` / `removeSelectors` | hub `deployer` | ❌ no |
| `setLiquidityRouter` | hub `deployer` | ❌ no |
| `setPriceUpdater` (oracle) | hub `deployer` | ❌ no |
| `wsXMR.replaceHub` / `setHub` | token `_deployer` | ❌ no |
| `updatePrices` | `priceUpdater` only | ✅ yes (required for oracle liveness) |

✅ **The live HyperEVM deployment has executed `lockHub()` / `lockDeployer()`** — the
deployer key can no longer repoint the minter or alter facet routes. Verified on-chain at
deploy time (`hubLocked() == true`, `deployerOperationsLocked() == true`).

### Testing

- [`BurnSolvencyInvariantTest.t.sol`](./ethereum/test/BurnSolvencyInvariantTest.t.sol) — 633-line Foundry invariant suite asserting system solvency across randomized mint/burn/liquidation sequences
- Full lifecycle E2E suites (`E2EFullCycle`, `E2EComprehensive`, `E2EAdvancedScenarios`) plus Hardhat unit suites per facet
- Co-LP fork tests against HyperEVM mainnet state (`test/coLP/`)
- Ed25519 compatibility tests against reference vectors

### Honest risk disclosure

⚠️ This is early-stage protocol software. Reviews to date do not eliminate risk:

- No formal verification yet
- Oracle reads the native XMR perp via L1-read precompile (validator-maintained; no off-chain pusher)
- LP-side Monero payment confirmation is an off-chain step; the protocol's protection is economic (collateral slashing), not cryptographic proof of XMR transfer
- Use amounts you can afford to lose

---

## 🛠️ Development

### Prerequisites

Node.js v18+, Foundry, Rust (for the LP node), Hardhat (via npm).

```bash
git clone https://github.com/madschristensen99/wrapsynth.git
cd wrapsynth/ethereum
npm install
cp .env.example .env   # add PRIVATE_KEY and RPC_URL (HyperEVM: https://rpc.hyperliquid.xyz/evm)

# Compile + test
npx hardhat compile
npm test               # Hardhat suites
forge test             # Foundry invariant + E2E suites
```

### Run the LP node

```bash
cd ethereum/lp-node
cargo build --release
cargo run --release -- --config config.toml
```

### Solana (in development)

```bash
cd solana/anchor-program
anchor build && anchor test
```

---

## 📁 Repo Layout

```
wrapsynth/
├── deployment.json           # Live HyperEVM mainnet deployment manifest
├── ethereum/
│   ├── contracts/
│   │   ├── core/             # wsXmrHub, wsXmrStorage
│   │   ├── facets/           # Vault, Mint, Burn, Liquidation, Yield, Oracle
│   │   ├── router/           # wsXMRLiquidityRouter (co-LP HyperSwap V3)
│   │   ├── Ed25519.sol       # On-chain Ed25519 scalar mult
│   │   └── wsXMR.sol         # ERC-20 (8 decimals, matching XMR)
│   ├── test/                 # Foundry invariant/E2E + Hardhat suites
│   └── lp-node/              # Rust LP node (events, Monero RPC, quotes, API)
├── solana/anchor-program/    # Solana port (Anchor)
├── frontend/                 # Web app
└── docs/                     # Sequence diagrams, seed storage design
```

---

## 🔮 Roadmap

- ✅ HyperEVM mainnet deployment + verified contracts
- ✅ Live wsXMR/USDe HyperSwap V3 pool
- ✅ Co-LP concentrated liquidity router
- ✅ Gnosis beta deployment (superseded)
- 🔄 Solana port (Meteora DLMM liquidity, JitoSOL collateral, Pyth oracle)
- 🔄 Additional LP onboarding + deeper liquidity
- ⏳ HIP-1 wsXMR/USDC on HyperCore CLOB + HIP-3 wsXMR/USD perp
- ⏳ Third-party audit + bug bounty ahead of broader scaling
- ⏳ Multi-chain expansion

---

## 📚 Documentation

- [Sequence diagrams](./docs/sequenceDiagrams.md) — mint/burn/liquidation flows
- [Seed storage design](./docs/SEED_STORAGE_IMPLEMENTATION.md)
- [LP node README](./ethereum/lp-node/)
- [Solana program](./solana/anchor-program/)

---

## ⚠️ Disclaimer

Experimental protocol software provided "as is." It has undergone security review but not formal third-party audit certification or formal verification. The developers assume no liability for losses. Interact at your own risk.

## � Donations

If you find WrapSynth useful, consider supporting the project:

**XMR:** `83PvXnBHDNmN4TtRdKXMr4Vq1uHerTthZDRjrTG4hMUyeLSd7pNYwM31eCmDdX9D3F61FsdA2XvTmT92eQzqWFwR9CJ4gb8`

---

## �📄 License

MIT

---

Built with ❤️ for privacy and decentralization