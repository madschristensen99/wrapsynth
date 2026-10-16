use anchor_lang::prelude::*;
use anchor_spl::token_2022::{
    burn as burn_tokens, Burn as BurnCpi, Token2022,
};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::instructions::vault_management::slash_to_pool;
use crate::state::{BurnRequest, BurnStatus, GlobalState, PendingReturns, Vault};
use crate::utils::{
    get_collateral_price, get_xmr_price,
    math::{
        calculate_collateral_ratio, collateral_to_usd, collateral_value_for_debt, get_actual_debt,
        normalize_debt, usd_to_collateral,
    },
};

// ─── resolve_burn_for_liquidation ─────────────────────────────────────────────
// Phase 1: Called once per active burn request on a to-be-liquidated vault.
// Resolves REQUESTED/PROPOSED burns (re-mint to user) or COMMITTED burns (slash to user).

pub fn resolve_burn_for_liquidation(ctx: Context<ResolveBurnForLiquidation>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    // Extract the index — the shared borrow must end before branches below
    // call load_mut() (a live `load()` Ref held across load_mut() aborts the tx).
    let global_debt_index = ctx.accounts.global_state.load()?.global_debt_index;

    // Verify the vault is actually liquidatable before resolving burns
    let actual_debt = get_actual_debt(vault.normalized_debt, global_debt_index);
    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &SOL_USD_FEED_ID,
    )?;
    let col_usd = collateral_to_usd(vault.collateral_amount, col_price);
    let debt_usd = actual_debt as u128 * xmr_price / WSXMR_DECIMALS as u128;
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
            let global = &mut ctx.accounts.global_state.load_mut()?;

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
            msg!(
                "Burn {:?} re-minted to user (pre-liquidation)",
                request.request_id
            );
        }
        BurnStatus::Committed => {
            if request.revealed_secret != [0u8; 32] {
                // LP already revealed — the user can claim the XMR. Settle rather
                // than slash: release the lock to the vault (seizable) and pay
                // only the reward (mirrors EVM _settleRevealedBurnLiquidation).
                let vault = &mut ctx.accounts.vault;
                let global = &mut ctx.accounts.global_state.load_mut()?;

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
                let normalized_burn =
                    normalize_debt(request.wsxmr_amount, global.global_debt_index);
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
                    // Move the reward into the program pool so the credit is
                    // backed. Vault PDA signs, so the global borrow is safe.
                    slash_to_pool(
                        vault,
                        &ctx.accounts.vault_collateral_escrow,
                        &ctx.accounts.collateral_escrow,
                        &ctx.accounts.system_program.to_account_info(),
                        reward,
                    )?;
                }

                vault.active_burn_count = vault.active_burn_count.saturating_sub(1);
                request.status = BurnStatus::Completed;
                msg!(
                    "Burn {:?} settled (revealed, liquidation)",
                    request.request_id
                );
            } else {
                // User confirmed Monero lock, LP never revealed — par-capped slash:
                // user receives min(par, locked) + reward; excess returns to vault
                // (mirrors EVM _settleCommittedBurnSlash).
                let vault = &mut ctx.accounts.vault;
                let global = &mut ctx.accounts.global_state.load_mut()?;

                let par_value_usd = (request.wsxmr_amount as u128)
                    .checked_mul(request.xmr_price_at_request)
                    .ok_or(WrapSynthError::MathOverflow)?
                    / WSXMR_DECIMALS as u128;
                let par_collateral = usd_to_collateral(par_value_usd, col_price);

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
                let normalized_burn =
                    normalize_debt(request.wsxmr_amount, global.global_debt_index);
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
                    "Burn {:?} slashed to user (liquidation)",
                    request.request_id
                );
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
    require!(
        vault.active_burn_count == 0,
        WrapSynthError::UnresolvedBurns
    );
    // Co-LP positions must be unwound first (EVM _unwindAllVaultPositions parity —
    // Solana unwinds via unwind_co_lp, one position at a time).
    require!(
        vault.deployed_collateral == 0,
        WrapSynthError::UnresolvedBurns
    );
    // NOTE: locked_collateral may be > 0 from in-flight mint key bonds / par
    // locks. Liquidation never seizes locked collateral — the seizure below caps
    // at the liquid balance, and the mint's cancel/finalize paths resolve the
    // bond against the bumped mint_nonce (EVM parity).

    // Extract the index — a `load()` Ref held across the load_mut() below would
    // abort the tx with AccountBorrowFailed.
    let global_debt_index = ctx.accounts.global_state.load()?.global_debt_index;
    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &SOL_USD_FEED_ID,
    )?;

    let actual_debt = get_actual_debt(vault.normalized_debt, global_debt_index);
    require!(actual_debt > 0, WrapSynthError::InsufficientDebt);

    // Verify vault is liquidatable (unlocked collateral vs actual debt).
    // Uses market SOL/USD price so discounts are already marked down.
    // Depeg-pause only blocks minting; liquidations remain permissionless.
    let col_usd = collateral_to_usd(vault.collateral_amount, col_price);
    let debt_usd = actual_debt as u128 * xmr_price / WSXMR_DECIMALS as u128;
    let ratio = calculate_collateral_ratio(col_usd, debt_usd);
    require!(ratio < LIQUIDATION_RATIO, WrapSynthError::VaultHealthy);

    let mut debt_to_clear = debt_to_clear.min(actual_debt);

    // Calculate collateral to seize at LIQUIDATION_BONUS (112%)
    let col_val_usd = collateral_value_for_debt(debt_to_clear, xmr_price, LIQUIDATION_BONUS);
    let mut collateral_amount = usd_to_collateral(col_val_usd, col_price);

    // Cap at available (unlocked) collateral — total model: locked collateral
    // (mint bonds / burn locks) is never seized.
    let available_collateral = vault
        .collateral_amount
        .saturating_sub(vault.locked_collateral);
    if collateral_amount > available_collateral {
        // Scale down proportionally to maintain liquidator's bonus
        debt_to_clear = (debt_to_clear as u128 * available_collateral as u128
            / collateral_amount as u128) as u64;
        collateral_amount = available_collateral;
    }

    vault.collateral_amount = vault.collateral_amount.saturating_sub(collateral_amount);

    // Clear normalized debt
    let normalized_clear = normalize_debt(debt_to_clear, global_debt_index);
    let normalized_clear = normalized_clear.min(vault.normalized_debt);
    vault.normalized_debt = vault.normalized_debt.saturating_sub(normalized_clear);

    let global = &mut ctx.accounts.global_state.load_mut()?;
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

    // Transfer seized collateral (lamports) to the liquidator
    let vault_key = vault.lp_address;
    let vault_pda_key = ctx.accounts.vault.key();
    let escrow_bump = ctx.bumps.vault_collateral_escrow;
    let seeds: &[&[u8]] = &[VAULT_COLLATERAL_SEED, vault_pda_key.as_ref(), &[escrow_bump]];
    anchor_lang::solana_program::program::invoke_signed(
        &anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.vault_collateral_escrow.key(),
            &ctx.accounts.liquidator.key(),
            collateral_amount,
        ),
        &[
            ctx.accounts.vault_collateral_escrow.to_account_info(),
            ctx.accounts.liquidator.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[seeds],
    )?;

    msg!(
        "Vault {} liquidated: {} debt cleared, {} collateral seized",
        vault_key,
        debt_to_clear,
        collateral_amount
    );
    Ok(())
}

