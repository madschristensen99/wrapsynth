# Oracle-Free wsXMR — Migration Spec

> **Status: spec for implementation.** Supersedes the concept stage of
> `AUCTION_LIQUIDATION.md`. Goal: remove every external price dependency
> (RedStone, Pyth, precompiles, TWAP feed pools) from consensus. Prices
> survive only as (a) negotiated terms between consenting counterparties,
> (b) LP self-declared collateralization quotes, and (c) market-discovered
> settlement inside auctions/pools. Display-only UI pricing is exempt —
> it never gates a transaction.
>
> **Drivers:** RedStone sunset its public pull gateways (permanent off
> 2026-10-29); its successors require identified, revocable API keys —
> a censorship vector for a privacy-coin protocol. Pyth gates Hermes
> behind a paid key. No third-party oracle carries an XMR feed without
> a sales relationship. The only structural fix is to stop needing one.

---

## 1. Design overview

Three mechanisms replace the oracle everywhere it was consumed:

| Mechanism | Replaces | Trust basis |
|---|---|---|
| **Negotiated rate** stored on each mint/burn request | `xmrPriceAtReady` / `xmrPriceAtRequest` | Both parties consented to that exact rate |
| **LP self-declared threshold** `collateralSharesPerWsxmr` | CR checks in mint, burn-lock sizing, capacity views | LP's own collateral backs the quote; mis-quoting is self-harm |
| **Bonded-kick Dutch haircut auction** | `liquidate()` trigger + seizure price | Market bidders prove solvency/insolvency by settling or not |

The auction is the linchpin: instead of the protocol *measuring*
insolvency against a reported price, the market *proves* it. A clearing
bid at X% of collateral for the full debt is the market's own
collateral↔debt valuation, delivered at the only moment it matters.
Same discovery pattern as Ajna (oracle-free lending), Maker clip
auctions, and Liquity redemption pricing.

**Consequence:** the protocol keeps no live price at all.
`lastXmrPrice`, `lastCollateralPrice`, `xmrEmaPrice`, staleness windows,
precompile reads, TWAP pools — all deleted from consensus.

---

## 2. New state

### 2.1 Vault additions (re-denominated, see §8)

```solidity
struct Vault {
    // ... existing fields ...
    uint256 thresholdSharesPerWsxmr;  // LP-declared: collateral units
        // (normalized 18-dec) required per wsXMR of debt. Mint cap and
        // self-declared solvency line. T ≥ MIN_THRESHOLD at all times.
    uint256 maxMintWsxmr;             // LP-quoted absolute mint cap
        // (replaces maxMintBps % interpretation)
}

struct Kick {
    address kicker;
    uint256 bond;            // collateralToken units, escrowed by hub
    uint256 kickBlock;       // grace window start
    uint256 auctionEnd;      // grace end + auctionDuration
    bool    active;
}

mapping(address => Kick) public vaultKicks;
```

### 2.2 Request additions

```solidity
struct MintRequest {
    // ...
    uint256 thresholdAtReady;   // vault threshold snapshotted at
                                // setMintReady — reparates par slashes
}
struct BurnRequest {
    // ...
    uint256 thresholdAtRequest; // vault threshold at requestBurn —
                                // replaces xmrPriceAtRequest in par math
}
```

`xmrPriceAtReady` / `xmrPriceAtRequest` are **deleted**. Par settlement
converts through the vault's declared collateral rate instead of USD:
`parCollateral = wsxmrAmount × thresholdAtLock` (18-dec normalized units,
bounded by the LP's own quote — conservative for the user by design of
the threshold floor, see §3.2).

### 2.3 New constants

