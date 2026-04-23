use anchor_lang::prelude::*;
use anchor_spl::token_2022::{
    Token2022, Burn as BurnCpi, burn as burn_tokens,
    TransferChecked, transfer_checked,
};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::state::{GlobalState, Vault, BurnRequest, BurnStatus, PendingReturns};
use crate::utils::{
    get_xmr_price, get_collateral_price,
    math::{
        get_actual_debt, normalize_debt, collateral_value_for_debt,
        usd_to_collateral, collateral_to_usd, calculate_collateral_ratio,
    },
};
use crate::instructions::vault_management::sync_vault_yield;

// ─── resolve_burn_for_liquidation ─────────────────────────────────────────────
// Phase 1: Called once per active burn request on a to-be-liquidated vault.
// Resolves REQUESTED/PROPOSED burns (re-mint to user) or COMMITTED burns (slash to user).

pub fn resolve_burn_for_liquidation(ctx: Context<ResolveBurnForLiquidation>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let global = &ctx.accounts.global_state;

    // Verify the vault is actually liquidatable before resolving burns
    let actual_debt = get_actual_debt(vault.normalized_debt, global.global_debt_index);
    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &global.pyth_collateral_feed.to_bytes(),
    )?;
    let col_usd = collateral_to_usd(vault.collateral_amount, col_price);
    let debt_usd = (actual_debt as u128 * xmr_price as u128 / WSXMR_DECIMALS as u128) as u64;
    let ratio = calculate_collateral_ratio(col_usd, debt_usd);
    require!(ratio < LIQUIDATION_RATIO, WrapSynthError::VaultHealthy);

    let request = &mut ctx.accounts.burn_request;
    require!(
        request.lp_vault == ctx.accounts.vault.key(),
        WrapSynthError::InvalidBurnRequest
    );

    let total_locked = request.locked_collateral + request.reward_collateral;

    match request.status {
        BurnStatus::Requested | BurnStatus::Proposed => {
            // LP has not yet committed XMR — re-mint wsXMR to user and restore debt
            let vault = &mut ctx.accounts.vault;
            let global = &mut ctx.accounts.global_state;

            // Restore normalized debt
            let max_normalized = normalize_debt(request.wsxmr_amount, global.global_debt_index);
            let safe_normalized = request.normalized_debt_amount.min(max_normalized);
            vault.normalized_debt = vault
                .normalized_debt
                .checked_add(safe_normalized)
                .ok_or(WrapSynthError::MathOverflow)?;
            global.global_total_debt = global
                .global_total_debt
                .checked_add(request.wsxmr_amount)
                .ok_or(WrapSynthError::MathOverflow)?;
            global.global_pending_burn_debt = global
                .global_pending_burn_debt
                .saturating_sub(request.wsxmr_amount);

            // Unlock collateral back to liquid
            vault.locked_collateral = vault.locked_collateral.saturating_sub(total_locked);
            vault.collateral_amount = vault
                .collateral_amount
                .checked_add(total_locked)
                .ok_or(WrapSynthError::MathOverflow)?;
            vault.active_burn_count = vault.active_burn_count.saturating_sub(1);

            // Re-mint wsXMR to user
            let bump = global.bump;
            let seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[bump]];
            let signer_seeds = &[seeds];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::MintTo {
                    mint: ctx.accounts.wsxmr_mint.to_account_info(),
                    to: ctx.accounts.user_wsxmr_ata.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                signer_seeds,
            );
            anchor_spl::token_interface::mint_to(cpi_ctx, request.wsxmr_amount)?;

            request.status = BurnStatus::Cancelled;
            msg!("Burn {:?} re-minted to user (pre-liquidation)", request.request_id);
        }
        BurnStatus::Committed => {
            // User confirmed Monero lock — slash locked collateral to user
            let vault = &mut ctx.accounts.vault;
            let global = &mut ctx.accounts.global_state;

            vault.locked_collateral = vault.locked_collateral.saturating_sub(total_locked);
            vault.active_burn_count = vault.active_burn_count.saturating_sub(1);

            ctx.accounts.user_pending_returns.collateral_amount = ctx
                .accounts
                .user_pending_returns
                .collateral_amount
                .checked_add(total_locked)
                .ok_or(WrapSynthError::MathOverflow)?;
            global.global_pending_collateral = global
                .global_pending_collateral
                .checked_add(total_locked)
                .ok_or(WrapSynthError::MathOverflow)?;
            global.global_pending_burn_debt = global
                .global_pending_burn_debt
                .saturating_sub(request.wsxmr_amount);

            request.status = BurnStatus::Slashed;
            msg!("Burn {:?} slashed to user (liquidation)", request.request_id);
        }
        _ => return err!(WrapSynthError::InvalidStatus),
    }

    Ok(())
}

// ─── execute_liquidation ──────────────────────────────────────────────────────
// Phase 2: Called after all active burns are resolved (active_burn_count == 0).