// ─── backstop_vault ───────────────────────────────────────────────────────────
// P1-1: Backstop an underwater vault by assuming its debt and collateral.
// A new LP takes over the old vault's position at a discount (no wsXMR sourcing
// needed). Mirrors EVM backstopVault, adapted to Solana's two-phase burn
// resolution: burns must be resolved first via resolve_burn_for_liquidation
// (active_burn_count == 0), since burn requests are PDAs resolved one at a time.

pub fn backstop_vault(ctx: Context<BackstopVault>) -> Result<()> {
    let old = &mut ctx.accounts.old_vault;
    let new = &mut ctx.accounts.new_vault;
    require!(old.active, WrapSynthError::VaultNotActive);
    // Co-LP positions must be unwound first (EVM _unwindAllVaultPositions parity)
    require!(
        old.deployed_collateral == 0,
        WrapSynthError::UnresolvedBurns
    );
    require!(new.active, WrapSynthError::VaultNotActive);
    require!(old.key() != new.key(), WrapSynthError::InvalidValue);
    require!(old.active_burn_count == 0, WrapSynthError::UnresolvedBurns);

    // Extract the index — a `load()` Ref held across the load_mut() below would
    // abort the tx with AccountBorrowFailed.
    let global_debt_index = ctx.accounts.global_state.load()?.global_debt_index;
    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &SOL_USD_FEED_ID,
    )?;

    let old_debt = get_actual_debt(old.normalized_debt, global_debt_index);
    require!(old_debt > 0, WrapSynthError::InsufficientDebt);

    // Old vault must be underwater (total collateral model — locked included)
    let col_usd = collateral_to_usd(old.collateral_amount, col_price);
    let debt_usd = old_debt as u128 * xmr_price / WSXMR_DECIMALS as u128;
    let ratio = calculate_collateral_ratio(col_usd, debt_usd);
    require!(ratio < LIQUIDATION_RATIO, WrapSynthError::VaultHealthy);

    // Absorb old vault's collateral — raw QQQx, no yield/receipt accounting.
    let absorbed = old.collateral_amount;

    // Transfer state: new vault assumes old vault's debt and collateral.
    // The discount is implicit — new LP gets collateral worth less than debt at market.
    new.normalized_debt = new
        .normalized_debt
        .checked_add(old.normalized_debt)
        .ok_or(WrapSynthError::MathOverflow)?;
    new.collateral_amount = new
        .collateral_amount
        .checked_add(absorbed)
        .ok_or(WrapSynthError::MathOverflow)?;

    // Physically migrate the collateral lamports to the new vault's escrow so
    // the accounting matches custody.
    if absorbed > 0 {
        let escrow_bump = ctx.bumps.old_vault_collateral_escrow;
        let old_vault_key = ctx.accounts.old_vault_collateral_escrow.key();
        // Re-derive the old vault PDA key for the escrow seeds (old_vault is
        // already mut-borrowed above).
        let (old_pda_key, _) = Pubkey::find_program_address(
            &[VAULT_SEED, old.lp_address.as_ref()],
            &crate::ID,
        );
        let _ = old_vault_key;
        let seeds: &[&[u8]] = &[
            VAULT_COLLATERAL_SEED,
            old_pda_key.as_ref(),
            &[escrow_bump],
        ];
        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.old_vault_collateral_escrow.key(),
                &ctx.accounts.new_vault_collateral_escrow.key(),
                absorbed,
            ),
            &[
                ctx.accounts.old_vault_collateral_escrow.to_account_info(),
                ctx.accounts.new_vault_collateral_escrow.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;
    }

    let global = &mut ctx.accounts.global_state.load_mut()?;

    // Zero out old vault — must clear ALL state to prevent phantom locked collateral
    old.normalized_debt = 0;
    old.collateral_amount = 0;
    old.locked_collateral = 0;
    old.liquidation_nonce = old
        .liquidation_nonce
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;
    old.mint_nonce = old
        .mint_nonce
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;
    // pending_debt is intentionally NOT zeroed — invalidated mint requests
    // release their own reservations on cancel/finalize (EVM parity).

    // Verify new vault is healthy after takeover
    let new_debt = get_actual_debt(new.normalized_debt, global.global_debt_index);
    let new_col_usd = collateral_to_usd(new.collateral_amount, col_price);
    let new_debt_usd = new_debt as u128 * xmr_price / WSXMR_DECIMALS as u128;
    let new_ratio = calculate_collateral_ratio(new_col_usd, new_debt_usd);
    require!(
        new_ratio >= COLLATERAL_RATIO,
        WrapSynthError::InsufficientCollateral
    );

    msg!(
        "Vault backstopped: old {} → new {}, {} debt, {} collateral absorbed",
        old.lp_address,
        new.lp_address,
        old_debt,
        absorbed
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

    #[account(
        init_if_needed,
        payer = caller,
        space = PendingReturns::LEN,
        seeds = [PENDING_RETURNS_SEED, burn_request.user.as_ref()],
        bump,
    )]
    pub user_pending_returns: Box<Account<'info, PendingReturns>>,

    #[account(mut)]
    pub wsxmr_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub user_wsxmr_ata: Box<InterfaceAccount<'info, TokenAccount>>,

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
pub struct ExecuteLiquidation<'info> {
    #[account(mut)]
    pub liquidator: Signer<'info>,

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

    #[account(mut)]
    pub wsxmr_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub liquidator_wsxmr_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: lamport-only vault collateral escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_escrow: AccountInfo<'info>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BackstopVault<'info> {
    #[account(mut)]
    pub new_lp: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, old_vault.lp_address.as_ref()],
        bump = old_vault.bump,
    )]
    pub old_vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, new_lp.key().as_ref()],
        bump = new_vault.bump,
        constraint = new_vault.lp_address == new_lp.key() @ WrapSynthError::Unauthorized,
    )]
    pub new_vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

    /// CHECK: old vault's lamport collateral escrow — source of the absorbed balance
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, old_vault.key().as_ref()],
        bump,
    )]
    pub old_vault_collateral_escrow: AccountInfo<'info>,

    /// CHECK: new vault's lamport collateral escrow — destination
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, new_vault.key().as_ref()],
        bump,
    )]
    pub new_vault_collateral_escrow: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
