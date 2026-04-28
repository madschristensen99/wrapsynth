use anchor_lang::prelude::*;
use anchor_spl::token_2022::{Token2022, TransferChecked, transfer_checked};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::state::{GlobalState, PendingReturns};

/// Create a PendingReturns PDA for the signer. Must be called once before participating
/// in any flow that requires a pre-existing PendingReturns account.
pub fn initialize_pending_returns(ctx: Context<InitializePendingReturns>) -> Result<()> {
    let returns = &mut ctx.accounts.pending_returns;
    returns.owner = ctx.accounts.owner.key();
    returns.collateral_amount = 0;
    returns.sol_amount = 0;
    returns.bump = ctx.bumps.pending_returns;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializePendingReturns<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = PendingReturns::LEN,
        seeds = [PENDING_RETURNS_SEED, owner.key().as_ref()],
        bump,
    )]
    pub pending_returns: Account<'info, PendingReturns>,

    pub system_program: Program<'info, System>,
}

/// Withdraw pending collateral returns (pull-pattern, prevents DoS).
/// Equivalent to withdrawReturns(SDAI) in VaultManager.sol.
pub fn withdraw_collateral_returns(ctx: Context<WithdrawCollateralReturns>) -> Result<()> {
    let returns = &mut ctx.accounts.pending_returns;
    let amount = returns.collateral_amount;
    require!(amount > 0, WrapSynthError::ZeroAmount);

    // CEI: clear state before transfer
    returns.collateral_amount = 0;
    ctx.accounts.global_state.global_pending_collateral = ctx
        .accounts
        .global_state
        .global_pending_collateral
        .saturating_sub(amount);

    // Transfer from war_chest ATA (program-owned) to user
    let bump = ctx.accounts.global_state.bump;
    let seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[bump]];
    let signer_seeds = &[seeds];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.program_collateral_ata.to_account_info(),
            mint: ctx.accounts.collateral_mint.to_account_info(),
            to: ctx.accounts.user_collateral_ata.to_account_info(),
            authority: ctx.accounts.global_state.to_account_info(),
        },
        signer_seeds,
    );
    transfer_checked(cpi_ctx, amount, ctx.accounts.collateral_mint.decimals)?;

    msg!(
        "Withdrew {} collateral returns for {}",
        amount,
        ctx.accounts.owner.key()
    );
    Ok(())
}

/// Withdraw pending SOL returns.
/// Equivalent to withdrawReturns(address(0)) in VaultManager.sol.
pub fn withdraw_sol_returns(ctx: Context<WithdrawSolReturns>) -> Result<()> {
    let returns = &mut ctx.accounts.pending_returns;
    let amount = returns.sol_amount;
    require!(amount > 0, WrapSynthError::ZeroAmount);

    returns.sol_amount = 0;
    ctx.accounts.global_state.global_pending_sol = ctx
        .accounts
        .global_state
        .global_pending_sol
        .saturating_sub(amount);

    // Transfer SOL lamports from escrow account to owner
    **ctx.accounts.sol_escrow.try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.owner.try_borrow_mut_lamports()? += amount;

    msg!(
        "Withdrew {} lamports for {}",
        amount,
        ctx.accounts.owner.key()
    );
    Ok(())
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct WithdrawCollateralReturns<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [PENDING_RETURNS_SEED, owner.key().as_ref()],
        bump = pending_returns.bump,
        constraint = pending_returns.owner == owner.key() @ WrapSynthError::Unauthorized,
    )]
    pub pending_returns: Account<'info, PendingReturns>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    pub collateral_mint: InterfaceAccount<'info, Mint>,

    /// Program-owned collateral ATA (war chest + pending returns pool)
    #[account(mut)]
    pub program_collateral_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user_collateral_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct WithdrawSolReturns<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [PENDING_RETURNS_SEED, owner.key().as_ref()],
        bump = pending_returns.bump,
        constraint = pending_returns.owner == owner.key() @ WrapSynthError::Unauthorized,
    )]
    pub pending_returns: Account<'info, PendingReturns>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    /// Program-owned SOL escrow account holding griefing deposits
    /// CHECK: validated by seeds, lamport transfer is manual
    #[account(
        mut,
        seeds = [b"sol_escrow"],
        bump,
    )]
    pub sol_escrow: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}
