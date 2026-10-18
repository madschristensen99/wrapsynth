# Oracle-Free Liquidation via Bonded-Kick Collateral Auctions

> **Status: concept / design exploration.** No code yet. This documents the
> architecture for removing the protocol's dependence on a signed price oracle
> (RedStone) in favor of market-discovered prices at the moments prices are
> actually needed.

## 1. Motivation

Every price-consuming entry point in the current deployment reads a stored
`lastXmrPrice` / `lastCollateralPrice`, pushed on-chain from a signed RedStone
data package. The dependency chain:

- RedStone is sunsetting its public pull-model gateways (progressive rejection
  windows → permanent shutdown 2026-10-29).
- Going forward, package fetches require a per-project API key issued via a
  manual form — permissioned, rate-limited (1 req/s), revocable, and attached
  to an identifiable account. For a privacy-coin protocol this is a structural
  liability: the feed can be declined, throttled, or dropped entirely.
- A WrapSynth-operated signer was considered and rejected: it relocates trust
  rather than removing it, and LPs have no reason to trust the deployer more
  than RedStone.

The only way to remove the dependency without relocating it is to stop
needing an external price reporter at all.

## 2. Key observation

The oracle answers exactly one question: the **XMR ↔ collateral exchange
rate**. In this codebase it is consumed in four places:

| Consumer | What the price is used for |
|---|---|
| `MintFacet.initiateMint` | Assign vault, check its collateral can back the mint |
| `BurnFacet.calculateBurnCollateral` | Collateral to lock during a redemption |
| `LiquidationFacet.liquidate` / `calculateLiquidation` | Trigger + seizure amount |
| `CoLPFacet.userOpenCoLP` / `rebalanceCoLP` / capacity / unwind distribution | Position sizing + settlement |

Of these, only **liquidation** is a safety-critical decision made by the
protocol itself. The others can be re-derived as self-interested quotes
(LP-quoted capacity) or user-supplied slippage bounds (pool-side protection),
because the party bearing the risk either sets the number or accepts it.

For liquidation, the mechanism below replaces the trigger: instead of the
protocol *measuring* insolvency with a reported price, it asks the market to
*prove* it — the auction clearing bid is itself the XMR/collateral rate,
delivered by rational bidders with real-world knowledge at exactly the moment
the rate matters.

This is the same discovery pattern used by Ajna (oracle-free lending),
MakerDAO liquidation auctions, and Liquity redemptions: prices arrive from
competitive settlement, not from a feed.

## 3. The mechanism

### 3.1 Kick lifecycle

```
           bond posted
  anyone ──────────────► kick(vault) ──► grace window (T_grace)
                                             │
                    LP tops up collateral /  │  window expires
                    repays debt              ▼
                          │              auction starts
                          ▼                  │
                     auction canceled ◄──────┤ bid arrives
                     (bond returned          ▼
                      + gas fee)      settlement:
                                      bestBid ≤ maxHaircut → liquidate
                                      no valid bid         → bad debt path
                                      auction inconclusive → vault freeze
```

- **`kick(address vault)`** — permissionless. Kicker posts a bond sized at
  ~1–2% of vault collateral value. The kick is only an *accusation*; it
  carries no price claim.
- **Grace window** (parameter `kickGraceBlocks`, ~1h at launch) — the LP can
  `depositCollateral` or repay debt. Either action cancels the auction. The
  kicker's bond is returned plus a gas stipend from the vault's future fees —
  kicks are cheap when wrong, free when right, and the LP proves solvency by
  *acting* rather than by citing a feed.
- **Per-vault cooldown** — one open kick per vault at a time; a failed kick
  imposes `kickCooldownBlocks` before the next, so griefing is rate-limited
  by bond capital.

### 3.2 The auction: collateral-haircut, debt-denominated

The auction does not ask bidders to name a price. It asks them to name a
**haircut**:

> "I will absorb this vault's outstanding debt `D` (wsXMR-denominated) in
> exchange for `X`% of its collateral."

- `X` starts at 100% and declines on a dutch curve over `auctionDuration`
  (24–72h at current liquidity, shortening as the bidder ecosystem matures).
- The first valid bid settles. The bidder burns `D` worth of wsXMR (or posts
  it for redemption) and receives `X`% of the vault's collateral shares.
- `X` < `maxHaircut` (e.g., 95%) → standard liquidation: the discount
  `(100 − X)%` is the market-priced liquidation bonus — same economics as the
  current fixed seize bonus, but discovered rather than parameterized.
