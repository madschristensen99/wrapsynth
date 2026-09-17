# ⛴️ WrapSynth

**A trustless cross-chain ferry for Monero. wsXMR is live in beta on Gnosis Chain, backed by overcollateralized LP vaults and Ed25519 atomic swap commitments. Mainnet launch on Arc scheduled for September 18th.**

🌐 **[wrapsynth.com](https://wrapsynth.com)** · 📊 **[wsXMR/sDAI Pool on Gnosis](https://www.geckoterminal.com/gnosis-chain/pools/0x73ffab40a766c0c6dc557ee53059be11c256bf65)**

WrapSynth brings Monero's anonymity set to DeFi and DeFi liquidity to Monero. Users swap XMR for wsXMR through atomic-swap mechanics enforced on-chain: LPs post sDAI collateral, mint/burn settlement is gated by Ed25519 secret reveals verified on-chain, and timeout-based slashing protects both sides. No custodian, no federation, no trusted intermediary — every swap settles peer-to-peer between a user and an LP vault.

---

## 🚀 Status: Beta on Gnosis Chain — Arc launch September 18th

- ✅ Full hub + facet system deployed and **verified on Gnosisscan** (beta)
- ✅ **wsXMR/sDAI Uniswap V3 pool live** (0.3% fee tier)
- ✅ Complete mint → trade → burn cycle executed end-to-end on mainnet
- ✅ Two rounds of security review completed; all critical findings resolved (see [Security](#-security))
- ✅ 633-line solvency invariant test suite + audit regression suite
- 📅 **Arc mainnet launch: September 18th, 2026**
- 🔄 Solana port in development (`solana/`)

### Deployed Contracts (Gnosis Chain, ChainID 100)

| Contract | Address |
|---|---|
| wsXMR Token | [`0xe23d7210fe278b188144b7708e462c7dd721c436`](https://gnosisscan.io/token/0xe23d7210fe278b188144b7708e462c7dd721c436) |
| wsXmrHub | [`0xd3dac8cf69c2d321bdc1e479d92a1b79cd2228a9`](https://gnosisscan.io/address/0xd3dac8cf69c2d321bdc1e479d92a1b79cd2228a9) |
| Liquidity Router | [`0x9fF795A27567367277B7f6bB0E1b073f89a0C29c`](https://gnosisscan.io/address/0x9fF795A27567367277B7f6bB0E1b073f89a0C29c) |
| wsXMR/sDAI UniV3 Pool | [`0x73ffab40a766c0c6dc557ee53059be11c256bf65`](https://gnosisscan.io/address/0x73ffab40a766c0c6dc557ee53059be11c256bf65) |

<details>
<summary>Facet addresses</summary>

| Facet | Address |
|---|---|
| RedStoneOracleFacet | [`0x584124026dabdc729b9dad408881da36a67057d0`](https://gnosisscan.io/address/0x584124026dabdc729b9dad408881da36a67057d0) |
| VaultFacet | [`0x20fca74c4690c6a09ee0a071d4d38dac8c5bd08a`](https://gnosisscan.io/address/0x20fca74c4690c6a09ee0a071d4d38dac8c5bd08a) |
| MintFacet | [`0x2f6773d8ea59a3e7f2d00fc71fabee3e65ec21c8`](https://gnosisscan.io/address/0x2f6773d8ea59a3e7f2d00fc71fabee3e65ec21c8) |
| BurnFacet | [`0xfe7519758c6caf0db057b8427e5b371a908651d2`](https://gnosisscan.io/address/0xfe7519758c6caf0db057b8427e5b371a908651d2) |
| LiquidationFacet | [`0x45de14afc6c17df6fdc1e67ce1da66cc7222735f`](https://gnosisscan.io/address/0x45de14afc6c17df6fdc1e67ce1da66cc7222735f) |
| YieldFacet | [`0x54b3e8b84643d84825acf8092fb261992e484991`](https://gnosisscan.io/address/0x54b3e8b84643d84825acf8092fb261992e484991) |

Full deployment manifest (external contracts, pool config, LP defaults): [`deployment.json`](./deployment.json)
</details>

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
   (LP vaults) (XMR→wsXMR)(wsXMR→XMR)  Facet     (sDAI yield) (RedStone)
```

### Key components

- **Ed25519 on-chain verification** — atomic swap secrets are Ed25519 scalars; the contract computes `scalarMultBase(secret)` and checks it against the user's commitment, binding settlement to the same key material used on the Monero side
- **sDAI collateral** — LP vaults are denominated in Savings DAI, so idle collateral earns the DSR; **YieldFacet** harvests and accounts for vault yield
- **Co-LP liquidity router** — `wsXMRLiquidityRouter` deploys vault collateral as Uniswap V3 concentrated liquidity paired against user-supplied wsXMR, putting backing capital to work instead of letting it sit idle
- **Oracle facet** — RedStone-style oracle with an off-chain price pusher keeping XMR/USD fresh on-chain
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

1. Create a vault and deposit sDAI via **VaultFacet** (minimum 150% collateral ratio; 180% target)
2. Optionally deploy collateral into the co-LP Uniswap V3 position via the router
3. Run the LP node to serve mint/burn flow automatically
4. Earn mint/burn fees + sDAI yield + LP fees; keep ratio above the 120% liquidation threshold

---

## 🔐 Security

### Review history

The protocol has been through **two rounds of security review**, with all critical and high-severity findings resolved and locked in by regression tests ([`AuditRegressionTest.t.sol`](./ethereum/test/AuditRegressionTest.t.sol)). Notable findings fixed:

- **Delegate-context reentrancy** in the hub dispatch path — closed using EIP-1153 transient-storage context flags
- **Yield harvesting unit mismatch** between sDAI shares and DAI amounts in vault accounting
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

✅ **The live v6.1 Gnosis deployment has executed `lockHub()` / `lockDeployer()`** — the
deployer key can no longer repoint the minter or alter facet routes. Verified on-chain at
deploy time (`hubLocked() == true`, `deployerOperationsLocked() == true`).

### Testing

- [`BurnSolvencyInvariantTest.t.sol`](./ethereum/test/BurnSolvencyInvariantTest.t.sol) — 633-line Foundry invariant suite asserting system solvency across randomized mint/burn/liquidation sequences
- Full lifecycle E2E suites (`E2EFullCycle`, `E2EComprehensive`, `E2EAdvancedScenarios`) plus Hardhat unit suites per facet
- Co-LP fork tests against Gnosis mainnet state (`test/coLP/`)
- Ed25519 compatibility tests against reference vectors

### Honest risk disclosure

⚠️ This is early-stage protocol software. Reviews to date do not eliminate risk:

- No formal verification yet
- Oracle liveness depends on the off-chain price pusher
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
cp .env.example .env   # add PRIVATE_KEY and GNOSIS_RPC_URL

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
├── deployment.json           # Live Gnosis mainnet deployment manifest
├── ethereum/
│   ├── contracts/
│   │   ├── core/             # wsXmrHub, wsXmrStorage
│   │   ├── facets/           # Vault, Mint, Burn, Liquidation, Yield, Oracle
│   │   ├── router/           # wsXMRLiquidityRouter (co-LP UniV3)
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

- ✅ Gnosis mainnet deployment + verified contracts
- ✅ Live wsXMR/sDAI Uniswap V3 pool
- ✅ Co-LP concentrated liquidity router
- 🔄 Solana port (Meteora DLMM liquidity, JitoSOL collateral, Pyth oracle)
- 🔄 Additional LP onboarding + deeper liquidity
- ⏳ Hyperliquid wsXMR/USD market (HIP-3 proposal drafted)
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