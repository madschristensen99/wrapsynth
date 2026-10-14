use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MintStatus {
    Invalid,
    Pending,
    KeyProvided,
    Ready,
    SecretRevealed,
    Completed,
    Cancelled,
    KeyCancelled,
    ExpiredReady,
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
    /// Ed25519 commitment: keccak256(compress(secret · G)) binding the user's secret
    pub claim_commitment: [u8; 32],
    /// User's compressed Ed25519 public spend key (for Monero address derivation)
    pub user_public_key: [u8; 32],
    /// LP's Ed25519 public spend key (x-coordinate) — set at provide_lp_key
    pub lp_public_spend_key: [u8; 32],
    /// LP's Ed25519 public view key (x-coordinate) — set at provide_lp_key
    pub lp_public_view_key: [u8; 32],
    /// LP's Ed25519 commitment: keccak256(compress(lp_secret · G))
    pub lp_commitment: [u8; 32],
    /// Expiry unix timestamp (also reused as the LP claim-window deadline for
    /// KeyCancelled / ExpiredReady states)
    pub timeout: i64,
    /// SOL lamports deposited as anti-spam
    pub griefing_deposit: u64,
    /// Collateral shares locked as the key bond (provide_lp_key) / par lock (set_mint_ready)
    pub locked_collateral: u64,
    /// XMR price snapshot at set_mint_ready (par settlement), 1e18-scaled USD
    pub xmr_price_at_ready: u128,
    /// Normalized debt amount stored for consistent accounting
    pub normalized_debt_amount: u64,
    /// Snapshot of vault's mint_nonce at creation (for liquidation invalidation)
    pub vault_mint_nonce: u64,
    /// User's revealed Ed25519 secret (set by reveal_secret, read by finalize_mint)
    pub revealed_secret: [u8; 32],
    pub status: MintStatus,
    pub bump: u8,
}

impl MintRequest {
    /// 8 disc + 4*32 (request_id, initiator, recipient, lp_vault) + 3*8 (amounts)
    /// + 5*32 (commitments/keys) + 5*8 (timeout, deposit, lock, price, nonce)
    /// + 32 (revealed_secret) + 1 (status) + 1 (bump) + padding = ~400 → 512 for safety
    pub const LEN: usize = 512;
}
