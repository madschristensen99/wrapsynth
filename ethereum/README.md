# wsXMR - Wrapped Monero on Gnosis Chain

A decentralized protocol for wrapping Monero (XMR) on Gnosis Chain using a diamond proxy pattern with LP-backed minting and burning.

## 🚀 Gnosis Mainnet Deployment

**Deployed:** June 2, 2026 (v1.3)

- **wsXmrHub (Diamond Proxy):** `0x284B1d429b1038Ef186314b1Fb33f76Eb61497E9`
- **wsXMR Token:** `0x31c76171773138215E518C0224b82AC9BE9897b8`
- **OracleFacet:** `0xA0ED496c6e16a6d0799Ad300DeC96494a12bE01A`
- **VaultFacet:** `0x203Ccc8B35c00752dc8B04f1D77E765a5ca65BbC`
- **MintFacet:** `0xC4Fa182098DEA7d37725203A636fBC5D5B7FcC43`
- **BurnFacet:** `0x28f325Da1D4910B788ba27FD68e06c2b830f3B9A`
- **LiquidationFacet:** `0x21A82BbA3C20d28baE6aEde14311f932F960Fa2F`
- **YieldFacet:** `0xa62B73677b82780059abB96ef29E1B732607B2Dc`
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
