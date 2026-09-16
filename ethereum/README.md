# wsXMR - Wrapped Monero on Gnosis Chain

A decentralized protocol for wrapping Monero (XMR) on Gnosis Chain using a diamond proxy pattern with LP-backed minting and burning.

## 🚀 Gnosis Mainnet Deployment

**Deployed:** September 16, 2026 (v6.0 — mint ghosting gap fix: collateral lock moved to provideLPKey, cancelMint slashes on KEY_PROVIDED timeout)

- **wsXmrHub (Diamond Proxy):** `0x2F6Ede34d2FC01209b104E74A3d657f71125b364`
- **wsXMR Token:** `0x66A7e0e70113fE6A293287A5Cc0903E5C08067E4`
- **LiquidityRouter:** `0xF44081dBE8C153cCfa1A74c157bd571F2d0f779D`
- **SwapHelper:** `0xA31215E4352846F4D55211e4C5115daaF379f641`
- **Uniswap V3 Pool:** `0xAf51b4f37096c21ff977284985209404679704a7`
- **RedStoneOracleFacet:** `0x891B682279940F0d03b1414A24c2964c0cB02c20`
- **VaultFacet:** `0x000C0c89599483839bec0C77894E401F309e969d`
- **MintFacet:** `0xF8a6Df73E9f9B0A434356FCdf1EB9Fd3d24d3f61`
- **BurnFacet:** `0x3c2b3515130AddF7aA17f577DAcc7339C802326E`
- **LiquidationFacet:** `0xffc3Cc0C07B71F2DeF118FAa4758AbaEf79D48A7`
- **YieldFacet:** `0xD6305b138406A7F7a72cD9Ac9525DD0ead349A9D`
- **Network:** Gnosis Chain (ChainID: 100)
- **Explorer:** https://gnosisscan.io

### Recent Changes (v5.0)

✅ **Mint Refundability — Collateral Locking**
- `setMintReady` now locks par-value collateral (110% of par) from the vault
- If LP ghosts and mint expires, user can `sweepUnclaimedExpiredMint` to slash locked collateral
- If LP was ready but user abandoned, LP calls `claimGriefingDeposit` to claim griefing deposit and release locked collateral
- `finalizeMint` releases the lock immediately upon successful mint

✅ **Liquidation `globalTotalDebt` Underflow Fix**
- Fixed arithmetic underflow when `debtToClear` exceeds `globalTotalDebt` after burn settlement
- Added cap: `if (debtToClear > globalTotalDebt) debtToClear = globalTotalDebt`

### Previous Fixes (v1.3)

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

## 🧪 Testing

The protocol has two testing layers: a comprehensive **Foundry (Anvil) test suite** that forks Gnosis mainnet for unit and integration testing, and a set of **mainnet JavaScript scripts** that verify live deployment behavior.

### Foundry Test Suite

16 test files (~5,800 lines) covering happy paths, error paths, security reverts, invariants, timeouts, slashing, liquidation, oracle manipulation, yield, and multi-party scenarios. All tests fork Gnosis mainnet via `vm.createSelectFork`.

**Key Foundry capabilities used:**
- `SimpleOracleFacet` mock — set arbitrary prices to trigger liquidations, test staleness
- `vm.warp` / `vm.roll` — time and block manipulation for timeout and yield tests
- `vm.prank` — impersonate any address for authorization tests
- `vm.expectRevert` — automated assertion that calls fail with correct errors
- `assertTrue` / `assertEq` / `assertGt` — automated state verification
- Fresh contract deployment per test — no state leakage between tests
- Multi-actor setup — separate LP, user, attacker, liquidator, keeper addresses

