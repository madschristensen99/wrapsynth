use anchor_lang::prelude::*;

/// A co-LP position: a user pairs wsXMR with an LP vault's idle sUSDe collateral
/// to open a concentrated-liquidity position on Orca Whirlpools (EVM
/// PositionMetadata parity). The vault manager program is the position authority;
/// the Orca Position account is referenced by `position_address`.
#[account]
pub struct CoLPPosition {
    /// LP vault that supplied the collateral leg
    pub vault: Pubkey,
    /// User that supplied the wsXMR leg
    pub user: Pubkey,
    /// sUSDe shares deployed from the vault (9 decimals)
    pub collateral_original: u64,
    /// wsXMR deployed by the user (8 decimals)
    pub wsxmr_original: u64,
    /// Lower tick of the concentrated range
    pub tick_lower: i32,
    /// Upper tick of the concentrated range
    pub tick_upper: i32,
    /// Liquidity units deployed (Orca Position.liquidity)
    pub liquidity: u128,
    /// Orca Whirlpools Position account address
    pub position_address: Pubkey,
    /// Unix timestamp of position creation
    pub created_at: i64,
    /// Nonce used in the PDA seed (global request nonce at creation)
    pub nonce: u64,
    pub bump: u8,
}

impl CoLPPosition {
    /// 8 disc + 32 + 32 + 8 + 8 + 4 + 4 + 16 + 32 + 8 + 8 + 1 = 161 → pad to 168
    pub const LEN: usize = 168;
}
