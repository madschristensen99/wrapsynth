use anchor_lang::prelude::*;
use crate::state::{GlobalState, Vault, BurnRequest, BurnStatus};
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct ProposeBurn<'info> {
    #[account(
        mut,
        constraint = burn_request.get_status() == BurnStatus::Requested @ ErrorCode::InvalidRequestStatus,
        constraint = burn_request.lp_vault == vault.key()
    )]
    pub burn_request: Account<'info, BurnRequest>,
    
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    
    #[account(
        seeds = [GlobalState::SEED_PREFIX],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,
    
    #[account(
        constraint = lp.key() == vault.lp_address @ ErrorCode::Unauthorized
    )]
    pub lp: Signer<'info>,
}

pub fn handler(ctx: Context<ProposeBurn>, secret_hash: [u8; 32]) -> Result<()> {
    let burn_request = &mut ctx.accounts.burn_request;
    let vault = &mut ctx.accounts.vault;
    let _global_state = &ctx.accounts.global_state;
    
    burn_request.secret_hash = secret_hash;
    
    // TODO: Replace with actual oracle integration
    let xmr_price: i64 = 15000000000; // $150 with -8 exponent
    let xmr_exp: i32 = -8;
    let coll_price: i64 = 200000000000; // $2000 with -8 exponent  
    let _coll_exp: i32 = -8;
    
    let debt_value = crate::utils::calculate_usd_value(
        burn_request.wsxmr_amount,
        xmr_price,
        xmr_exp,
        crate::constants::WSXMR_DECIMALS,
    )?;
    
    let locked_collateral = crate::utils::calculate_required_collateral(
        debt_value,
        coll_price.abs() as u128,
        6, // Assuming 6 decimals for collateral
    )?;
    
    let reward_amount = crate::utils::apply_bps_fee(
        locked_collateral,
        vault.burn_reward_bps,
    )?;
    
    let total_locked = locked_collateral
        .checked_add(reward_amount)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    require!(
        vault.get_available_collateral() >= total_locked,
        ErrorCode::InsufficientCollateral
    );
    
    vault.locked_collateral = vault.locked_collateral
        .checked_add(total_locked)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    burn_request.locked_collateral = locked_collateral;
    burn_request.reward_collateral = reward_amount;
    burn_request.set_status(BurnStatus::Proposed);
    
    msg!("Burn proposed by LP");
    msg!("Locked collateral: {}, Reward: {}", locked_collateral, reward_amount);
    
    Ok(())
}