| Constant | Initial | Meaning |
|---|---|---|
| `KICK_BOND_BPS` | 200 (2%) | Kicker bond vs. vault collateral |
| `KICK_BOND_MIN` | per-chain dust floor | Absolute min bond (spam floor) |
| `KICK_GRACE_BLOCKS` | ~1h equivalent | LP respond window |
| `KICK_COOLDOWN_BLOCKS` | ~6h equivalent | Per-vault re-kick rate limit |
| `AUCTION_DURATION` | 24h | Dutch window (tune to liquidity) |
| `AUCTION_OPEN_DELAY` | ~30 min equiv | Bid-locked rescue window at auction start; bids revert until elapsed. Gives the LP a guaranteed self-rescue window after grace, independent of KICK_SANE classification |
| `HAIRCUT_START_BPS` | 10000 (100%) | Offer opens at all collateral |
| `HAIRCUT_FLOOR_BPS` | 500 (5%) | Curve end; below → inconclusive |
| `CHIP_BPS` | 50 | Kicker's cut of liquidation surplus |
| `KICK_SANE_BPS` | 8000 (80%) | Wrongful-kick threshold: clearing X* ≤ this → vault was ≥125% collateralized → bond → LP |
| `BURN_LOCK_MULTIPLIER_BPS` | 13000 (1.3×) | Proportional burn lock |
| `MIN_THRESHOLD` | per-chain, set in deploy script | Floor under `thresholdSharesPerWsxmr` — prevents degenerate near-zero quotes enabling unbacked issuance. Passed to hub at construction as an immutable; NOT a hardcoded contract constant (varies by collateral asset: cbBTC ≠ QQQB ≠ SPY) |

Block-based constants stay block-based per chain (existing convention:
rescaled per-chain block time in deploy config, same as today).

---

## 3. Mechanism details

### 3.1 LP threshold quote

- `setThreshold(uint256 sharesPerWsxmr)` — LP-only, reverts below
  `MIN_THRESHOLD` or when a kick is active on the vault. Raising the
  threshold applies immediately (it only makes the vault *more*
  conservative for new debt); lowering it is also allowed immediately —
  it only loosens the LP's own issuance headroom and moves their
  solvency line *closer* to insolvency, self-harm bounded.
- Mint eligibility: `freeCollateral ≥ (debt + pendingDebt + mint) ×
  threshold`. `freeCollateral = collateralShares − lockedCollateral`
  (key bonds and burn locks never count).
- This is an issuance bound, not a liquidation trigger. The market —
  not the threshold — decides insolvency (§3.3). Its purpose is to stop
  an LP from minting debt that *obviously* exceeds their collateral at
  their own declared terms, which would manufacture unbacked wsXMR.
- `MIN_THRESHOLD` is a per-chain deploy constant — NOT a hardcoded
  contract constant like `COLLATERAL_RATIO` is today. The current
  `COLLATERAL_RATIO = 150` is the same on every chain, which only
  worked because the oracle adapted per-chain at runtime. With no
  oracle, the floor *is* the per-chain price opinion, so it must vary
  by collateral asset (cbBTC on Base, QQQB on BNB, SPY on Robinhood).
  Set in the deploy script per chain, passed to the hub at
  construction, stored as an immutable storage variable. No on-chain
  update path; if the floor becomes stale (collateral crashes hard
  relative to XMR), new mints pause until redeploy. The auction still
  catches true insolvency regardless of the floor value, so a mis-set
  `MIN_THRESHOLD` cannot manufacture unbacked wsXMR — it can only pause
  or enable issuance, not break solvency.

### 3.2 Why the threshold protects users in par settlement

Slashed key bonds and burn-locks pay the user par *in collateral*.
With `parCollateral = amount × thresholdAtLock`, the user is paid at
the LP's own declared rate — the same rate the LP was required to
satisfy when accepting the request. An LP that under-quotes their
threshold to dodge par obligations simultaneously lowers their mint
bound and their own buffer against kicks; a floor `MIN_THRESHOLD`
bounds the damage. The user's swap economics are protected by the
negotiated `xmrAmount`/`wsxmrAmount` terms already stored on the
request — unchanged from today.

