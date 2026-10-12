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
        &JITOSOL_USD_FEED_ID,
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
    // Idempotency / invalidation guard: a prior liquidation increments liquidation_nonce,
    // so burns created before that liquidation must not be re-resolved.
    require!(
        request.vault_liquidation_nonce == vault.liquidation_nonce,
        WrapSynthError::BurnInvalidatedByLiquidation
    );

    let total_locked = request.locked_collateral + request.reward_collateral;

    match request.status {
        BurnStatus::Requested | BurnStatus::Proposed => {
            // LP has not yet committed XMR — re-mint wsXMR to user. Debt was NOT
            // reduced at request time, so there is nothing to restore.
            let vault = &mut ctx.accounts.vault;
            let global = &mut ctx.accounts.global_state;

            // Total model: release the reservation only.
            if vault.locked_collateral < total_locked {
                vault.locked_collateral = 0;
            } else {
                vault.locked_collateral -= total_locked;
            }
            vault.active_burn_count = vault.active_burn_count.saturating_sub(1);

            if global.global_pending_burn_debt < request.wsxmr_amount {
                global.global_pending_burn_debt = 0;
            } else {
                global.global_pending_burn_debt -= request.wsxmr_amount;
            }

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
            if request.revealed_secret != [0u8; 32] {
                // LP already revealed — the user can claim the XMR. Settle rather
                // than slash: release the lock to the vault (seizable) and pay
                // only the reward (mirrors EVM _settleRevealedBurnLiquidation).
                let vault = &mut ctx.accounts.vault;
                let global = &mut ctx.accounts.global_state;

                if vault.locked_collateral < total_locked {
                    vault.locked_collateral = 0;
                } else {
                    vault.locked_collateral -= total_locked;
                }

                let mut reward = request.reward_collateral;
                if vault.collateral_amount < reward {
                    reward = vault.collateral_amount;
                }
                vault.collateral_amount -= reward;

                // Debt reduction happens here at settlement
                let normalized_burn = normalize_debt(request.wsxmr_amount, global.global_debt_index);
                let normalized_burn = normalized_burn.min(vault.normalized_debt);
                vault.normalized_debt -= normalized_burn;
                global.global_total_debt = global
                    .global_total_debt
                    .saturating_sub(get_actual_debt(normalized_burn, global.global_debt_index));

                if global.global_pending_burn_debt < request.wsxmr_amount {
                    global.global_pending_burn_debt = 0;
                } else {
                    global.global_pending_burn_debt -= request.wsxmr_amount;
                }

                if reward > 0 {
                    ctx.accounts.user_pending_returns.collateral_amount = ctx
                        .accounts
                        .user_pending_returns
                        .collateral_amount
                        .checked_add(reward)
                        .ok_or(WrapSynthError::MathOverflow)?;
                    global.global_pending_collateral = global
                        .global_pending_collateral
                        .checked_add(reward)
                        .ok_or(WrapSynthError::MathOverflow)?;
                }

                vault.active_burn_count = vault.active_burn_count.saturating_sub(1);
                request.status = BurnStatus::Completed;
                msg!("Burn {:?} settled (revealed, liquidation)", request.request_id);
            } else {
                // User confirmed Monero lock, LP never revealed — par-capped slash:
                // user receives min(par, locked) + reward; excess returns to vault
                // (mirrors EVM _settleCommittedBurnSlash).
                let vault = &mut ctx.accounts.vault;
                let global = &mut ctx.accounts.global_state;

                let par_value_usd = (request.wsxmr_amount as u128)
                    .checked_mul(request.xmr_price_at_request as u128)
                    .ok_or(WrapSynthError::MathOverflow)?
                    / WSXMR_DECIMALS as u128;
                let par_collateral = usd_to_collateral(par_value_usd as u64, col_price);

                let user_base = par_collateral.min(request.locked_collateral);
                let user_payout = user_base.saturating_add(request.reward_collateral);

                if vault.locked_collateral < total_locked {
                    vault.locked_collateral = 0;
                } else {
                    vault.locked_collateral -= total_locked;
                }
                if vault.collateral_amount < user_payout {
                    vault.collateral_amount = 0;
                } else {
                    vault.collateral_amount -= user_payout;
                }

                // Debt reduction happens here at settlement
                let normalized_burn = normalize_debt(request.wsxmr_amount, global.global_debt_index);
                let normalized_burn = normalized_burn.min(vault.normalized_debt);
                vault.normalized_debt -= normalized_burn;
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
                }

                vault.active_burn_count = vault.active_burn_count.saturating_sub(1);
                request.status = BurnStatus::Slashed;
                msg!("Burn {:?} slashed to user (liquidation)", request.request_id);
            }
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
    // NOTE: locked_collateral may be > 0 from in-flight mint key bonds / par
    // locks. Liquidation never seizes locked collateral — the seizure below caps
    // at the liquid balance, and the mint's cancel/finalize paths resolve the
    // bond against the bumped mint_nonce (EVM parity).

    sync_vault_yield(
        vault,
        &mut ctx.accounts.global_state,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
        &ctx.accounts.jitosol_stake_pool,
    )?;

    let global = &ctx.accounts.global_state;
    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &JITOSOL_USD_FEED_ID,
    )?;

    let actual_debt = get_actual_debt(vault.normalized_debt, global.global_debt_index);
    require!(actual_debt > 0, WrapSynthError::InsufficientDebt);

    // Verify vault is liquidatable (unlocked collateral vs actual debt).
    // Uses market JitoSOL/USD price (Task 2) so depegs are already marked down.
    // Depeg-pause only blocks minting; liquidations remain permissionless.
    let col_usd = collateral_to_usd(vault.collateral_amount, col_price);
    let debt_usd = (actual_debt as u128 * xmr_price as u128 / WSXMR_DECIMALS as u128) as u64;
    let ratio = calculate_collateral_ratio(col_usd, debt_usd);
    require!(ratio < LIQUIDATION_RATIO, WrapSynthError::VaultHealthy);

    let mut debt_to_clear = debt_to_clear.min(actual_debt);

    // Calculate collateral to seize at LIQUIDATION_BONUS (112%)
    let col_val_usd = collateral_value_for_debt(debt_to_clear, xmr_price, LIQUIDATION_BONUS);
    let mut collateral_amount = usd_to_collateral(col_val_usd, col_price);

    // Cap at available (unlocked) collateral — total model: locked collateral
    // (mint bonds / burn locks) is never seized.
    let available_collateral = vault.collateral_amount.saturating_sub(vault.locked_collateral);
    if collateral_amount > available_collateral {
        // Scale down proportionally to maintain liquidator's bonus
        debt_to_clear = (debt_to_clear as u128 * available_collateral as u128
            / collateral_amount as u128) as u64;
        collateral_amount = available_collateral;
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

    vault.collateral_amount = vault.collateral_amount.saturating_sub(collateral_amount);

    // Clear normalized debt
    let normalized_clear = normalize_debt(debt_to_clear, ctx.accounts.global_state.global_debt_index);
    let normalized_clear = normalized_clear.min(vault.normalized_debt);
    vault.normalized_debt = vault.normalized_debt.saturating_sub(normalized_clear);

    let global = &mut ctx.accounts.global_state;
    global.global_total_debt = global.global_total_debt.saturating_sub(debt_to_clear);

    // Track bad debt if vault is fully drained and zero it cleanly.
    // Also remove the remaining from global_total_debt so active and unbacked debt don't overlap.
    if vault.collateral_amount == 0 && vault.normalized_debt > 0 {
        let remaining = get_actual_debt(vault.normalized_debt, global.global_debt_index);
        if remaining > 0 {
            global.global_bad_debt = global
                .global_bad_debt
                .checked_add(remaining)
                .ok_or(WrapSynthError::MathOverflow)?;
            global.global_total_debt = global.global_total_debt.saturating_sub(remaining);
        }
        vault.normalized_debt = 0;
    }

    // Increment nonces to atomically invalidate all pending mints/burns.
    // pending_debt is intentionally NOT zeroed — liquidation never touches it;
    // the invalidated mint requests release their own reservations on cancel/
    // finalize (EVM parity).
    vault.liquidation_nonce = vault
        .liquidation_nonce
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;
    vault.mint_nonce = vault
        .mint_nonce
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;

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
    /// CHECK: JitoSOL stake pool account for reading exchange rate
    pub jitosol_stake_pool: AccountInfo<'info>,

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
    /// CHECK: JitoSOL stake pool account for reading exchange rate
    pub jitosol_stake_pool: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
