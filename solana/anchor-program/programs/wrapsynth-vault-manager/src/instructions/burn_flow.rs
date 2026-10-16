use anchor_lang::prelude::*;
use anchor_spl::token_2022::{burn as burn_tokens, mint_to, Burn as BurnCpi, MintTo, Token2022};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::instructions::vault_management::slash_to_pool;
use crate::state::{BurnRequest, BurnStatus, GlobalState, PendingReturns, Vault};
use crate::utils::{
    get_collateral_price, get_xmr_price,
    math::{
        calculate_collateral_ratio, check_collateral_ratio, collateral_to_usd,
        collateral_value_for_debt, get_actual_debt, normalize_debt, usd_to_collateral,
    },
    mul_verify, verify_public_key,
};

// ─── request_burn ─────────────────────────────────────────────────────────────

pub fn request_burn(
    ctx: Context<RequestBurn>,
    wsxmr_amount: u64,
    claim_commitment: [u8; 32],
    user_public_key: [u8; 32],
    user_view_key: [u8; 32],
    request_id: [u8; 32],
) -> Result<()> {
    _request_burn(
        ctx,
        wsxmr_amount,
        claim_commitment,
        user_public_key,
        user_view_key,
        request_id,
        false,
    )
}

pub fn request_burn_from_router(
    ctx: Context<RequestBurn>,
    wsxmr_amount: u64,
    claim_commitment: [u8; 32],
    user_public_key: [u8; 32],
    user_view_key: [u8; 32],
    request_id: [u8; 32],
) -> Result<()> {
    require!(
        ctx.accounts.global_state.load()?.liquidity_router == ctx.accounts.user.key(),
        WrapSynthError::OnlyRouter
    );
    _request_burn(
        ctx,
        wsxmr_amount,
        claim_commitment,
        user_public_key,
        user_view_key,
        request_id,
        true,
    )
}