- No bid arrives even at `X` = 100% by the end of the dutch window → the
  vault is **provably insolvent at market rates**: nobody will take its
  collateral for free in exchange for its debt. This is the bad-debt path,
  routed to `backstopVault` (existing hook) — honest recognition instead of
  an oracle that keeps insisting the vault is fine.
- The winning bid's implied rate (`debt / collateral received`) *is* the
  XMR/collateral price — market-delivered, no reporter.

Bid format (candidate): bidders commit `bidWsXmr` + `maxCollateralShare`, or
simply call `bid(vault, shares)` where the contract computes the current
auction's implied offer. Open ascending-bid (bidders undercut each other's `X`)
vs. sealed-then-reveal is an open design question — ascending is simpler and
better for price discovery at thin liquidity.

### 3.3 What happens to the vault's co-LP positions

A vault under auction first unwinds its open co-LP positions through the
pool itself (`_unwindAllVaultPositions` already exists). Pool settlement is
market-priced by definition — the pool is the venue. Position proceeds return
to the vault (LP share) and position users (their share) before the
collateral-haircut auction runs on the remainder.

### 3.4 Routine operations — no external price required

| Today (oracle-priced) | Oracle-free version |
|---|---|
| `maxMintBps` interpreted against oracle-valued collateral | LP self-quotes absolute capacity (`maxMintWsxmr`). Over-quoting only over-locks *their own* collateral — self-harm bounded. |
| `calculateBurnCollateral` locks `debt × price` of collateral | Proportional lock: burning `n%` of vault debt locks `n% × burnLockMultiplier` (~1.3×) of collateral shares. Crude, safe, LP-tunable. |
| `userOpenCoLP` reverts when pool spot deviates >0.5% from oracle-implied sqrt price ("Price slippage check") | User supplies `minLiquidity` / acceptable tick-range params — identical to how `NonfungiblePositionManager.mint` protects callers natively. The pool price *is* the price; the user states their tolerance. |
| `getCoLPCapacity` priced in USD terms | Capacity expressed in vault-relative units (shares + quoted cap). |
| `calculateLiquidation` preview | Preview becomes "auction clearing estimate" — off-chain computed, not a protocol input. |

### 3.5 Display-only prices

UI price displays ($ values) can keep fetching any public price API — they are
informational and never gate a transaction. Removing the oracle removes it
from *consensus*, not from the UI.

## 4. Failure modes & mitigations

| Risk | Mitigation |
|---|---|
| **Auction liveness** — no bidders show up | LP server ships a seeded-keeper mode that auto-bids a conservative haircut; kick incentive (`chip`) pays the kicker a small % of the bonus even if outbid; long initial windows. Liveness failure degrades to **vault freeze** (mints/withdrawals paused), never to theft. |
| **Kick griefing** — repeated frivolous kicks | Bond (~1–2% of collateral) burned/paid to LP on failed kicks; per-vault cooldown; kicker bond scales with vault size. |
| **Cascade auctions** — all vaults kicked in a crash | Auctions queue per collateral asset; settlement ordering prevents simultaneous fire-sales draining the bidder pool at once. |
| **Thin-bid manipulation** — single bidder clears at extreme haircut | Ascending-bid with a settlement delay (any better bid re-arms the close timer); the LP can always outbid during settlement by repaying — same as a "self-liquidation" escape hatch. |
| **Auctions during pool depeg** | Positions unwind through the pool at market; that is the correct behavior — a depeg is the market's verdict, not an oracle lag to be corrected. |
| **Bad debt** | `backstopVault` socialization (existing), sized insurance fund later. Explicit > silent. |

## 5. What exists vs. what's new

**Already in the codebase:**
- `_unwindAllVaultPositions` — market-priced position unwind
- `backstopVault` — bad-debt hook
- `claimSlashedCollateral` — proceeds-claim plumbing pattern
- LP server daemon — natural seeded bidder
- Diamond architecture — facets are replaceable without redeploying the hub

**New:**
- `LiquidationAuctionFacet` — kick lifecycle, bonds, grace, dutch curve, bid
  bookkeeping, settlement, freeze state
- Vault-state additions: `kickState { kicker, bond, kickBlock, auctionStart }`,
  freeze flag
- Re-derivation of the priced paths listed in §3.4 (mostly mechanical:
  replace price-multiplied quantities with share-proportional quantities)
- LP-server keeper: kick monitor, auto-bidder, auction watcher
- Frontend: auction status display, LP grace-window alerts, bid UI (later —
  bidders can be bots-only initially)

## 6. Parameters (initial guesses, all governable)

