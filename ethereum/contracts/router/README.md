# Co-LP Router

## Overview

`wsXMRLiquidityRouter` is the protocol's V3 concentrated-liquidity arm. The hub's **CoLPFacet** calls it to deploy a vault's collateral leg paired against a user's wsXMR leg into the chain's wsXMR/collateral pool (PancakeSwap V3 on BNB, Uniswap V3 on Base/Robinhood).

The router is **only callable by the diamond** (`onlyDiamond`) — users and LPs never touch it directly. All co-LP negotiation happens in CoLPFacet (`userOpenCoLP(vault, wsxmrAmount, collateralAmount, deadline)`); the router just executes the position.

**Oracle-free**: the router reads no external price. Range bounds and slippage floors are computed from the pool's own `slot0.sqrtPriceX96` — the pool's live market state is the only "price" used, and only for pool-native mechanics.

## Architecture

```
CoLPFacet (in diamond context)
  │  userOpenCoLP / lpDeployCollateral / unwind / rebalance
  ▼
wsXMRLiquidityRouter (immutable, onlyDiamond)
  │  mintConcentratedPosition — NFT LP position, ±rangeBps ticks around current tick
  │  drainPosition — full withdraw, spot-derived slippage floor
  │  collectFees — fee harvest, collateral leg → LP, wsXMR leg → user
  │  isPositionOutOfRange / getPositionAmountsAtSpot — pool-native views
  ▼
Uniswap/PancakeSwap V3 NonfungiblePositionManager → pool (collateral ↔ wsXMR)
```

### Immutables

| Field | Meaning |
|---|---|
| `hub` | The diamond — only address allowed to call |
| `positionManager` | Chain's V3 NFT position manager |
| `collateral` | The chain's collateral token (was "sDAI" on the legacy Gnosis deployment) |
| `wsXMR` | The wsXMR token (8 decimals) |
| `pool` | The wsXMR/collateral V3 pool |
| `collateralIsToken0` | Token ordering of the pool pair |
| `POOL_FEE` / `TICK_SPACING` | Pool fee tier and spacing, fixed at deploy |

### Collateral normalization

The router handles raw token units; CoLPFacet normalizes to 18-dec units at the vault boundary (`collateralScale` set in `setExternalAddresses`). Human collateral = `normalized / 1e18` on every chain, regardless of token decimals.

## Entry points

| Function | Caller | Purpose |
|---|---|---|
| `initializePool(initialXmrPrice)` | diamond (deploy only) | Create + initialize the pool at a deploy-time market price |
| `initializePoolWithPrice(xmrPrice, collateralPrice)` | diamond (deploy only) | Same, with an explicit collateral quote — needed when collateral isn't ~$1 (QQQB, SPY, cbBTC) |
| `mintConcentratedPosition(collateralAmount, wsxmrAmount, rangeBps, deadline, slippageBps)` | diamond | Open ±rangeBps position around the pool's current tick; returns `tokenId, collateralConsumed, wsxmrConsumed` |
| `drainPosition(tokenId, slippageBps)` | diamond | Withdraw all liquidity + fees; slippage floor derived from `slot0` |
| `collectFees(tokenId)` | diamond | Harvest accrued fees → `(collFees, wsxmrFees)` |
| `isPositionOutOfRange(tokenId)` | view | `pool.tick` outside the position's range |
| `getPositionAmountsAtSpot(tokenId)` | view | Token amounts implied by current `slot0` |
| `poolInitialized()`, `token0()`, `token1()` | view | Pool introspection |

## Slippage model

- Mint: at least `(100% − slippageBps)` of each desired leg must be consumed; leftovers are refunded to the hub
- Drain: the router computes expected outputs via `_getAmountsAtSqrtPrice` at the pool's current `sqrtPriceX96` and reverts if collected amounts fall short — the pool's own spot is the reference, not any oracle

## Tick bounds

`mintConcentratedPosition` centers the position on `slot0.tick` and widens by `rangeBps`-equivalent ticks (`TickMath` log base 1.0001), snapped to `TICK_SPACING` and clamped to `[MIN_TICK, MAX_TICK]`.

## Deployment

The router is deployed by `script/Deploy{Bnb,Base,Robinhood}.s.sol` — constructed with the chain's collateral token, wsXMR, position manager, and pool; then `initializePoolWithPrice` is called once by the deployer-diamond to seed the pool's starting tick from live off-chain quotes (a deploy-time market price, not a protocol oracle).

## Known limitations

- **One position per open call** — each `userOpenCoLP`/`lpDeployCollateral` mints a fresh NFT position
- **Wei-rounding floor** — positions pairing <~500 wei of collateral revert on the slippage floor; keep deposits above dust
- **No partial drain** — `drainPosition` withdraws the full position; partial liquidity management isn't supported