fn _request_burn(
    ctx: Context<RequestBurn>,
    wsxmr_amount: u64,
    claim_commitment: [u8; 32],
    user_public_key: [u8; 32],
    user_view_key: [u8; 32],
    request_id: [u8; 32],
    from_router: bool,
) -> Result<()> {
    require!(
        claim_commitment != [0u8; 32],
        WrapSynthError::InvalidCommitment
    );
    require!(
        user_public_key != [0u8; 32],
        WrapSynthError::InvalidCommitment
    );
    require!(
        user_view_key != [0u8; 32],
        WrapSynthError::InvalidCommitment
    );
    require!(wsxmr_amount > 0, WrapSynthError::ZeroAmount);
    require!(
        wsxmr_amount >= MIN_BURN_AMOUNT,
        WrapSynthError::BelowMinimumBurn
    );

    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);

    if vault.min_burn_amount > 0 {
        require!(
            wsxmr_amount >= vault.min_burn_amount,
            WrapSynthError::BelowMinimumBurn
        );
    }
    require!(
        vault.active_burn_count < MAX_BURN_REQUESTS_PER_VAULT,
        WrapSynthError::MaxBurnRequestsReached
    );

    let global_debt_index = ctx.accounts.global_state.load()?.global_debt_index;
    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &SOL_USD_FEED_ID,
    )?;

    // M1: Burn cannot exceed the vault's own debt. Debt is NOT reduced here —
    // it is reduced only at settlement (finalize, slash, force_settle, abort).
    // This eliminates the class of index-shift debt inflation bugs that would
    // occur if debt were reduced and then restored on cancel/abort.
    let actual_debt = get_actual_debt(vault.normalized_debt, global_debt_index);
    require!(
        wsxmr_amount <= actual_debt,
        WrapSynthError::BurnExceedsVaultDebt
    );

    // Calculate collateral to lock at BURN_LOCK_RATIO + reward
    let col_val_usd = collateral_value_for_debt(wsxmr_amount, xmr_price, BURN_LOCK_RATIO);
    let collateral_to_lock = usd_to_collateral(col_val_usd, col_price);

    let reward_usd =
        (wsxmr_amount as u128).checked_mul(xmr_price).unwrap_or(0) / WSXMR_DECIMALS as u128;
    let reward_usd = reward_usd
        .checked_mul(vault.burn_reward_bps as u128)
        .unwrap_or(0)
        / BPS_DENOMINATOR as u128;
    let reward_collateral = usd_to_collateral(reward_usd, col_price);
    let total_lock = collateral_to_lock
        .checked_add(reward_collateral)
        .ok_or(WrapSynthError::MathOverflow)?;

    // Total collateral model: collateral_amount = total (locked included), so
    // available = collateral_amount - locked_collateral.
    let available_collateral = vault
        .collateral_amount
        .saturating_sub(vault.locked_collateral);
    require!(
        available_collateral >= total_lock,
        WrapSynthError::InsufficientCollateral
    );

    // Ensure remaining free collateral can back pending mints at COLLATERAL_RATIO
    let remaining_free = available_collateral - total_lock;
    if vault.pending_debt > 0 {
        require!(
            check_collateral_ratio(
                remaining_free,
                col_price,
                vault.pending_debt,
                xmr_price,
                COLLATERAL_RATIO,
            ),
            WrapSynthError::InsufficientCollateral
        );
    }

    // Increment nonce. Client pre-computed request_id = keccak(user, vault, amount, nonce+1).
    let nonce = ctx.accounts.global_state.load_mut()?.request_nonce + 1;
    ctx.accounts.global_state.load_mut()?.request_nonce = nonce;
    // Bind the passed request_id to the canonical hash (seed uses request_id directly)
    let expected_id = anchor_lang::solana_program::keccak::hashv(&[
        ctx.accounts.user.key().as_ref(),
        ctx.accounts.vault.key().as_ref(),
        &wsxmr_amount.to_le_bytes(),
        &nonce.to_le_bytes(),
    ])
    .0;
    require!(
        request_id == expected_id,
        WrapSynthError::InvalidBurnRequest
    );

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

    // B1: Total collateral model — never subtract from collateral_amount when locking
    let vault = &mut ctx.accounts.vault;
    vault.locked_collateral = vault
        .locked_collateral
        .checked_add(total_lock)
        .ok_or(WrapSynthError::MathOverflow)?;
    vault.active_burn_count = vault
        .active_burn_count
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;

    let global = &mut ctx.accounts.global_state.load_mut()?;
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
    burn_req.user_claim_commitment = claim_commitment;
    burn_req.user_public_key = user_public_key;
    burn_req.user_view_key = user_view_key;
    burn_req.xmr_price_at_request = xmr_price;
    burn_req.secret_hash = [0u8; 32];
    burn_req.lp_public_spend_key = [0u8; 32];
    burn_req.lp_public_view_key = [0u8; 32];
    burn_req.revealed_secret = [0u8; 32];
    burn_req.deadline = clock.unix_timestamp + ctx.accounts.vault.burn_timeout_seconds;
    burn_req.vault_liquidation_nonce = ctx.accounts.vault.liquidation_nonce;
    burn_req.normalized_debt_amount = 0;
    burn_req.abandoned = false;
    burn_req.status = BurnStatus::Requested;
    burn_req.bump = ctx.bumps.burn_request;

    msg!(
        "Burn requested: {:?} for {} wsXMR",
        request_id,
        wsxmr_amount
    );
    Ok(())
}

// ─── propose_hash ─────────────────────────────────────────────────────────────

pub fn propose_hash(
    ctx: Context<ProposeHash>,
    secret_hash: [u8; 32],
    lp_public_spend_key: [u8; 32],
    lp_public_view_key: [u8; 32],
) -> Result<()> {
    require!(secret_hash != [0u8; 32], WrapSynthError::InvalidSecret);
    require!(
        lp_public_spend_key != [0u8; 32],
        WrapSynthError::InvalidCommitment
    );
    require!(
        lp_public_view_key != [0u8; 32],
        WrapSynthError::InvalidCommitment
    );
    let request = &mut ctx.accounts.burn_request;
    require!(
        request.status == BurnStatus::Requested,
        WrapSynthError::InvalidStatus
    );
    require!(
        ctx.accounts.lp.key() == ctx.accounts.vault.lp_address,
        WrapSynthError::Unauthorized
    );
    // Already provided
    require!(
        request.lp_public_spend_key == [0u8; 32],
        WrapSynthError::InvalidStatus
    );

    request.secret_hash = secret_hash;
    request.lp_public_spend_key = lp_public_spend_key;
    request.lp_public_view_key = lp_public_view_key;
    request.status = BurnStatus::Proposed;
    let clock = Clock::get()?;
    request.deadline = clock.unix_timestamp + BURN_COMMIT_TIMEOUT;
    msg!("Hash proposed for burn: {:?}", request.request_id);
    Ok(())
}

// ─── confirm_monero_lock ──────────────────────────────────────────────────────

