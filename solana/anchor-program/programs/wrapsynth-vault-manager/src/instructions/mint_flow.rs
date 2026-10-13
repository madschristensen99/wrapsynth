use anchor_lang::prelude::*;
use anchor_spl::token_2022::{Token2022, MintTo, mint_to};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::state::{GlobalState, Vault, MintRequest, MintStatus, PendingReturns};
use crate::utils::{
    get_xmr_price, get_collateral_price, get_collateral_redemption_rate, check_depeg_guard, mul_verify,
    math::{get_actual_debt, normalize_debt, collateral_to_usd, usd_to_collateral, check_collateral_ratio},
};
use crate::instructions::vault_management::sync_vault_yield;

/// Compute the par-value collateral lock for a mint — the key bond at
/// provide_lp_key and the re-priced par lock at set_mint_ready. Mirrors the EVM
/// MintFacet sizing:
///   par_value_usd = wsxmr_amount * xmr_price / 1e8
///   lock_usd      = par_value_usd * MINT_LOCK_RATIO / 100
///   lock_shares   = lock_usd * 1e18 / collateral_price
fn compute_mint_lock(wsxmr_amount: u64, xmr_price: u64, col_price: u64) -> Result<u64> {
    let par_value_usd = (wsxmr_amount as u128)
        .checked_mul(xmr_price as u128)
        .ok_or(WrapSynthError::MathOverflow)?
        / WSXMR_DECIMALS as u128;
    let lock_usd = (par_value_usd as u128)
        .checked_mul(MINT_LOCK_RATIO as u128)
        .ok_or(WrapSynthError::MathOverflow)?
        / RATIO_PRECISION as u128;
    Ok(usd_to_collateral(lock_usd as u64, col_price))
}

// ─── initiate_mint ────────────────────────────────────────────────────────────

pub fn initiate_mint(
    ctx: Context<InitiateMint>,
    xmr_amount: u64,
    claim_commitment: [u8; 32],
    user_public_key: [u8; 32],
    request_id: [u8; 32],
) -> Result<()> {
    require!(xmr_amount >= XMR_TO_WSXMR_DIVISOR, WrapSynthError::XmrAmountTooSmall);
    require!(claim_commitment != [0u8; 32], WrapSynthError::InvalidCommitment);
    require!(user_public_key != [0u8; 32], WrapSynthError::InvalidCommitment);

    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);

    // Sync yield before reading collateral
    sync_vault_yield(
        vault,
        &mut *ctx.accounts.global_state.load_mut()?,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
        &ctx.accounts.pyth_susde_rr,
    )?;

    let global_debt_index = ctx.accounts.global_state.load()?.global_debt_index;

    // Griefing deposit check — whitelisted minters bypass it (EVM parity)
    let is_whitelisted = {
        let count = vault.whitelisted_minter_count as usize;
        let mut found = false;
        for i in 0..count {
            if vault.whitelisted_minters[i] == ctx.accounts.initiator.key() {
                found = true;
                break;
            }
        }
        found
    };
    if !is_whitelisted {
        require!(
            ctx.accounts.griefing_escrow.lamports() >= vault.mint_griefing_deposit,
            WrapSynthError::InsufficientDeposit
        );
    }

    let wsxmr_amount = xmr_amount / XMR_TO_WSXMR_DIVISOR;
    let fee_amount = (wsxmr_amount as u128)
        .checked_mul(vault.mint_fee_bps as u128)
        .unwrap_or(0)
        / BPS_DENOMINATOR as u128;
    let fee_amount = fee_amount as u64;

    // Enforce max mint bps limit
    if vault.max_mint_bps > 0 {
        let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
        let col_price = get_collateral_price(
            &ctx.accounts.pyth_collateral,
            PRICE_MAX_AGE,
            &SUSDE_USD_FEED_ID,
        )?;
        let col_val_usd = collateral_to_usd(vault.collateral_amount, col_price);
        let max_debt_capacity = (col_val_usd as u128 * RATIO_PRECISION as u128)
            / COLLATERAL_RATIO as u128;
        let max_mint_allowed = (max_debt_capacity * vault.max_mint_bps as u128)
            / BPS_DENOMINATOR as u128;
        let wsxmr_val_usd = (wsxmr_amount as u128 * xmr_price as u128) / WSXMR_DECIMALS as u128;
        require!(wsxmr_val_usd <= max_mint_allowed, WrapSynthError::InvalidValue);
    }

    // Capacity check — mirrors EVM initiateMint: the key bond (MINT_LOCK_RATIO of
    // par) is reserved in the CR check so the LP can always key the mint. Nothing
    // is reserved in storage here; pending_debt is reserved at provide_lp_key so
    // spamming initiate_mint cannot DoS the vault's minting ability.
    let actual_debt = get_actual_debt(vault.normalized_debt, global_debt_index);
    let total_projected = actual_debt
        .checked_add(vault.pending_debt)
        .ok_or(WrapSynthError::MathOverflow)?
        .checked_add(wsxmr_amount)
        .ok_or(WrapSynthError::MathOverflow)?;

    // Total collateral model: collateral_amount = total (locked included), so
    // available = collateral_amount - locked_collateral.
    let available_collateral = vault.collateral_amount.saturating_sub(vault.locked_collateral);
    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &SUSDE_USD_FEED_ID,
    )?;
    let bond_shares = compute_mint_lock(wsxmr_amount, xmr_price, col_price)?;
    require!(
        available_collateral >= bond_shares,
        WrapSynthError::InsufficientCollateral
    );
    let remaining_free = available_collateral - bond_shares;

    require!(
        check_collateral_ratio(
            remaining_free,
            col_price,
            total_projected,
            xmr_price,
            COLLATERAL_RATIO,
        ),
        WrapSynthError::InsufficientCollateral
    );

    // Depeg guard: prevent new mints if sUSDe market price diverges below its
    // redemption value (fair value ≈ sUSDe→USDe rate, since USDe is pegged 1:1)
    let redemption_rate = get_collateral_redemption_rate(&ctx.accounts.pyth_susde_rr)?;
    check_depeg_guard(col_price, redemption_rate)?;

    // Increment nonce. Client pre-computed request_id = keccak(initiator, vault, amount, commitment, nonce+1).
    let gs = &mut ctx.accounts.global_state.load_mut()?;
    gs.request_nonce = gs.request_nonce
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;
    // Bind the passed request_id to the canonical hash (seed uses request_id directly)
    let expected_id = anchor_lang::solana_program::keccak::hashv(&[
        ctx.accounts.initiator.key().as_ref(),
        ctx.accounts.vault.key().as_ref(),
        &xmr_amount.to_le_bytes(),
        &claim_commitment,
        &gs.request_nonce.to_le_bytes(),
    ])
    .0;
    require!(request_id == expected_id, WrapSynthError::InvalidMintRequest);

    // Extract vault key before mutable borrow.
    let vault_key = ctx.accounts.vault.key();

    let clock = Clock::get()?;
    let request = &mut ctx.accounts.mint_request;
    let vault = &mut ctx.accounts.vault;
    request.request_id = request_id;
    request.initiator = ctx.accounts.initiator.key();
    request.recipient = ctx.accounts.recipient.key();
    request.lp_vault = vault_key;
    request.xmr_amount = xmr_amount;
    request.wsxmr_amount = wsxmr_amount;
    request.fee_amount = fee_amount;
    request.claim_commitment = claim_commitment;
    request.user_public_key = user_public_key;
    request.lp_public_spend_key = [0u8; 32];
    request.lp_public_view_key = [0u8; 32];
    request.lp_commitment = [0u8; 32];
    request.timeout = clock.unix_timestamp + vault.mint_timeout_seconds;
    request.griefing_deposit = vault.mint_griefing_deposit;
    request.locked_collateral = 0;
    request.xmr_price_at_ready = 0;
    request.normalized_debt_amount = 0;
    request.vault_mint_nonce = vault.mint_nonce;
    request.revealed_secret = [0u8; 32];
    request.status = MintStatus::Pending;
    request.bump = ctx.bumps.mint_request;

    msg!(
        "Mint initiated: {:?} for {} wsXMR",
        request_id,
        wsxmr_amount
    );
    Ok(())
}

