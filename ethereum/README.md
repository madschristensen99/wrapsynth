# wsXMR - Wrapped Monero on HyperEVM

A decentralized protocol for wrapping Monero (XMR) on HyperEVM (Hyperliquid L1) using a diamond proxy pattern with LP-backed minting and burning. Originally deployed to Gnosis Chain (beta); now live on HyperEVM.

## 🚀 HyperEVM Mainnet Deployment (primary venue)

**Deployed:** September 25, 2026 — full stack live, tested end-to-end on mainnet. See `hypeMigration.md` for the port spec and `deployments/hyperevm-deployment.json` for the manifest.

- **wsXmrHub (Diamond Proxy):** `0xb901C70F2a49d78c32e88ea1F36290d3F5F21f12`
- **wsXMR Token:** `0x25Ed246C3CB273730235A3184aB63aB4DF4f4CF3`
- **LiquidityRouter:** `0x4619e409c8070042DAC16637F8f883F1C7118aEE`
- **SwapHelper:** `0x6bbB5fE4F82b14Bd29fd8d7B9cC1f45a6e19c3dD`
- **Ed25519Helper:** `0x52AF4f5CA562793D2018fe6F7817970A30DBC67a`
- **StataUSDe (collateral):** `0x3BA7C8c0f693703B24AcE1db311e15fd8D2904ED`
- **HyperSwap USDe/wsXMR Pool:** `0xFA529Dc1B245B3228a172CEb886F47F2127AF401`
- **HyperCoreOracleFacet:** `0x2a18BCFf642015E363080072F51DaA34A86A14bD`
- **VaultFacet:** `0x09444C6Af846b1E9628FDb47ed44185A3f650425`
- **MintFacet:** `0xfF9D2c2BBd88Ad92ED2Ee5b0CaF3ddFdc7BC6Fee`
- **BurnFacet:** `0x31D33FF29D147dEf74a5F3959F6302b38aB8bD50`
- **LiquidationFacet:** `0xfFc6F0F8d5ed6010532EE95646115E0118BAa144`
- **YieldFacet:** `0x8D7DD0A1FD26A2602837B028afB7A1f1b21DA9E7`
- **Network:** HyperEVM (ChainID: 999) · **Collateral:** USDe via HyperLend · **Oracle:** native XMR perp via L1-read precompile
- **Explorer:** https://hyperevmscan.io

**Mainnet validation (all passing):** `testFullCycleNow.hyperevm.js` (deposit → mint → Co-LP open/unwind → burn + reward), `testCoLPNow.hyperevm.js` (Co-LP open + unwind), `testPoolSwaps.hyperevm.js` (seeded pool + both-direction swaps + fee collection). All contracts verified on hyperevmscan via Etherscan V2.

### Deploying to HyperEVM (the big-block dance)

HyperEVM uses a **dual-block architecture**: small blocks (~2–3M gas, ~1s) for routine txs and
**big blocks (30M gas, ~60s)** for heavy operations like contract deployment. The RPC
**hard-rejects any tx with `gasLimit > 3M`** — even while a 30M block is the latest block —
unless the sender account is opted into big-block routing.

Four facets exceed 3M gas and cannot deploy without it: `VaultFacet` (5.4M), `MintFacet` (3.9M),
`BurnFacet` (4.1M), `LiquidationFacet` (3.3M).

**Step 1 — enable big-block routing** (one-time per deployer account):

Submit a HyperCore L1 action via `POST https://api.hyperliquid.xyz/exchange`:

```json
{ "action": {"type": "evmUserModify", "usingBigBlocks": true},
  "nonce": 1767949700000,
  "signature": {"r": "0x...", "s": "0x...", "v": 27} }
```

The signature is EIP-712 over a **phantom "Agent"** (not the action itself):
- `actionHash = keccak256(msgpack(action) + nonce(8B BE) + 0x00)`
- `msgpack({"type":"evmUserModify","usingBigBlocks":true})` =
  `82 a4 74 79 70 65 ad 65 76 6d 55 73 65 72 4d 6f 64 69 66 79 ae 75 73 69 6e 67 42 69 67 42 6c 6f 63 6b 73 c3`
  (note: `evmUserModify` is **13 chars** → `0xad`; `usingBigBlocks` is 14 chars → `0xae`; `true` = `0xc3`)