| Param | Initial | Notes |
|---|---|---|
| `kickBondBps` | ~150–200 bps of vault collateral | Spam deterrent |
| `kickGraceBlocks` | ~1h | LP top-up window |
| `kickCooldownBlocks` | ~6h | Post-failed-kick rate limit |
| `auctionDuration` | 24–72h | Shrinks as bidders mature |
| `maxHaircut` | ~95% | Liquidation bonus ceiling |
| `chipBps` | ~50 bps of bonus | Kick incentive on success |
| `burnLockMultiplier` | ~1.3× | Proportional burn-lock ratio |

## 7. Migration path (diamond upgrade)

1. Ship `LiquidationAuctionFacet`; cut it alongside the existing
   `LiquidationFacet` (both live; oracle path stays as fallback during
   transition).
2. Re-derive priced functions per §3.4 behind the same selectors.
3. Deprecate oracle reads for liquidation triggers; keep `updateOraclePrices`
   for display/reference until the last consumer is removed.
4. Remove `RedStoneConsumerBase` dependency in a final cleanup cut —
   `StalePrice` reverts disappear entirely.

## 8. Collateral accounting: drop the share/yield abstraction

Same redesign pass, second half: the collateral pivot (USDe → QQQB/cbBTC/SPY
tokenized assets) makes the stata-share machinery vestigial. These assets
appreciate in *price*; there is no on-chain yield to harvest, so on BNB and
Base the stata wrappers are already pure pass-throughs (fixed SCALE ratio,
nothing to collect).

**Decision recorded:** yield-bearing cbBTC venues exist (Aave aCbBTC etc.)
but wrapping collateral in a lending market adds third-party smart-contract
risk for a yield that isn't worth it. The collateral thesis is price
appreciation, not carry — so the adapter pattern's optionality is being given
up deliberately.

**Remove in v2:**
- `collateralShares` / `lpPrincipalShares` / `deployedSDAIShares` /
  `globalLpPrincipalShares` → store **raw underlying units** directly
- The stata wrapper contracts themselves (`StataCbBTC`, `StataQQQB`,
  `StataSPY`) — collateral sits in the hub as the naked ERC-20
- `ISavingsDAI` adapter surface (`deposit`/`redeem`/`convertToShares`/
  `convertToAssets`) — call sites operate on underlying directly
- `YieldFacet` — `syncVaultYield`, `getVaultExtractableYield`,
  `triggerBuyAndBurn`, the yield war chest: all inert on zero-yield
  collateral, all removed (a dead `buyAndBurn` that can never fire is strictly
  worse than no `buyAndBurn`)
- Every `_syncVaultYield` call threaded through Mint/Burn/Liquidation/CoLP —
  pure gas overhead today

**Keep:**
- `pendingReturns` — it is *not* yield; it is the general payout rail (co-LP
  fee shares, position leftovers, slash refunds, keeper rewards, liquidation
  payouts). Stays, re-denominated in raw underlying instead of shares.
- The 18-decimals assumption, if convenient — normalize all collateral to
  internal 18-dec at the boundary (cbBTC: `amount × 1e10`) rather than via a
  wrapper contract, OR carry per-chain `collateralDecimals` in storage.
  Pick whichever produces less per-chain divergence in the facets; the
  stata wrapper's only remaining value was hiding this scaling, and a
  constant in the vault config hides it for free.

**Migration:** this is the disruptive half — vault storage is
share-denominated end-to-end, so v2 is a redeploy-grade change, not a facet
patch. New vaults register under the new accounting; existing vaults migrate
by redeem-then-redeposit (wrapper redemption is trivial since shares are
1:1×SCALE with underlying). The auction-liquidation cut already forces a
collateral-accounting rewrite — bundling this in costs ~nothing extra.

**Frontend fallout (small):** every `convertToAssets` read goes away;
collateral displays read underlying directly (also fixes the share-vs-asset
decimals class of bugs — e.g., the TVL 10¹⁰ blow-up — permanently).

## 9. Open questions

- Bid mechanics: ascending public bids vs. commit-reveal (thin markets favor
  ascending).
- Should `bid` require wsXMR up front, or accept a claim-then-settle model
  (winner posts within N blocks or forfeits bid-bond)?
- How co-LP user shares interleave with the haircut — senior/junior
  tranching of position proceeds vs. pro-rata.
- Whether mint routing ever needs a *cross-vault* capacity comparison that
  reintroduces a relative-value input (probably not — routing is greedy by
  available quoted capacity).
- Governance over the parameters in §6 — likely deployer-multisig initially,
  same as current upgrade powers.