// ─── provide_lp_key ───────────────────────────────────────────────────────────

pub fn provide_lp_key(
    ctx: Context<ProvideLPKey>,
    lp_public_spend_key: [u8; 32],
    lp_public_view_key: [u8; 32],
    lp_commitment: [u8; 32],
) -> Result<()> {
    let request = &mut ctx.accounts.mint_request;
    require!(request.status == MintStatus::Pending, WrapSynthError::InvalidStatus);
    require!(
        ctx.accounts.lp.key() == ctx.accounts.vault.lp_address,
        WrapSynthError::Unauthorized
    );

    let clock = Clock::get()?;
    require!(clock.unix_timestamp < request.timeout, WrapSynthError::DeadlineExpired);
    require!(
        request.vault_mint_nonce == ctx.accounts.vault.mint_nonce,
        WrapSynthError::MintNonceMismatch
    );
    require!(lp_public_spend_key != [0u8; 32], WrapSynthError::InvalidCommitment);
    require!(lp_public_view_key != [0u8; 32], WrapSynthError::InvalidCommitment);
    require!(lp_commitment != [0u8; 32], WrapSynthError::InvalidCommitment);
    // Already provided
    require!(request.lp_commitment == [0u8; 32], WrapSynthError::InvalidStatus);

    // Sync yield before reading collateral
    sync_vault_yield(
        &mut ctx.accounts.vault,
        &mut *ctx.accounts.global_state.load_mut()?,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
        &ctx.accounts.pyth_susde_rr,
    )?;

    // Reserve debt capacity now that the LP has engaged. Reverts if the vault
    // cannot plausibly serve this mint — prevents over-reservation.
    let vault = &mut ctx.accounts.vault;
    vault.pending_debt = vault
        .pending_debt
        .checked_add(request.wsxmr_amount)
        .ok_or(WrapSynthError::MathOverflow)?;

    // Compute the par-value key bond — same sizing as the set_mint_ready lock
    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &SUSDE_USD_FEED_ID,
    )?;
    let bond_shares = compute_mint_lock(request.wsxmr_amount, xmr_price, col_price)?;

    // Total collateral model: collateral_amount = total (locked included), so
    // available = collateral_amount - locked_collateral.
    let available_collateral = vault.collateral_amount.saturating_sub(vault.locked_collateral);
    require!(available_collateral >= bond_shares, WrapSynthError::InsufficientCollateral);

    // Re-check CR with the remaining free collateral after locking the bond
    let remaining_free = available_collateral - bond_shares;
    let actual_debt = get_actual_debt(
        vault.normalized_debt,
        ctx.accounts.global_state.load()?.global_debt_index,
    );
    let projected_debt = actual_debt
        .checked_add(vault.pending_debt)
        .ok_or(WrapSynthError::MathOverflow)?;
    require!(
        check_collateral_ratio(
            remaining_free,
            col_price,
            projected_debt,
            xmr_price,
            COLLATERAL_RATIO,
        ),
        WrapSynthError::InsufficientCollateral
    );

    // Lock the key bond (total model: only increment locked_collateral)
    vault.locked_collateral = vault
        .locked_collateral
        .checked_add(bond_shares)
        .ok_or(WrapSynthError::MathOverflow)?;
    request.locked_collateral = bond_shares;

    request.lp_public_spend_key = lp_public_spend_key;
    request.lp_public_view_key = lp_public_view_key;
    request.lp_commitment = lp_commitment;
    request.status = MintStatus::KeyProvided;

    msg!("LP key provided for mint: {:?}", request.request_id);
    Ok(())
}