pub fn confirm_monero_lock(ctx: Context<ConfirmMoneroLock>) -> Result<()> {
    let request = &mut ctx.accounts.burn_request;
    require!(
        request.status == BurnStatus::Proposed,
        WrapSynthError::InvalidStatus
    );
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

// ─── reveal_burn_secret ───────────────────────────────────────────────────────

pub fn reveal_burn_secret(ctx: Context<RevealBurnSecret>, secret: [u8; 32]) -> Result<()> {
    require!(secret != [0u8; 32], WrapSynthError::InvalidSecret);
    let request = &mut ctx.accounts.burn_request;
    require!(
        request.status == BurnStatus::Committed,
        WrapSynthError::InvalidStatus
    );
    require!(
        request.revealed_secret == [0u8; 32],
        WrapSynthError::InvalidStatus
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp < request.deadline + BURN_FINALIZE_GRACE,
        WrapSynthError::DeadlineExpired
    );

    // Pure Ed25519 verification — no oracle, no yield sync, no vault state. The
    // secret is stored on-chain; settle_burn reads it from storage so the secret
    // never appears in the calldata of a tx that can revert on vault state
    // (mirrors the EVM revealBurnSecret/settleBurn split).
    require!(
        mul_verify(&secret, &request.secret_hash),
        WrapSynthError::InvalidSecret
    );

    request.revealed_secret = secret;
    msg!("Burn secret revealed: {:?}", request.request_id);
    Ok(())
}

// ─── settle_burn ──────────────────────────────────────────────────────────────

pub fn settle_burn(ctx: Context<SettleBurn>) -> Result<()> {
    let request = &mut ctx.accounts.burn_request;
    require!(
        request.status == BurnStatus::Committed,
        WrapSynthError::InvalidStatus
    );
    require!(
        request.revealed_secret != [0u8; 32],
        WrapSynthError::InvalidStatus
    );

    settle_burn_internal(
        request,
        &mut ctx.accounts.vault,
        &mut *ctx.accounts.global_state.load_mut()?,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
        &ctx.accounts.vault_collateral_escrow,
        &ctx.accounts.collateral_escrow,
        &ctx.accounts.system_program,
        &mut ctx.accounts.user_pending_returns,
    )
}

// ─── finalize_burn ────────────────────────────────────────────────────────────

pub fn finalize_burn(ctx: Context<FinalizeBurn>, secret: [u8; 32]) -> Result<()> {
    require!(secret != [0u8; 32], WrapSynthError::InvalidSecret);
    let request = &mut ctx.accounts.burn_request;
    require!(
        request.status == BurnStatus::Committed,
        WrapSynthError::InvalidStatus
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp < request.deadline + BURN_FINALIZE_GRACE,
        WrapSynthError::DeadlineExpired
    );

    // Ed25519 secret verification: compute_commitment(secret) == secret_hash
    require!(
        mul_verify(&secret, &request.secret_hash),
        WrapSynthError::InvalidSecret
    );

    request.revealed_secret = secret;
    settle_burn_internal(
        request,
        &mut ctx.accounts.vault,
        &mut *ctx.accounts.global_state.load_mut()?,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
        &ctx.accounts.vault_collateral_escrow,
        &ctx.accounts.collateral_escrow,
        &ctx.accounts.system_program,
        &mut ctx.accounts.user_pending_returns,
    )
}

/// Shared settlement for settle_burn and finalize_burn — releases the collateral
/// reservation, pays the burn reward to the user, and reduces vault debt.
/// Caller must have verified status == Committed and revealed_secret != 0.
#[allow(clippy::too_many_arguments)]
fn settle_burn_internal<'a>(
    request: &mut BurnRequest,
    vault: &mut Vault,
    global: &mut GlobalState,
    pyth_xmr: &AccountInfo<'a>,
    pyth_collateral: &AccountInfo<'a>,
    vault_collateral_escrow: &AccountInfo<'a>,
    collateral_escrow: &AccountInfo<'a>,
    system_program: &Program<'a, System>,
    user_pending_returns: &mut PendingReturns,
) -> Result<()> {
    let xmr_price = get_xmr_price(pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(pyth_collateral, PRICE_MAX_AGE, &SOL_USD_FEED_ID)?;

    let mut safe_reward = request.reward_collateral;
    let total_unlock = request.locked_collateral + request.reward_collateral;

    // Cap the reward to maintain vault health (total model: collateral_amount
    // includes locked collateral).
    if safe_reward > 0 {
        let projected_collateral = vault.collateral_amount;
        let remaining_debt = get_actual_debt(vault.normalized_debt, global.global_debt_index);

        if remaining_debt > 0 {
            let other_locked = vault.locked_collateral.saturating_sub(total_unlock);
            let available_for_debt = projected_collateral.saturating_sub(other_locked);

            let col_usd =
                collateral_to_usd(available_for_debt.saturating_sub(safe_reward), col_price);
            let debt_usd = remaining_debt as u128 * xmr_price / WSXMR_DECIMALS as u128;
            let ratio = calculate_collateral_ratio(col_usd, debt_usd);

            if ratio < LIQUIDATION_RATIO {
                // Reduce reward to maintain vault at LIQUIDATION_RATIO
                let debt_with_pending = remaining_debt.saturating_add(vault.pending_debt);
                let debt_usd_full = debt_with_pending as u128 * xmr_price / WSXMR_DECIMALS as u128;
                let min_col_usd =
                    debt_usd_full * LIQUIDATION_RATIO as u128 / RATIO_PRECISION as u128;
                let min_col_shares =
                    usd_to_collateral(min_col_usd, col_price).saturating_add(other_locked);

                if projected_collateral > min_col_shares {
                    safe_reward = projected_collateral - min_col_shares;
                } else {
                    safe_reward = 0;
                }
            }
        }
    }

    // Total collateral model: release the reservation, AND remove the paid-out
    // reward from vault equity (it leaves the vault to the holder).
    if vault.locked_collateral < total_unlock {
        return err!(WrapSynthError::InsufficientCollateral);
    }
    vault.locked_collateral -= total_unlock;

    if vault.collateral_amount < safe_reward {
        return err!(WrapSynthError::InsufficientCollateral);
    }
    vault.collateral_amount -= safe_reward;

    // Debt reduction happens here at settlement, not at request time
    let normalized_burn = normalize_debt(request.wsxmr_amount, global.global_debt_index);
    let normalized_burn = normalized_burn.min(vault.normalized_debt);
    vault.normalized_debt -= normalized_burn;
    request.normalized_debt_amount = normalized_burn;
    global.global_total_debt = global
        .global_total_debt
        .saturating_sub(get_actual_debt(normalized_burn, global.global_debt_index));

    if global.global_pending_burn_debt < request.wsxmr_amount {
        global.global_pending_burn_debt = 0;
    } else {
        global.global_pending_burn_debt -= request.wsxmr_amount;
    }

    if safe_reward > 0 {
        user_pending_returns.collateral_amount = user_pending_returns
            .collateral_amount
            .checked_add(safe_reward)
            .ok_or(WrapSynthError::MathOverflow)?;
        global.global_pending_collateral = global
            .global_pending_collateral
            .checked_add(safe_reward)
            .ok_or(WrapSynthError::MathOverflow)?;
        // Move the reward into the program pool so the credit is backed.
        // global_state is not touched by this CPI (vault PDA signs), so the
        // outstanding global borrow is fine.
        slash_to_pool(
            vault,
            vault_collateral_escrow,
            collateral_escrow,
            &system_program.to_account_info(),
            safe_reward,
        )?;
    }

    vault.active_burn_count = vault.active_burn_count.saturating_sub(1);
    request.status = BurnStatus::Completed;
    msg!(
        "Burn finalized: {:?}, reward: {}",
        request.request_id,
        safe_reward
    );
    Ok(())
}

// ─── claim_slashed_collateral ─────────────────────────────────────────────────

pub fn claim_slashed_collateral(
    ctx: Context<ClaimSlashedCollateral>,
    user_secret: [u8; 32],
) -> Result<()> {
    require!(user_secret != [0u8; 32], WrapSynthError::InvalidUserSecret);

    let request = &mut ctx.accounts.burn_request;
    require!(
        request.status == BurnStatus::Committed,
        WrapSynthError::InvalidStatus
    );
    // If the LP already revealed, the burn is settleable — slashing would
    // double-pay the user (XMR via the public secret + collateral). Route to settle.
    require!(
        request.revealed_secret == [0u8; 32],
        WrapSynthError::InvalidStatus
    );
    require!(
        ctx.accounts.user.key() == request.user,
        WrapSynthError::Unauthorized
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= request.deadline + BURN_FINALIZE_GRACE,
        WrapSynthError::DeadlineNotExpired
    );

    // Verify userSecret corresponds to the stored userPublicKey (compressed
    // Ed25519 point) — the user must reveal their Monero spend key half so the
    // LP can combine it with their own and sweep the shared XMR back.
    require!(
        verify_public_key(&user_secret, &request.user_public_key),
        WrapSynthError::InvalidUserSecret
    );

    let vault = &mut ctx.accounts.vault;
    let global = &mut ctx.accounts.global_state.load_mut()?;

    // Par-capped slash: user receives min(par, locked) — NO reward, since the LP
    // never completed the burn. Par is fixed at request time via xmr_price_at_request,
    // protecting the user from XMR price appreciation.
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &SOL_USD_FEED_ID,
    )?;
    let par_value_usd = (request.wsxmr_amount as u128)
        .checked_mul(request.xmr_price_at_request)
        .ok_or(WrapSynthError::MathOverflow)?
        / WSXMR_DECIMALS as u128;
    let par_collateral = usd_to_collateral(par_value_usd, col_price);

    let mut user_payout = par_collateral.min(request.locked_collateral);
    if user_payout > vault.collateral_amount {
        user_payout = vault.collateral_amount;
    }

    let total_lock = request.locked_collateral + request.reward_collateral;

    // Total collateral model: release the reservation, AND remove the paid-out
    // amount (par only) from vault equity. The reward stays in the vault — the
    // LP never completed the burn, so no reward is earned.
    if vault.locked_collateral < total_lock {
        return err!(WrapSynthError::InsufficientCollateral);
    }
    vault.locked_collateral -= total_lock;

    if vault.collateral_amount < user_payout {
        return err!(WrapSynthError::InsufficientCollateral);
    }
    vault.collateral_amount -= user_payout;

    // Debt reduction happens here at settlement
    let normalized_burn = normalize_debt(request.wsxmr_amount, global.global_debt_index);
    let normalized_burn = normalized_burn.min(vault.normalized_debt);
    vault.normalized_debt -= normalized_burn;
    request.normalized_debt_amount = normalized_burn;
    global.global_total_debt = global
        .global_total_debt
        .saturating_sub(get_actual_debt(normalized_burn, global.global_debt_index));

    if global.global_pending_burn_debt < request.wsxmr_amount {
        global.global_pending_burn_debt = 0;
    } else {
        global.global_pending_burn_debt -= request.wsxmr_amount;
    }

    if user_payout > 0 {
        ctx.accounts.user_pending_returns.collateral_amount = ctx
            .accounts
            .user_pending_returns
            .collateral_amount
            .checked_add(user_payout)
            .ok_or(WrapSynthError::MathOverflow)?;
        global.global_pending_collateral = global
            .global_pending_collateral
            .checked_add(user_payout)
            .ok_or(WrapSynthError::MathOverflow)?;
        slash_to_pool(
            vault,
            &ctx.accounts.vault_collateral_escrow,
            &ctx.accounts.collateral_escrow,
            &ctx.accounts.system_program.to_account_info(),
            user_payout,
        )?;
    }

    vault.active_burn_count = vault.active_burn_count.saturating_sub(1);
    request.status = BurnStatus::Slashed;
    msg!(
        "Collateral slashed for burn {:?}: {} par-capped payout",
        request.request_id,
        user_payout
    );
    Ok(())
}

