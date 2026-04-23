use anchor_lang::prelude::*;
use anchor_spl::token_2022::{
    Token2022, Burn as BurnCpi, burn as burn_tokens,
    MintTo, mint_to, TransferChecked, transfer_checked,
};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::state::{GlobalState, Vault, BurnRequest, BurnStatus, PendingReturns};
use crate::utils::{
    get_xmr_price, get_collateral_price, mul_verify,
    math::{
        get_actual_debt, normalize_debt, collateral_value_for_debt,
        usd_to_collateral, check_collateral_ratio, collateral_to_usd,
        calculate_collateral_ratio,
    },
};
use crate::instructions::vault_management::sync_vault_yield;

// ─── request_burn ─────────────────────────────────────────────────────────────

pub fn request_burn(ctx: Context<RequestBurn>, wsxmr_amount: u64, request_id: [u8; 32]) -> Result<()> {
    _request_burn(ctx, wsxmr_amount, request_id, false)
}

pub fn request_burn_from_router(ctx: Context<RequestBurn>, wsxmr_amount: u64, request_id: [u8; 32]) -> Result<()> {
    require!(
        ctx.accounts.global_state.liquidity_router == ctx.accounts.user.key(),
        WrapSynthError::OnlyRouter
    );
    _request_burn(ctx, wsxmr_amount, request_id, true)
}

fn _request_burn(ctx: Context<RequestBurn>, wsxmr_amount: u64, request_id: [u8; 32], from_router: bool) -> Result<()> {
    require!(wsxmr_amount > 0, WrapSynthError::ZeroAmount);
    require!(wsxmr_amount >= MIN_BURN_AMOUNT, WrapSynthError::BelowMinimumBurn);

    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);

    if vault.min_burn_amount > 0 {
        require!(wsxmr_amount >= vault.min_burn_amount, WrapSynthError::BelowMinimumBurn);
    }
    require!(
        vault.active_burn_count < MAX_BURN_REQUESTS_PER_VAULT,
        WrapSynthError::MaxBurnRequestsReached
    );

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
    require!(actual_debt >= wsxmr_amount, WrapSynthError::InsufficientDebt);

    // Calculate collateral to lock at 130% (BURN_LOCK_RATIO)
    let col_val_usd = collateral_value_for_debt(wsxmr_amount, xmr_price, BURN_LOCK_RATIO);
    let collateral_to_lock = usd_to_collateral(col_val_usd, col_price);

    let reward_usd = (wsxmr_amount as u128)
        .checked_mul(xmr_price as u128)
        .unwrap_or(0)
        / WSXMR_DECIMALS as u128;
    let reward_usd = (reward_usd as u128)
        .checked_mul(vault.burn_reward_bps as u128)
        .unwrap_or(0)
        / BPS_DENOMINATOR as u128;
    let reward_collateral = usd_to_collateral(reward_usd as u64, col_price);
    let total_lock = collateral_to_lock
        .checked_add(reward_collateral)
        .ok_or(WrapSynthError::MathOverflow)?;

    require!(vault.collateral_amount >= total_lock, WrapSynthError::InsufficientCollateral);

    // Post-burn health check on remaining vault
    let remaining_collateral = vault.collateral_amount.saturating_sub(total_lock);
    let remaining_debt = actual_debt.saturating_sub(wsxmr_amount);
    if remaining_debt > 0 {
        require!(
            check_collateral_ratio(
                remaining_collateral,
                col_price,
                remaining_debt.saturating_add(vault.pending_debt),
                xmr_price,
                COLLATERAL_RATIO,
            ),
            WrapSynthError::InsufficientCollateral
        );
    }

    // Generate request_id
    let nonce = ctx.accounts.global_state.request_nonce + 1;
    ctx.accounts.global_state.request_nonce = nonce;
    let request_id = anchor_lang::solana_program::keccak::hashv(&[
        ctx.accounts.user.key().as_ref(),
        ctx.accounts.vault.key().as_ref(),
        &wsxmr_amount.to_le_bytes(),
        &nonce.to_le_bytes(),
    ])
    .0;

    // Burn wsXMR from user unless coming from router (router handles its own burn)
    if !from_router {
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            BurnCpi {
                mint: ctx.accounts.wsxmr_mint.to_account_info(),
                from: ctx.accounts.user_wsxmr_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        burn_tokens(cpi_ctx, wsxmr_amount)?;
    }

    // Lock collateral: physically move from liquid to locked
    let vault = &mut ctx.accounts.vault;
    vault.collateral_amount = vault.collateral_amount.saturating_sub(total_lock);
    vault.locked_collateral = vault
        .locked_collateral
        .checked_add(total_lock)
        .ok_or(WrapSynthError::MathOverflow)?;

    // Reduce normalized debt
    let normalized_burn = normalize_debt(wsxmr_amount, ctx.accounts.global_state.global_debt_index);
    let normalized_burn = normalized_burn.min(vault.normalized_debt);
    vault.normalized_debt = vault.normalized_debt.saturating_sub(normalized_burn);
    vault.active_burn_count = vault
        .active_burn_count
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;

    let global = &mut ctx.accounts.global_state;
    global.global_total_debt = global.global_total_debt.saturating_sub(wsxmr_amount);
    global.global_pending_burn_debt = global
        .global_pending_burn_debt
        .checked_add(wsxmr_amount)
        .ok_or(WrapSynthError::MathOverflow)?;

    let clock = Clock::get()?;
    let burn_req = &mut ctx.accounts.burn_request;
    burn_req.request_id = request_id;
    burn_req.user = ctx.accounts.user.key();
    burn_req.lp_vault = ctx.accounts.vault.key();
    burn_req.wsxmr_amount = wsxmr_amount;
    burn_req.xmr_amount = wsxmr_amount * XMR_TO_WSXMR_DIVISOR;
    burn_req.locked_collateral = collateral_to_lock;
    burn_req.reward_collateral = reward_collateral;
    burn_req.secret_hash = [0u8; 32];
    burn_req.deadline = clock.unix_timestamp + BURN_REQUEST_TIMEOUT;
    burn_req.vault_liquidation_nonce = ctx.accounts.vault.liquidation_nonce;
    burn_req.normalized_debt_amount = normalized_burn;
    burn_req.status = BurnStatus::Requested;
    burn_req.bump = ctx.bumps.burn_request;

    msg!("Burn requested: {:?} for {} wsXMR", request_id, wsxmr_amount);
    Ok(())
}

