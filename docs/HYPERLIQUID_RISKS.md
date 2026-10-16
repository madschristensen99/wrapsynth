# Hyperliquid Integration Risks

**Status:** Living document · October 2026
**Context:** WrapSynth previously deployed on HyperEVM (sUSDe collateral,
`HyperCoreOracleFacet` reading the native XMR perp's `oraclePx` via the
`0x0807` L1-read precompile). That deployment is deprecated. This document
records what we learned and the risks that must be resolved *before* any
future deeper integration with Hyperliquid's perp order books (HIP-1 CLOB
listing, HIP-3 partner-deployed wsXMR perp, or CoreWriter liquidations).

---

## 1. Why we stepped back

HyperEVM was attractive because it was the only venue offering a
**validator-maintained XMR/USD oracle with zero off-chain infrastructure**
(the native XMR perp's `oraclePx`). In practice, that convenience priced in
a stack of dependencies and product-direction risks that we now consider
unresolved:

1. The oracle's liveness is Hyperliquid platform risk, not ours — a
   delisting or halt of the native XMR perp pauses mints, burns, and
   liquidations on our side with no recourse.
2. The "Phase B" roadmap (HIP-1 CLOB, HIP-3 perp, CoreWriter liquidation
   path) deepens that coupling rather than reducing it, and forces USDC —
   a freezeable asset — into the critical settlement path.
3. Building leverage-bearing Monero derivatives on a venue that is actively
   expanding into prediction-market-style perps raises product-ethics and
   regulatory questions we had not fully priced in (see §4).

The multi-chain pivot (BNB / Base / Robinhood Chain, each with a RedStone
XMR pull + fully on-chain collateral TWAP) trades the "free" validator
oracle for an oracle model where **the only external input is a signed XMR
price** and everything else is settled on the deployment's own chain.

## 2. Technical risks of deep Hyperliquid coupling

| Risk | Mechanism | Consequence |
|---|---|---|
| Oracle liveness | `HyperCoreOracleFacet` reverts if the native XMR perp is halted or delisted | Mint/burn/liquidation pause; in-flight swaps still settle (fixed `xmrPriceAtRequest`), but new activity stops |
| Venue reflexivity | Using the wsXMR spot venue price for collateral ratios is reflexive — pumping wsXMR inflates apparent collateral health | The original spec mitigated this by *never* using the wsXMR venue for CR checks; any future design must keep that rule |
| CoreWriter timing | Phase-B liquidations execute on the next L1 block (~1s) rather than atomically in-tx | Worse execution semantics than a same-tx AMM swap; the CLOB's advantage is depth, not mechanics |
| Quote-asset capture | HIP-1 mandates USDC as the quote asset | Circle's `freeze`/`blacklist` powers enter the settlement path — the exact censorship failure mode this protocol exists to avoid |
| Stake + ops burden | Self-deployed HIP-3 needs a 500k HYPE stake and a 24/7 deployer-operated `setOracle` | Either treasury concentration or dependency on a partner deployer's honesty and uptime |

## 3. Platform and market-structure risks

- **Single-point platform risk.** HyperCore and HyperEVM share HyperBFT
  consensus and global state. That is elegant for bridging (the same wsXMR
  lives on both layers) but means a consensus halt, validator incident, or
  regulatory action against Hyperliquid takes down *both* the venue and
  the oracle simultaneously — correlated failure of our two most critical
  external dependencies.
- **Thin-venue price discovery.** A fresh wsXMR pool/CLOB book prints
  whatever thin liquidity allows. The mitigation — exogenous collateral
  pricing — works, but it means the *user-facing* wsXMR price can diverge
  from XMR/USD for long stretches, which produces bad UX and arb-driven
  vault stress until depth exists.
- **Partner-deployed HIP-3.** Offloading the perp to a staked partner
  removes our ops burden but makes a third party the oracle-of-record for
  a WrapSynth-branded product. Their mispricing (malice or downtime) is
  our reputational and solvency problem.

## 4. The prediction-market / assassination-market problem

This is the risk that most needs explicit discussion before any HIP-3
wsXMR perp or CLOB listing, and it is not purely technical.

**The mechanism.** Hyperliquid's HIP-3 permissionless perp listings are
already being used to create markets on real-world outcomes (elections,
geopolitical events, dates of events — effectively binary prediction
markets expressed as perps). A permissionless perp DEX combined with a
*private, untraceable* settlement asset is the textbook recipe for an
**assassination market**: a prediction market on whether a specific person
dies by a specific date, where the payout to the "yes" side is itself the
bounty. The concept predates crypto (Bell's "Assassination Politics",
1997); what has historically prevented it is the traceability of the money
flow. wsXMR exists to break exactly that traceability.

**Why this is specifically our problem.** wsXMR would not be the market —
it would be the *anonymous funding leg* for whatever markets get listed.
If Hyperliquid's venue evolves toward outcome-linked perps, "wrap XMR →
trade outcome perps → unwrap" becomes a fully private path to speculate
on — and thereby subsidize — real-world events, including harmful ones.
The deeper we integrate (native perp, CLOB liquidity, CoreWriter
liquidations), the more wsXMR becomes *infrastructure* for that flow
rather than merely compatible with it.

**Honest assessment of our leverage.** We cannot prevent anyone from
building a harmful market, and Monero itself already enables private
payments — wsXMR does not create a capability that did not exist. What
deeper Hyperliquid integration *would* do is (a) reduce friction for that
flow to near zero, and (b) legally and reputationally position WrapSynth
as a facilitating venue. The first is a magnitude problem, the second is
an accountability problem, and both are worsened the more "native" our
presence on the venue becomes.

**Open questions to resolve before revisiting:**

- What listing controls, if any, does the venue apply to outcome-linked
  perps, and would our presence (a branded spot token + perp) make us a
  facilitator in the eyes of the jurisdictions that would care?
- Is there an integration depth (spot pool only, no HIP-3, no CoreWriter)
  that captures HyperEVM's liquidity benefits without making us part of
  the perp-market plumbing?
- Does the protocol's own positioning ("no trusted intermediary") survive
  contact with a venue whose oracle we depend on and whose listing
  policies we don't control?

## 5. Conditions for reconsidering Hyperliquid

A future HyperEVM/HyperCore re-integration is reasonable **only if**:

1. The oracle dependency is replaced or hedged (e.g. RedStone primary +
   precompile as cross-check, not sole source).
2. No freezeable asset (USDC) sits in the settlement path — including the
   liquidation path and the CLOB quote leg.
3. The venue's stance on outcome-linked perps is understood well enough
   to argue §4 away, or our integration is deliberately scoped to exclude
   the flows that argument worries about.
4. Partner-vs-self HIP-3 tradeoffs are re-priced with current stake costs
   and a named partner.

Until then: BNB, Base, and Robinhood Chain deployments use RedStone for
XMR/USD and on-chain TWAP for collateral — one external signed feed, no
platform coupling, no perp infrastructure of ours on any venue.