**User-facing disclosure (UI requirement):** the frontend MUST display
the vault's `thresholdSharesPerWsxmr` and the implied par rate
(collateral units per wsXMR payable on slash) to the user at mint and
burn request time, before the user commits. The user never verified
the threshold is a fair XMR/collateral rate — they only saw the
negotiated `xmrAmount`/`wsxmrAmount`. If an LP declares a threshold
30% below the real XMR/collateral rate, the user's par (on slash) is
30% worse than an oracle would have given, and the user had no way to
detect this at request time. Surfacing the threshold and implied par
rate, with explicit user acceptance, closes this gap. This is a
frontend requirement, not a protocol change — the threshold is
already public on-chain state.

### 3.3 Kick lifecycle

```
anyone ──bond──► kick(vault) ──► GRACE (KICK_GRACE_BLOCKS)
                                  │
                 LP: depositCollateral / repayDebt / ──► KICK CANCELLED
                   withdraw nothing; proves solvency     bond → LP
                   by acting                              (+ gas stipend)
                                  │
                            grace expires
                                  ▼
                        AUCTION (dutch haircut, AUCTION_DURATION)
                                  │
              first bid wins → settle          no bid → floor reached
                  │                                   │
                  ▼                                   ▼
           LIQUIDATION                        INCONCLUSIVE →
           (see §3.4)                         vault FROZEN (§3.6)
```

- `kick(address vault)` — permissionless. Posts `bond = max(
  KICK_BOND_BPS × vaultCollateral, KICK_BOND_MIN)` in collateralToken,
  escrowed by the hub. One active kick per vault; a second kick reverts.
  After any resolved kick, `KICK_COOLDOWN_BLOCKS` must pass.
- **Grace.** While in grace the LP may `depositCollateral` or
  `repayDebt` — either cancels the kick and pays the bond to the LP.
  The LP proves solvency by acting; no price is consulted.
  (Liveness assumption is already load-bearing in this protocol —
  `LP_CLAIM_WINDOW`, LP attestation, shared XMR addresses — so this
  adds no new assumption.)
- **In-flight request handling on kick** — mirrors `liquidate()`'s
  existing inline settlement (force-cancel REQUESTED/PROPOSED burns,
  par-settle COMMITTED burns at `thresholdAtRequest`, unwind co-LP
  positions through the pool) — moved to kick-settlement time so the
  auction offers clean state. Par math by burn status:
  - REQUESTED/PROPOSED burns: force-cancelled. No `thresholdAtRequest`
    exists yet (the burn never reached COMMITTED). wsXMR is re-minted
    to the user; the burn lock is released to the vault. No par
    settlement — the user is made whole in wsXMR.
  - COMMITTED burns (secret not yet revealed): par-settled at
    `thresholdAtRequest` (snapshotted at `requestBurn` time). User
    gets `min(parCollateral, lockedCollateral) + rewardCollateral`;
    excess locked collateral returns to the vault (seizable in
    auction).
  - COMMITTED burns (secret already revealed): the user can claim
    the XMR with the public secret, so they receive only the burn
    reward; the locked collateral is released to the vault (seizable).

### 3.4 The auction

Descending-haircut, whole-vault, first-bid-wins (ascending price
competition emerges from the dutch curve: each bidder rationally bids
as late as they dare — this is optimal for thin liquidity vs.
commit-reveal).

- Offer at time `t` since auction start:

```
X(t) = HAIRCUT_START_BPS
       − (HAIRCUT_START_BPS − HAIRCUT_FLOOR_BPS) × t / AUCTION_DURATION
```

  i.e. linear decay from 100% → 5% of `collateralShares` (post
  in-flight settlement, post position unwind; locked key-bond
  collateral excluded). The decay clock starts after
  `AUCTION_OPEN_DELAY` elapses (see below); during the delay, `X(t)`
  is held at `HAIRCUT_START_BPS` and bids revert.