// ─── propose_hash ─────────────────────────────────────────────────────────────

pub fn propose_hash(ctx: Context<ProposeHash>, secret_hash: [u8; 32]) -> Result<()> {
    require!(secret_hash != [0u8; 32], WrapSynthError::InvalidSecret);
    let request = &mut ctx.accounts.burn_request;
    require!(request.status == BurnStatus::Requested, WrapSynthError::InvalidStatus);
    require!(
        ctx.accounts.lp.key() == ctx.accounts.vault.lp_address,
        WrapSynthError::Unauthorized
    );

    request.secret_hash = secret_hash;
    request.status = BurnStatus::Proposed;
    let clock = Clock::get()?;
    request.deadline = clock.unix_timestamp + BURN_COMMIT_TIMEOUT;
    msg!("Hash proposed for burn: {:?}", request.request_id);
    Ok(())
}

// ─── confirm_monero_lock ──────────────────────────────────────────────────────

pub fn confirm_monero_lock(ctx: Context<ConfirmMoneroLock>) -> Result<()> {
    let request = &mut ctx.accounts.burn_request;
    require!(request.status == BurnStatus::Proposed, WrapSynthError::InvalidStatus);
    require!(
        ctx.accounts.user.key() == request.user,
        WrapSynthError::Unauthorized
    );

    let clock = Clock::get()?;
    request.deadline = clock.unix_timestamp + BURN_COMMIT_TIMEOUT;
    request.status = BurnStatus::Committed;
    msg!("Monero lock confirmed, deadline: {}", request.deadline);
    Ok(())
}

// ─── finalize_burn ────────────────────────────────────────────────────────────