// ─── set_mint_ready ───────────────────────────────────────────────────────────

pub fn set_mint_ready(ctx: Context<SetMintReady>) -> Result<()> {
    let request = &mut ctx.accounts.mint_request;
    require!(request.status == MintStatus::KeyProvided, WrapSynthError::InvalidStatus);
    require!(
        ctx.accounts.lp.key() == ctx.accounts.vault.lp_address,
        WrapSynthError::Unauthorized
    );

    let clock = Clock::get()?;
    require!(clock.unix_timestamp < request.timeout, WrapSynthError::DeadlineExpired);
    require!(
        request.vault_mint_nonce == ctx.accounts.vault.mint_nonce,
        WrapSynthError::MintNonceMismatch
    );

    // Sync yield + re-check collateral
    sync_vault_yield(
        &mut ctx.accounts.vault,
        &mut *ctx.accounts.global_state.load_mut()?,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
        &ctx.accounts.pyth_susde_rr,
    )?;

    let vault = &mut ctx.accounts.vault;

    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &SUSDE_USD_FEED_ID,
    )?;

    // Re-price the par-value lock at ready time
    let lock_shares = compute_mint_lock(request.wsxmr_amount, xmr_price, col_price)?;

    // Total model: available = collateral_amount - locked_collateral (excludes
    // the key bond); adding it back gives the free collateral the new lock must
    // fit within.
    let current_locked = request.locked_collateral;
    let available_collateral = vault.collateral_amount.saturating_sub(vault.locked_collateral);
    let mut remaining_free = available_collateral
        .checked_add(current_locked)
        .ok_or(WrapSynthError::MathOverflow)?;
    require!(remaining_free >= lock_shares, WrapSynthError::InsufficientCollateral);
    remaining_free -= lock_shares;

    // Re-check CR with the remaining free collateral after adjustment
    let actual_debt = get_actual_debt(
        vault.normalized_debt,
        ctx.accounts.global_state.load()?.global_debt_index,
    );
    let projected_debt = actual_debt
        .checked_add(vault.pending_debt)
        .ok_or(WrapSynthError::MathOverflow)?;
    require!(
        check_collateral_ratio(
            remaining_free,
            col_price,
            projected_debt,
            xmr_price,
            COLLATERAL_RATIO,
        ),
        WrapSynthError::InsufficientCollateral
    );

    // Adjust the bond to the re-priced lock (top up or release the excess)
    if lock_shares > current_locked {
        let delta = lock_shares - current_locked;
        vault.locked_collateral = vault
            .locked_collateral
            .checked_add(delta)
            .ok_or(WrapSynthError::MathOverflow)?;
    } else if lock_shares < current_locked {
        let delta = current_locked - lock_shares;
        vault.locked_collateral = vault.locked_collateral.saturating_sub(delta);
    }
    request.locked_collateral = lock_shares;
    request.xmr_price_at_ready = xmr_price;

    request.status = MintStatus::Ready;
    request.timeout = clock.unix_timestamp + MINT_READY_EXTENSION;
    vault.pending_mint_count = vault
        .pending_mint_count
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;
    let __total_pending_mints_cur = ctx.accounts.global_state.load()?.total_pending_mints;
    ctx.accounts.global_state.load_mut()?.total_pending_mints = __total_pending_mints_cur
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;
    msg!("Mint ready: {:?}", request.request_id);
    Ok(())
}

// ─── reveal_secret ────────────────────────────────────────────────────────────

pub fn reveal_secret(ctx: Context<RevealSecret>, secret: [u8; 32]) -> Result<()> {
    let request = &mut ctx.accounts.mint_request;
    require!(request.status == MintStatus::Ready, WrapSynthError::InvalidStatus);
    require!(secret != [0u8; 32], WrapSynthError::InvalidSecret);

    // Pure Ed25519 verification — no oracle, no yield sync, no CR check. The
    // secret is stored on-chain; finalize_mint reads it from storage so the
    // secret never appears in the calldata of a tx that can revert on vault
    // state (mirrors the EVM revealSecret/finalizeMint split).
    require!(
        mul_verify(&secret, &request.claim_commitment),
        WrapSynthError::InvalidSecret
    );

    request.revealed_secret = secret;
    request.status = MintStatus::SecretRevealed;
    msg!("Secret revealed for mint: {:?}", request.request_id);
    Ok(())
}

// ─── finalize_mint ────────────────────────────────────────────────────────────

