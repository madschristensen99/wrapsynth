# ⛴️ WrapSynth

**A trustless cross-chain ferry bringing Monero to EVM and Solana using atomic-swap commitments and overcollateralized vaults.**

🌐 **[wrapsynth.com](https://wrapsynth.com)**

WrapSynth enables trust-minimized transfers of Monero (XMR) onto EVM chains and Solana. Liquidity providers run overcollateralized vaults (150% minimum) and mint `wsXMR` against incoming XMR; redemptions burn `wsXMR` and release XMR back to the user. Both legs are bound by Ed25519 secret commitments in an HTLC-style atomic swap, so neither party can take funds without the counterparty completing their side — **no bridge custodian and no ZK circuits**.

---

## ✨ Key Features

### Core Technology

- **Atomic-Swap Protocol**: HTLC-style secret commitments for trustless XMR ↔ wsXMR exchange, with timeout-based slashing for non-compliance.
- **Ed25519 Verification**: Secret reveals are verified on-chain against their commitments using an Ed25519 library (EVM) / Ed25519 instruction-sysvar checks (Solana), matching Monero's signature curve.
- **Overcollateralized Vaults**: Each LP runs an isolated vault with its own collateral, debt, and risk parameters.
- **Yield-Bearing Collateral**: On Gnosis, collateral is sDAI (auto-converted from xDAI deposits), so idle collateral earns the DAI Savings Rate.
- **Diamond / Hub-Facet Architecture**: A single state-owning hub with hot-swappable logic facets keeps the system under the 24KB contract-size limit and upgrade-friendly.

### Security & Trust Model

- **Overcollateralization**: 150% minimum collateral ratio backs all outstanding wsXMR.
- **Liquidation**: 120% liquidation threshold with a 110% liquidator payout (10% bonus).
- **Atomic-Swap Guarantees**: Cryptographic commitments prevent fund loss for both user and LP.
- **Timeout Protection**: Block-based mint/burn windows (~5s/block on Gnosis) with on-chain slashing if a counterparty stalls.
- **Griefing Protection**: Configurable mint griefing deposits and LP ready-bonds deter spam against vaults.
- **Immutable Token**: `wsXMR` has no admin keys — only the hub can mint or burn.

### DeFi Integration

- **ERC-20 + Permit**: `wsXMR` is a standard ERC-20 with EIP-2612 gasless approvals (8 decimals).
- **Uniswap V3 (Gnosis)**: Native integration for buy-and-burn and a concentrated-liquidity router (CoLP) for wsXMR pools.
- **Multi-Chain**: Live on Gnosis Chain; Anchor program for Solana.

---

## 🏗️ Monorepo Structure

WrapSynth is a multi-chain monorepo with clear separation between implementations:

- **`ethereum/`** — EVM implementation (Gnosis Chain). Foundry-based Solidity contracts (diamond/hub-facet), deploy/test scripts, and a Rust LP node.
- **`solana/anchor-program/`** — Anchor program (`wrapsynth-vault-manager`) implementing the same vault and atomic-swap mechanics natively on Solana.
- **`frontend/`** — Web interface supporting both chains.
- **`docs/`** — Technical design docs and sequence diagrams.

---

## 🚀 Current Status

**Development Phase**: ✅ **Deployed to Gnosis Chain Mainnet** (experimental / unaudited)

### 🌐 Live Deployment — Gnosis Chain (ChainID: 100)

Deployed June 6, 2026. Collateral: **sDAI**. Oracle: **RedStone** pull oracle.

| Contract | Address |
| --- | --- |
| **wsXMR Token** | [`0xd48d298650fcd0c1c8478ee4c3ee077f16171697`](https://gnosisscan.io/address/0xd48d298650fcd0c1c8478ee4c3ee077f16171697) |
| **wsXmrHub** | [`0xe485b74fe0a6aeb590a2e655734d436daa1dec8a`](https://gnosisscan.io/address/0xe485b74fe0a6aeb590a2e655734d436daa1dec8a) |
| **RedStoneOracleFacet** | [`0xcb85ee56254f925e910e8bbe4c34b5e285fdae34`](https://gnosisscan.io/address/0xcb85ee56254f925e910e8bbe4c34b5e285fdae34) |
| **VaultFacet** | [`0x3c6a147b3aced0ed207d75343462db1c863923cd`](https://gnosisscan.io/address/0x3c6a147b3aced0ed207d75343462db1c863923cd) |
| **MintFacet** | [`0x6933456daa0f3018b7f3ab6fbf08c66bda011c4a`](https://gnosisscan.io/address/0x6933456daa0f3018b7f3ab6fbf08c66bda011c4a) |
| **BurnFacet** | [`0xd2ae40b9427ac197b3847fbe677f7027bf00a728`](https://gnosisscan.io/address/0xd2ae40b9427ac197b3847fbe677f7027bf00a728) |
| **LiquidationFacet** | [`0x813523c2f43e81e0b5e10c072037f817b6495851`](https://gnosisscan.io/address/0x813523c2f43e81e0b5e10c072037f817b6495851) |
| **YieldFacet** | [`0x5989690092ffcc195663c0ab4da3c71bea705049`](https://gnosisscan.io/address/0x5989690092ffcc195663c0ab4da3c71bea705049) |
| **LiquidityRouter** | [`0x4ca832cb79514d05a7162257d8bd316ad6fc46a9`](https://gnosisscan.io/address/0x4ca832cb79514d05a7162257d8bd316ad6fc46a9) |

External: **sDAI** [`0xaf204776c7245bF4147c2612BF6e5972Ee483701`](https://gnosisscan.io/address/0xaf204776c7245bF4147c2612BF6e5972Ee483701)

### Solana — Anchor Program

- **Program ID**: `EZ1hsgYwmqmCY5Gzw9mwnJnJE4PJcKX5hHw5MZXk2ssy`
- **Oracle**: Pyth (`PriceUpdateV2`) for XMR/USD and collateral feeds.

### Next Steps

1. ✅ ~~Deploy hub + facets and wsXMR to Gnosis mainnet~~ **COMPLETE**
2. LP server infrastructure for vault management
3. End-to-end testing against Monero stagenet
4. Security audit before public launch

---

## 🧩 Architecture

### EVM: Hub-and-Facet (Diamond)

The EVM implementation is **not** a single monolithic contract. State and logic are separated:

- **`wsXmrHub`** — owns all state (via `wsXmrStorage`), holds all collateral, controls `wsXMR` mint/burn, and routes calls to facets through a selector-dispatch table. Uses EIP-1153 transient storage to gate delegate-call context, plus a reentrancy guard. Only registered facets may mutate state.
- **`wsXmrStorage`** — the shared, append-only storage layout inherited by the hub and every facet (vaults, mint/burn requests, debt index, oracle prices, constants).
- **Facets** (logic only, state accessed through the hub):
  - **VaultFacet** — create/fund vaults, manage collateral and parameters.
  - **MintFacet** — XMR → wsXMR mint lifecycle.
  - **BurnFacet** — wsXMR → XMR burn lifecycle.
  - **LiquidationFacet** — health checks and liquidation of undercollateralized vaults.
  - **YieldFacet** — sDAI yield harvesting / buy-and-burn.
  - **OracleFacet** — price reads + staleness checks (see below).
- **`wsXMRLiquidityRouter`** — Uniswap V3 concentrated-liquidity (CoLP) router for wsXMR pools.

### Oracles

- **EVM (Gnosis): RedStone pull oracle.** `RedStoneOracleFacet` extends RedStone's `PrimaryProdDataServiceConsumerBase`; price data is injected into the transaction calldata, verified on-chain, and read for the `XMR` and `DAI` feeds. Prices arrive in 8 decimals and are normalized to 18. Default staleness window is 2 minutes; RedStone charges no verification fee. A `SimpleOracleFacet` variant accepts prices pushed by a trusted updater that pulls from the RedStone API — useful for chains where calldata injection isn't convenient.
- **Solana: Pyth.** `utils/oracle.rs` parses Pyth `PriceUpdateV2` accounts directly from raw bytes (spot + EMA), enforces a feed-ID match, a confidence check (`conf × 10 ≤ price`), and a staleness window, then normalizes to 18 decimals to mirror the EVM math exactly.
- **Note on Chainlink Data Streams.** The repo includes a minimal `IDataStreamsVerifier` interface and a `MockVerifierProxy`, and the hub storage carries a `verifierProxy` slot. This is scaffolding for evaluating Chainlink Data Streams (available on Gnosis) as an alternative XMR/USD source; it is **not** the active oracle. XMR/USD is not available as a classic Chainlink Data Feed on Gnosis, which is why a pull oracle (RedStone) is used instead.

### High-Level Flow

```
┌──────────────┐                                    ┌─────────────┐
│   Monero     │                                    │  Gnosis /   │
│   Mainnet    │                                    │   Solana    │
└──────┬───────┘                                    └──────┬──────┘
       │ 1. User initiates mint, posts Ed25519 claim       │
       │    commitment + griefing deposit                  │
       │  ────────────────────────────────────────────►    │
       │ 2. User sends XMR to LP's Monero address           │
       │ 3. LP confirms receipt → setMintReady (+ bond)     │
       │ 4. User reveals secret → commitment verified       │
       │    (Ed25519) → wsXMR minted, deposit refunded      │
       │  ◄────────────────────────────────────────────    │
       │                                                    │
       │ 5. Burn: user requests w/ XMR addr + secret hash   │
       │    → wsXMR + LP collateral reserved                │
       │ 6. LP sends XMR off-chain                           │
       │ 7. User commits burn → wsXMR burned, collateral    │
       │    escrowed                                         │
       │ 8. LP reveals secret → collateral released         │
       │    (timeout → user slashes & seizes collateral)    │
```

---

## 📖 How It Works

### Minting (Monero → wsXMR)

1. **Create & fund vault** (LP): create a vault and deposit collateral (sDAI on Gnosis) at ≥150% of intended debt.
2. **Initiate mint** (User): submit an on-chain mint request with an Ed25519 claim commitment and a griefing deposit; the target vault's debt is reserved.
3. **Send XMR** (User): transfer XMR to the LP's Monero address off-chain.
4. **Mark ready** (LP): confirm XMR receipt and post a ready-bond, moving the request to `READY`.
5. **Finalize** (User): reveal the secret; it's verified against the commitment, `wsXMR` is minted to the recipient, and the griefing deposit is refunded.

### Burning (wsXMR → Monero)

1. **Request burn** (User): specify Monero destination + secret hash; `wsXMR` and LP collateral are reserved.
2. **Send XMR** (LP): pay the user in XMR off-chain.
3. **Commit burn** (User): confirm receipt; `wsXMR` is burned and collateral escrowed.
4. **Finalize** (LP): reveal the secret to release the escrowed collateral.
5. **Timeout** : if the LP fails to reveal in time, the user slashes the vault and seizes collateral.

Mint statuses: `PENDING → READY → COMPLETED` (or `CANCELLED`). Burn statuses: `REQUESTED → PROPOSED → COMMITTED → COMPLETED` (or `SLASHED` / `CANCELLED`).

---

## 🛠️ Development Setup

### Prerequisites

- **Foundry** (forge/cast) — install from [getfoundry.sh](https://getfoundry.sh)
- **Node.js** v18+ (frontend + legacy scripts)
- **Rust** (LP node + Solana program) — [rustup.rs](https://rustup.rs)
- **Anchor** + **Solana CLI** (Solana program)

### Clone (with submodules)

```bash
git clone --recurse-submodules https://github.com/madschristensen99/wrapsynth.git
cd wrapsynth
```

Submodules: `openzeppelin-contracts`, `forge-std`, `chainlink`, `redstone-oracles-monorepo`, `svm-fhe`.

### EVM (Foundry)

```bash
cd ethereum
forge build
forge test

# Configure environment
cp .env.example .env
# set PRIVATE_KEY, GNOSIS_RPC_URL, GNOSISSCAN_API_KEY

# Deploy to Gnosis (RedStone oracle wiring)
forge script script/DeployGnosisRedStone.s.sol --rpc-url gnosis --broadcast --verify
```

Build profile: solc `0.8.28`, EVM `cancun`, `via_ir = true`, `optimizer_runs = 1`.

### LP Node (Rust)

```bash
cd ethereum/lp-node
cargo build --release
cargo run --release
```

The LP node manages vaults, watches chain events, talks to a Monero RPC wallet, and pushes RedStone prices on-chain (`oracle.rs` pulls from `api.redstone.finance`).

### Solana (Anchor)

```bash
cd solana/anchor-program
anchor build
anchor test
```

Instructions: `initialize`, `vault_management`, `mint_flow`, `burn_flow`, `liquidation`, `buy_and_burn`, `reconciliation`, `withdrawals`.

---

## 🔐 Security

⚠️ **This is experimental, unaudited research software. Do not use with real funds.**

Before any production deployment: professional security audit, formal verification of critical components, extensive testnet/stagenet testing, and legal/regulatory review.

Economic parameters: 150% collateral ratio, 120% liquidation threshold, 110% liquidator payout, 2-minute oracle staleness window, block-based mint/burn timeouts.

---

## 📚 Documentation

- [Ethereum Contracts](ethereum/contracts) — Solidity (hub, facets, libraries)
- [LP Node](ethereum/lp-node/README.md) — setup and operation
- [Solana Program](solana/anchor-program/README.md) — Anchor program docs
- [Seed Storage Design](docs/SEED_STORAGE_IMPLEMENTATION.md)
- [Sequence Diagrams](docs/sequenceDiagrams.md)

### External Resources

- [Monero Developer Guides](https://www.getmonero.org/resources/developer-guides/)
- [RedStone Oracles](https://docs.redstone.finance/) — EVM price feeds
- [Pyth Network](https://pyth.network/) — Solana price feeds
- [Atomic Swaps](https://en.bitcoin.it/wiki/Atomic_swap) · [HTLC](https://en.bitcoin.it/wiki/Hash_Time_Locked_Contracts)
- [Uniswap V3](https://docs.uniswap.org/contracts/v3/overview)

---

## 📄 License

LGPL-3.0 for contracts (see SPDX headers); MIT where noted. See [LICENSE](LICENSE).

---

Built with ❤️ for privacy and decentralization
