# wsXMR Foundry Test Suite

Per-chain Foundry test suites for the oracle-free protocol. Every suite forks its target chain into local Anvil and deploys the full stack — `wsXMR` token, `wsXmrHub` (with `MIN_THRESHOLD`), Vault/Mint/Burn/LiquidationAuction/CoLP facets, `wsXMRLiquidityRouter`, and the V3 pool.

## Layout

Test files are named per chain — `Base*` runs against a Base fork, `Bnb*` against BNB Chain, `Robin*` against Robinhood Chain. All three share the same test bodies, generated from the ported `Base*` files with mechanical renames.

| Group | Files | Collateral |
|---|---|---|
| Mock suites | `*MintBurnCoverage`, `*VaultFacetCoverage`, `*SecurityGuardTest`, `*LibraryCoverage`, `*MintFlowTest`, `*BurnFlowTest`, `*CoLPTest`, `*VaultOperationsTest`, `*PoolSwapTest`, `*ForkRegressionTest` | 18-decimal `MockCollateral` deployed in `setUp` |
| Audit regressions | `*AuditRegressionTest` | Mock collateral — delegate-context reentrancy, decimal handling, debt-index consistency, kick→auction bad-debt settlement |
| E2E suites | `*E2EComprehensive`, `*E2EAdvancedScenarios`, `*E2EFinal`, `*E2EFullCycle` | Mock collateral — full mint→burn→co-LP→withdraw cycles, timeouts, slashing, kick/auction lifecycle |
| Real fork suites | `*ForkTest` | Real collateral token: QQQB on BNB, cbBTC on Base, SPY on Robinhood |

## Test bases

`test/BaseTestBase.sol`, `test/BnbTestBase.sol`, `test/RobinTestBase.sol` define the shared `setUp`:

- Deploys `wsXMR`, `wsXmrHub`, all five facets, `wsXMRLiquidityRouter`, and the V3 pool
- Registers facets, wires external addresses (collateral token + `collateralScale`), locks deployer
- Helpers: `_createVaultAndDeposit`, `_setThreshold`, `_mintFor`, `_kickVault`, `_bidOnAuction`, `_liquidateVault`, `_getPendingReturns`, `_hubView` (low-level call pattern that bypasses the TSTORE-in-staticcall restriction on hub views)

Oracle-free specifics:

- No etches, no oracle mocks, no TWAP mocks, no stata wrappers — collateral is raw tokens normalized at the boundary
- `stata` is a compat alias: `IERC20 stata = IERC20(collateralToken)` so legacy test bodies keep working on the 18-dec mock where share≡asset
- Threshold helpers set `thresholdSharesPerWsxmr` directly (normalized collateral per 1e8 wsXMR)

## Running the suites

Public RPCs prune state (~128 blocks on BSC), so **run tests immediately after starting the Anvil fork** — stale forks fail with storage-fetch errors.

```bash
# Base
anvil --fork-url $BASE_RPC_URL --port 8545 &
forge test --match-path "test/Base*" --fork-url http://127.0.0.1:8545

# BNB
anvil --fork-url $BNB_RPC_URL --port 8546 &
forge test --match-path "test/Bnb*" --fork-url http://127.0.0.1:8546

# Robinhood — requires a reachable ROBINHOOD_RPC_URL
anvil --fork-url $ROBINHOOD_RPC_URL --port 8547 &
forge test --match-path "test/Robin*" --fork-url http://127.0.0.1:8547
```

For flaky upstream endpoints, anvil flags that help: `--fork-retry-backoff`, `--timeout 120000`, `--compute-units-per-second`.

## Current status

| Chain | Result |
|---|---|
| Base | ✅ 210/210 |
| BNB | ✅ 209/209 (202 mock + 7 fork) |
| Robinhood | ⏳ Compiles — needs reachable `ROBINHOOD_RPC_URL` to execute |

## Notable test semantics

- **Burn lock is proportional** — `requestBurn` locks `~1.3 × freeCollateral × wsxmr/debt` capped at free collateral; tests burn half the minted amount (a full-debt burn is impossible by design — the lock would exceed free collateral)
- **Kicks need no solvency proof** — `kick(vault)` + bond works on any vault; tests assert the cancel/auction/freeze paths
- **`auctionState` through the hub** — read via low-level `call` in tests (TSTORE-in-staticcall restriction); see `_kickVault`/`_auctionState` helpers
- **`getMintCapacity`** — bond-reserved formula `free / (threshold × (100 + 110) / 100)`, also capped by `maxMintWsxmr`
- **Backstop** — `backstopVault` requires the absorbing vault to have no active kick/freeze and enough free collateral to assume the debt at its own threshold
