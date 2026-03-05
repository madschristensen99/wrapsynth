use anchor_lang::prelude::*;

#[account]
pub struct Vault {
    pub lp_address: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_amount: u64,
    pub locked_collateral: u64,
    pub normalized_debt: u64,
    pub pending_debt: u64,
    pub lp_principal: u64,
    pub mint_fee_bps: u16,
    pub burn_reward_bps: u16,
    pub max_mint_bps: u16,
    pub mint_griefing_deposit: u64,
    pub active: bool,
}

impl Vault {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 2 + 2 + 2 + 8 + 1;
    pub const SEED_PREFIX: &'static [u8] = b"vault";
    
    pub fn get_actual_debt(&self, global_debt_index: u64) -> Result<u64> {
        let debt_u128 = (self.normalized_debt as u128)
            .checked_mul(global_debt_index as u128)
            .ok_or(error!(crate::error::ErrorCode::MathOverflow))?;
        
        let actual_debt = debt_u128
            .checked_div(crate::state::GlobalState::DEBT_INDEX_PRECISION as u128)
            .ok_or(error!(crate::error::ErrorCode::MathOverflow))?;
        
        Ok(actual_debt as u64)
    }
    
    pub fn get_available_collateral(&self) -> u64 {
        self.collateral_amount.saturating_sub(self.locked_collateral)
    }
}
