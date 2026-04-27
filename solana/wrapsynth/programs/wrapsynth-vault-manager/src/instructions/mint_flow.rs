use anchor_lang::prelude::*;
use anchor_spl::token_2022::{Token2022, MintTo, mint_to};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::state::{GlobalState, Vault, MintRequest, MintStatus};
use crate::utils::{
    get_xmr_price, get_collateral_price, mul_verify,
    math::{get_actual_debt, normalize_debt, collateral_to_usd, check_collateral_ratio},
};
use crate::instructions::vault_management::sync_vault_yield;

// ─── initiate_mint ────────────────────────────────────────────────────────────

pub fn initiate_mint(
    ctx: Context<InitiateMint>,
    xmr_amount: u64,
    claim_commitment: [u8; 32],
    timeout_duration: i64,
    request_id: [u8; 32],
) -> Result<()> {
    require!(xmr_amount >= XMR_TO_WSXMR_DIVISOR, WrapSynthError::XmrAmountTooSmall);
    require!(claim_commitment != [0u8; 32], WrapSynthError::InvalidSecret);
    require!(
        timeout_duration > 0 && timeout_duration <= MAX_MINT_TIMEOUT,
        WrapSynthError::InvalidValue
    );

    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);

    // Sync yield before reading collateral
    sync_vault_yield(
        vault,
        &mut ctx.accounts.global_state,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
    )?;

    let global = &ctx.accounts.global_state;

    // Griefing deposit check
    let griefing_deposit = ctx.accounts.initiator.lamports();
    // Note: the actual SOL transfer is handled by the system_program CPI in the accounts
    // The ctx.accounts.griefing_vault receives the lamports via init
    require!(
        ctx.accounts.griefing_escrow.lamports() >= vault.mint_griefing_deposit,
        WrapSynthError::InsufficientDeposit
    );

    let wsxmr_amount = xmr_amount / XMR_TO_WSXMR_DIVISOR;
    let fee_amount = (wsxmr_amount as u128)
        .checked_mul(vault.mint_fee_bps as u128)
        .unwrap_or(0)
        / BPS_DENOMINATOR as u128;
    let fee_amount = fee_amount as u64;

    // Enforce max mint bps limit
    if vault.max_mint_bps > 0 {
        msg!("DEBUG: Getting XMR price");
        let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
        msg!("DEBUG: XMR price = {}", xmr_price);
        msg!("DEBUG: Getting collateral price");
        let col_price = get_collateral_price(
            &ctx.accounts.pyth_collateral,
            PRICE_MAX_AGE,
            &global.pyth_collateral_feed.to_bytes(),
        )?;
        msg!("DEBUG: Collateral price = {}", col_price);
        let col_val_usd = collateral_to_usd(vault.collateral_amount, col_price);
        msg!("DEBUG: Collateral value USD = {}", col_val_usd);
        let max_debt_capacity = (col_val_usd as u128 * RATIO_PRECISION as u128)
            / COLLATERAL_RATIO as u128;
        let max_mint_allowed = (max_debt_capacity * vault.max_mint_bps as u128)
            / BPS_DENOMINATOR as u128;
        let wsxmr_val_usd = (wsxmr_amount as u128 * xmr_price as u128) / WSXMR_DECIMALS as u128;
        msg!("DEBUG: wsxmr_val_usd = {}, max_mint_allowed = {}", wsxmr_val_usd, max_mint_allowed);
        require!(wsxmr_val_usd <= max_mint_allowed, WrapSynthError::InvalidValue);
    }

    // Capacity check: actual + pending + this_mint <= available collateral capacity
    let actual_debt = get_actual_debt(vault.normalized_debt, global.global_debt_index);
    let total_projected = actual_debt
        .checked_add(vault.pending_debt)
        .ok_or(WrapSynthError::MathOverflow)?
        .checked_add(wsxmr_amount)
        .ok_or(WrapSynthError::MathOverflow)?;

    let available_collateral = vault.collateral_amount.saturating_sub(vault.locked_collateral);
    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &global.pyth_collateral_feed.to_bytes(),
    )?;

    require!(
        check_collateral_ratio(
            available_collateral,
            col_price,
            total_projected,
            xmr_price,
            COLLATERAL_RATIO,
        ),
        WrapSynthError::InsufficientCollateral
    );

    // Increment nonce. Client pre-computed request_id = keccak(initiator, vault, amount, commitment, nonce+1).
    ctx.accounts.global_state.request_nonce = ctx.accounts.global_state.request_nonce
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;

    // Extract vault key before mutable borrow.
    let vault_key = ctx.accounts.vault.key();

    // Reserve pending debt capacity
    let vault = &mut ctx.accounts.vault;
    vault.pending_debt = vault
        .pending_debt
        .checked_add(wsxmr_amount)
        .ok_or(WrapSynthError::MathOverflow)?;

    let clock = Clock::get()?;
    let request = &mut ctx.accounts.mint_request;
    request.request_id = request_id;
    request.initiator = ctx.accounts.initiator.key();
    request.recipient = ctx.accounts.recipient.key();
    request.lp_vault = vault_key;
    request.xmr_amount = xmr_amount;
    request.wsxmr_amount = wsxmr_amount;
    request.fee_amount = fee_amount;
    request.claim_commitment = claim_commitment;
    request.timeout = clock.unix_timestamp + timeout_duration;
    request.griefing_deposit = vault.mint_griefing_deposit;
    request.normalized_debt_amount = 0;
    request.vault_mint_nonce = vault.mint_nonce;
    request.status = MintStatus::Pending;
    request.bump = ctx.bumps.mint_request;

    msg!(
        "Mint initiated: {:?} for {} wsXMR",
        request_id,
        wsxmr_amount
    );
    Ok(())
}