- **Bid-locked rescue window (`AUCTION_OPEN_DELAY`):** after the grace
  window expires and the auction opens, the first `AUCTION_OPEN_DELAY`
  blocks are a bid-locked rescue window. Bids revert during this
  window. The LP may `repayDebt` in full to cancel the auction (bond →
  LP). This gives the LP a guaranteed self-rescue window after grace,
  independent of KICK_SANE classification — the primary defense against
  solvent-vault griefing (see "Limitation" below). After the delay,
  normal Dutch descending-bid proceeds.
- `bid(vault)` — caller pays `debt` wsXMR (burned by hub — debt
  cleared against `normalizedDebt`/`globalTotalDebt` exactly as
  `liquidate()` does today) and receives `X(t)% × collateralShares`.
  First valid bid settles immediately; the auction ends. Reverts if
  called during `AUCTION_OPEN_DELAY`.
- **Settlement outcomes:**
  - `X* > HAIRCUT_FLOOR_BPS`: liquidation. Bidder gets `X*` shares;
    surplus `(100% − X*)` returns to the LP; kicker receives
    `CHIP_BPS × surplus` (kick incentive) plus bond back.
  - No bid by end (or X decays to floor): market refused the vault at
    any offered collateral share — treat as provably insolvent /
    inconclusive (§3.6), NOT automatic bad debt (a no-bid could also
    mean no bidders online).
- **Wrongful-kick compensation:** if the clearing `X* ≤
  KICK_SANE_BPS` (e.g. 80% — collateral demonstrably worth ≳125% of
  debt), the vault was healthy when kicked; the kick bond is paid to
  the LP as griefing compensation. The liquidation still stands — the
  LP had a grace window to act and didn't. Bond is slashed to the LP,
  not the bidder.
- **Limitation of KICK_SANE protection:** KICK_SANE only protects
  *marginally* solvent vaults (125–~150% CR), where bidders are
  uncertain and wait for a lower X*. For a *clearly* solvent vault
  (e.g. 200% CR), competitive bidders race to bid at X=100% (they
  want the surplus), so X* → 100% > KICK_SANE → classified as
  justified → LP gets no compensation despite being clearly solvent.
  The more solvent the vault, the worse the potential griefing, the
  less the KICK_SANE protection. The `AUCTION_OPEN_DELAY`
  bid-locked rescue window is the primary protection for
  clearly-solvent vaults — it gives the LP a guaranteed rescue window
  after grace regardless of where X* would clear. KICK_SANE remains
  useful for the marginal band where the LP missed the rescue window
  but the vault was still healthy.
- **LP self-rescue during auction:** until the first bid (and during
  the entire `AUCTION_OPEN_DELAY`), the LP may `repayDebt` in full →
  auction cancels, bond → LP. After a bid lands, settlement is atomic
  and irreversible.
- **Bad debt:** if settlement leaves residual `normalizedDebt` (e.g.
  bidder capped by available collateral), write off via existing
  `globalBadDebt` path and route to `backstopVault` (unchanged hook).

### 3.5 Why no bid ⇒ inconclusive, not bad debt

A no-bid outcome is ambiguous: vault truly insolvent, or no bidder was
watching. Rather than socializing losses on ambiguity:

- Vault enters **FROZEN**: mints/burns/withdrawals revert; only
  `repayDebt`, `depositCollateral`, and `backstopVault` are allowed.
- **Bond disposition on no-bid:** the kicker's bond is **returned to
  the kicker**. Rationale: kicking a truly insolvent vault is a useful
  service (it surfaced insolvency and froze the vault, protecting
  future minters). The chip does not pay on no-bid (no surplus exists),
  so the kicker earns no reward but loses no bond — neutral. If the
  bond went to the LP, nobody would kick insolvent vaults (kicking
  would be strictly costly). If burned, the outcome is the same for
  the kicker but provides no incentive signal. Returning the bond
  keeps kickers willing to kick vaults they expect to be insolvent,
  even though those are exactly the kicks that won't produce a surplus.
  The incentive to kick *marginally* solvent vaults (which clear with
  surplus and pay the chip) is preserved separately.
