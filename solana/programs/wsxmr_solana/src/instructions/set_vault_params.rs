use anchor_lang::prelude::*;
use crate::state::Vault;
use crate::error::ErrorCode;
use crate::constants::BPS_DENOMINATOR;

#[derive(Accounts)]
pub struct SetVaultParams<'info> {
    #[account(
        mut,
        constraint = lp.key() == vault.lp_address @ ErrorCode::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    
    pub lp: Signer<'info>,
}

pub fn handler(
    ctx: Context<SetVaultParams>,
    mint_fee_bps: u16,
    burn_reward_bps: u16,
    max_mint_bps: u16,
    mint_griefing_deposit: u64,
    active: bool,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    
    require!(
        mint_fee_bps <= BPS_DENOMINATOR && 
        burn_reward_bps <= BPS_DENOMINATOR && 
        max_mint_bps <= BPS_DENOMINATOR,
        ErrorCode::InvalidFeeParameters
    );
    
    vault.mint_fee_bps = mint_fee_bps;
    vault.burn_reward_bps = burn_reward_bps;
    vault.max_mint_bps = max_mint_bps;
    vault.mint_griefing_deposit = mint_griefing_deposit;
    vault.active = active;
    
    msg!("Vault parameters updated");
    msg!("Mint fee: {} bps, Burn reward: {} bps", mint_fee_bps, burn_reward_bps);
    msg!("Max mint: {} bps, Griefing deposit: {}", max_mint_bps, mint_griefing_deposit);
    msg!("Active: {}", active);
    
    Ok(())
}