// ─── abort_burn ───────────────────────────────────────────────────────────────

pub fn abort_burn(ctx: Context<AbortBurn>) -> Result<()> {
    let request = &mut ctx.accounts.burn_request;
    require!(
        request.status == BurnStatus::Requested,
        WrapSynthError::InvalidStatus
    );
    require!(
        ctx.accounts.caller.key() == request.user,
        WrapSynthError::Unauthorized
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= request.deadline,
        WrapSynthError::DeadlineNotExpired
    );

    let vault = &mut ctx.accounts.vault;
    // If the vault was liquidated since the burn was requested, the locked
    // collateral is not released (it was already handled by liquidation).
    if request.vault_liquidation_nonce == vault.liquidation_nonce {
        let total_lock = request.locked_collateral + request.reward_collateral;
        if vault.locked_collateral < total_lock {
            return err!(WrapSynthError::InsufficientCollateral);
        }
        vault.locked_collateral -= total_lock;
    }

    let global = &mut ctx.accounts.global_state.load_mut()?;
    if global.global_pending_burn_debt < request.wsxmr_amount {
        global.global_pending_burn_debt = 0;
    } else {
        global.global_pending_burn_debt -= request.wsxmr_amount;
    }

    vault.active_burn_count = vault.active_burn_count.saturating_sub(1);

    // Restore wsXMR to holder
    let gs_bump = global.bump;
    let gs_info = ctx.accounts.global_state.to_account_info();
    let seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[gs_bump]];
    let signer_seeds = &[seeds];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint: ctx.accounts.wsxmr_mint.to_account_info(),
            to: ctx.accounts.user_wsxmr_ata.to_account_info(),
            authority: gs_info,
        },
        signer_seeds,
    );
    mint_to(cpi_ctx, request.wsxmr_amount)?;

    request.status = BurnStatus::Cancelled;
    msg!("Burn aborted: {:?}", request.request_id);
    Ok(())
}