- A later `reauction` (anyone, small re-bond) can retry discovery once;
  `backstopVault` remains the manual escape, unchanged.

Freezing (not draining) is the fail-safe: a liveness failure degrades
to a locked vault, never to theft.

### 3.6 Keeper/seeded bidder

LP server ships an optional seeded keeper: watches kicks, auto-bids at
a configured conservative haircut floor (e.g. never below 70%). This is
infrastructure, not consensus — the protocol never trusts the keeper's
price; it only guarantees a participant exists so honest auctions
don't die on thin liquidity day one.

### 3.7 Co-LP under the oracle-free model

Co-LP (co-liquidity provision) lets users pair their wsXMR with a
vault's collateral into concentrated Uniswap V3 positions. Today the
oracle is used in four co-LP places: amount matching at open, tick
range selection, out-of-range checks, and position valuation in CR.
All four are replaceable without reintroducing a price feed.

**Opening a position (`userOpenCoLP`):**
- Today: the oracle matches collateral to wsXMR via
  `wsxmrUsd = wsxmrAmount × xmrPrice`, then
  `daiNeeded = wsxmrUsd / collateralPrice`.
- Oracle-free: the user and vault agree on amounts directly. The
  router reads the pool's own `slot0.sqrtPriceX96` to set the tick
  range — the pool knows its own price. This is what Uniswap's
  `NonfungiblePositionManager.mint` already does natively; the oracle
  was a convenience wrapper, not a structural need.

**Range checks (`isPositionOutOfRange`, `rebalanceCoLP`):**
- Today: checks the position's tick range against the oracle-implied
  price.
- Oracle-free: checks against the pool's actual current tick
  (`slot0.tick`). Out-of-range is a pool-state fact, not a price
  opinion.

**Slippage protection (`drainPosition`, `mintConcentratedPosition`):**
- Today: reverts when pool spot deviates >0.5% from oracle-implied
  price.
- Oracle-free: the user supplies `minLiquidity` / acceptable tick
  bounds — exactly what `NonfungiblePositionManager.mint` already
  takes natively. The pool price *is* the price; the user states
  their tolerance. No external reference needed.

**Position valuation in CR (`_calculateCRWithPositions`,
`_getVaultPositionTotalsAtOracle`):**
- Today: values each position's DAI and wsXMR legs at the oracle
  price, then computes a USD-denominated CR.
- Oracle-free: the DAI leg counts as collateral at face value; the
  wsXMR leg nets against debt at face value. No cross-asset
  conversion. This is conservative — it values the collateral leg at
  1:1 and the wsXMR leg at 1:1 against debt, ignoring any pool
  mid-price gain or loss. The auction (§3.4) is the real solvency
  test; CR with positions becomes an informational display metric
  only, never a liquidation trigger.

**Drain / distribution (`_unwindAndDistribute`,
`_unwindAllVaultPositions`):**
- **Asset-type split (decided):** vault gets ALL `daiOut` (wrapped
  back to collateral shares), user gets ALL `wsxmrOut` (via
  `pendingReturns`). This is what the code already does today — no
  change needed. Each party gets their own asset back; the pool's
  internal price handles conversion at drain time. No oracle needed
  for the split itself.
- Pro-rata distribution (splitting both assets by contribution share)
  was considered and rejected: it would require valuing the original
  contributions relative to each other, which needs a price. The
  asset-type split is the oracle-free answer. Users who want pure
  wsXMR exposure can swap their returned DAI leg through the pool
  separately.

**Capacity (`getCoLPCapacity`):**
- Today: returns USD-priced max wsXMR acceptable.
- Oracle-free: `freeCollateral / threshold − debt` — vault-relative
  units. No USD pricing.

