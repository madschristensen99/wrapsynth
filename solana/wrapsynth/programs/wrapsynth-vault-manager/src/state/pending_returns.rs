use anchor_lang::prelude::*;

#[account]
pub struct PendingReturns {
    pub owner: Pubkey,
    /// Pending collateral token withdrawals
    pub collateral_amount: u64,
    /// Pending SOL (lamport) withdrawals
    pub sol_amount: u64,
    pub bump: u8,
}

impl PendingReturns {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 1 + 7; // = 64
}