pub fn execute_liquidation(ctx: Context<ExecuteLiquidation>, debt_to_clear: u64) -> Result<()> {
    require!(debt_to_clear > 0, WrapSynthError::ZeroAmount);

    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);
    require!(vault.active_burn_count == 0, WrapSynthError::UnresolvedBurns);
    require!(vault.locked_collateral == 0, WrapSynthError::CancelBurnsFirst);

    sync_vault_yield(
        vault,
        &mut ctx.accounts.global_state,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
    )?;

    let global = &ctx.accounts.global_state;
    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &global.pyth_collateral_feed.to_bytes(),
    )?;

    let actual_debt = get_actual_debt(vault.normalized_debt, global.global_debt_index);
    require!(actual_debt > 0, WrapSynthError::InsufficientDebt);

    // Verify vault is liquidatable (unlocked collateral vs actual debt)
    let col_usd = collateral_to_usd(vault.collateral_amount, col_price);
    let debt_usd = (actual_debt as u128 * xmr_price as u128 / WSXMR_DECIMALS as u128) as u64;
    let ratio = calculate_collateral_ratio(col_usd, debt_usd);
    require!(ratio < LIQUIDATION_RATIO, WrapSynthError::VaultHealthy);

    let mut debt_to_clear = debt_to_clear.min(actual_debt);

    // Calculate collateral to seize at LIQUIDATION_BONUS (110%)
    let col_val_usd = collateral_value_for_debt(debt_to_clear, xmr_price, LIQUIDATION_BONUS);
    let mut collateral_amount = usd_to_collateral(col_val_usd, col_price);

    // Cap at available (unlocked) collateral
    if collateral_amount > vault.collateral_amount {
        // Scale down proportionally to maintain liquidator's bonus
        debt_to_clear = (debt_to_clear as u128 * vault.collateral_amount as u128
            / collateral_amount as u128) as u64;
        collateral_amount = vault.collateral_amount;
    }

    // Update principal tracking proportionally
    let total_before = vault.collateral_amount;
    if vault.principal_deposits > 0 && total_before > 0 {
        let principal_reduction = (vault.principal_deposits as u128 * collateral_amount as u128
            / total_before as u128) as u64;
        vault.principal_deposits = vault.principal_deposits.saturating_sub(principal_reduction);
        let global_mut = &mut ctx.accounts.global_state;
        global_mut.global_lp_principal = global_mut.global_lp_principal.saturating_sub(principal_reduction);
    }
    if vault.principal_shares > 0 && total_before > 0 {
        let shares_reduction = (vault.principal_shares as u128 * collateral_amount as u128
            / total_before as u128) as u64;
        vault.principal_shares = vault.principal_shares.saturating_sub(shares_reduction);
        let global_mut = &mut ctx.accounts.global_state;
        global_mut.global_lp_principal_shares = global_mut.global_lp_principal_shares.saturating_sub(shares_reduction);
    }

    vault.collateral_amount -= collateral_amount;

    // Clear normalized debt
    let normalized_clear = normalize_debt(debt_to_clear, ctx.accounts.global_state.global_debt_index);
    let normalized_clear = normalized_clear.min(vault.normalized_debt);
    vault.normalized_debt -= normalized_clear;

    let global = &mut ctx.accounts.global_state;
    global.global_total_debt = global.global_total_debt.saturating_sub(debt_to_clear);

    // Track bad debt if vault is insolvent
    if vault.collateral_amount == 0 && vault.normalized_debt > 0 {
        let remaining = get_actual_debt(vault.normalized_debt, global.global_debt_index);
        if remaining > 0 {
            global.global_bad_debt = global
                .global_bad_debt
                .checked_add(remaining)
                .ok_or(WrapSynthError::MathOverflow)?;
        }
    }

    // Increment nonces to atomically invalidate all pending mints/burns
    vault.liquidation_nonce = vault
        .liquidation_nonce
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;
    vault.mint_nonce = vault
        .mint_nonce
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;
    vault.pending_debt = 0;

    // Burn liquidator's wsXMR
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        BurnCpi {
            mint: ctx.accounts.wsxmr_mint.to_account_info(),
            from: ctx.accounts.liquidator_wsxmr_ata.to_account_info(),
            authority: ctx.accounts.liquidator.to_account_info(),
        },
    );
    burn_tokens(cpi_ctx, debt_to_clear)?;

    // Transfer seized collateral to liquidator
    let vault_key = vault.lp_address;
    let vault_bump = vault.bump;
    let seeds: &[&[u8]] = &[VAULT_SEED, vault_key.as_ref(), &[vault_bump]];
    let signer_seeds = &[seeds];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.vault_collateral_ata.to_account_info(),
            mint: ctx.accounts.collateral_mint.to_account_info(),
            to: ctx.accounts.liquidator_collateral_ata.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    );
    transfer_checked(cpi_ctx, collateral_amount, ctx.accounts.collateral_mint.decimals)?;

    msg!(
        "Vault {} liquidated: {} debt cleared, {} collateral seized",
        vault_key,
        debt_to_clear,
        collateral_amount
    );
    Ok(())
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ResolveBurnForLiquidation<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
    )]
    pub burn_request: Account<'info, BurnRequest>,

    #[account(
        init_if_needed,
        payer = caller,
        space = PendingReturns::LEN,
        seeds = [PENDING_RETURNS_SEED, burn_request.user.as_ref()],
        bump,
    )]
    pub user_pending_returns: Account<'info, PendingReturns>,

    #[account(mut)]
    pub wsxmr_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_wsxmr_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteLiquidation<'info> {
    #[account(mut)]
    pub liquidator: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(mut)]
    pub wsxmr_mint: InterfaceAccount<'info, Mint>,

    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub liquidator_wsxmr_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub liquidator_collateral_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