// ─── force_settle_burn ────────────────────────────────────────────────────────

pub fn force_settle_burn(ctx: Context<ForceSettleBurn>) -> Result<()> {
    let request = &mut ctx.accounts.burn_request;
    require!(
        request.status == BurnStatus::Requested,
        WrapSynthError::InvalidStatus
    );
    require!(
        ctx.accounts.caller.key() == request.user,
        WrapSynthError::Unauthorized
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= request.deadline,
        WrapSynthError::DeadlineNotExpired
    );

    let vault = &mut ctx.accounts.vault;
    let global = &mut ctx.accounts.global_state.load_mut()?;

    // Par-capped settlement: user receives min(par, locked) — no reward, since
    // the LP never proposed. Unlike abort_burn, this pays collateral instead of
    // restoring wsXMR (user prefers collateral over getting wsXMR back).
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &SOL_USD_FEED_ID,
    )?;
    let par_value_usd = (request.wsxmr_amount as u128)
        .checked_mul(request.xmr_price_at_request)
        .ok_or(WrapSynthError::MathOverflow)?
        / WSXMR_DECIMALS as u128;
    let par_collateral = usd_to_collateral(par_value_usd, col_price);

    let user_base = par_collateral.min(request.locked_collateral);
    let total_lock = request.locked_collateral + request.reward_collateral;

    if vault.locked_collateral < total_lock {
        return err!(WrapSynthError::InsufficientCollateral);
    }
    vault.locked_collateral -= total_lock;
    if vault.collateral_amount < user_base {
        return err!(WrapSynthError::InsufficientCollateral);
    }
    vault.collateral_amount -= user_base;

    // Debt reduction happens here at settlement
    let normalized_burn = normalize_debt(request.wsxmr_amount, global.global_debt_index);
    let normalized_burn = normalized_burn.min(vault.normalized_debt);
    vault.normalized_debt -= normalized_burn;
    request.normalized_debt_amount = normalized_burn;
    global.global_total_debt = global
        .global_total_debt
        .saturating_sub(get_actual_debt(normalized_burn, global.global_debt_index));

    if global.global_pending_burn_debt < request.wsxmr_amount {
        global.global_pending_burn_debt = 0;
    } else {
        global.global_pending_burn_debt -= request.wsxmr_amount;
    }

    // Pay par value to holder (no reward for force-settle)
    if user_base > 0 {
        ctx.accounts.user_pending_returns.collateral_amount = ctx
            .accounts
            .user_pending_returns
            .collateral_amount
            .checked_add(user_base)
            .ok_or(WrapSynthError::MathOverflow)?;
        global.global_pending_collateral = global
            .global_pending_collateral
            .checked_add(user_base)
            .ok_or(WrapSynthError::MathOverflow)?;
        slash_to_pool(
            vault,
            &ctx.accounts.vault_collateral_escrow,
            &ctx.accounts.collateral_escrow,
            &ctx.accounts.system_program.to_account_info(),
            user_base,
        )?;
    }

    vault.active_burn_count = vault.active_burn_count.saturating_sub(1);
    request.status = BurnStatus::Slashed;
    msg!(
        "Burn force-settled: {:?}, payout: {}",
        request.request_id,
        user_base
    );
    Ok(())
}

