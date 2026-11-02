# ⛴️ WrapSynth

**A trustless cross-chain ferry for Monero. wsXMR deploys per-chain on BNB Chain (QQQB collateral), Base (cbBTC), and Robinhood Chain (SPY), backed by overcollateralized LP vaults and Ed25519 atomic swap commitments — one interface, pick your chain.**

🌐 **[wrapsynth.com](https://wrapsynth.com)**

WrapSynth brings Monero's anonymity set to DeFi and DeFi liquidity to Monero. Users swap XMR for wsXMR through atomic-swap mechanics enforced on-chain: LPs post collateral (the collateral asset is per-deployment — see [Roadmap](#-roadmap)), mint/burn settlement is gated by Ed25519 secret reveals verified on-chain, and timeout-based slashing protects both sides. No custodian, no federation, no trusted intermediary — every swap settles peer-to-peer between a user and an LP vault. Each chain runs an independent wsXMR deployment; there is no bridging between them.

**The protocol is oracle-free.** No price feed is read by any protocol function — no RedStone, no Pyth, no oracle precompiles, no TWAP. Each LP declares a collateralization threshold (normalized collateral per wsXMR) that bounds their vault's mint capacity, defines par settlement terms for mints and burns, and marks their vault's own solvency line. Collateral checks, mint capacity, and insolvency resolution are threshold-relative, not market-price-relative.

---

## 🚀 Status: Oracle-free migration — redeployment in progress

- ✅ **Oracle-free rewrite complete** — contracts, tests, deployment tooling, LP server, and frontend ported to threshold-relative accounting
- ✅ Base suite: **210/210 tests passing** on local Anvil fork
- ✅ BNB suite: **209/209 tests passing** (202 mock + 7 real-fork) on local Anvil fork
- ✅ Robinhood suite compiled — requires a reachable `ROBINHOOD_RPC_URL` to execute
- 🔄 Fresh deployments pending for BNB, Base, and Robinhood
- 🔄 Solana port in development (`solana/`)

### Why oracle-free

- RedStone public pull gateways are being sunset; Pyth Hermes requires a paid key
- Third-party XMR feeds are a censorship and availability liability for a privacy protocol
- Protocol correctness — collateral checks, mint capacity, burns, transaction gating — must not depend on external prices

Market prices still exist where they belong: negotiated counterparty terms, LP-declared thresholds, market-discovered auction settlement, and display-only frontend values.

### Deployment manifests

Per-chain manifests live at `frontend/deployment.<chain>.json` and `ethereum/deployments/<chain>-deployment.json` after each `forge script` deploy run. See [`ethereum/README.md`](./ethereum/README.md) for deploy instructions.

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
        ┌──────────┬─────────┬──┴──────┬──────────────┬─────────┐
   VaultFacet  MintFacet  BurnFacet  LiquidationAuction  CoLPFacet
   (LP vaults) (XMR→wsXMR)(wsXMR→XMR)   Facet (kick +   (co-LP)
                                       Dutch auction)
```

### Key components

- **Ed25519 on-chain verification** — atomic swap secrets are Ed25519 scalars; the contract computes `scalarMultBase(secret)` and checks it against the user's commitment, binding settlement to the same key material used on the Monero side
- **Per-chain collateral** — LP vaults hold the chain's collateral asset raw (QQQB on BNB, cbBTC on Base, SPY on Robinhood), normalized to 18-decimal units at the contract boundary. No share tokens, no yield wrappers, no `convertToAssets`
- **LP-declared threshold** — `thresholdSharesPerWsxmr` is the vault's own declared exchange rate: normalized collateral per 1e8 wsXMR. Par settlement is `wsxmr × threshold / 1e8`. It bounds mint capacity, defines burn redemption, and is the vault's solvency line
- **Bonded kick + Dutch haircut auction** — replaces oracle-triggered liquidation. Anyone can `kick()` a vault they believe is insolvent by posting a bond; the LP gets a grace window to cancel via deposit/repay (wrongful kicks pay the bond to the LP). If uncancelled, a Dutch auction offers the vault's collateral at a haircut decaying 100% → 5%; `bid()` pays the full debt and takes X(t)% of the collateral. No-bid vaults freeze rather than drain; `reauction`/`backstopVault` are the rescue paths
- **Co-LP liquidity router** — `wsXMRLiquidityRouter` deploys vault collateral as V3 concentrated liquidity (PancakeSwap on BNB, Uniswap on Base/Robinhood) paired against user-supplied wsXMR at negotiated amounts. Pool `slot0` drives range mechanics — no external price input
- **LP server** (`lp-server-js/`) — monitors events, manages Monero RPC, finalizes mints/burns, and watches for kicks on its own vault (with optional seeded bidding)

---

## 📖 How It Works

### Minting (XMR → wsXMR)

1. **`initiateMint`** — user posts a claim commitment (Ed25519 point) and griefing deposit; capacity is checked against the vault's declared threshold (`(debt + pending + mint) × threshold ≤ free collateral`)
2. User sends XMR to the LP's shared Monero address
3. **`setMintReady`** — LP confirms XMR receipt on-chain; the vault's key bond locks at `par × 110%` (par = amount × threshold snapshot `thresholdAtReady`)
4. **`finalizeMint`** — user reveals the secret scalar; the contract verifies `scalarMultBase(secret)` matches the commitment, mints wsXMR (minus the LP's mint fee), and refunds the deposit

### Burning (wsXMR → XMR)

1. **`requestBurn`** — user locks wsXMR and posts a hash commitment with their Monero destination; the vault locks proportional par collateral at its threshold (~1.3× free × wsxmr/debt cap) plus the burn reward, and a deadline starts
2. **`commitBurn`** — LP signals the XMR payment is underway
3. LP sends XMR; **`finalizeBurn`** settles with the secret reveal, burning the wsXMR and releasing collateral at par (`thresholdAtRequest`)
4. Escape hatches:
   - **`abortBurn`** — clean unwind before settlement, returning wsXMR to the user
   - **`claimSlashedCollateral`** / **`forceSettleBurn`** — if the LP misses the deadline, the user seizes the locked collateral at the threshold locked at request time

### Liquidation (no oracle)

- **`kick(vault)`** — anyone posts a bond to declare a vault insolvent. During `GRACE`, any `depositCollateral` or `repayDebt` by the LP cancels the kick and pays the kicker's bond to the LP
- **`openAuction(vault)`** — after grace (and a bid-lock delay), in-flight burns settle and co-LP positions unwind so the offered collateral is clean; the Dutch haircut X(t) starts at 100% and decays to 5%
- **`bid(vault)`** — bidder pays the vault's full wsXMR debt and receives X(t)% of the offered collateral. A clearing X* ≤ 80% proves the kick was wrongful — the kicker's bond goes to the LP
- **No bid** — the vault freezes (never drains). `reauction` can retry price discovery once; `backstopVault` lets a healthy LP assume the debt + collateral as the manual escape

### For Liquidity Providers

1. Create a vault and deposit the chain's collateral asset via **VaultFacet**
2. Set the vault's terms: `setThreshold` (collateral per wsXMR — your solvency line and settlement par), `setMaxMintWsxmr` (optional cap), `setVaultMarketMetrics` (mint fee / burn reward bps)
3. Optionally deploy collateral into the co-LP V3 position via the router
4. Run the LP server to serve mint/burn flow automatically — including the kick watcher that alerts (or auto-cancels during grace) if your vault is kicked
5. Keep free collateral comfortably above `(debt + pending) × threshold` — that is your solvency line

---

## 🔐 Security

### Review history

The protocol has been through **two rounds of security review**, with all critical and high-severity findings resolved and locked in by regression tests (`BaseAuditRegressionTest.t.sol` and per-chain replicas). Notable findings fixed:

- **Delegate-context reentrancy** in the hub dispatch path — closed using EIP-1153 transient-storage context flags
- **Inverted bad-debt socialization** logic in the liquidation flow (now: bad debt is absorbed by the auction bidder's discount, never socialized)
- **Burn flow redesign** — the original single-path burn was replaced with the `requestBurn` / `abortBurn` / `claimSlashedCollateral` state machine to remove griefing and stuck-funds paths
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
| `setLiquidityRouter` / `setExternalAddresses` | hub `deployer` | ❌ no |
| `wsXMR.replaceHub` / `setHub` | token `_deployer` | ❌ no |

✅ **Every deployment executes `lockHub()` / `lockDeployer()` as its final step** — the
deployer key can no longer repoint the minter or alter facet routes. There is no oracle
updater key — there is no oracle.

### Testing

- Per-chain Foundry suites (`test/Base*.t.sol`, `test/Bnb*.t.sol`, `test/Robin*.t.sol`) — mock-collateral unit/integration suites plus real-collateral fork suites
- `*AuditRegressionTest.t.sol` — security regression tests including the ported kick→auction bad-debt path
- `*MintBurnCoverage`, `*VaultFacetCoverage`, `*SecurityGuardTest`, `*ForkTest` — full lifecycle, timeouts, slashing, auctions
- Co-LP fork tests against BNB Chain mainnet state (`test/`)

### Honest risk disclosure

⚠️ This is early-stage protocol software. Reviews to date do not eliminate risk:

- No formal verification yet
- LP-declared thresholds are the protocol's only "price" — an LP who misprices their threshold can over-commit their vault; the auction system resolves it, but settlement happens at their declared terms
- LP-side Monero payment confirmation is an off-chain step; the protocol's protection is economic (collateral slashing), not cryptographic proof of XMR transfer
- **LP liveness is assumed.** Only the LP can attest a Monero deposit (`setMintReady`) or release a user's XMR from the shared 2-of-2 address (by revealing `lpSecret`). After a mint timeout the LP has `LP_CLAIM_WINDOW_BLOCKS` (~1 hour at the deployment's block time) to reveal; a live LP always will — it earns the parked griefing deposit and loses nothing. If the LP is unresponsive past the window, the key bond is slashed to the user (`reclaimParkedDeposit` / `sweepUnclaimedExpiredMint`). This means an LP outage longer than the window forfeits the bond even for mints where the user never sent XMR — the chain cannot distinguish a real deposit from a phantom one
- Use amounts you can afford to lose

---

## 🛠️ Development

### Prerequisites

Node.js v18+, Foundry.

```bash
git clone https://github.com/madschristensen99/wrapsynth.git
cd wrapsynth/ethereum
npm install
cp .env.example .env   # add PRIVATE_KEY and per-chain RPC URLs (BNB_RPC_URL, BASE_RPC_URL, ROBINHOOD_RPC_URL)

# Compile + test
forge build
forge test --fork-url $BASE_RPC_URL   # per-chain suite
```

### Run the LP server

```bash
cd lp-server-js
npm install
node server.js   # see README for config
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
├── ethereum/
│   ├── contracts/
│   │   ├── core/             # wsXmrHub, wsXmrStorage
│   │   ├── facets/           # Vault, Mint, Burn, LiquidationAuction, CoLP
│   │   ├── router/           # wsXMRLiquidityRouter (co-LP V3)
│   │   ├── Ed25519.sol       # On-chain Ed25519 scalar mult
│   │   └── wsXMR.sol         # ERC-20 (8 decimals, matching XMR)
│   ├── script/               # Deploy{Bnb,Base,Robinhood}.s.sol
│   ├── scripts/              # Operational JS (deployAndTestAll, testFullCycle*, …)
│   └── test/                 # Per-chain Foundry suites
├── lp-server-js/             # LP automation (mints, burns, kick watcher)
├── solana/anchor-program/    # Solana port (Anchor)
├── frontend/                 # Web app
└── docs/                     # Migration spec, auction design, funding guide
```

---

## 🔮 Roadmap

The strategy is parallel collateral experiments across chains — deploy everywhere, let the market decide which venues get traction. Each deployment pairs wsXMR with a different collateral asset, spanning the censorship-resistance spectrum from native gas tokens to issuer-custodied tokenized equities.

| Chain | Collateral | Collateral type | Status |
|---|---|---|---|
| BNB Chain | QQQB (bStocks tokenized Nasdaq) | Tokenized equity | 🔄 Redeploying (oracle-free) |
| Base | cbBTC (Coinbase Wrapped BTC) | Custodial wrapped asset | 🔄 Redeploying (oracle-free) |
| Robinhood Chain | SPY (Robinhood tokenized S&P 500) | Tokenized equity | 🔄 Redeploying (oracle-free) |
| Solana | Native SOL | Maximal censorship resistance — no issuer | 🔄 In development |
| HyperEVM | sUSDe (HyperLend) | Yield-bearing stablecoin | ⛔ Deprecated — removed from repo |
| Gnosis | sDAI | Yield-bearing stablecoin | ⛔ Beta (superseded) |

- 🔄 Additional LP onboarding + deeper liquidity
- ⏳ Third-party audit + bug bounty ahead of broader scaling

The oracle-free model removes all external price dependencies from consensus: thresholds are LP-declared, settlement is par at those declared terms, and insolvency is resolved by bonded auction — no feed can censor or stall the protocol.

---

## 📚 Documentation

- [Oracle-free migration spec](./docs/ORACLE_FREE_MIGRATION_SPEC.md)
- [Auction liquidation design](./docs/AUCTION_LIQUIDATION.md)
- [Funding guide](./docs/FUNDING.md) — what assets each chain needs and where to get them
- [Sequence diagrams](./docs/sequenceDiagrams.md) — mint/burn/auction flows
- [Seed storage design](./docs/SEED_STORAGE_IMPLEMENTATION.md)
- [Ethereum contracts](./ethereum/README.md)
- [LP server](./lp-server-js/README.md)
- [Frontend](./frontend/README.md)

---

## ⚠️ Disclaimer

Experimental protocol software provided "as is." It has undergone security review but not formal third-party audit certification or formal verification. The developers assume no liability for losses. Interact at your own risk.

## 💜 Donations

If you find WrapSynth useful, consider supporting the project:

**XMR:** `83PvXnBHDNmN4TtRdKXMr4Vq1uHerTthZDRjrTG4hMUyeLSd7pNYwM31eCmDdX9D3F61FsdA2XvTmT92eQzqWFwR9CJ4gb8`

---

## 📄 License

MIT

---

Built with ❤️ for privacy and decentralization