pub fn finalize_burn(ctx: Context<FinalizeBurn>, secret: [u8; 32]) -> Result<()> {
    let request = &mut ctx.accounts.burn_request;
    require!(request.status == BurnStatus::Committed, WrapSynthError::InvalidStatus);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp < request.deadline, WrapSynthError::DeadlineExpired);

    // Ed25519 secret verification: compute_commitment(secret) == secret_hash
    require!(
        mul_verify(&secret, &request.secret_hash),
        WrapSynthError::InvalidSecret
    );

    sync_vault_yield(
        &mut ctx.accounts.vault,
        &mut ctx.accounts.global_state,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
    )?;

    let vault = &mut ctx.accounts.vault;
    let global = &mut ctx.accounts.global_state;

    // Calculate safe reward (capped to maintain vault health)
    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &global.pyth_collateral_feed.to_bytes(),
    )?;

    let mut safe_reward = request.reward_collateral;
    let total_unlock = request.locked_collateral + request.reward_collateral;

    if safe_reward > 0 {
        let projected_collateral = vault.collateral_amount + request.locked_collateral;
        let remaining_debt = get_actual_debt(vault.normalized_debt, global.global_debt_index);

        if remaining_debt > 0 {
            let other_locked = vault
                .locked_collateral
                .saturating_sub(total_unlock);
            let available_for_debt = projected_collateral.saturating_sub(other_locked);

            let col_usd = collateral_to_usd(
                available_for_debt.saturating_sub(safe_reward),
                col_price,
            );
            let debt_usd = (remaining_debt as u128 * xmr_price as u128
                / WSXMR_DECIMALS as u128) as u64;
            let ratio = calculate_collateral_ratio(col_usd, debt_usd);

            if ratio < LIQUIDATION_RATIO {
                // Reduce reward to maintain vault at LIQUIDATION_RATIO
                let debt_with_pending = remaining_debt.saturating_add(vault.pending_debt);
                let debt_usd_full = (debt_with_pending as u128 * xmr_price as u128
                    / WSXMR_DECIMALS as u128) as u64;
                let min_col_usd = (debt_usd_full as u128 * LIQUIDATION_RATIO as u128
                    / RATIO_PRECISION as u128) as u64;
                let min_col_shares = usd_to_collateral(min_col_usd, col_price)
                    .saturating_add(vault.locked_collateral);

                if projected_collateral > min_col_shares {
                    safe_reward = projected_collateral - min_col_shares;
                } else {
                    safe_reward = 0;
                }
            }
        }
    }

    // Unlock from locked_collateral tracker
    if vault.locked_collateral >= total_unlock {
        vault.locked_collateral -= total_unlock;
    } else {
        vault.locked_collateral = 0;
    }

    // Return base collateral + unused reward back to liquid balance
    let unused_reward = request.reward_collateral.saturating_sub(safe_reward);
    vault.collateral_amount = vault
        .collateral_amount
        .checked_add(request.locked_collateral + unused_reward)
        .ok_or(WrapSynthError::MathOverflow)?;

    vault.active_burn_count = vault.active_burn_count.saturating_sub(1);

    // Queue reward for user withdrawal
    if safe_reward > 0 {
        ctx.accounts.user_pending_returns.collateral_amount = ctx
            .accounts
            .user_pending_returns
            .collateral_amount
            .checked_add(safe_reward)
            .ok_or(WrapSynthError::MathOverflow)?;
        global.global_pending_collateral = global
            .global_pending_collateral
            .checked_add(safe_reward)
            .ok_or(WrapSynthError::MathOverflow)?;
    }

    // Remove from pending burn debt
    global.global_pending_burn_debt = global
        .global_pending_burn_debt
        .saturating_sub(request.wsxmr_amount);

    request.status = BurnStatus::Completed;
    msg!("Burn finalized: {:?}, reward: {}", request.request_id, safe_reward);
    Ok(())
}

// ─── claim_slashed_collateral ─────────────────────────────────────────────────

