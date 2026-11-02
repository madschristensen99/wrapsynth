# wsXMR - Wrapped Monero (multi-chain, oracle-free)

A decentralized protocol for wrapping Monero (XMR) using a diamond proxy pattern with LP-backed minting and burning. Target chains: **BNB Chain** (QQQB collateral), **Base** (cbBTC collateral), and **Robinhood Chain** (SPY collateral).

**The protocol is oracle-free.** No contract reads an external price — no RedStone, no Pyth, no oracle precompiles, no TWAP. Each LP vault declares a `thresholdSharesPerWsxmr`: normalized collateral (18-dec) per 1e8 wsXMR. That threshold bounds the vault's mint capacity, defines par settlement for mints (`thresholdAtReady`) and burns (`thresholdAtRequest`), and marks the vault's own solvency line. Insolvency is resolved by a bonded kick → Dutch haircut auction, not a price trigger.

## 🚀 Deployments

Fresh oracle-free deployments are pending on all three chains. Per-chain deploy:

```shell
# BNB Chain (chain 56) — QQQB collateral
forge script script/DeployBnb.s.sol --rpc-url bnb --broadcast --verify -vvvv

# Base (chain 8453) — cbBTC collateral
forge script script/DeployBase.s.sol --rpc-url base --broadcast --verify -vvvv

# Robinhood (chain 4663) — SPY collateral
forge script script/DeployRobinhood.s.sol --rpc-url robinhood --broadcast -vvvv
```

Each script deploys the full stack — `wsXMR` token, `wsXmrHub` (with `MIN_THRESHOLD` immutable), Vault/Mint/Burn/LiquidationAuction/CoLP facets, `wsXMRLiquidityRouter`, and the V3 pool — registers facets, seeds the pool, and executes `lockHub()`/`lockDeployer()` as its final step so deployer powers are permanently disabled. It writes a manifest to `deployments/<chain>-deployment.json`; copy it to `frontend/deployment.<chain>.json` for the web app.

Required env: `PRIVATE_KEY` plus the chain's RPC var (`BNB_RPC_URL`, `BASE_RPC_URL`, `ROBINHOOD_RPC_URL`); `BSCSCAN_API_KEY`/scan keys for `--verify`. The deploy script fetches live collateral + XMR prices **off-chain** to initialize the V3 pool's starting tick — pool initialization is a deploy-time market price, not a protocol oracle.

Notes:
- Robinhood verification: `forge verify-contract` cannot resolve chain 4663 — generate `--show-standard-json-input` and POST it to `https://api.etherscan.io/v2/api?chainid=4663` with the unified scan API key.
- Very small co-LP positions (<~500 wei of paired collateral) revert on the router's slippage floor due to wei rounding — keep test deposits above dust.

### Admin privilege lock

`wsXMR.lockHub()` permanently disables `setHub`/`replaceHub`; `wsXmrHub.lockDeployer()` permanently disables every `onlyDeployer` action (`registerFacets`, `addSelectors`, `removeSelectors`, `setLiquidityRouter`, `setExternalAddresses`). Both are called as the final deploy step — regression-tested in `*SecurityGuardTest.t.sol`. There is no `setPriceUpdater`: there is no oracle.

## 🏗️ Architecture

```
                      ┌────────────────────────────┐
                      │         wsXmrHub           │
                      │  state · collateral · token │
                      │  selector → facet dispatch  │
                      └──────────┬─────────────────┘
        ┌──────────┬─────────┬──┴──────┬──────────────┬─────────┐
   VaultFacet  MintFacet  BurnFacet  LiquidationAuction  CoLPFacet
                                    Facet (kick + Dutch auction)
```

