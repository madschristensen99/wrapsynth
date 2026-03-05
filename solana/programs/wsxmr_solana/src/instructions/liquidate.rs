use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Burn, Transfer};
use crate::state::{GlobalState, Vault};
use crate::error::ErrorCode;
use crate::constants::{LIQUIDATION_RATIO, LIQUIDATION_BONUS};

#[derive(Accounts)]
pub struct Liquidate<'info> {
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
        constraint = wsxmr_mint.key() == global_state.wsxmr_mint
    )]
    pub wsxmr_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = liquidator_wsxmr_account.mint == wsxmr_mint.key(),
        constraint = liquidator_wsxmr_account.owner == liquidator.key()
    )]
    pub liquidator_wsxmr_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = vault_collateral_account.mint == vault.collateral_mint
    )]
    pub vault_collateral_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = liquidator_collateral_account.mint == vault.collateral_mint,
        constraint = liquidator_collateral_account.owner == liquidator.key()
    )]
    pub liquidator_collateral_account: Account<'info, TokenAccount>,
    
    /// CHECK: PDA signer for vault
    #[account(
        seeds = [Vault::SEED_PREFIX, vault.lp_address.as_ref(), vault.collateral_mint.as_ref()],
        bump
    )]
    pub vault_signer: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub liquidator: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Liquidate>, debt_amount: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let global_state = &ctx.accounts.global_state;
    
    let actual_debt = vault.get_actual_debt(global_state.global_debt_index)?;
    
    require!(
        debt_amount <= actual_debt,
        ErrorCode::InsufficientCollateral
    );
    
    // TODO: Replace with actual oracle integration
    let xmr_price: i64 = 15000000000; // $150
    let xmr_exp: i32 = -8;
    let coll_price: i64 = 200000000000; // $2000
    let coll_exp: i32 = -8;
    
    let debt_value = crate::utils::calculate_usd_value(
        actual_debt,
        xmr_price,
        xmr_exp,
        crate::constants::WSXMR_DECIMALS,
    )?;
    
    let collateral_value = crate::utils::calculate_usd_value(
        vault.get_available_collateral(),
        coll_price,
        coll_exp,
        6, // Assuming 6 decimals
    )?;
    
    let health_ratio = crate::utils::calculate_collateral_ratio(
        collateral_value,
        debt_value,
    )?;
    
    require!(
        health_ratio < LIQUIDATION_RATIO,
        ErrorCode::VaultHealthTooLow
    );
    
    let debt_to_liquidate_value = crate::utils::calculate_usd_value(
        debt_amount,
        xmr_price,
        xmr_exp,
        crate::constants::WSXMR_DECIMALS,
    )?;
    
    let collateral_value_with_bonus = debt_to_liquidate_value
        .checked_mul(LIQUIDATION_BONUS as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?
        .checked_div(100)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    let collateral_to_seize = collateral_value_with_bonus
        .checked_mul(10u128.pow(6))
        .ok_or(error!(ErrorCode::MathOverflow))?
        .checked_div(coll_price.abs() as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    let collateral_to_seize_u64 = if collateral_to_seize > u64::MAX as u128 {
        return Err(error!(ErrorCode::MathOverflow));
    } else {
        collateral_to_seize as u64
    };
    
    require!(
        vault.get_available_collateral() >= collateral_to_seize_u64,
        ErrorCode::InsufficientCollateral
    );
    
    let burn_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Burn {
            mint: ctx.accounts.wsxmr_mint.to_account_info(),
            from: ctx.accounts.liquidator_wsxmr_account.to_account_info(),
            authority: ctx.accounts.liquidator.to_account_info(),
        },
    );
    token::burn(burn_ctx, debt_amount)?;
    
    let vault_seeds = &[
        Vault::SEED_PREFIX,
        vault.lp_address.as_ref(),
        vault.collateral_mint.as_ref(),
        &[ctx.bumps.vault_signer],
    ];
    let signer_seeds = &[&vault_seeds[..]];
    
    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_collateral_account.to_account_info(),
            to: ctx.accounts.liquidator_collateral_account.to_account_info(),
            authority: ctx.accounts.vault_signer.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, collateral_to_seize_u64)?;
    
    vault.collateral_amount = vault.collateral_amount
        .checked_sub(collateral_to_seize_u64)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    let normalized_debt_reduction = (debt_amount as u128)
        .checked_mul(GlobalState::DEBT_INDEX_PRECISION as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?
        .checked_div(global_state.global_debt_index as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    vault.normalized_debt = vault.normalized_debt
        .checked_sub(normalized_debt_reduction as u64)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    msg!("Vault liquidated");
    msg!("Debt liquidated: {}", debt_amount);
    msg!("Collateral seized: {} (with {}% bonus)", collateral_to_seize_u64, LIQUIDATION_BONUS - 100);
    msg!("New vault health ratio: {}", health_ratio);
    
    Ok(())
}
