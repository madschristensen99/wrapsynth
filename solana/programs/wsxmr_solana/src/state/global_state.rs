use anchor_lang::prelude::*;

#[account]
pub struct GlobalState {
    pub mint_authority_bump: u8,
    pub global_debt_index: u64,
    pub yield_war_chest: u64,
    pub global_lp_principal: u64,
    pub last_buy_timestamp: i64,
    pub price_max_age: u64,
    pub wsxmr_mint: Pubkey,
    pub admin: Pubkey,
}

impl GlobalState {
    pub const LEN: usize = 8 + 1 + 8 + 8 + 8 + 8 + 8 + 32 + 32;
    pub const SEED_PREFIX: &'static [u8] = b"global_state";
    
    pub const DEBT_INDEX_PRECISION: u64 = 1_000_000_000_000_000_000; // 1e18
}