- **wsXmrHub / wsXmrStorage** — single owner of all state and collateral; EIP-1153 transient storage tracks delegate-context so facet logic can't run outside the dispatch path. A handful of views (`getVault`, `getVaultDebt`, `getMintCapacity`, `auctionState`, …) are implemented directly on the hub so `eth_call` reads don't hit the TSTORE-in-staticcall restriction.
- **VaultFacet** — vault lifecycle, raw collateral deposits/withdrawals (normalized to 18-dec at the boundary), `setThreshold`, `setMaxMintWsxmr`, `repayDebt`, and the kick-cancel hooks (`depositCollateral`/`repayDebt` cancel a kick during grace).
- **MintFacet** — the atomic mint state machine; capacity checks are `(debt + pending + mint) × threshold ≤ free collateral`; the LP's key bond locks `par × 110%` at `setMintReady`.
- **BurnFacet** — proportional par collateral locks (`~1.3 × free × wsxmr/debt` cap) plus the burn reward; settlement pays par at `thresholdAtRequest`.
- **LiquidationAuctionFacet** — `kick` (bonded), grace cancel, `openAuction` (settles in-flight burns + unwinds co-LP first), `bid` (Dutch haircut 100%→5%, pays full debt, takes X(t)% collateral), freeze on no-bid, `reauction`, `backstopVault`.
- **CoLPFacet** — negotiated co-LP: `userOpenCoLP(vault, wsxmrAmount, collateralAmount, deadline)`; range/market state comes from the pool's own `slot0.sqrtPriceX96`, never an external feed.

### Units

- wsXMR amounts: **8 decimals** (matching XMR)
- Collateral at the contract boundary: **18-dec normalized units** (raw token × collateralScale). Human collateral = `units / 1e18` on every chain
- `pendingReturns`: **raw token units** (withdrawals transfer raw tokens)
- Threshold: normalized collateral per **1e8** wsXMR → `par = wsxmrAmount × threshold / 1e8`

## 🧪 Testing

Per-chain Foundry suites fork their chain and deploy the full stack. Mock suites use an 18-decimal mock collateral; fork suites (`*ForkTest`) exercise the real collateral token and V3 pool.

| Suite family | Coverage |
|---|---|
| `*MockTest`-family coverage files (`*MintBurnCoverage`, `*VaultFacetCoverage`, `*SecurityGuardTest`, `*LibraryCoverage`, `*CoLPTest`, …) | Unit/integration against mock collateral on a local Anvil fork |
| `*AuditRegressionTest` | Security regressions: delegate-context reentrancy, decimal handling, debt-index consistency, kick→auction bad-debt settlement |
| `*E2E*` suites | Full mint → burn → co-LP → withdraw cycles, timeouts, slashing, kick/auction lifecycle |
| `*ForkTest` | Real collateral token (QQQB on BNB, cbBTC on Base, SPY on Robinhood) + real V3 pool |

```shell
# Fork a chain into local Anvil first — public RPCs prune state (~128 blocks on
# BSC), so run tests immediately after starting the fork.
anvil --fork-url $BASE_RPC_URL --port 8545 &
forge test --match-path "test/Base*" --fork-url http://127.0.0.1:8545

anvil --fork-url $BNB_RPC_URL --port 8546 &
forge test --match-path "test/Bnb*" --fork-url http://127.0.0.1:8546
```

Current status: **Base 210/210**, **BNB 209/209** (202 mock + 7 fork). Robinhood compiles but its public RPC times out from test environments — supply a reachable `ROBINHOOD_RPC_URL` to run `test/Robin*`.

## 📜 Operational scripts

`scripts/` holds per-chain JS smoke tests and utilities (ethers.js, `PRIVATE_KEY` + per-chain RPC env). All are oracle-free — no price pushes anywhere:

| Script | What it does |
|---|---|
| `deployAndTestAll.js` | Generic per-chain deployer driving the Foundry deploy scripts |
| `testFullCycleNow.<chain>.js` | Vault create + deposit → setThreshold/setMaxMintWsxmr → mint → burn (burn sized to the proportional lock) |
| `testCoLPNow.<chain>.js` | Mint if needed → `userOpenCoLP(vault, wsxmr, collateral, deadline)` → unwind → withdraw returns |
| `testPoolSwaps.<chain>.js` | Both-direction swaps through the chain's V3 router |
| `burnOnly.<chain>.js` | Standalone burn against an existing vault |
| `checkAbiConformance.js` | Compares built artifacts against an on-chain deployment; flags stale selectors |
| `unstickAndExit.bnb.js` | Withdraw pending returns + vault collateral, deactivate vault |

## 📚 Foundry usage

```shell
forge build          # compile
forge test           # test
forge fmt            # format
forge snapshot       # gas snapshots
forge coverage       # coverage report
anvil                # local node
cast <subcommand>    # chain interaction
```

Built with Foundry — https://book.getfoundry.sh/