pub fn finalize_mint(ctx: Context<FinalizeMint>) -> Result<()> {
    let request = &mut ctx.accounts.mint_request;
    require!(request.status == MintStatus::SecretRevealed, WrapSynthError::InvalidStatus);
    require!(request.revealed_secret != [0u8; 32], WrapSynthError::InvalidStatus);

    // Extract bump and account_info before mutable borrows (needed for CPIs).
    let gs_bump = ctx.accounts.global_state.load()?.bump;
    let gs_info = ctx.accounts.global_state.to_account_info();

    execute_finalize(
        request,
        &mut ctx.accounts.vault,
        &ctx.accounts.global_state,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
        &ctx.accounts.pyth_susde_rr,
        &ctx.accounts.wsxmr_mint,
        &ctx.accounts.recipient_wsxmr_ata,
        &ctx.accounts.lp_wsxmr_ata,
        &mut ctx.accounts.pending_returns,
        &ctx.accounts.token_program,
        gs_info,
        gs_bump,
    )
}

/// Shared finalize logic used by finalize_mint and by cancel_mint's
/// SECRET_REVEALED branch. Caller must have verified status == SecretRevealed
/// and revealed_secret != 0.
#[allow(clippy::too_many_arguments)]
fn execute_finalize<'a>(
    request: &mut MintRequest,
    vault: &mut Vault,
    global_state: &AccountLoader<'a, GlobalState>,
    pyth_xmr: &AccountInfo<'a>,
    pyth_collateral: &AccountInfo<'a>,
    pyth_susde_rr: &AccountInfo<'a>,
    wsxmr_mint: &InterfaceAccount<'a, Mint>,
    recipient_wsxmr_ata: &InterfaceAccount<'a, TokenAccount>,
    lp_wsxmr_ata: &InterfaceAccount<'a, TokenAccount>,
    initiator_returns: &mut PendingReturns,
    token_program: &Program<'a, Token2022>,
    gs_info: AccountInfo<'a>,
    gs_bump: u8,
) -> Result<()> {
    // Liquidation nonce invalidation check
    if request.vault_mint_nonce != vault.mint_nonce {
        // Vault was liquidated — cancel and compensate the user. The user's
        // secret is public, so the LP can sweep the XMR; slash the locked
        // collateral to the user if still held.
        let global = &mut *global_state.load_mut()?;
        request.status = MintStatus::Cancelled;
        vault.pending_mint_count = vault.pending_mint_count.saturating_sub(1);
        global.total_pending_mints = global.total_pending_mints.saturating_sub(1);

        // Release the debt reservation — liquidation never touches pending_debt,
        // so the reservation is still held and must be freed here. The nonce
        // guard applies to collateral only, never to debt.
        vault.pending_debt = vault.pending_debt.saturating_sub(request.wsxmr_amount);

        if request.locked_collateral > 0 && vault.locked_collateral >= request.locked_collateral {
            vault.locked_collateral -= request.locked_collateral;
            // Total model: the slashed bond leaves the vault to the user.
            vault.collateral_amount = vault.collateral_amount.saturating_sub(request.locked_collateral);
            initiator_returns.collateral_amount = initiator_returns
                .collateral_amount
                .checked_add(request.locked_collateral)
                .ok_or(WrapSynthError::MathOverflow)?;
            global.global_pending_collateral = global
                .global_pending_collateral
                .checked_add(request.locked_collateral)
                .ok_or(WrapSynthError::MathOverflow)?;
        }
        if request.griefing_deposit > 0 {
            initiator_returns.sol_amount = initiator_returns
                .sol_amount
                .checked_add(request.griefing_deposit)
                .ok_or(WrapSynthError::MathOverflow)?;
            global.global_pending_sol = global
                .global_pending_sol
                .checked_add(request.griefing_deposit)
                .ok_or(WrapSynthError::MathOverflow)?;
        }
        msg!("Mint cancelled (vault liquidated): {:?}", request.request_id);
        return Ok(());
    }

    // Sync yield + debt/collateral accounting — scope the global borrow so the
    // RefMut is dropped before the mint_to CPIs reuse gs_info (global_state's
    // AccountInfo). invoke_signed borrows the account data to serialize, so we
    // must not hold a load_mut() across the CPI.
    {
        let global = &mut *global_state.load_mut()?;
        sync_vault_yield(vault, global, pyth_xmr, pyth_collateral, pyth_susde_rr)?;

        // Release locked collateral — mint succeeded, reservation no longer needed.
        // Total model: only the reservation is released; collateral stays in the vault.
        if request.locked_collateral > 0 && vault.locked_collateral >= request.locked_collateral {
            vault.locked_collateral -= request.locked_collateral;
        }

        // Release pending debt reservation and add to actual normalized debt
        vault.pending_debt = vault.pending_debt.saturating_sub(request.wsxmr_amount);
        let normalized = normalize_debt(request.wsxmr_amount, global.global_debt_index);
        vault.normalized_debt = vault
            .normalized_debt
            .checked_add(normalized)
            .ok_or(WrapSynthError::MathOverflow)?;
        request.normalized_debt_amount = normalized;
        global.global_total_debt = global
            .global_total_debt
            .checked_add(request.wsxmr_amount)
            .ok_or(WrapSynthError::MathOverflow)?;
    }

    // Mint wsXMR to recipient (net of fee) and fee to LP
    let seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[gs_bump]];
    let signer_seeds = &[seeds];

    let net_amount = request.wsxmr_amount - request.fee_amount;
    if net_amount > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            MintTo {
                mint: wsxmr_mint.to_account_info(),
                to: recipient_wsxmr_ata.to_account_info(),
                authority: gs_info.clone(),
            },
            signer_seeds,
        );
        mint_to(cpi_ctx, net_amount)?;
    }

    if request.fee_amount > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            token_program.to_account_info(),
            MintTo {
                mint: wsxmr_mint.to_account_info(),
                to: lp_wsxmr_ata.to_account_info(),
                authority: gs_info.clone(),
            },
            signer_seeds,
        );
        mint_to(cpi_ctx, request.fee_amount)?;
    }

    // Refund griefing deposit to initiator
    if request.griefing_deposit > 0 {
        initiator_returns.sol_amount = initiator_returns
            .sol_amount
            .checked_add(request.griefing_deposit)
            .ok_or(WrapSynthError::MathOverflow)?;
    }

    // Post-CPI global bookkeeping — fresh scoped borrow (CPIs are done above).
    {
        let global = &mut *global_state.load_mut()?;
        if request.griefing_deposit > 0 {
            global.global_pending_sol = global
                .global_pending_sol
                .checked_add(request.griefing_deposit)
                .ok_or(WrapSynthError::MathOverflow)?;
        }
        global.total_pending_mints = global.total_pending_mints.saturating_sub(1);
    }
    vault.pending_mint_count = vault.pending_mint_count.saturating_sub(1);
    request.status = MintStatus::Completed;
    msg!("Mint finalized: {:?}", request.request_id);
    Ok(())
}

