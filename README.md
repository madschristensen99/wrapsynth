# ⛴️ WrapSynth

**A trustless cross-chain ferry for Monero. wsXMR deploys per-chain on BNB Chain (QQQB collateral), Base (cbBTC), and Robinhood Chain (SPY), backed by overcollateralized LP vaults and Ed25519 atomic swap commitments — one interface, pick your chain.**

🌐 **[wrapsynth.com](https://wrapsynth.com)**

WrapSynth brings Monero's anonymity set to DeFi and DeFi liquidity to Monero. Users swap XMR for wsXMR through atomic-swap mechanics enforced on-chain: LPs post collateral (the collateral asset is per-deployment — see [Roadmap](#-roadmap)), mint/burn settlement is gated by Ed25519 secret reveals verified on-chain, and timeout-based slashing protects both sides. No custodian, no federation, no trusted intermediary — every swap settles peer-to-peer between a user and an LP vault. Each chain runs an independent wsXMR deployment; there is no bridging between them.

---

## 🚀 Status: Multi-chain rollout in progress

- ✅ **Live on BNB Chain** — deployed, verified on BscScan, and exercised end-to-end on mainnet (mint → co-LP → pool swap → burn)
- ✅ **Live on Base** — deployed, verified on BaseScan, and exercised end-to-end on mainnet (mint → burn → co-LP open/unwind → pool swaps)
- ✅ **Live on Robinhood Chain** — deployed, verified on robin.etherscan.io, and exercised end-to-end on mainnet (mint → burn → co-LP open/unwind → pool swaps)
- ✅ Complete mint → trade → burn cycle executed end-to-end on mainnet (former HyperEVM deployment)
- ✅ Two rounds of security review completed; all critical findings resolved (see [Security](#-security))
- ✅ 633-line solvency invariant test suite + audit regression suite, replicated per chain (~900 fork tests)
-  Solana port in development (`solana/`)

### Live: BNB Chain (ChainID 56)

Deployed at block `128040249`. All contracts verified on BscScan; deployer powers permanently locked (`deployerOperationsLocked` / `hubLocked` verified on-chain).

| Contract | Address |
|---|---|
| wsXMR Token | [`0x9B8d1851bCc06ac265c1c1ACaBD0F71E69DD312c`](https://bscscan.com/address/0x9B8d1851bCc06ac265c1c1ACaBD0F71E69DD312c) |
| wsXmrHub | [`0x15bb9ba8236De055090a262F45a7e213F6040320`](https://bscscan.com/address/0x15bb9ba8236De055090a262F45a7e213F6040320) |
| Liquidity Router | [`0x1034259f355566fcE4571F792d239a99BBa1b9b4`](https://bscscan.com/address/0x1034259f355566fcE4571F792d239a99BBa1b9b4) |
| StataQQQB (collateral share token) | [`0xd821A7D919e007b6b39925f672f1219dB4865Fba`](https://bscscan.com/address/0xd821A7D919e007b6b39925f672f1219dB4865Fba) |
| wsXMR/QQQB PancakeSwap V3 Pool (0.05%) | [`0x9711698489150C9Fbc377C7d5aBC735D6198A845`](https://bscscan.com/address/0x9711698489150C9Fbc377C7d5aBC735D6198A845) |

<details>
<summary>Facet addresses</summary>

| Facet | Address |
|---|---|
| BnbOracleFacet | [`0xb694120Ecdc69fbbEe3Ae21831d7B76ab8a9169B`](https://bscscan.com/address/0xb694120Ecdc69fbbEe3Ae21831d7B76ab8a9169B) |
| VaultFacet | [`0x6ABAEB70c9BA9EA497Ff5e20D08bd20Ca1E02139`](https://bscscan.com/address/0x6ABAEB70c9BA9EA497Ff5e20D08bd20Ca1E02139) |
| MintFacet | [`0xb6251797386a8C5a2a4A8783f430Ef2ED5c63BeF`](https://bscscan.com/address/0xb6251797386a8C5a2a4A8783f430Ef2ED5c63BeF) |
| BurnFacet | [`0xCE92E887d225D06c21a16d845D88E980d536FA2b`](https://bscscan.com/address/0xCE92E887d225D06c21a16d845D88E980d536FA2b) |
| LiquidationFacet | [`0xd6Ee29f9ae035aDB0f2741228eD55F0fC6dBb6c2`](https://bscscan.com/address/0xd6Ee29f9ae035aDB0f2741228eD55F0fC6dBb6c2) |
| BnbYieldFacet | [`0xD1f77F73Ca47a726875D884cc45EFf289f6176E3`](https://bscscan.com/address/0xD1f77F73Ca47a726875D884cc45EFf289f6176E3) |
| CoLPFacet | [`0x8e3EF1e28262E351EB066374df1bEd36CC704dDA`](https://bscscan.com/address/0x8e3EF1e28262E351EB066374df1bEd36CC704dDA) |

Machine-readable manifest: [`frontend/deployment.bnb.json`](./frontend/deployment.bnb.json) · [`ethereum/deployments/bnb-deployment.json`](./ethereum/deployments/bnb-deployment.json)
</details>

### Live: Base (ChainID 8453)

Deployed at block `52775153`. All contracts verified on BaseScan; deployer powers permanently locked. Exercised end-to-end on mainnet: mint → burn round-trip, co-LP open + unwind (position `6297447` left live seeding the pool), and swaps through Uniswap SwapRouter02. Collateral is **cbBTC**; the vault is funded and active.

| Contract | Address |
|---|---|
| wsXMR Token | [`0x9E50B436901A573DC4f0676150B282135f0C0623`](https://basescan.org/address/0x9E50B436901A573DC4f0676150B282135f0C0623) |
| wsXmrHub | [`0xF22f1550829E1413f1bc538Be419071728DD53b8`](https://basescan.org/address/0xF22f1550829E1413f1bc538Be419071728DD53b8) |
| Liquidity Router | [`0x53E46B60D79d33D031A0e222029A382146d5a15F`](https://basescan.org/address/0x53E46B60D79d33D031A0e222029A382146d5a15F) |
| StataCbBTC (collateral share token) | [`0x64f05A6c0E19Fe7Ae76Ca88740D63EA069A5CA28`](https://basescan.org/address/0x64f05A6c0E19Fe7Ae76Ca88740D63EA069A5CA28) |
| wsXMR/cbBTC Uniswap V3 Pool (0.05%) | [`0xEac27935Dc31AF9215822505174404c38c5A3FEc`](https://basescan.org/address/0xEac27935Dc31AF9215822505174404c38c5A3FEc) |
| Ed25519Helper | [`0xA1b9115450c3e3dCAD11c04Cf9Bf4092335B3A64`](https://basescan.org/address/0xA1b9115450c3e3dCAD11c04Cf9Bf4092335B3A64) |
| SwapHelper | [`0x313166bb40927D94e969c51Af227bc22F30df6D2`](https://basescan.org/address/0x313166bb40927D94e969c51Af227bc22F30df6D2) |

<details>
<summary>Facet addresses</summary>

| Facet | Address |
|---|---|
| BaseOracleFacet | [`0x147F829Fa732811A0f54E50310eCB71218B4511a`](https://basescan.org/address/0x147F829Fa732811A0f54E50310eCB71218B4511a) |
| VaultFacet | [`0x97166ED3478759199442BFc6570F386884b4917B`](https://basescan.org/address/0x97166ED3478759199442BFc6570F386884b4917B) |
| MintFacet | [`0xBfCDA75903920cDe32F0B17eD1a57974Bab4bc66`](https://basescan.org/address/0xBfCDA75903920cDe32F0B17eD1a57974Bab4bc66) |
| BurnFacet | [`0xAa32790EF174Db5457AdF7c268fEa4Bc527eB140`](https://basescan.org/address/0xAa32790EF174Db5457AdF7c268fEa4Bc527eB140) |
| LiquidationFacet | [`0x7c7BD2D57Db2C08F39d3050fabC002593183fF69`](https://basescan.org/address/0x7c7BD2D57Db2C08F39d3050fabC002593183fF69) |
| YieldFacet | [`0xF1fBBb13004410dCA48360872004870B6C85a214`](https://basescan.org/address/0xF1fBBb13004410dCA48360872004870B6C85a214) |
| CoLPFacet | [`0xA6b4F4Ea557e2f7F2f23F32EDA9D17aB7F48dd49`](https://basescan.org/address/0xA6b4F4Ea557e2f7F2f23F32EDA9D17aB7F48dd49) |

Machine-readable manifest: [`frontend/deployment.base.json`](./frontend/deployment.base.json) · [`ethereum/deployments/base-deployment.json`](./ethereum/deployments/base-deployment.json)
</details>

### Deprecated: former HyperEVM deployment (ChainID 999)

> HyperEVM is deprecated. The contracts remain live and immutable on-chain
> (deployer powers were permanently locked at launch), but it is no longer a
> supported venue and is not selectable in the frontend. Deeper Hyperliquid
> integration (CLOB listing, HIP-3 perps) is deferred — see
> [docs/HYPERLIQUID_RISKS.md](./docs/HYPERLIQUID_RISKS.md) for the risk
> analysis behind that decision.

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
        ┌──────────┬─────────┬──┴──────┬───────────┬──────────┬─────────┐
   VaultFacet  MintFacet  BurnFacet  Liquidation  YieldFacet  OracleFacet  CoLPFacet
   (LP vaults) (XMR→wsXMR)(wsXMR→XMR)  Facet  (per-chain) (RedStone + TWAP) (co-LP)
```

### Key components

- **Ed25519 on-chain verification** — atomic swap secrets are Ed25519 scalars; the contract computes `scalarMultBase(secret)` and checks it against the user's commitment, binding settlement to the same key material used on the Monero side
- **Per-chain collateral** — LP vaults are denominated in the chain's collateral asset (QQQB on BNB, cbBTC on Base, SPY on Robinhood) through a `Stata*` share adapter; **YieldFacet** harvests and accounts for vault yield
- **Co-LP liquidity router** — `wsXMRLiquidityRouter` deploys vault collateral as V3 concentrated liquidity (PancakeSwap on BNB, Uniswap on Base/Robinhood) paired against user-supplied wsXMR, putting backing capital to work instead of letting it sit idle
- **Oracle facet** — per-chain oracle facets read XMR/USD from RedStone signed calldata and compute the collateral price fully on-chain from V3 TWAP pools; the only external input is a signed XMR price
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

1. Create a vault and deposit the chain's collateral asset via **VaultFacet** (minimum 150% collateral ratio; 180% target)
2. Optionally deploy collateral into the co-LP V3 position via the router
3. Run the LP node to serve mint/burn flow automatically
4. Earn mint/burn fees + collateral yield + LP fees; keep ratio above the 120% liquidation threshold

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
| `addFacet` (non-core facets e.g. CoLPFacet) | hub `deployer` | ❌ no |
| `addSelectors` / `removeSelectors` | hub `deployer` | ❌ no |
| `setLiquidityRouter` | hub `deployer` | ❌ no |
| `setPriceUpdater` (oracle) | hub `deployer` | ❌ no |
| `wsXMR.replaceHub` / `setHub` | token `_deployer` | ❌ no |
| `updatePrices` | `priceUpdater` only | ✅ yes (required for oracle liveness) |

✅ **Every deployment executes `lockHub()` / `lockDeployer()` as its final step** — the
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
- XMR/USD comes from RedStone signed calldata pushed by callers/LP; collateral price is computed on-chain from a V3 TWAP pool — a stale XMR push or a shallow TWAP pool are the main oracle risks
- LP-side Monero payment confirmation is an off-chain step; the protocol's protection is economic (collateral slashing), not cryptographic proof of XMR transfer
- **LP liveness is assumed.** Only the LP can attest a Monero deposit (`setMintReady`) or release a user's XMR from the shared 2-of-2 address (by revealing `lpSecret`). After a mint timeout the LP has `LP_CLAIM_WINDOW_BLOCKS` (~1 hour at the deployment's block time) to reveal; a live LP always will — it earns the parked griefing deposit and loses nothing. If the LP is unresponsive past the window, the key bond is slashed to the user (`reclaimParkedDeposit` / `sweepUnclaimedExpiredMint`). This means an LP outage longer than the window forfeits the bond even for mints where the user never sent XMR — the chain cannot distinguish a real deposit from a phantom one
- Use amounts you can afford to lose

---

## 🛠️ Development

### Prerequisites

Node.js v18+, Foundry, Rust (for the LP node), Hardhat (via npm).

```bash
git clone https://github.com/madschristensen99/wrapsynth.git
cd wrapsynth/ethereum
npm install
cp .env.example .env   # add PRIVATE_KEY and per-chain RPC URLs (BNB_RPC_URL, BASE_RPC_URL, ROBINHOOD_RPC_URL)

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
├── deployment.json           # Per-chain deployment manifests (bnb / base / robinhood)
├── ethereum/
│   ├── contracts/
│   │   ├── core/             # wsXmrHub, wsXmrStorage
│   │   ├── facets/           # Vault, Mint, Burn, Liquidation, Yield, Oracle
│   │   ├── router/           # wsXMRLiquidityRouter (co-LP V3)
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

The strategy is parallel collateral experiments across chains — deploy everywhere, let the market decide which venues get traction. Each deployment pairs wsXMR with a different collateral asset, spanning the censorship-resistance spectrum from native gas tokens to issuer-custodied tokenized equities.

| Chain | Collateral | Collateral type | Status |
|---|---|---|---|
| BNB Chain | QQQB (bStocks tokenized Nasdaq) | Tokenized equity | ✅ **Live** — deployed, verified, end-to-end tested on mainnet |
| Base | cbBTC (Coinbase Wrapped BTC) | Custodial wrapped asset | ✅ **Live** — deployed, verified, end-to-end tested on mainnet |
| Robinhood Chain | SPY (Robinhood tokenized S&P 500) | Tokenized equity | ✅ **Live** — deployed, verified, end-to-end tested on mainnet |
| Solana | Native SOL | Maximal censorship resistance — no issuer | 🔄 In development |
| HyperEVM | sUSDe (HyperLend) | Yield-bearing stablecoin | ⛔ Deprecated — see [Hyperliquid risks](./docs/HYPERLIQUID_RISKS.md) |
| Gnosis | sDAI | Yield-bearing stablecoin | ⛔ Beta (superseded) |

- 🔄 Additional LP onboarding + deeper liquidity
- ⏳ Third-party audit + bug bounty ahead of broader scaling

The oracle model minimizes external dependencies: XMR/USD comes from RedStone signed calldata, and collateral prices are computed fully on-chain from V3 TWAP pools — no second oracle provider per deployment. (The deprecated HyperEVM build read a native perp precompile instead; see [Hyperliquid risks](./docs/HYPERLIQUID_RISKS.md).)

---

## 📚 Documentation

- [Funding guide](./docs/FUNDING.md) — what assets each chain needs and where to get them
- [Sequence diagrams](./docs/sequenceDiagrams.md) — mint/burn/liquidation flows
- [Hyperliquid integration risks](./docs/HYPERLIQUID_RISKS.md) — why HyperEVM is deprecated and what deeper perp integration would require
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