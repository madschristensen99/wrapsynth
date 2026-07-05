# wsXMR - Wrapped Monero on Gnosis Chain

A decentralized protocol for wrapping Monero (XMR) on Gnosis Chain using a diamond proxy pattern with LP-backed minting and burning.

## 🚀 Gnosis Mainnet Deployment

**Deployed:** July 5, 2026 (v2.1)

- **wsXmrHub (Diamond Proxy):** `0x512a76C2E4edC0695F6195Dd88BBa7AE425AA160`
- **wsXMR Token:** `0x4bD004F941D115a57D892d6C5F84F4A21a17F979`
- **LiquidityRouter:** `0x67507CE0682DEc4011f98DD87983C4Fe5e2e0905`
- **SwapHelper:** `0xDd9144B9B5AE92E6F5C3D548358025dc18134a68`
- **Uniswap V3 Pool:** `0x67C96d27A4855A3fFD11698E7db8884576E93942`
- **RedStoneOracleFacet:** `0x9b368bB643d816DDA423d876B62C68F6aE475007`
- **VaultFacet:** `0x81fE694d64acBeEa131C89aB745E16A981849fEB`
- **MintFacet:** `0x7dB1dbE57b344006dC2856EC8344C60662fd8B13`
- **BurnFacet:** `0x34a73e184CF1B25Dd6043d95a3E7b84E71ec5AE0`
- **LiquidationFacet:** `0x9a7c4175D1Cb775Bb1EC406498117357e5c812b5`
- **YieldFacet:** `0x3105eBEed407dE76Efca44546342c196dA41594f`
- **Network:** Gnosis Chain (ChainID: 100)
- **Explorer:** https://gnosisscan.io

### Recent Fixes (v1.3)

✅ **Configurable LP Vault Timeouts**
- LPs can now set per-vault `mintTimeoutBlocks` and `burnTimeoutBlocks`
- Bounds: 360 (30 min) to 17280 (24 hours) blocks
- Default: 720 blocks (~1 hour at 5s/block)
- Enforced via `VaultFacet.setMintTimeoutBlocks()` and `setBurnTimeoutBlocks()`

### Previous Fixes (v1.2)

✅ **Burn Reward Withdrawal Fix**
- Fixed burn rewards to be stored with SDAI address instead of hub address
- Users can now successfully claim burn rewards via `withdrawReturns(SDAI)`
- Burn reward: 0.3% of burn value paid in sDAI (from freed LP collateral)

✅ **Critical Decimal Mismatch Fix (v1.1)**
- Fixed wsXMR decimal handling (8 decimals) in collateral ratio calculations
- Previously treated wsXMR as 18 decimals, causing 10 billion times underestimation of debt
- All collateralization checks now correctly enforce 150% ratio

✅ **Configuration Updates**
- Lowered `MIN_BURN_AMOUNT` from 1e6 (0.01 wsXMR) to 1e4 (0.0001 wsXMR)
- More reasonable minimum for smaller transactions

### Fee Structure

- **Mint Fee:** 0.5% (50 bps) - Goes to LP vault
- **Burn Reward:** 0.3% (30 bps) - Goes to burner in sDAI
- Configurable per-vault via `setVaultMarketMetrics(mintFeeBps, burnRewardBps)`

### Verified Contracts

All contracts verified on Gnosisscan:
- MintFacet
- BurnFacet  
- VaultFacet
- LiquidationFacet
- YieldFacet
- SimpleOracleFacet

## 📚 Documentation

Built with Foundry - https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

Run all tests:
```shell
forge test
```

Run E2E tests on Gnosis fork:
```shell
forge test --match-path test/E2EComprehensive.t.sol --fork-url $GNOSIS_RPC_URL -vv
```

Test mainnet deployment:
```shell
node scripts/testFullCycleNow.js
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

Deploy to Gnosis mainnet:
```shell
source .env && forge script script/DeployGnosis.s.sol:DeployGnosis --rpc-url $GNOSIS_RPC_URL --broadcast --verify --legacy
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