| File | Lines | Coverage Area |
|------|-------|---------------|
| `E2EComprehensive.t.sol` | 508 | Happy path mint/burn, mint timeouts (4 tests), burn timeouts (4 tests), concurrent mints, simultaneous mint+burn |
| `E2EAdvancedScenarios.t.sol` | 386 | Price crash liquidation, time-warp mint/burn timeout, slashing, multi-vault price volatility, oracle staleness, crash→recovery→yield |
| `E2EFinal.t.sol` | 162 | Basic full mint→burn cycle |
| `E2EFullCycle.t.sol` | 445 | Full cycle: deploy, vault, config, mint, burn, withdraw, co-LP, fee collection |
| `AuditRegressionTest.t.sol` | 697 | Regression tests for reentrancy (C1), decimal mismatch (H1), debt index context (H2) |
| `BurnSolvencyInvariantTest.t.sol` | 648 | Burn settlement accounting invariants (Fix 1 + Fix 2) |
| `SecurityGuardTest.t.sol` | 577 | Authorization, state ordering, deadline enforcement, security-critical reverts |
| `LiquidationCoverage.t.sol` | 268 | Liquidation engine, bad debt handling |
| `VaultFacetCoverage.t.sol` | 354 | Vault creation, collateral deposit/withdrawal, admin functions |
| `YieldKeeperTest.t.sol` | 387 | Yield accumulation, keeper operations, buy-and-burn |
| `OracleCoverage.t.sol` | 243 | Oracle staleness, price normalization, authorized updaters |
| `LibraryCoverage.t.sol` | 267 | Pure library functions: CollateralLogic, BurnLogic, YieldLogic |
| `MintBurnCoverage.t.sol` | 414 | View function coverage: getMintRequest, getVaultPendingMints, fee calculations, min burn checks |
| `PoolSwapTest.t.sol` | 507 | Pool initialization price correctness, both-direction swaps |
| `coLP/CoLPTest.t.sol` | 1009 | Co-LP open/unwind, fee collection, range rebalancing, liquidation triggers |
| `coLP/CoLPTestMainnet.t.sol` | 82 | Verifies deployed mainnet contracts are accessible (read-only checks) |

**Run Foundry tests:**
```shell
# All tests
forge test

# Specific E2E test with verbose output
forge test --match-path test/E2EComprehensive.t.sol --fork-url $GNOSIS_RPC_URL -vv

# Run only co-LP tests
forge test --match-path test/coLP/*.t.sol --fork-url $GNOSIS_RPC_URL -vv

# Gas snapshots
forge snapshot

# Coverage report
forge coverage
```

See `test/README.md` for detailed per-test descriptions of the legacy Hardhat test suite.

### Mainnet JavaScript Scripts

Operational scripts in `scripts/` that interact with deployed contracts on Gnosis mainnet. These are **smoke tests** — they verify transactions broadcast successfully but lack automated pass/fail assertions.

| Script | Lines | What It Does |
|--------|-------|--------------|
| `deployAndTestAll.js` | 216 | Orchestrator: deploy → parse addresses → write `deployment.json` → run 3 test scripts in sequence |
| `testFullCycleNow.js` | 581 | Vault setup → price update → mint (4 steps) → collateral withdraw → co-LP open/unwind → burn (4 steps) → claim rewards |
| `testCoLPNow.js` | 286 | Vault setup → price update → mint if needed → co-LP open → co-LP unwind → withdraw returns |
| `testPoolSwaps.js` | 434 | Pool state check → wsXMR→sDAI swap → sDAI→wsXMR swap → co-LP creation → fee-generating swaps → fee collection |
| `testDeploymentSimple.js` | 126 | Read-only deployment verification (checks contract code exists, token metadata, pool state) |

**Run mainnet scripts:**
```shell
# Full deploy + test cycle
npm run deploy

# Individual scripts (requires PRIVATE_KEY and GNOSIS_RPC_URL in .env)
node scripts/testFullCycleNow.js
node scripts/testCoLPNow.js
node scripts/testPoolSwaps.js
node scripts/testDeploymentSimple.js
```

**Environment variables required:**
- `PRIVATE_KEY` — wallet with xDAI for gas
- `GNOSIS_RPC_URL` — Gnosis Chain RPC endpoint
- `MONERO_RPC_URL` — Monero node for LP operations (optional for basic tests)

### Coverage Gap Analysis

#### What the Foundry suite covers that mainnet scripts do not

1. **Error path testing** — Foundry verifies ~30+ revert scenarios (unauthorized calls, insufficient collateral, expired deadlines, invalid statuses, double-provision of keys, burn exceeds vault debt, etc.). Mainnet scripts test only happy paths; every `try/catch` logs a warning and continues without failing.

2. **Timeout and slashing** — Foundry tests mint timeout before/after LP ready, burn user abandonment, LP failure to reveal, slash claims. Mainnet scripts execute the full cycle in a single block with no waiting.

3. **Liquidation** — Foundry tests price crash liquidation, multi-vault liquidation, healthy vault rejection, bad debt writeoff. Mainnet scripts never trigger liquidation (single-actor model makes it impossible).

4. **Invariant verification** — Foundry asserts collateral ratio ≥ 150%, burn solvency, debt index consistency, global debt = sum of vault debts, fee calculations. Mainnet scripts log values but don't assert them (e.g., `console.log('✅ Fee correctly applied:', match ? 'YES' : 'NO')` prints "NO" and continues).

