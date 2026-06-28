# wsXMR - Wrapped Monero on Gnosis Chain

A decentralized protocol for wrapping Monero (XMR) on Gnosis Chain using a diamond proxy pattern with LP-backed minting and burning.

## 🚀 Gnosis Mainnet Deployment

**Deployed:** June 28, 2026 (v2.0)

- **wsXmrHub (Diamond Proxy):** `0x2147f47829014B0b32531124d45A30352e721F75`
- **wsXMR Token:** `0xB59AC6A4443ACBc22dCd5F4Fb0db485ADDDd7bB8`
- **LiquidityRouter:** `0x161d50B1D4bb196C5ECeDA82dd7dD708887F1546`
- **SwapHelper:** `0x32E52ec15bF409B3a8AC3270b5d9CB1757872825`
- **Uniswap V3 Pool:** `0xf993E42DE700abE5Aa2027987Ab6874319f00d70`
- **RedStoneOracleFacet:** `0x83Db30253df3222C04df76043A5a54F9D3453aa4`
- **VaultFacet:** `0xE64fD58133D0be05e42B292643C6f3355f25d62B`
- **MintFacet:** `0xBA24b4ae92236D00eA80Bc7CB5990D497770E82c`
- **BurnFacet:** `0x1Ee6f2aA087D65Ba2A6DB11925D94367012ce259`
- **LiquidationFacet:** `0xc78b13dd3C0EDE7257972d145eab890560F1F0AE`
- **YieldFacet:** `0xe1b8E2d96F3C0baD925c9543919601Fe22C33a75`
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