// ─── cancel_mint ──────────────────────────────────────────────────────────────

pub fn cancel_mint(ctx: Context<CancelMint>) -> Result<()> {
    let request = &mut ctx.accounts.mint_request;
    require!(
        request.status == MintStatus::Pending
            || request.status == MintStatus::KeyProvided
            || request.status == MintStatus::Ready
            || request.status == MintStatus::SecretRevealed,
        WrapSynthError::InvalidStatus
    );

    let clock = Clock::get()?;
    require!(clock.unix_timestamp >= request.timeout, WrapSynthError::TimeoutNotReached);

    let vault = &mut ctx.accounts.vault;
    let original_status = request.status;

    // Release reserved debt for mints that engaged the LP (KEY_PROVIDED/READY).
    // SECRET_REVEALED is excluded — execute_finalize handles its own debt
    // accounting. Unconditional: liquidation never touches pending_debt, so the
    // reservation is still held even when the nonce no longer matches.
    if original_status != MintStatus::Pending && original_status != MintStatus::SecretRevealed {
        vault.pending_debt = vault.pending_debt.saturating_sub(request.wsxmr_amount);
    }

    if original_status == MintStatus::Pending {
        // LP never engaged — cancel and return the griefing deposit to the user.
        request.status = MintStatus::Cancelled;
        if request.griefing_deposit > 0 {
            ctx.accounts.initiator_returns.sol_amount = ctx
                .accounts
                .initiator_returns
                .sol_amount
                .checked_add(request.griefing_deposit)
                .ok_or(WrapSynthError::MathOverflow)?;
            let __global_pending_sol_cur = ctx.accounts.global_state.load()?.global_pending_sol;
            ctx.accounts.global_state.load_mut()?.global_pending_sol = __global_pending_sol_cur
                .checked_add(request.griefing_deposit)
                .ok_or(WrapSynthError::MathOverflow)?;
        }
        msg!("Mint cancelled (pending): {:?}", request.request_id);
    } else if original_status == MintStatus::KeyProvided {
        // LP keyed but the mint never became READY — either no deposit arrived or
        // the LP ghosted. The key bond stays locked: it is released if the LP
        // publishes lp_secret (abandon_key_provided_mint), slashed to the user if
        // they don't (reclaim_parked_deposit). Park the deposit as the reveal bounty.
        request.status = MintStatus::KeyCancelled;
        request.timeout = clock.unix_timestamp + LP_CLAIM_WINDOW;
        msg!("Mint key cancelled: {:?}", request.request_id);
    } else if original_status == MintStatus::SecretRevealed {
        // Secret already public via reveal_secret — mint anyway (see execute_finalize).
        let gs_bump = ctx.accounts.global_state.load()?.bump;
        let gs_info = ctx.accounts.global_state.to_account_info();
        execute_finalize(
            request,
            vault,
            &ctx.accounts.global_state,
            &ctx.accounts.pyth_xmr,
            &ctx.accounts.pyth_collateral,
            &ctx.accounts.pyth_susde_rr,
            &ctx.accounts.wsxmr_mint,
            &ctx.accounts.recipient_wsxmr_ata,
            &ctx.accounts.lp_wsxmr_ata,
            &mut ctx.accounts.initiator_returns,
            &ctx.accounts.token_program,
            gs_info,
            gs_bump,
        )?;
    } else {
        // READY, timed out, user never finalized. Move to EXPIRED_READY — the LP
        // must claim with a secret reveal within the claim window.
        request.status = MintStatus::ExpiredReady;
        request.timeout = clock.unix_timestamp + LP_CLAIM_WINDOW;
        msg!("Mint expired ready: {:?}", request.request_id);
    }

    Ok(())
}

// ─── abandon_key_provided_mint ────────────────────────────────────────────────

