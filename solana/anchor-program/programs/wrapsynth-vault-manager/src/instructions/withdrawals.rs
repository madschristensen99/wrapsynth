use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;

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
    pub pending_returns: Box<Account<'info, PendingReturns>>,

    pub system_program: Program<'info, System>,
}

/// Withdraw pending collateral returns (pull-pattern, prevents DoS).
/// Collateral is native SOL — pays lamports from the program collateral pool.
pub fn withdraw_collateral_returns(ctx: Context<WithdrawCollateralReturns>) -> Result<()> {
    let returns = &mut ctx.accounts.pending_returns;
    let amount = returns.collateral_amount;
    require!(amount > 0, WrapSynthError::ZeroAmount);

    // CEI: clear state before transfer
    returns.collateral_amount = 0;
    let __global_pending_collateral_cur =
        ctx.accounts.global_state.load()?.global_pending_collateral;
    ctx.accounts
        .global_state
        .load_mut()?
        .global_pending_collateral = __global_pending_collateral_cur.saturating_sub(amount);

    // Transfer lamports from the program collateral pool escrow to owner
    let bump = ctx.bumps.collateral_escrow;
    let seeds: &[&[u8]] = &[PROGRAM_COLLATERAL_SEED, &[bump]];
    invoke_signed(
        &system_instruction::transfer(
            &ctx.accounts.collateral_escrow.key(),
            &ctx.accounts.owner.key(),
            amount,
        ),
        &[
            ctx.accounts.collateral_escrow.to_account_info(),
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[seeds],
    )?;

    msg!(
        "Withdrew {} lamports of collateral returns for {}",
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
    let __global_pending_sol_cur = ctx.accounts.global_state.load()?.global_pending_sol;
    ctx.accounts.global_state.load_mut()?.global_pending_sol =
        __global_pending_sol_cur.saturating_sub(amount);

    // Transfer SOL lamports from escrow account to owner
    let bump = ctx.bumps.sol_escrow;
    let seeds: &[&[u8]] = &[b"sol_escrow", &[bump]];
    invoke_signed(
        &system_instruction::transfer(
            &ctx.accounts.sol_escrow.key(),
            &ctx.accounts.owner.key(),
            amount,
        ),
        &[
            ctx.accounts.sol_escrow.to_account_info(),
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[seeds],
    )?;

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
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [PENDING_RETURNS_SEED, owner.key().as_ref()],
        bump = pending_returns.bump,
        constraint = pending_returns.owner == owner.key() @ WrapSynthError::Unauthorized,
    )]
    pub pending_returns: Box<Account<'info, PendingReturns>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    /// CHECK: lamport-only program collateral escrow (pending returns pool)
    #[account(
        mut,
        seeds = [PROGRAM_COLLATERAL_SEED],
        bump,
    )]
    pub collateral_escrow: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
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
    pub pending_returns: Box<Account<'info, PendingReturns>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

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