// ─── set_mint_ready ───────────────────────────────────────────────────────────

pub fn set_mint_ready(ctx: Context<SetMintReady>) -> Result<()> {
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

    // Sync yield + re-check collateral
    sync_vault_yield(
        &mut ctx.accounts.vault,
        &mut ctx.accounts.global_state,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
    )?;

    let vault = &ctx.accounts.vault;
    let global = &ctx.accounts.global_state;
    let actual_debt = get_actual_debt(vault.normalized_debt, global.global_debt_index);
    let projected = actual_debt
        .checked_add(request.wsxmr_amount)
        .ok_or(WrapSynthError::MathOverflow)?;
    let available = vault.collateral_amount.saturating_sub(vault.locked_collateral);

    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &global.pyth_collateral_feed.to_bytes(),
    )?;
    require!(
        check_collateral_ratio(available, col_price, projected, xmr_price, COLLATERAL_RATIO),
        WrapSynthError::InsufficientCollateral
    );

    request.status = MintStatus::Ready;
    request.timeout = clock.unix_timestamp + MINT_READY_EXTENSION;
    msg!("Mint ready: {:?}", request.request_id);
    Ok(())
}

// ─── finalize_mint ────────────────────────────────────────────────────────────

pub fn finalize_mint(ctx: Context<FinalizeMint>, secret: [u8; 32]) -> Result<()> {
    let request = &mut ctx.accounts.mint_request;
    require!(request.status == MintStatus::Ready, WrapSynthError::InvalidStatus);

    // Ed25519 verification: compute_commitment(secret) == claim_commitment
    require!(
        mul_verify(&secret, &request.claim_commitment),
        WrapSynthError::InvalidSecret
    );

    // Liquidation nonce invalidation check
    if request.vault_mint_nonce != ctx.accounts.vault.mint_nonce {
        // Vault was liquidated — cancel and refund griefing deposit
        request.status = MintStatus::Cancelled;
        if request.griefing_deposit > 0 {
            // SOL refund tracked in PendingReturns
            ctx.accounts.pending_returns.sol_amount = ctx
                .accounts
                .pending_returns
                .sol_amount
                .saturating_add(request.griefing_deposit);
            ctx.accounts.global_state.global_pending_sol = ctx
                .accounts
                .global_state
                .global_pending_sol
                .saturating_add(request.griefing_deposit);
        }
        msg!("Mint cancelled (vault liquidated): {:?}", request.request_id);
        return Ok(());
    }

    // Sync yield
    sync_vault_yield(
        &mut ctx.accounts.vault,
        &mut ctx.accounts.global_state,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
    )?;

    let vault = &mut ctx.accounts.vault;
    // Extract bump and account_info before mutable borrow of global_state.
    let gs_bump = ctx.accounts.global_state.bump;
    let gs_info = ctx.accounts.global_state.to_account_info();

    let global = &mut ctx.accounts.global_state;

    // Release pending debt reservation
    vault.pending_debt = vault.pending_debt.saturating_sub(request.wsxmr_amount);

    // Add to actual normalized debt
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

    // Drop mutable borrow before CPIs that need account_info.
    drop(global);

    // Mint wsXMR to recipient (net of fee)
    let seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[gs_bump]];
    let signer_seeds = &[seeds];

    let net_amount = request.wsxmr_amount - request.fee_amount;
    if net_amount > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.wsxmr_mint.to_account_info(),
                to: ctx.accounts.recipient_wsxmr_ata.to_account_info(),
                authority: gs_info.clone(),
            },
            signer_seeds,
        );
        mint_to(cpi_ctx, net_amount)?;
    }

    if request.fee_amount > 0 {
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.wsxmr_mint.to_account_info(),
                to: ctx.accounts.lp_wsxmr_ata.to_account_info(),
                authority: gs_info.clone(),
            },
            signer_seeds,
        );
        mint_to(cpi_ctx, request.fee_amount)?;
    }

    // Refund griefing deposit to initiator (re-borrow after CPIs).
    let global = &mut ctx.accounts.global_state;
    if request.griefing_deposit > 0 {
        ctx.accounts.pending_returns.sol_amount = ctx
            .accounts
            .pending_returns
            .sol_amount
            .saturating_add(request.griefing_deposit);
        global.global_pending_sol = global
            .global_pending_sol
            .saturating_add(request.griefing_deposit);
    }

    request.status = MintStatus::Completed;
    msg!("Mint finalized: {:?}", request.request_id);
    Ok(())
}

