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
    /// User's Ed25519 commitment: keccak256(compress(secret · G))
    pub user_claim_commitment: [u8; 32],
    /// User's compressed Ed25519 public spend key (for Monero address derivation + slash verification)
    pub user_public_key: [u8; 32],
    /// User's Ed25519 public view key (x-coordinate)
    pub user_view_key: [u8; 32],
    /// XMR price snapshot at request time (par settlement for slashes)
    pub xmr_price_at_request: u64,
    /// Hash of LP's secret (set in propose_hash)
    pub secret_hash: [u8; 32],
    /// LP's Ed25519 public spend key (x-coordinate) — set at propose_hash
    pub lp_public_spend_key: [u8; 32],
    /// LP's Ed25519 public view key (x-coordinate) — set at propose_hash
    pub lp_public_view_key: [u8; 32],
    /// LP's revealed Ed25519 secret (set by reveal_burn_secret / finalize_burn)
    pub revealed_secret: [u8; 32],
    /// Deadline unix timestamp
    pub deadline: i64,
    /// Snapshot of vault liquidation nonce at creation
    pub vault_liquidation_nonce: u64,
    /// Normalized debt amount deducted at settlement (0 until then — debt is NOT
    /// reduced at request time, eliminating index-shift debt inflation bugs)
    pub normalized_debt_amount: u64,
    /// True when the LP abandoned a PROPOSED burn — the user's wsXMR remains
    /// claimable via resolve_declined_proposal (requires userSecret reveal)
    pub abandoned: bool,
    pub status: BurnStatus,
    pub bump: u8,
}

impl BurnRequest {
    /// 8 disc + 3*32 (ids) + 4*8 (amounts) + 8*32 (commitments/keys/secrets)
    /// + 8 (deadline) + 8 (nonce) + 8 (normalized) + 1 (abandoned) + 1 (status)
    /// + 1 (bump) + padding = ~440 → 512 for safety
    pub const LEN: usize = 512;
}
