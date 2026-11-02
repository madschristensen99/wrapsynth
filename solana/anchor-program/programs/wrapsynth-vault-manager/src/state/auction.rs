use anchor_lang::prelude::*;

/// Bonded-kick Dutch haircut auction — the oracle-free replacement for
/// oracle-triggered liquidation (EVM Kick struct + KickPhase parity).
///
/// Lifecycle (times are unix seconds):
///   1. kick() posts a bond into the vault's bond-escrow PDA → GRACE opens.
///      The LP cancels by acting (deposit_collateral / repay_debt); the bond
///      is paid to the vault either way the kick resolves in the LP's favor.
///   2. After KICK_GRACE_SECONDS, keepers resolve in-flight burns and unwind
///      co-LP positions, then open_auction() snapshots offered_collateral
///      (free collateral; key bonds excluded) and bumps both nonces.
///   3. During AUCTION_OPEN_DELAY_SECONDS bids still revert — the LP may
///      repay_debt in full to cancel outright (bond → LP).
///   4. ACTIVE: X(t) decays linearly from HAIRCUT_START_BPS to
///      HAIRCUT_FLOOR_BPS over AUCTION_DURATION_SECONDS. First bid wins:
///      bidder burns the vault's FULL actual debt in wsXMR and receives X%
///      of offered_collateral. Kicker gets CHIP_BPS of the surplus; on a
///      wrongful kick (clearing X* ≤ KICK_SANE_BPS) the bond goes to the LP.
///   5. ENDED with no bid → resolve_kick freezes the vault; bond → kicker.
///      reauction retries discovery exactly once; backstop_vault lets a
///      healthy LP absorb a frozen vault.
///
/// No price is ever consulted — the auction discovers the settlement
/// haircut in the market.
#[account]
pub struct Auction {
    /// Vault this auction belongs to (one auction per vault)
    pub vault: Pubkey,
    /// Who posted the kick bond
    pub kicker: Pubkey,
    /// Bond held in the bond-escrow PDA (lamports)
    pub bond: u64,
    /// Kick timestamp
    pub kick_time: i64,
    /// kick_time + GRACE + OPEN_DELAY + DURATION — no-bid resolution point
    pub auction_end: i64,
    /// Free collateral snapshotted at open_auction (lamports)
    pub offered_collateral: u64,
    /// True once open_auction() ran the grace→auction transition
    pub auction_opened: bool,
    /// True while the kick is unresolved
    pub active: bool,
    /// True when this kick was started via reauction
    pub is_reauction: bool,
    pub bump: u8,
}

/// Mirrors the EVM KickPhase enum. GRACE → OPEN_DELAY → ACTIVE → ENDED.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum KickPhase {
    Grace,
    OpenDelay,
    Active,
    Ended,
}

impl Auction {
    /// 8 disc + 32*2 + 8*4 + 1*4 = 110 → pad to 128
    pub const LEN: usize = 128;
}