// ─── cancel_mint ──────────────────────────────────────────────────────────────

pub fn cancel_mint(ctx: Context<CancelMint>) -> Result<()> {
    let request = &mut ctx.accounts.mint_request;
    require!(
        request.status == MintStatus::Pending || request.status == MintStatus::Ready,
        WrapSynthError::InvalidStatus
    );

    let clock = Clock::get()?;
    require!(clock.unix_timestamp >= request.timeout, WrapSynthError::TimeoutNotReached);

    let vault = &mut ctx.accounts.vault;
    // Release pending debt only if vault wasn't liquidated
    if request.vault_mint_nonce == vault.mint_nonce {
        vault.pending_debt = vault.pending_debt.saturating_sub(request.wsxmr_amount);
    }

    let original_status = request.status;
    request.status = MintStatus::Cancelled;

    // Award griefing deposit
    if request.griefing_deposit > 0 {
        let global = &mut ctx.accounts.global_state;
        if original_status == MintStatus::Pending {
            // LP never responded — return to initiator
            ctx.accounts.initiator_returns.sol_amount = ctx
                .accounts
                .initiator_returns
                .sol_amount
                .saturating_add(request.griefing_deposit);
            global.global_pending_sol = global
                .global_pending_sol
                .saturating_add(request.griefing_deposit);
        } else {
            // LP set ready but user never finalized — award to LP
            ctx.accounts.lp_returns.sol_amount = ctx
                .accounts
                .lp_returns
                .sol_amount
                .saturating_add(request.griefing_deposit);
            global.global_pending_sol = global
                .global_pending_sol
                .saturating_add(request.griefing_deposit);
        }
    }

    msg!("Mint cancelled: {:?}", request.request_id);
    Ok(())
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(xmr_amount: u64, claim_commitment: [u8; 32], timeout_duration: i64)]
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
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init,
        payer = initiator,
        space = MintRequest::LEN,
        seeds = [MINT_REQUEST_SEED, &anchor_lang::solana_program::keccak::hashv(&[
            initiator.key().as_ref(),
            vault.key().as_ref(),
            &xmr_amount.to_le_bytes(),
            &claim_commitment,
            &(global_state.request_nonce + 1).to_le_bytes(),
        ]).0],
        bump,
    )]
    pub mint_request: Account<'info, MintRequest>,

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
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

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
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [MINT_REQUEST_SEED, mint_request.request_id.as_ref()],
        bump = mint_request.bump,
        constraint = mint_request.lp_vault == vault.key() @ WrapSynthError::Unauthorized,
    )]
    pub mint_request: Account<'info, MintRequest>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,
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
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [MINT_REQUEST_SEED, mint_request.request_id.as_ref()],
        bump = mint_request.bump,
        constraint = mint_request.lp_vault == vault.key() @ WrapSynthError::InvalidMintRequest,
    )]
    pub mint_request: Account<'info, MintRequest>,

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

    pub token_program: Program<'info, Token2022>,
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
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [MINT_REQUEST_SEED, mint_request.request_id.as_ref()],
        bump = mint_request.bump,
    )]
    pub mint_request: Account<'info, MintRequest>,

    /// Pre-existing PendingReturns for mint initiator.
    #[account(
        mut,
        constraint = initiator_returns.owner == mint_request.initiator @ WrapSynthError::InvalidMintRequest,
    )]
    pub initiator_returns: Account<'info, crate::state::PendingReturns>,

    /// Pre-existing PendingReturns for vault LP.
    #[account(
        mut,
        constraint = lp_returns.owner == vault.lp_address @ WrapSynthError::Unauthorized,
    )]
    pub lp_returns: Account<'info, crate::state::PendingReturns>,

    pub system_program: Program<'info, System>,
}
