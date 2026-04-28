use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum BurnStatus {
    Invalid,
    /// Step 1: wsXMR burned, collateral locked (not escrowed, still liquidatable)
    Requested,
    /// Step 2: LP proposed secretHash (waiting for user confirmation)
    Proposed,
    /// Step 3: User confirmed Monero lock (slashing timer T2 starts)
    Committed,
    /// Step 4: LP revealed secret, locked collateral released
    Completed,
    /// LP failed to reveal secret after user confirmation
    Slashed,
    /// Cancelled before user confirmation
    Cancelled,
}

impl Default for BurnStatus {
    fn default() -> Self {
        BurnStatus::Invalid
    }
}

#[account]
pub struct BurnRequest {
    pub request_id: [u8; 32],
    pub user: Pubkey,
    pub lp_vault: Pubkey,
    /// wsXMR burned (8 decimals)
    pub wsxmr_amount: u64,
    /// Equivalent XMR atomic units (12 decimals)
    pub xmr_amount: u64,
    /// Base collateral locked for this burn
    pub locked_collateral: u64,
    /// Extra collateral locked as burn reward
    pub reward_collateral: u64,
    /// Hash of LP's secret (set in propose_hash)
    pub secret_hash: [u8; 32],
    /// Deadline unix timestamp
    pub deadline: i64,
    /// Snapshot of vault liquidation nonce at creation
    pub vault_liquidation_nonce: u64,
    /// Normalized debt amount deducted when burn was requested
    pub normalized_debt_amount: u64,
    pub status: BurnStatus,
    pub bump: u8,
}

impl BurnRequest {
    /// 8 + 32 + 32*2 + 8*6 + 32 + 8 + 8*2 + 1 + 1 + padding = ~270
    pub const LEN: usize = 280;
}