---

## 4. Oracle-touchpoint removal map

Every price consumer in the current codebase and its replacement:

| Location | Today | Oracle-free replacement |
|---|---|---|
| `MintFacet.initiateMint` capacity check | `freeCollateral × collateralPrice ≥ (debt+mint) × xmrPrice × 150%` | `freeCollateral ≥ (debt + pending + mint) × threshold` |
| `MintFacet` key-bond par reprice (×3) | `wsxmr × xmrPrice / collateralPrice` | `wsxmr × thresholdAtReady` |
| `MintRequest.xmrPriceAtReady` | oracle price at ready | `thresholdAtReady` (LP-declared rate) |
| `BurnFacet._requestBurn` lock | `debt × price × lock ratio` | proportional lock: `(burn/debt) × freeCollateral × BURN_LOCK_MULTIPLIER` |
| `BurnRequest.xmrPriceAtRequest` | oracle price at request | `thresholdAtRequest` |
| `BurnFacet.claimSlashedCollateral`, `_settleCommittedBurnSlash` | par via stored oracle price | par via `thresholdAtRequest` |
| `LiquidationFacet.liquidate` trigger | `CR < 120%` via oracle | kick + auction (§3.3/3.4) |
| `liquidate` seizure calc | `debt × bonus / collateralPrice` | auction clearing `X*` |
| `LiquidationFacet.backstopVault` | CR check via oracle | callable when vault FROZEN or after failed auction |
| `_unwindAllVaultPositions(xmrPrice)` / router `drainPosition` | priced distribution | **asset-type split (§3.7):** vault gets all DAI leg, user gets all wsXMR leg — no cross-asset conversion, no price need |
| `CoLPFacet.userOpenCoLP` slippage check | pool spot vs oracle-implied price ±0.5% | user-supplied `minLiquidity`/tick bounds — exactly what `NonfungiblePositionManager.mint` already takes natively |
| `CoLPFacet.getCoLPCapacity` / `rebalanceCoLP` | USD-priced capacity | vault-relative units: `freeCollateral / threshold − debt` |
| `VaultFacet.getMintCapacity` | CR formula via oracle | `min(maxMintWsxmr, freeCollateral/threshold − debt)` |
| `VaultFacet.getVaultHealth`, hub `getVaultHealth` | CR % via oracle | self-declared coverage: `freeCollateral / (debt × threshold)` — display semantic changes, documented |
| `VaultFacet._calculateCRWithPositions`, `_getVaultPositionTotalsAtOracle` | position value via oracle | vault-relative collateral totals only (positions count as their collateral leg at face, wsXMR leg nets against debt) |
| `VaultFacet` evictable-vault check | `collateral < 1% × max` | unchanged (already unit-relative, no price) |
| `YieldFacet` (all) | yield extraction, `triggerBuyAndBurn`, EMA trigger | **facet deleted** — zero-yield collateral makes it inert (see §8) |
| `SimpleOracleFacet`, `BnbOracleFacet`, `BaseOracleFacet`, `RobinhoodOracleFacet`, `RedStoneOracleFacet`, `IOracleFacet` | oracle push/read | **deleted** — hub registers no oracle facet |
| `wsXmrStorage` oracle plumbing | `lastXmrPrice`, `lastCollateralPrice`, `xmrEmaPrice`, `lastEmaSampleTime`, `_tryRefreshOracle*`, precompile consts, TWAP config, `priceUpdater` | **deleted** |
| `IOracleFacet.StalePrice` | reverts on stale | gone entirely — every path is usable at all times |

Result: **no entry point can revert on stale or missing price data.
The protocol cannot be frozen by a feed outage.**

---

## 5. Function surface (new/changed)