- EIP-712 domain: `{name: "Exchange", version: "1", chainId: 1337, verifyingContract: 0x0000...0000}`
- Types: `Agent: [{name: "source", type: "string"}, {name: "connectionId", type: "bytes32"}]`
- Message: `{source: "a" (mainnet) / "b" (testnet), connectionId: actionHash}`

`scripts/enableBigBlocks.js` does this (edit `usingBigBlocks` to `false` to disable).

**Step 2 — deploy** with `scripts/deployHyperEVM-bigblock.js` (resumable, manifest-driven):

```shell
set -a; source /home/remsee/wsFrontendOverhaul/.env; set +a   # PRIVATE_KEY lives here
node scripts/deployHyperEVM-bigblock.js
```

The script enables big blocks, deploys all contracts (skipping any already in
`deployments/hyperevm-deployment.json`), creates + initializes the pool, and wires everything.

**Step 3 — disable big blocks** (test txs are fast in small blocks, ~1s each):

```shell
# same evmUserModify action with usingBigBlocks: false
```

**Step 4 — run the tests:**

```shell
set -a; source /home/remsee/wsFrontendOverhaul/.env; set +a
node scripts/testFullCycleNow.hyperevm.js
node scripts/testCoLPNow.hyperevm.js
node scripts/testPoolSwaps.hyperevm.js
```

### Deployment gotchas (all hit in production, Sep 2026)

1. **CREATE tx address**: `ethers.utils.parseTransaction(signed).to` is `null` for contract
   creation — compute the target with `ethers.utils.getContractAddress({from, nonce})`. Using
   `null` makes the code-poll loop spin until timeout and redeploy a duplicate.
2. **Receipt waits**: ethers `tx.wait()` throws `invalid address or ENS name` on HyperEVM for
   CREATE receipts. Poll `getTransactionReceipt(hash)` or `getCode(target)` directly.
3. **Nonce**: re-sign with a fresh nonce on every attempt. A pre-signed tx with a stale nonce
   fails forever with `nonce has already been used`.
4. **`createPool` needs 6M gas** — it deploys a ~17KB pool contract via CREATE. 2.9M runs out
   of gas and reverts with a generic `EvmError: Revert`.
5. **`replacement fee too low`**: a pending tx at the same nonce (e.g., from a killed run)
   blocks new txs. Wait ~70s for it to mine (big blocks) before retrying.
6. **RPC flakiness**: rate limits (`-32005`), socket errors (`-32100`), and
   `processing response error` are common — retry with backoff. The public RPC
   (`rpc.hyperliquid.xyz/evm`) is the only one that accepts big-block txs.
7. **One-shot setters**: `setHub`, `setExternalAddresses`, `registerFacets` revert if called
   twice — guard them with getter checks (`if (await hub.collateralToken()) === zero`).
8. **`.env` location**: the deploy/test scripts load `.env` from CWD, but the key lives in
   `/home/remsee/wsFrontendOverhaul/.env` — source it or symlink it into `ethereum/`.

## 🚀 Gnosis Mainnet Deployment (beta — superseded)

**Deployed:** September 16, 2026 (v6.1 — admin privilege lock: `lockHub()` / `lockDeployer()` executed as final deploy step, permanently disabling deployer hooks). Superseded by the HyperEVM deployment above.

- **wsXmrHub (Diamond Proxy):** `0xd3dac8cf69c2d321bdc1e479d92a1b79cd2228a9`
- **wsXMR Token:** `0xe23d7210fe278b188144b7708e462c7dd721c436`
- **LiquidityRouter:** `0x9fF795A27567367277B7f6bB0E1b073f89a0C29c`
- **SwapHelper:** `0x14aa282e8a68305ea386c3cb7c254590f7b34310`
- **Uniswap V3 Pool:** `0x73ffab40a766c0c6dc557ee53059be11c256bf65`
- **RedStoneOracleFacet:** `0x584124026dabdc729b9dad408881da36a67057d0`
- **VaultFacet:** `0x20fca74c4690c6a09ee0a071d4d38dac8c5bd08a`
- **MintFacet:** `0x2f6773d8ea59a3e7f2d00fc71fabee3e65ec21c8`
- **BurnFacet:** `0xfe7519758c6caf0db057b8427e5b371a908651d2`
- **LiquidationFacet:** `0x45de14afc6c17df6fdc1e67ce1da66cc7222735f`
- **YieldFacet:** `0x54b3e8b84643d84825acf8092fb261992e484991`
- **Network:** Gnosis Chain (ChainID: 100)
- **Explorer:** https://gnosisscan.io