5. **Multi-party scenarios** — Foundry uses separate addresses for LP, user, attacker, liquidator, keeper. Mainnet scripts use a single wallet as both LP and user, missing `msg.sender != user` reverts, unauthorized LP key provision, third-party cancellation, and liquidator role.

6. **Oracle edge cases** — Foundry uses `SimpleOracleFacet` to set arbitrary prices, test staleness, test price normalization to zero. Mainnet scripts use real RedStone oracle with retry logic but don't test stale price rejection, price deviation limits, or unauthorized signers.

7. **Yield accumulation** — Foundry uses `vm.warp(30 days)` to test sDAI yield accrual, yield extraction, yield-aware collateral withdrawal. Mainnet scripts execute immediately — no time passes, so yield is never meaningfully tested.

#### What mainnet scripts test that Foundry cannot

- **Real RedStone price feed integration** — actual signed data pipeline, gas costs of price updates
- **Real Ed25519Helper contract** — on-chain Ed25519 scalar multiplication vs Foundry's inline library
- **Real transaction broadcast** — gas estimation, mempool, confirmation, nonce management
- **Real sDAI conversion** — actual `convertToAssets()` rates from live sDAI contract

#### Structural issues with mainnet scripts

- **Ordering dependency**: `deployAndTestAll.js` runs `testFullCycleNow` → `testCoLPNow` → `testPoolSwaps` in sequence. If `testFullCycleNow` fails mid-way (e.g., RedStone timeout), subsequent scripts start with broken state.
- **State leakage**: Scripts are not idempotent. `testFullCycleNow.js` checks if wsXMR balance exists — if so, it skips mint and jumps to burn. Second run gives different coverage than first run.
- **No teardown**: No way to reset vault state, burn all wsXMR, or withdraw all collateral between runs. Must redeploy contracts for clean state.
- **Hardcoded addresses**: sDAI address `0xaf204776c7245bF4147c2612BF6e5972Ee483701` hardcoded in multiple scripts instead of using `deploymentConfig.js`.
- **No CI integration**: Requires `PRIVATE_KEY` and live RPC — can't run in automated pipeline without secrets.
- **ABI duplication**: Each script defines its own inline ABI with different function subsets. No shared ABI file.

#### What's achievable on mainnet (despite constraints)

On mainnet there is **one wallet, real time, real oracle, no `vm.prank`** — most Foundry capabilities are impossible. But there is a meaningful middle ground:

- **Assertions instead of console.log** — Replace `console.log('✅ ...', match ? 'YES' : 'NO')` with `if (!match) throw new Error(...)`. Every script already has the data to assert.
- **Error path testing with single wallet** — Withdraw more collateral than available, mint with insufficient griefing deposit, burn more than vault debt, finalize non-existent request, request burn below minimum, double-provide LP key. All testable with `try/catch` + assertion that revert occurred.
- **Two-wallet setup** — Fund a second throwaway wallet with xDAI. Wallet A = LP, Wallet B = user. Unlocks `msg.sender != user` reverts, actual atomic swap coordination, third-party cancellation.
- **Post-operation invariant checks** — After every state-changing tx, read vault state and verify collateral ratio ≥ 150%, `lockedCollateral` ≤ `collateralShares`, `globalTotalDebt` decreased by exact burn amount, `pendingReturns` matches expected payout, wsXMR totalSupply matches expected deltas. All read-only calls.
- **Timeout testing (slow)** — Set mint with minimum timeout (360 blocks ≈ 30 min on Gnosis) and wait. Then test cancellation. Could be a separate "slow test" script.

#### What's genuinely impossible on mainnet

- **Oracle manipulation** — can't set arbitrary prices to trigger liquidation
- **Time travel** — can't test yield accumulation without waiting real days
- **Impersonation** — can't call as another address without that wallet's key
- **Fork resets** — every tx is permanent, no `vm.createSelectFork` undo
- **Free retries** — every failed tx costs gas

### Recommended Improvements

1. Add `if (!match) throw` assertions to all mainnet scripts
2. Add error-path test functions (revert testing with `try/catch`)
3. Extract shared ABI file to eliminate duplication
4. Replace hardcoded addresses with `deploymentConfig.js` references
5. Add `--reset` mode that burns all wsXMR and withdraws all collateral for clean state
6. Add two-wallet mode for multi-party testing
7. Add post-operation invariant checks (collateral ratio, debt consistency)
8. Add slow timeout test script (separate, runs overnight)

## 📚 Documentation

Built with Foundry - https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Format

```shell
$ forge fmt
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
