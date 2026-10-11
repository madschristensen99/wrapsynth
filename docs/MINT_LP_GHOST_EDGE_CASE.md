# Mint-Side LP Ghost Protection & the Liquidation Edge Case

**Status:** Finding documented, fix proposed (not yet implemented)
**Date:** 2026-09-19
**Scope:** `ethereum/contracts/facets/MintFacet.sol`, `LiquidationFacet.sol`

---

## 1. Question

Does the mint side have a timeout-based `forceRefundMint` / `claimMintSlashedCollateral`
symmetric to the burn side's `forceSettleBurn`? If not, what protects a user whose LP
receives XMR and never calls `setMintReady`?

**Short answer:** No single symmetric function exists, but an equivalent protection
chain does — structured differently because the failure mode differs. On the burn side
the user's wsXMR is burned at request time, so the protocol must pay par value in
collateral. On the mint side the user's XMR sits at a **shared Monero address** that
neither party can spend alone, so the primary recovery is *getting the XMR back*, with
a collateral slash as the fallback.

## 2. The Protection Chain

| Stage | Mechanism | File:Line |
|-------|-----------|-----------|
| Bond posted | `provideLPKey` locks a par-value key bond (`MINT_LOCK_RATIO` = 110% of mint USD par) into `vault.lockedCollateral` before the user sends XMR | `MintFacet.sol:183-200` |
| Timeout | `cancelMint` (permissionless, post-`request.timeout`) moves `KEY_PROVIDED` → `KEY_CANCELLED` and parks the griefing deposit as a reveal bounty | `MintFacet.sol:438-444` |
| XMR recovery | `abandonKeyProvidedMint` pays the LP the parked deposit for revealing `lpSecret` on-chain; user combines it with `userSecret` to sweep the shared address | `MintFacet.sol:459-518` |
| Dead-LP slash | `reclaimParkedDeposit` (permissionless, after `LP_CLAIM_WINDOW_BLOCKS`) slashes the key bond to the user + returns the deposit | `MintFacet.sol:520-565` |
| Post-READY ghost | `cancelMint` moves `READY` → `EXPIRED_READY`; LP can claim deposit via `claimGriefingDeposit` (reveals `lpSecret` — same XMR recovery effect); else `sweepUnclaimedExpiredMint` slashes the re-priced par lock to the user | `MintFacet.sol:448-454, 567-660` |

Key invariant: the LP can never unilaterally take the XMR. Worst case it is stranded
at the shared address — a symmetric loss, not theft.

## 3. Finding: Liquidation Mid-Window

`liquidate()` bumps `vault.mintNonce` (`LiquidationFacet.sol:269`), which invalidates
in-flight mints. The slash paths gate on the nonce:

```solidity
// reclaimParkedDeposit / sweepUnclaimedExpiredMint
if (request.vaultMintNonce == vault.mintNonce) {
    // slash bond to user
} else if (vault.lockedCollateral >= request.lockedCollateral) {
    vault.lockedCollateral -= request.lockedCollateral;  // released back to vault
}
```

So when the vault was liquidated mid-mint and the LP never reveals `lpSecret`, the
bond is **released back to the (liquidated) LP's vault instead of slashed to the
stranded user**.

### What still works post-liquidation

- `abandonKeyProvidedMint` and `claimGriefingDeposit` have **no nonce check** — a live
  LP can still reveal `lpSecret`, claim the griefing deposit (ETH held by the
  contract, not vault collateral), and get the bond released.
- `cancelMint` has no nonce check — the mint still reaches `KEY_CANCELLED` /
  `EXPIRED_READY`.

So the gap is narrow: **dead LP + liquidated vault** → user recovers only the
griefing deposit; XMR stays unspendable at the shared address forever.

### Why the current behavior is wrong

The code comment says the bond "was already handled by liquidation" — but
`liquidate()` **never touches mint bonds** (L1: "Never seize locked collateral",
`LiquidationFacet.sol:223-227`). The bond shares are still sitting in the vault; the
nonce check merely routes them back to the LP's estate rather than to the user the LP
wronged. That is a policy choice, not a mechanical necessity — and it refunds the
wrong party.

Only in the vault-takeover path (`oldV.lockedCollateral = 0`,
`LiquidationFacet.sol:410`) is the bond genuinely gone — and the existing balance
guards already cover that case.

## 4. Proposed Fix

In `reclaimParkedDeposit` and `sweepUnclaimedExpiredMint`:

- **Remove** the `request.vaultMintNonce == vault.mintNonce` gate on the slash.
- **Keep** the balance guards (`vault.lockedCollateral >= request.lockedCollateral`,
  `vault.collateralShares >= request.lockedCollateral`) — they handle the takeover
  path where the bond was zeroed.

Net effect: if the bond shares exist, the stranded user receives them — liquidation
or not. ~10 lines deleted, no new logic.

### Explicitly unchanged

- Reveal paths (`abandonKeyProvidedMint`, `claimGriefingDeposit`) — already work
  post-liquidation; LP who reveals still gets bond + bounty. Correct as-is.
- Bond sizing — paying the full 110% bond is reasonable compensation for permanently
  stuck XMR (unlike the burn side, where the user's wsXMR is restorable value and the
  payout is par-capped).

## 5. Regression Test Plan

Add to `test/AuditRegressionTest.t.sol` (or `MintBurnCoverage.t.sol`):

1. `initiateMint` → `provideLPKey` (bond locked)
2. Liquidate the vault (`mintNonce` bumps)
3. `cancelMint` → `KEY_CANCELLED`; warp past `LP_CLAIM_WINDOW_BLOCKS`
4. `reclaimParkedDeposit`
5. Assert: `pendingReturns[user][collateralToken]` increased by the bond amount;
   `vault.lockedCollateral` decreased; bond did **not** return to vault free balance.

Mirror for `sweepUnclaimedExpiredMint` via the `READY` → `EXPIRED_READY` path.
