use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};
use crate::state::{GlobalState, Vault};

#[derive(Accounts)]
pub struct HarvestYield<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    
    #[account(
        mut,
        seeds = [GlobalState::SEED_PREFIX],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,
    
    #[account(
        mut,
        constraint = vault_collateral_account.mint == vault.collateral_mint
    )]
    pub vault_collateral_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = yield_account.mint == vault.collateral_mint
    )]
    pub yield_account: Account<'info, TokenAccount>,
    
    /// CHECK: PDA signer for vault
    #[account(
        seeds = [Vault::SEED_PREFIX, vault.lp_address.as_ref(), vault.collateral_mint.as_ref()],
        bump
    )]
    pub vault_signer: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<HarvestYield>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let global_state = &mut ctx.accounts.global_state;
    
    let actual_debt = vault.get_actual_debt(global_state.global_debt_index)?;
    
    if vault.lp_principal == 0 || actual_debt == 0 {
        msg!("No yield to harvest");
        return Ok(());
    }
    
    let current_collateral = vault.collateral_amount;
    
    if current_collateral > vault.lp_principal {
        let yield_amount = current_collateral
            .checked_sub(vault.lp_principal)
            .ok_or(error!(crate::error::ErrorCode::MathOverflow))?;
        
        global_state.yield_war_chest = global_state.yield_war_chest
            .checked_add(yield_amount)
            .ok_or(error!(crate::error::ErrorCode::MathOverflow))?;
        
        msg!("Yield harvested: {}", yield_amount);
        msg!("Total yield war chest: {}", global_state.yield_war_chest);
    } else {
        msg!("No positive yield to harvest");
    }
    
    Ok(())
}