// ─── resolve_declined_proposal ────────────────────────────────────────────────

pub fn resolve_declined_proposal(
    ctx: Context<ResolveDeclinedProposal>,
    user_secret: [u8; 32],
) -> Result<()> {
    require!(user_secret != [0u8; 32], WrapSynthError::InvalidUserSecret);

    let request = &mut ctx.accounts.burn_request;
    let late_claim = request.abandoned;
    if late_claim {
        // LP already abandoned — collateral/debt settled, only the wsXMR claim remains.
        require!(
            request.status == BurnStatus::Cancelled,
            WrapSynthError::InvalidStatus
        );
    } else {
        require!(
            request.status == BurnStatus::Proposed,
            WrapSynthError::InvalidStatus
        );
    }

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= request.deadline,
        WrapSynthError::DeadlineNotExpired
    );

    // Verify userSecret corresponds to the stored userPublicKey (compressed
    // Ed25519 point) — the refund always costs a key-half reveal so the LP can
    // sweep the shared XMR back, preserving atomicity.
    require!(
        verify_public_key(&user_secret, &request.user_public_key),
        WrapSynthError::InvalidUserSecret
    );

    if !late_claim {
        let vault = &mut ctx.accounts.vault;
        if request.vault_liquidation_nonce == vault.liquidation_nonce {
            let total_lock = request.locked_collateral + request.reward_collateral;
            if vault.locked_collateral < total_lock {
                return err!(WrapSynthError::InsufficientCollateral);
            }
            vault.locked_collateral -= total_lock;
        }

        let global = &mut ctx.accounts.global_state.load_mut()?;
        if global.global_pending_burn_debt < request.wsxmr_amount {
            global.global_pending_burn_debt = 0;
        } else {
            global.global_pending_burn_debt -= request.wsxmr_amount;
        }

        vault.active_burn_count = vault.active_burn_count.saturating_sub(1);
        request.status = BurnStatus::Cancelled;
    } else {
        // Clear the flag so the late claim cannot execute twice.
        request.abandoned = false;
    }

    // Restore wsXMR to holder
    let gs_bump = ctx.accounts.global_state.load()?.bump;
    let gs_info = ctx.accounts.global_state.to_account_info();
    let seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[gs_bump]];
    let signer_seeds = &[seeds];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint: ctx.accounts.wsxmr_mint.to_account_info(),
            to: ctx.accounts.user_wsxmr_ata.to_account_info(),
            authority: gs_info,
        },
        signer_seeds,
    );
    mint_to(cpi_ctx, request.wsxmr_amount)?;

    msg!("Burn proposal declined: {:?}", request.request_id);
    Ok(())
}