pub fn claim_slashed_collateral(ctx: Context<ClaimSlashedCollateral>) -> Result<()> {
    let request = &mut ctx.accounts.burn_request;
    require!(request.status == BurnStatus::Committed, WrapSynthError::InvalidStatus);
    require!(ctx.accounts.user.key() == request.user, WrapSynthError::Unauthorized);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp >= request.deadline, WrapSynthError::DeadlineNotExpired);

    sync_vault_yield(
        &mut ctx.accounts.vault,
        &mut ctx.accounts.global_state,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
    )?;

    let vault = &mut ctx.accounts.vault;
    let global = &mut ctx.accounts.global_state;

    let total_seized = request.locked_collateral + request.reward_collateral;
    vault.locked_collateral = vault.locked_collateral.saturating_sub(total_seized);
    vault.active_burn_count = vault.active_burn_count.saturating_sub(1);

    ctx.accounts.user_pending_returns.collateral_amount = ctx
        .accounts
        .user_pending_returns
        .collateral_amount
        .checked_add(total_seized)
        .ok_or(WrapSynthError::MathOverflow)?;
    global.global_pending_collateral = global
        .global_pending_collateral
        .checked_add(total_seized)
        .ok_or(WrapSynthError::MathOverflow)?;

    global.global_pending_burn_debt = global
        .global_pending_burn_debt
        .saturating_sub(request.wsxmr_amount);

    request.status = BurnStatus::Slashed;
    msg!(
        "Collateral slashed for burn {:?}: {} seized",
        request.request_id,
        total_seized
    );
    Ok(())
}

// ─── cancel_burn ──────────────────────────────────────────────────────────────

pub fn cancel_burn(ctx: Context<CancelBurn>) -> Result<()> {
    let request = &mut ctx.accounts.burn_request;
    require!(
        request.status == BurnStatus::Requested || request.status == BurnStatus::Proposed,
        WrapSynthError::InvalidStatus
    );

    let clock = Clock::get()?;
    require!(clock.unix_timestamp >= request.deadline, WrapSynthError::DeadlineNotExpired);

    // Grace period: only user can cancel in the 15-minute window after PROPOSED deadline
    if request.status == BurnStatus::Proposed {
        if clock.unix_timestamp < request.deadline + GRACE_PERIOD {
            require!(
                ctx.accounts.caller.key() == request.user,
                WrapSynthError::GracePeriodOnlyUser
            );
        }
    }

    let vault = &mut ctx.accounts.vault;
    require!(
        request.vault_liquidation_nonce == vault.liquidation_nonce,
        WrapSynthError::BurnInvalidatedByLiquidation
    );

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

    let total_unlock = request.locked_collateral + request.reward_collateral;
    let restored_normalized = request.normalized_debt_amount;
    let restored_actual = get_actual_debt(restored_normalized, global.global_debt_index);
    let restored_collateral = vault.collateral_amount + total_unlock;

    // Health check at 150% after restoration
    let unhealthy = if restored_actual > 0 {
        let new_locked = vault.locked_collateral.saturating_sub(total_unlock);
        let available = restored_collateral.saturating_sub(new_locked);
        !check_collateral_ratio(
            available,
            col_price,
            restored_actual.saturating_add(vault.pending_debt),
            xmr_price,
            COLLATERAL_RATIO,
        )
    } else {
        false
    };

    let vault = &mut ctx.accounts.vault;
    let global = &mut ctx.accounts.global_state;

    if unhealthy {
        // Vault can't absorb restored debt — give user fair compensation (1:1 value of burned wsXMR)
        let fair_usd = crate::utils::math::collateral_value_for_debt(request.wsxmr_amount, xmr_price, RATIO_PRECISION);
        let fair_collateral = usd_to_collateral(fair_usd, col_price).min(total_unlock);

        vault.locked_collateral = vault.locked_collateral.saturating_sub(total_unlock);
        let excess = total_unlock.saturating_sub(fair_collateral);
        vault.collateral_amount = vault.collateral_amount.saturating_add(excess);
        vault.active_burn_count = vault.active_burn_count.saturating_sub(1);

        if fair_collateral > 0 {
            ctx.accounts.user_pending_returns.collateral_amount = ctx
                .accounts
                .user_pending_returns
                .collateral_amount
                .checked_add(fair_collateral)
                .ok_or(WrapSynthError::MathOverflow)?;
            global.global_pending_collateral = global
                .global_pending_collateral
                .checked_add(fair_collateral)
                .ok_or(WrapSynthError::MathOverflow)?;
        }

        global.global_pending_burn_debt = global
            .global_pending_burn_debt
            .saturating_sub(request.wsxmr_amount);
    } else {
        // Vault healthy — restore debt and re-mint wsXMR to user
        let max_normalized = normalize_debt(request.wsxmr_amount, global.global_debt_index);
        let safe_normalized = restored_normalized.min(max_normalized);

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

        vault.locked_collateral = vault.locked_collateral.saturating_sub(total_unlock);
        vault.collateral_amount = vault
            .collateral_amount
            .checked_add(total_unlock)
            .ok_or(WrapSynthError::MathOverflow)?;
        vault.active_burn_count = vault.active_burn_count.saturating_sub(1);

        // Re-mint wsXMR to user
        let bump = global.bump;
        let seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[bump]];
        let signer_seeds = &[seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.wsxmr_mint.to_account_info(),
                to: ctx.accounts.user_wsxmr_ata.to_account_info(),
                authority: ctx.accounts.global_state.to_account_info(),
            },
            signer_seeds,
        );
        mint_to(cpi_ctx, request.wsxmr_amount)?;
    }

    request.status = BurnStatus::Cancelled;
    msg!("Burn cancelled: {:?}", request.request_id);
    Ok(())
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(wsxmr_amount: u64)]
pub struct RequestBurn<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
        bump = vault.bump,
        constraint = vault.active @ WrapSynthError::VaultNotActive,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init,
        payer = user,
        space = BurnRequest::LEN,
        seeds = [BURN_REQUEST_SEED, &anchor_lang::solana_program::keccak::hashv(&[
            user.key().as_ref(),
            vault.key().as_ref(),
            &wsxmr_amount.to_le_bytes(),
            &(global_state.request_nonce + 1).to_le_bytes(),
        ]).0],
        bump,
    )]
    pub burn_request: Account<'info, BurnRequest>,

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
pub struct ProposeHash<'info> {
    pub lp: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, lp.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
        constraint = burn_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub burn_request: Account<'info, BurnRequest>,
}