pub fn abandon_key_provided_mint(
    ctx: Context<AbandonKeyProvidedMint>,
    lp_secret: [u8; 32],
) -> Result<()> {
    let request = &mut ctx.accounts.mint_request;
    require!(
        request.status == MintStatus::KeyProvided || request.status == MintStatus::KeyCancelled,
        WrapSynthError::InvalidStatus
    );
    require!(
        ctx.accounts.lp.key() == ctx.accounts.vault.lp_address,
        WrapSynthError::Unauthorized
    );

    let clock = Clock::get()?;
    let vault = &mut ctx.accounts.vault;

    if request.status == MintStatus::KeyProvided {
        // Direct abandon — only after the mint timeout so the LP cannot key-then-
        // instant-abandon to farm griefing deposits from users about to send XMR.
        require!(clock.unix_timestamp >= request.timeout, WrapSynthError::TimeoutNotReached);
        // Release the debt reservation unconditionally — liquidation never touches
        // pending_debt, so it is still held even when the nonce no longer matches.
        vault.pending_debt = vault.pending_debt.saturating_sub(request.wsxmr_amount);
    } else {
        // KEY_CANCELLED — must claim within the parked-deposit window.
        require!(clock.unix_timestamp < request.timeout, WrapSynthError::DeadlineExpired);
    }

    // Verify the LP secret matches the commitment
    require!(
        mul_verify(&lp_secret, &request.lp_commitment),
        WrapSynthError::InvalidSecret
    );

    request.status = MintStatus::Cancelled;

    // Release the key bond — the LP fulfilled their obligation by publishing
    // lp_secret. Total model: only the reservation is released. Guard covers the
    // liquidation-takeover case where locked was zeroed.
    if request.locked_collateral > 0 && vault.locked_collateral >= request.locked_collateral {
        vault.locked_collateral -= request.locked_collateral;
        request.locked_collateral = 0;
    }

    if request.griefing_deposit > 0 {
        ctx.accounts.lp_returns.sol_amount = ctx
            .accounts
            .lp_returns
            .sol_amount
            .checked_add(request.griefing_deposit)
            .ok_or(WrapSynthError::MathOverflow)?;
        let __global_pending_sol_cur = ctx.accounts.global_state.load()?.global_pending_sol;
        ctx.accounts.global_state.load_mut()?.global_pending_sol = __global_pending_sol_cur
            .checked_add(request.griefing_deposit)
            .ok_or(WrapSynthError::MathOverflow)?;
    }

    msg!("Mint abandoned by LP: {:?}", request.request_id);
    Ok(())
}

// ─── reclaim_parked_deposit ───────────────────────────────────────────────────

pub fn reclaim_parked_deposit(ctx: Context<ReclaimParkedDeposit>) -> Result<()> {
    let request = &mut ctx.accounts.mint_request;
    require!(request.status == MintStatus::KeyCancelled, WrapSynthError::InvalidStatus);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp >= request.timeout, WrapSynthError::TimeoutNotReached);

    request.status = MintStatus::Cancelled;

    let vault = &mut ctx.accounts.vault;
    // Release the key bond reservation. If the vault was not liquidated, slash it
    // to the user — the LP never revealed lp_secret. If liquidated (nonce changed),
    // release it back to the vault's free balance instead of leaving it locked.
    if request.locked_collateral > 0 {
        if request.vault_mint_nonce == vault.mint_nonce {
            if vault.locked_collateral >= request.locked_collateral {
                vault.locked_collateral -= request.locked_collateral;
            }
            // Total model: the slashed bond leaves the vault to the user.
            vault.collateral_amount = vault.collateral_amount.saturating_sub(request.locked_collateral);
            ctx.accounts.initiator_returns.collateral_amount = ctx
                .accounts
                .initiator_returns
                .collateral_amount
                .checked_add(request.locked_collateral)
                .ok_or(WrapSynthError::MathOverflow)?;
            let __global_pending_collateral_cur = ctx.accounts.global_state.load()?.global_pending_collateral;
            ctx.accounts.global_state.load_mut()?.global_pending_collateral = __global_pending_collateral_cur
                .checked_add(request.locked_collateral)
                .ok_or(WrapSynthError::MathOverflow)?;
        } else if vault.locked_collateral >= request.locked_collateral {
            vault.locked_collateral -= request.locked_collateral;
        }
    }

    if request.griefing_deposit > 0 {
        ctx.accounts.initiator_returns.sol_amount = ctx
            .accounts
            .initiator_returns
            .sol_amount
            .checked_add(request.griefing_deposit)
            .ok_or(WrapSynthError::MathOverflow)?;
        let __global_pending_sol_cur = ctx.accounts.global_state.load()?.global_pending_sol;
        ctx.accounts.global_state.load_mut()?.global_pending_sol = __global_pending_sol_cur
            .checked_add(request.griefing_deposit)
            .ok_or(WrapSynthError::MathOverflow)?;
    }

    msg!("Parked deposit reclaimed for mint: {:?}", request.request_id);
    Ok(())
}

// ─── claim_griefing_deposit ───────────────────────────────────────────────────

