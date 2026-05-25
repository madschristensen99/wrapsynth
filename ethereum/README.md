# wsXMR - Wrapped Monero on Gnosis Chain

A decentralized protocol for wrapping Monero (XMR) on Gnosis Chain using a diamond proxy pattern with LP-backed minting and burning.

## 🚀 Gnosis Mainnet Deployment

**Deployed:** May 25, 2026

- **wsXmrHub (Diamond Proxy):** `0xf873f64360c2214feb5cf7d7b542a6a3ca6a3afb`
- **wsXMR Token:** `0x54182a360c9014b981a8dbf5d199bb82c3c5b197`
- **Network:** Gnosis Chain (ChainID: 100)
- **Explorer:** https://gnosisscan.io

### Recent Fixes (v1.1)

✅ **Critical Decimal Mismatch Fix**
- Fixed wsXMR decimal handling (8 decimals) in collateral ratio calculations
- Previously treated wsXMR as 18 decimals, causing 10 billion times underestimation of debt
- All collateralization checks now correctly enforce 150% ratio

✅ **Configuration Updates**
- Lowered `MIN_BURN_AMOUNT` from 1e6 (0.01 wsXMR) to 1e4 (0.0001 wsXMR)
- More reasonable minimum for smaller transactions

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