```
// VaultFacet
setThreshold(uint256 sharesPerWsxmr)
setMaxMintWsxmr(uint256 cap)            // replaces setMaxMintBps
repayDebt(uint256 wsxmrAmount)          // new: burn wsXMR to cut own debt

// LiquidationAuctionFacet (replaces LiquidationFacet)
kick(address vault)                     // post bond, open grace
bid(address vault)                      // pay debt, take X(t)% collateral
reauction(address vault)                // retry after inconclusive
backstopVault(address oldVault)         // unchanged semantics, new gate
cancelKickDuringGrace()                 // internal via deposit/repay

// views (semantics change)
getVaultHealth(lp) → coverage vs threshold (informational)
getMintCapacity(lp) → threshold-derived + quoted cap
auctionState(vault) → {phase, X(t), bond, kicker, endsAt}
```

Removed selectors: `updateOraclePrices`, `getXmrPrice*`,
`getCollateralPrice*`, `getXmrEmaPrice`, `getUpdateFee`,
`updatePrices`, `setPriceUpdater`, `refreshCollateralPrice`,
`refreshPrices`, `liquidate`, `calculateLiquidation`, all YieldFacet
selectors.

**ABI breakage note:** off-chain tooling (keeper, frontend, lp-server)
calling any removed selector will hard-fail. Since this is a fresh
redeploy (not a facet cut on the live hub), no on-chain selector shim
is needed — the new deployment ships with the reduced ABI. All
off-chain consumers must update to the new ABI at cutover. Version
the ABI bump in the deployment announcement.

---

## 6. Collateral accounting (already decided — carried over)

Per `AUCTION_LIQUIDATION.md` §8: drop the stata-share abstraction.
Collateral stored as raw underlying units normalized to 18-dec at the
boundary (`collateralDecimals` in deploy config). Removes
`StataCbBTC`/`StataQQQB`/`StataSPY`/`StataUSDe`, the `IERC4626` surface,
`convertToAssets` reads, `_daiToShares`/`_sharesToDai`, and all
yield-share bookkeeping (`lpPrincipalShares`, `globalLpPrincipalShares`,
`deployedSDAIShares`, `yieldWarChest`). `pendingReturns` stays,
re-denominated in underlying.

This halves the spec's blast radius: every `threshold`,
`lockedCollateral`, and auction quantity is denominated in the same
plain unit — no share/asset conversion layer under auction settlement.

---

## 7. What stays unchanged

- Atomic-swap state machines (MintStatus/BurnStatus transitions,
  Ed25519 2-of-2 key mechanics, timeouts, griefing deposits) — only
  par-settlement inputs change (threshold rate vs oracle price).
- `globalDebtIndex` normalized-debt accounting.
- `backstopVault` mechanism (re-gated to auction outcomes).
- `pendingReturns` payout rail.
- Diamond hub + selector routing (fresh deployment registers the
  reduced facet set).
- Co-LP mechanics other than priced distribution/slippage checks.

---

## 8. Cross-chain & Solana

Same model ports to the Anchor program: drop `oracle.rs` Pyth reads;
vault state gains `threshold_shares_per_wsxmr`; add kick/auction
instructions (bids transfer wsXMR to program-burn, collateral via
token account transfer). The Dutch auction mechanism itself is
straightforward on Solana. The kick bond escrow + grace window +
self-rescue (`AUCTION_OPEN_DELAY`) + per-vault cooldown state machine
needs careful account-locking design on Solana's parallel-execution
runtime, which has no per-account mutex — concurrent `kick`/`bid`/
`repayDebt` calls on the same vault must be serialized via account
ownership checks or a sequential state PDA. Not a blocker, but don't
underestimate the state-machine port.
Deploy once, consistent trust model on all four chains — and the
Pyth/Hermes API-key problem disappears on Solana too.

Gnosis deployment is EOL — no migration (code cleanup per existing
plan; its hub is already frozen with the feed).

---

## 9. Deployment

