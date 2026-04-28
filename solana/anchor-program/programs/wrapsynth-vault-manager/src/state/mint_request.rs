use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MintStatus {
    Invalid,
    Pending,
    Ready,
    Completed,
    Cancelled,
}

impl Default for MintStatus {
    fn default() -> Self {
        MintStatus::Invalid
    }
}

#[account]
pub struct MintRequest {
    /// Unique request identifier (hash of initiator+lp+xmr_amount+commitment+nonce)
    pub request_id: [u8; 32],
    /// Who paid the griefing deposit
    pub initiator: Pubkey,
    /// Destination for minted wsXMR
    pub recipient: Pubkey,
    /// LP vault pubkey
    pub lp_vault: Pubkey,
    /// XMR atomic units (12 decimals)
    pub xmr_amount: u64,
    /// wsXMR amount (8 decimals)
    pub wsxmr_amount: u64,
    /// Portion of wsxmr_amount going to LP as fee
    pub fee_amount: u64,
    /// Ed25519 commitment: keccak256(Px || Py) where P = secret * G
    pub claim_commitment: [u8; 32],
    /// Expiry unix timestamp
    pub timeout: i64,
    /// SOL lamports deposited as anti-spam
    pub griefing_deposit: u64,
    /// Normalized debt amount stored for consistent accounting
    pub normalized_debt_amount: u64,
    /// Snapshot of vault's mint_nonce at creation (for liquidation invalidation)
    pub vault_mint_nonce: u64,
    pub status: MintStatus,
    pub bump: u8,
}

impl MintRequest {
    /// 8 + 32 + 32*3 + 32 + 8*5 + 32 + 8 + 8*2 + 1 + 1 + padding = ~300
    pub const LEN: usize = 300;
}