pub fn claim_griefing_deposit(ctx: Context<ClaimGriefingDeposit>, lp_secret: [u8; 32]) -> Result<()> {
    let request = &mut ctx.accounts.mint_request;
    require!(request.status == MintStatus::ExpiredReady, WrapSynthError::InvalidStatus);
    require!(
        ctx.accounts.lp.key() == ctx.accounts.vault.lp_address,
        WrapSynthError::Unauthorized
    );

    let clock = Clock::get()?;
    require!(clock.unix_timestamp < request.timeout, WrapSynthError::DeadlineExpired);

    // Verify the LP secret matches the commitment — proves the LP was ready to
    // finalize and the user abandoned the mint.
    require!(
        mul_verify(&lp_secret, &request.lp_commitment),
        WrapSynthError::InvalidSecret
    );

    let vault = &mut ctx.accounts.vault;
    request.status = MintStatus::Cancelled;
    vault.pending_mint_count = vault.pending_mint_count.saturating_sub(1);
    let __total_pending_mints_cur = ctx.accounts.global_state.load()?.total_pending_mints;
    ctx.accounts.global_state.load_mut()?.total_pending_mints = __total_pending_mints_cur
        .saturating_sub(1);

    // Release locked collateral back to vault — LP revealed their secret, user
    // can recover XMR from the shared address. Total model: reservation only.
    if request.locked_collateral > 0 && vault.locked_collateral >= request.locked_collateral {
        vault.locked_collateral -= request.locked_collateral;
    }

    if request.griefing_deposit > 0 {
        ctx.accounts.lp_returns.sol_amount = ctx
            .accounts
            .lp_returns
            .sol_amount
            .checked_add(request.griefing_deposit)
            .ok_or(WrapSynthError::MathOverflow)?;
        let __global_pending_sol_cur = ctx.accounts.global_state.load()?.global_pending_sol;
        ctx.accounts.global_state.load_mut()?.global_pending_sol = __global_pending_sol_cur
            .checked_add(request.griefing_deposit)
            .ok_or(WrapSynthError::MathOverflow)?;
    }

    msg!("Griefing deposit claimed by LP for mint: {:?}", request.request_id);
    Ok(())
}

// ─── sweep_unclaimed_expired_mint ─────────────────────────────────────────────

pub fn sweep_unclaimed_expired_mint(ctx: Context<SweepUnclaimedExpiredMint>) -> Result<()> {
    let request = &mut ctx.accounts.mint_request;
    require!(request.status == MintStatus::ExpiredReady, WrapSynthError::InvalidStatus);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp >= request.timeout, WrapSynthError::TimeoutNotReached);

    let vault = &mut ctx.accounts.vault;
    request.status = MintStatus::Cancelled;
    vault.pending_mint_count = vault.pending_mint_count.saturating_sub(1);
    let __total_pending_mints_cur = ctx.accounts.global_state.load()?.total_pending_mints;
    ctx.accounts.global_state.load_mut()?.total_pending_mints = __total_pending_mints_cur
        .saturating_sub(1);

    // Release the par-value lock. If the vault was not liquidated, slash it to
    // the user — the LP ghosted. If liquidated (nonce changed), release it back
    // to the vault's free balance instead of leaving it locked forever.
    if request.locked_collateral > 0 {
        if request.vault_mint_nonce == vault.mint_nonce {
            if vault.locked_collateral >= request.locked_collateral {
                vault.locked_collateral -= request.locked_collateral;
            }
            // Total model: the slashed lock leaves the vault to the user.
            vault.collateral_amount = vault.collateral_amount.saturating_sub(request.locked_collateral);
            ctx.accounts.initiator_returns.collateral_amount = ctx
                .accounts
                .initiator_returns
                .collateral_amount
                .checked_add(request.locked_collateral)
                .ok_or(WrapSynthError::MathOverflow)?;
            let __global_pending_collateral_cur = ctx.accounts.global_state.load()?.global_pending_collateral;
            ctx.accounts.global_state.load_mut()?.global_pending_collateral = __global_pending_collateral_cur
                .checked_add(request.locked_collateral)
                .ok_or(WrapSynthError::MathOverflow)?;
        } else if vault.locked_collateral >= request.locked_collateral {
            vault.locked_collateral -= request.locked_collateral;
        }
    }

    if request.griefing_deposit > 0 {
        ctx.accounts.initiator_returns.sol_amount = ctx
            .accounts
            .initiator_returns
            .sol_amount
            .checked_add(request.griefing_deposit)
            .ok_or(WrapSynthError::MathOverflow)?;
        let __global_pending_sol_cur = ctx.accounts.global_state.load()?.global_pending_sol;
        ctx.accounts.global_state.load_mut()?.global_pending_sol = __global_pending_sol_cur
            .checked_add(request.griefing_deposit)
            .ok_or(WrapSynthError::MathOverflow)?;
    }

    msg!("Unclaimed expired mint swept: {:?}", request.request_id);
    Ok(())
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(xmr_amount: u64, claim_commitment: [u8; 32], user_public_key: [u8; 32], request_id: [u8; 32])]
pub struct InitiateMint<'info> {
    #[account(mut)]
    pub initiator: Signer<'info>,

    /// CHECK: recipient may differ from initiator
    pub recipient: AccountInfo<'info>,

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
        payer = initiator,
        space = MintRequest::LEN,
        seeds = [MINT_REQUEST_SEED, request_id.as_ref()],
        bump,
    )]
    pub mint_request: Box<Account<'info, MintRequest>>,

    /// SOL escrow account for griefing deposit (created by initiator, lamports checked)
    /// CHECK: balance verified in instruction
    #[account(mut)]
    pub griefing_escrow: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [PENDING_RETURNS_SEED, initiator.key().as_ref()],
        bump,
    )]
    pub initiator_pending_returns: Account<'info, crate::state::PendingReturns>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed (sUSDe/USD) — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,
    /// CHECK: Pyth sUSDe→USDe redemption rate feed — validated by oracle.rs
    pub pyth_susde_rr: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMintReady<'info> {
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
        seeds = [MINT_REQUEST_SEED, mint_request.request_id.as_ref()],
        bump = mint_request.bump,
        constraint = mint_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub mint_request: Box<Account<'info, MintRequest>>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,
    /// CHECK: Pyth sUSDe→USDe redemption rate feed — validated by oracle.rs
    pub pyth_susde_rr: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct FinalizeMint<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
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
        seeds = [MINT_REQUEST_SEED, mint_request.request_id.as_ref()],
        bump = mint_request.bump,
        constraint = mint_request.lp_vault == vault.key() @ WrapSynthError::InvalidMintRequest,
    )]
    pub mint_request: Box<Account<'info, MintRequest>>,

    #[account(mut)]
    pub wsxmr_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub recipient_wsxmr_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub lp_wsxmr_ata: InterfaceAccount<'info, TokenAccount>,

    /// Pre-existing PendingReturns for mint initiator. Created via initialize_pending_returns.
    #[account(
        mut,
        constraint = pending_returns.owner == mint_request.initiator @ WrapSynthError::InvalidMintRequest,
    )]
    pub pending_returns: Account<'info, crate::state::PendingReturns>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,
    /// CHECK: Pyth sUSDe→USDe redemption rate feed — validated by oracle.rs
    pub pyth_susde_rr: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProvideLPKey<'info> {
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
        seeds = [MINT_REQUEST_SEED, mint_request.request_id.as_ref()],
        bump = mint_request.bump,
        constraint = mint_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub mint_request: Box<Account<'info, MintRequest>>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,
    /// CHECK: Pyth sUSDe→USDe redemption rate feed — validated by oracle.rs
    pub pyth_susde_rr: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RevealSecret<'info> {
    /// CHECK: permissionless — anyone can reveal the secret on behalf of the user
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [MINT_REQUEST_SEED, mint_request.request_id.as_ref()],
        bump = mint_request.bump,
    )]
    pub mint_request: Box<Account<'info, MintRequest>>,
}