// ─── abandon_proposed_burn ────────────────────────────────────────────────────

pub fn abandon_proposed_burn(ctx: Context<AbandonProposedBurn>) -> Result<()> {
    let request = &mut ctx.accounts.burn_request;
    require!(
        request.status == BurnStatus::Proposed,
        WrapSynthError::InvalidStatus
    );
    require!(
        ctx.accounts.lp.key() == ctx.accounts.vault.lp_address,
        WrapSynthError::Unauthorized
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= request.deadline,
        WrapSynthError::DeadlineNotExpired
    );

    let vault = &mut ctx.accounts.vault;
    if request.vault_liquidation_nonce == vault.liquidation_nonce {
        let total_lock = request.locked_collateral + request.reward_collateral;
        if vault.locked_collateral < total_lock {
            return err!(WrapSynthError::InsufficientCollateral);
        }
        vault.locked_collateral -= total_lock;
    }

    let global = &mut ctx.accounts.global_state.load_mut()?;
    if global.global_pending_burn_debt < request.wsxmr_amount {
        global.global_pending_burn_debt = 0;
    } else {
        global.global_pending_burn_debt -= request.wsxmr_amount;
    }

    vault.active_burn_count = vault.active_burn_count.saturating_sub(1);

    // Do NOT restore wsXMR — the user must reveal userSecret via
    // resolve_declined_proposal to reclaim it, which also gives the LP the key
    // material to sweep the shared XMR output.
    request.abandoned = true;
    request.status = BurnStatus::Cancelled;
    msg!("Burn abandoned by LP: {:?}", request.request_id);
    Ok(())
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(wsxmr_amount: u64, claim_commitment: [u8; 32], user_public_key: [u8; 32], user_view_key: [u8; 32], request_id: [u8; 32])]
pub struct RequestBurn<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
        bump = vault.bump,
        constraint = vault.active @ WrapSynthError::VaultNotActive,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    #[account(
        init,
        payer = user,
        space = BurnRequest::LEN,
        seeds = [BURN_REQUEST_SEED, request_id.as_ref()],
        bump,
    )]
    pub burn_request: Box<Account<'info, BurnRequest>>,

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
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
        constraint = burn_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub burn_request: Box<Account<'info, BurnRequest>>,
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
    pub burn_request: Box<Account<'info, BurnRequest>>,
}