### Admin Privilege Lock (v6.1 — deployed)

The original design left two **permanent** admin hooks on the deployer key:

- `wsXMR.replaceHub(address)` — the token deployer could repoint the token at an arbitrary
  contract, which could then `mint`/`burn` wsXMR without limit (no timelock, no expiry).
- `wsXmrHub.addSelectors()` / `removeSelectors()` — the hub deployer could add new facet routes
  or remove existing ones, bricking or extending protocol functionality after launch.

Neither was renounceable. This is now fixed with a one-way lock:

- `wsXMR.lockHub()` — permanently disables `setHub` / `replaceHub`.
- `wsXmrHub.lockDeployer()` — permanently disables every `onlyDeployer` action
  (`registerFacets`, `addSelectors`, `removeSelectors`, `setLiquidityRouter`) and the
  oracle's `setPriceUpdater` hook.

`script/DeployGnosis.s.sol` calls both as **STEP 10**, the final configuration action.
Behaviour is regression-tested in `test/SecurityGuardTest.t.sol` (10 tests covering
authorization, one-way semantics, and every disabled entry point).

> ✅ The live v6.1 deployment executed `lockHub()` / `lockDeployer()` as the final deploy
> step — verified on-chain (`hubLocked() == true`, `deployerOperationsLocked() == true`).
> The deployer key can no longer repoint the minter or alter facet routes.

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

The protocol has two testing layers: a comprehensive **Foundry (Anvil) test suite** that forks mainnet for unit and integration testing, and a set of **mainnet JavaScript scripts** that verify live deployment behavior.

### Foundry Test Suite

16 test files (~5,800 lines) covering happy paths, error paths, security reverts, invariants, timeouts, slashing, liquidation, oracle manipulation, yield, and multi-party scenarios. Tests fork mainnet via `vm.createSelectFork`.

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
forge test --match-path test/E2EComprehensive.t.sol --fork-url $RPC_URL -vv

# Run only co-LP tests
forge test --match-path test/coLP/*.t.sol --fork-url $RPC_URL -vv

# Gas snapshots
forge snapshot

# Coverage report
forge coverage
```

See `test/README.md` for detailed per-test descriptions of the legacy Hardhat test suite.

### Mainnet JavaScript Scripts

Operational scripts in `scripts/` that interact with deployed contracts on HyperEVM mainnet. These are **smoke tests** — they verify transactions broadcast successfully but lack automated pass/fail assertions. The `.hyperevm.js` variants use `hyperevmLib.js` helpers (`send`/`sendRetry`) to tolerate HyperEVM's state-propagation lag.

| Script | What It Does |
|--------|--------------|
| `deployHyperEVM-bigblock.js` | **Recommended.** Resumable full-stack deploy: enables big-block routing, deploys all contracts (skips live ones), creates + initializes the pool, wires everything | 
| `enableBigBlocks.js` | Toggle big-block routing for the deployer account (`usingBigBlocks: true`/`false`) |
| `deployHyperEVM.js` | Original deploy script (no big-block handling — large facets will fail) |
| `testFullCycleNow.hyperevm.js` | Vault setup → mint → collateral withdraw → co-LP open/unwind → burn → claim rewards |
| `testCoLPNow.hyperevm.js` | Vault setup → mint if needed → co-LP open → co-LP unwind → withdraw returns |
| `testPoolSwaps.hyperevm.js` | Pool state check → wsXMR→USDe swap → USDe→wsXMR swap → co-LP creation → fee-generating swaps → fee collection |

**Run mainnet scripts:**
```shell
# Individual scripts (requires PRIVATE_KEY and RPC_URL in .env)
node scripts/testFullCycleNow.hyperevm.js
node scripts/testCoLPNow.hyperevm.js
node scripts/testPoolSwaps.hyperevm.js
```

**Environment variables required:**
- `PRIVATE_KEY` — wallet with HYPE for gas
- `RPC_URL` — HyperEVM RPC endpoint (`https://rpc.hyperliquid.xyz/evm`)
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