#[derive(Accounts)]
pub struct AbandonKeyProvidedMint<'info> {
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
        seeds = [MINT_REQUEST_SEED, mint_request.request_id.as_ref()],
        bump = mint_request.bump,
        constraint = mint_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub mint_request: Box<Account<'info, MintRequest>>,

    /// Pre-existing PendingReturns for vault LP.
    #[account(
        mut,
        constraint = lp_returns.owner == vault.lp_address @ WrapSynthError::Unauthorized,
    )]
    pub lp_returns: Box<Account<'info, PendingReturns>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReclaimParkedDeposit<'info> {
    /// CHECK: permissionless — anyone can reclaim after the LP claim window lapses
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
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
        seeds = [MINT_REQUEST_SEED, mint_request.request_id.as_ref()],
        bump = mint_request.bump,
    )]
    pub mint_request: Box<Account<'info, MintRequest>>,

    /// Pre-existing PendingReturns for mint initiator (collateral slash + SOL refund).
    #[account(
        mut,
        constraint = initiator_returns.owner == mint_request.initiator @ WrapSynthError::InvalidMintRequest,
    )]
    pub initiator_returns: Box<Account<'info, PendingReturns>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimGriefingDeposit<'info> {
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
        seeds = [MINT_REQUEST_SEED, mint_request.request_id.as_ref()],
        bump = mint_request.bump,
        constraint = mint_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub mint_request: Box<Account<'info, MintRequest>>,

    /// Pre-existing PendingReturns for vault LP.
    #[account(
        mut,
        constraint = lp_returns.owner == vault.lp_address @ WrapSynthError::Unauthorized,
    )]
    pub lp_returns: Box<Account<'info, PendingReturns>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SweepUnclaimedExpiredMint<'info> {
    /// CHECK: permissionless — anyone can sweep after the LP claim window lapses
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
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
        seeds = [MINT_REQUEST_SEED, mint_request.request_id.as_ref()],
        bump = mint_request.bump,
    )]
    pub mint_request: Box<Account<'info, MintRequest>>,

    /// Pre-existing PendingReturns for mint initiator (collateral slash + SOL refund).
    #[account(
        mut,
        constraint = initiator_returns.owner == mint_request.initiator @ WrapSynthError::InvalidMintRequest,
    )]
    pub initiator_returns: Box<Account<'info, PendingReturns>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelMint<'info> {
    /// CHECK: permissionless — anyone can cancel an expired request
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
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
        seeds = [MINT_REQUEST_SEED, mint_request.request_id.as_ref()],
        bump = mint_request.bump,
    )]
    pub mint_request: Box<Account<'info, MintRequest>>,

    /// Pre-existing PendingReturns for mint initiator (SOL refund + collateral slash).
    #[account(
        mut,
        constraint = initiator_returns.owner == mint_request.initiator @ WrapSynthError::InvalidMintRequest,
    )]
    pub initiator_returns: Box<Account<'info, PendingReturns>>,

    /// Pre-existing PendingReturns for vault LP.
    #[account(
        mut,
        constraint = lp_returns.owner == vault.lp_address @ WrapSynthError::Unauthorized,
    )]
    pub lp_returns: Box<Account<'info, PendingReturns>>,

    // ── Accounts required only for the SECRET_REVEALED branch (inline finalize) ──
    #[account(mut)]
    pub wsxmr_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub recipient_wsxmr_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub lp_wsxmr_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,
    /// CHECK: Pyth sUSDe→USDe redemption rate feed — validated by oracle.rs
    pub pyth_susde_rr: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