Fresh redeploy per chain (BNB, Base, Robinhood): wsXMR token, hub,
facets {Vault, Mint, Burn, LiquidationAuction, CoLP} (no oracle/yield
facets), router, pool, locks. Reuse `Deploy*.s.sol` minus oracle
wiring. Vaults need no price to open — threshold is LP-declared day
one, so there is no oracle cold-start gap. Pool seeds at market rate
by LP choice. Off-chain: lp-server oracle updater deleted; replaced
by kick watcher + optional seeded bidder. Frontend drops
`redstoneWrapper` entirely — price displays read any free API (DIA,
CoinGecko).

---

## 10. Failure modes & mitigations

| Risk | Mitigation |
|---|---|
| No bidders (auction liveness) | Freeze, never theft; seeded keeper in lp-server; `reauction`; `backstopVault` escape. Bond → kicker on no-bid (neutral, keeps kickers willing) |
| Solvent-vault griefing (LP offline) | `AUCTION_OPEN_DELAY` bid-locked rescue window after grace — LP gets guaranteed self-rescue time regardless of KICK_SANE classification |
| Kick griefing (marginally solvent vault) | Bond → LP on wrongful kick (`X* ≤ KICK_SANE`) or grace cancel; per-vault cooldown; bond scales with vault size |
| LP asleep during kick | Grace window + `AUCTION_OPEN_DELAY` rescue window; LP-server alerting; liveness is already a protocol assumption |
| Thin-bid sniping (clears at extreme haircut) | LP self-rescue until first bid (and through `AUCTION_OPEN_DELAY`); kicker `CHIP_BPS` incentivizes early honest kicks |
| Degenerate threshold quote | `MIN_THRESHOLD` floor + mint bound; over-quoting is self-harm |
| Proportional burn-lock roughness | `BURN_LOCK_MULTIPLIER` conservative-high; LP-tunable per vault later if needed |
| Cascade kicks | One kick per vault; cooldown; auction queueing optional post-v1 |
| Bad debt | Existing `globalBadDebt` + `backstopVault`; insurance fund later |
| `MIN_THRESHOLD` stale after collateral crash | No on-chain update; new mints pause until redeploy. Auction still catches insolvency regardless |

---

## 11. Testing & security review plan

- Port the solvency-invariant suite to threshold-relative invariants
  (collateral vs. `debt × threshold`; auction conservation: shares in =
  bidder + LP surplus + kicker chip).
- New suites: kick lifecycle (grace cancel, cooldown, bond payout
  paths), dutch math boundaries (t=0, t=end, overflow), in-flight
  request settlement under auction, frozen-vault gating, wrongful-kick
  classification at `KICK_SANE` boundary, proportional burn-lock
  round-trip, `AUCTION_OPEN_DELAY` bid-revert + LP self-rescue,
  no-bid bond return-to-kicker, solvent-vault griefing scenario
  (200% CR vault kicked, LP offline, rescue window expires, bid at
  X=100%).
- Fork tests per chain replicating today's ~900-case matrix.
- External review focused on: auction incentive compatibility, kick
  griefing economics, par-settlement fairness under threshold repricing.

---

## 12. Open questions

- `KICK_SANE_BPS` boundary value (80%?) — wrongful-kick classification.
- Whether `bid` supports partial-debt bids later (v1: whole-debt only).
- ~~Co-LP unwind distribution detail: proportional split of both legs —
  confirm no residual price need inside router `drainPosition`.~~
  **Resolved (§3.7):** asset-type split — vault gets DAI leg, user
  gets wsXMR leg. No pro-rata, no residual price need. The pool's
  internal price handles conversion at drain time.
- Auction bond/kick parameters governance — none post-lock; fixed at
  deploy. `MIN_THRESHOLD` is also fixed at deploy with no on-chain
  update path (§3.1). Acceptable since protocol is deliberately
  governance-minimal.
- Whether `setThreshold` needs a per-change cooldown to prevent
  threshold-jitter during a pending kick (kicks lock it anyway).