#[derive(Accounts)]
pub struct ConfirmMoneroLock<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
        constraint = burn_request.user == user.key() @ WrapSynthError::Unauthorized,
    )]
    pub burn_request: Account<'info, BurnRequest>,
}

#[derive(Accounts)]
pub struct FinalizeBurn<'info> {
    pub lp: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lp.key().as_ref()],
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
        constraint = burn_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub burn_request: Account<'info, BurnRequest>,

    /// Pre-existing PendingReturns for burn user. Created via initialize_pending_returns.
    #[account(
        mut,
        constraint = user_pending_returns.owner == burn_request.user @ WrapSynthError::Unauthorized,
    )]
    pub user_pending_returns: Account<'info, PendingReturns>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimSlashedCollateral<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: LP address for vault seed derivation
    pub vault_lp: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault_lp.key().as_ref()],
        bump = vault.bump,
        constraint = vault.key() == burn_request.lp_vault @ WrapSynthError::Unauthorized,
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
        constraint = burn_request.user == user.key() @ WrapSynthError::Unauthorized,
    )]
    pub burn_request: Account<'info, BurnRequest>,

    #[account(
        mut,
        seeds = [PENDING_RETURNS_SEED, user.key().as_ref()],
        bump = user_pending_returns.bump,
        constraint = user_pending_returns.owner == user.key() @ WrapSynthError::Unauthorized,
    )]
    pub user_pending_returns: Account<'info, PendingReturns>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelBurn<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, burn_request.lp_vault.as_ref()],
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

    /// Pre-existing PendingReturns for burn user.
    #[account(
        mut,
        constraint = user_pending_returns.owner == burn_request.user @ WrapSynthError::Unauthorized,
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