#[derive(Accounts)]
pub struct RevealBurnSecret<'info> {
    /// CHECK: permissionless — anyone can reveal the secret on behalf of the LP
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
    )]
    pub burn_request: Box<Account<'info, BurnRequest>>,
}

#[derive(Accounts)]
pub struct SettleBurn<'info> {
    /// CHECK: permissionless — anyone can settle after the secret is revealed
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: LP address for vault seed derivation
    pub vault_lp: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault_lp.key().as_ref()],
        bump = vault.bump,
        constraint = vault.key() == burn_request.lp_vault @ WrapSynthError::Unauthorized,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
        constraint = burn_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub burn_request: Box<Account<'info, BurnRequest>>,

    /// Pre-existing PendingReturns for burn user. Created via initialize_pending_returns.
    #[account(
        mut,
        constraint = user_pending_returns.owner == burn_request.user @ WrapSynthError::Unauthorized,
    )]
    pub user_pending_returns: Box<Account<'info, PendingReturns>>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

    /// CHECK: lamport-only vault collateral escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_escrow: AccountInfo<'info>,

    /// CHECK: lamport-only program collateral pool PDA — validated by seeds
    #[account(
        mut,
        seeds = [PROGRAM_COLLATERAL_SEED],
        bump,
    )]
    pub collateral_escrow: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeBurn<'info> {
    /// CHECK: permissionless — anyone holding the secret can finalize
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: LP address for vault seed derivation
    pub vault_lp: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault_lp.key().as_ref()],
        bump = vault.bump,
        constraint = vault.key() == burn_request.lp_vault @ WrapSynthError::Unauthorized,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
        constraint = burn_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub burn_request: Box<Account<'info, BurnRequest>>,

    /// Pre-existing PendingReturns for burn user. Created via initialize_pending_returns.
    #[account(
        mut,
        constraint = user_pending_returns.owner == burn_request.user @ WrapSynthError::Unauthorized,
    )]
    pub user_pending_returns: Box<Account<'info, PendingReturns>>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

    /// CHECK: lamport-only vault collateral escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_escrow: AccountInfo<'info>,

    /// CHECK: lamport-only program collateral pool PDA — validated by seeds
    #[account(
        mut,
        seeds = [PROGRAM_COLLATERAL_SEED],
        bump,
    )]
    pub collateral_escrow: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
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
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
        constraint = burn_request.user == user.key() @ WrapSynthError::Unauthorized,
    )]
    pub burn_request: Box<Account<'info, BurnRequest>>,

    #[account(
        mut,
        seeds = [PENDING_RETURNS_SEED, user.key().as_ref()],
        bump = user_pending_returns.bump,
        constraint = user_pending_returns.owner == user.key() @ WrapSynthError::Unauthorized,
    )]
    pub user_pending_returns: Box<Account<'info, PendingReturns>>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

    /// CHECK: lamport-only vault collateral escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_escrow: AccountInfo<'info>,

    /// CHECK: lamport-only program collateral pool PDA — validated by seeds
    #[account(
        mut,
        seeds = [PROGRAM_COLLATERAL_SEED],
        bump,
    )]
    pub collateral_escrow: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AbortBurn<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        constraint = burn_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
    )]
    pub burn_request: Box<Account<'info, BurnRequest>>,

    #[account(mut)]
    pub wsxmr_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_wsxmr_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ForceSettleBurn<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        constraint = burn_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
    )]
    pub burn_request: Box<Account<'info, BurnRequest>>,

    /// Pre-existing PendingReturns for burn user.
    #[account(
        mut,
        constraint = user_pending_returns.owner == burn_request.user @ WrapSynthError::Unauthorized,
    )]
    pub user_pending_returns: Box<Account<'info, PendingReturns>>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

    /// CHECK: lamport-only vault collateral escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_escrow: AccountInfo<'info>,

    /// CHECK: lamport-only program collateral pool PDA — validated by seeds
    #[account(
        mut,
        seeds = [PROGRAM_COLLATERAL_SEED],
        bump,
    )]
    pub collateral_escrow: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveDeclinedProposal<'info> {
    /// CHECK: permissionless — anyone can resolve after the deadline
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        constraint = burn_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
    )]
    pub burn_request: Box<Account<'info, BurnRequest>>,

    #[account(mut)]
    pub wsxmr_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub user_wsxmr_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AbandonProposedBurn<'info> {
    pub lp: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lp.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
        constraint = burn_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub burn_request: Box<Account<'info, BurnRequest>>,

    pub system_program: Program<'info, System>,
}
