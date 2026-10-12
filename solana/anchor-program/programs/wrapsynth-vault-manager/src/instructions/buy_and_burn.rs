use anchor_lang::prelude::*;
use anchor_spl::token_2022::{Token2022, Burn as BurnCpi, burn as burn_tokens};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::state::{GlobalState, PendingReturns, Vault};
use crate::utils::{
    get_xmr_price, get_xmr_ema_price, get_collateral_price,
    math::{collateral_to_usd, usd_to_collateral},
};

/// Trigger buy-and-burn when XMR spot is ≥1% below EMA.
/// Permissionless keeper function with MEV protection and 2% keeper bounty.
///
/// Note: On Solana there is no embedded DEX swap CPI in this instruction.
/// The swap is performed by Jupiter/Orca in the same transaction via
/// composed instructions. This instruction deducts from the war chest,
/// pays the keeper reward, and burns whatever wsXMR balance the swap deposited
/// into the program's burn ATA. The caller constructs a versioned transaction
/// that sequences: [compute_budget, pyth_update, trigger_buy_and_burn_setup,
/// jupiter_swap, trigger_buy_and_burn_finalize].
///
/// For simplicity of the on-chain program, the two-phase approach is used:
///   Phase 1 (setup): validate EMA/cooldown, deduct war chest, pay keeper reward.
///   Phase 2 (finalize): burn whatever wsXMR arrived in the burn ATA, update debt index.
///
/// To keep the surface minimal and auditable, both phases are in a single
/// instruction here — the caller is responsible for providing the wsxmr_bought
/// value which is validated against oracle-derived minimum output.
pub fn trigger_buy_and_burn(
    ctx: Context<TriggerBuyAndBurn>,
    wsxmr_bought: u64,
) -> Result<()> {
    let global = &mut ctx.accounts.global_state;
    let clock = Clock::get()?;

    // 1. Cooldown check (24 hours)
    require!(
        clock.unix_timestamp >= global.last_buy_timestamp + COOLDOWN_PERIOD,
        WrapSynthError::CooldownActive
    );

    // 1b. Pending mint lock — a full wipe while READY mints are outstanding would
    //     zero the index under their reservations (EVM parity).
    require!(global.total_pending_mints == 0, WrapSynthError::PendingMintLock);

    // 1c. Batch wipe/migration locks — a new buy-and-burn while a wipe or
    //     migration is in progress would corrupt the index accounting (EVM parity).
    require!(global.debt_wipe_batch_start == 0, WrapSynthError::WipeInProgress);
    require!(global.migration_batch_start == 0, WrapSynthError::MigrationInProgress);

    // 2. EMA vs Spot: spot <= ema * 99/100
    let spot = get_xmr_price(&ctx.accounts.pyth_xmr, 3600)?;
    let ema = get_xmr_ema_price(&ctx.accounts.pyth_xmr, 3600)?;
    let ema_threshold = (ema as u128)
        .checked_mul(EMA_TRIGGER_THRESHOLD as u128)
        .ok_or(WrapSynthError::MathOverflow)?
        / 100;
    require!(
        (spot as u128) <= ema_threshold,
        WrapSynthError::XMRNotDipped
    );

    // 3. War chest check
    require!(global.yield_war_chest > 0, WrapSynthError::WarChestEmpty);

    // 4. Calculate 20% chunk
    let total_chunk = global.yield_war_chest * BUY_CHUNK_PERCENT / 100;
    let keeper_reward = total_chunk * KEEPER_REWARD_BPS / BPS_DENOMINATOR;
    let spend_amount = total_chunk - keeper_reward;

    // 5. MEV protection: validate wsxmr_bought against oracle minimum output (allow 2% slippage)
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &SUSDE_USD_FEED_ID,
    )?;
    let xmr_price = spot;
    let spend_usd = collateral_to_usd(spend_amount, col_price);
    // expected_wsxmr = spend_usd / xmr_price * 1e8
    let expected_wsxmr = (spend_usd as u128 * WSXMR_DECIMALS as u128 / xmr_price as u128) as u64;
    let min_wsxmr = expected_wsxmr * (BPS_DENOMINATOR - MEV_SLIPPAGE_BPS) / BPS_DENOMINATOR;
    require!(wsxmr_bought >= min_wsxmr, WrapSynthError::InvalidValue);

    // 6. Deduct war chest and update timestamp
    global.yield_war_chest -= total_chunk;
    global.last_buy_timestamp = clock.unix_timestamp;

    // 7. Transfer keeper reward in collateral to caller's PendingReturns
    if keeper_reward > 0 {
        ctx.accounts.keeper_pending_returns.collateral_amount = ctx
            .accounts
            .keeper_pending_returns
            .collateral_amount
            .checked_add(keeper_reward)
            .ok_or(WrapSynthError::MathOverflow)?;
        global.global_pending_collateral = global
            .global_pending_collateral
            .checked_add(keeper_reward)
            .ok_or(WrapSynthError::MathOverflow)?;
    }

    // 8. Burn the purchased wsXMR (caller must have transferred it to burn_wsxmr_ata)
    // Drop mutable borrow before taking account_info for CPI.
    let gs_bump = global.bump;
    drop(global);

    let seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[gs_bump]];
    let signer_seeds = &[seeds];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        BurnCpi {
            mint: ctx.accounts.wsxmr_mint.to_account_info(),
            from: ctx.accounts.burn_wsxmr_ata.to_account_info(),
            authority: ctx.accounts.global_state.to_account_info(),
        },
        signer_seeds,
    );
    burn_tokens(cpi_ctx, wsxmr_bought)?;

    let global = &mut ctx.accounts.global_state;

    // 9. Update global debt — O(1) proportional forgiveness (EVM parity)
    // effective_debt excludes wsXMR locked in pending burns (already burned by user)
    let effective_debt = if global.global_total_debt > global.global_pending_burn_debt {
        global.global_total_debt - global.global_pending_burn_debt
    } else {
        0
    };

    if wsxmr_bought >= effective_debt {
        // Full wipe: start batch zeroing of vault normalized debts.
        // Index is NOT reset to 1e18 until all vaults are zeroed via
        // continue_debt_wipe() — until then it stays so _denormalizeDebt
        // remains correct for un-wiped vaults (EVM parity).
        global.global_total_debt = global.global_pending_burn_debt;
        global.debt_wipe_batch_start = 1;
    } else {
        let remaining_debt = effective_debt - wsxmr_bought;
        global.global_total_debt -= wsxmr_bought;
        // new_index = old_index * remaining / effective
        global.global_debt_index = (global.global_debt_index as u128 * remaining_debt as u128
            / effective_debt as u128) as u64;
    }

    // 9b. Migrate debt index when it drops too low to prevent precision loss.
    //     Starts a batch migration; continue_debt_migration() rescales vaults
    //     and resets the index to 1e18 when complete (EVM parity).
    if global.global_debt_index < INITIAL_DEBT_INDEX {
        global.migration_old_index = global.global_debt_index;
        global.migration_batch_start = 1;
    }

    msg!(
        "Buy-and-burn executed: {} wsXMR burned, new debt index: {}, keeper reward: {}",
        wsxmr_bought,
        global.global_debt_index,
        keeper_reward
    );
    Ok(())
}

// ─── continue_debt_wipe ──────────────────────────────────────────────────────
// Continue an in-progress debt wipe (zeroing vault normalized debts after a
// full buy-and-burn). Processes up to batch_size vaults per call. Resets
// global_debt_index to 1e18 when complete (EVM continueDebtWipe parity).
// The caller must pass the vault accounts for the batch range as remaining
// accounts, in vault-list order.

pub fn continue_debt_wipe(ctx: Context<ContinueDebtWipe>, batch_size: u64) -> Result<()> {
    let global = &mut ctx.accounts.global_state;
    require!(global.debt_wipe_batch_start > 0, WrapSynthError::WipeNotInProgress);

    let start = (global.debt_wipe_batch_start - 1) as usize;
    let count = global.vault_count as usize;
    let mut end = start.saturating_add(batch_size as usize);
    if end > count {
        end = count;
    }

    let remaining = &ctx.remaining_accounts;
    require!(remaining.len() == end - start, WrapSynthError::InvalidValue);

    for (i, acc) in remaining.iter().enumerate() {
        require!(acc.is_writable, WrapSynthError::InvalidValue);
        // Verify the account is the vault PDA for the expected LP in the list
        let expected_lp = global.vault_list[start + i];
        let (expected_pda, _) = Pubkey::find_program_address(
            &[VAULT_SEED, expected_lp.as_ref()],
            ctx.program_id,
        );
        require!(acc.key() == expected_pda, WrapSynthError::Unauthorized);

        // Manual deserialize/mutate/serialize (avoids Account lifetime issues)
        let mut data = acc.try_borrow_mut_data()?;
        let mut vault = Vault::try_deserialize(&mut &data[..])?;
        vault.normalized_debt = 0;
        let mut out = Vec::with_capacity(Vault::LEN);
        vault.try_serialize(&mut out)?;
        data[..out.len()].copy_from_slice(&out);
    }

    if end >= count {
        global.debt_wipe_batch_start = 0;
        global.global_debt_index = INITIAL_DEBT_INDEX;
        msg!("Debt wipe complete: {} vaults zeroed", count);
    } else {
        global.debt_wipe_batch_start = (end + 1) as u64;
    }
    Ok(())
}

// ─── continue_debt_migration ─────────────────────────────────────────────────
// Continue an in-progress debt index migration (rescaling vault normalized
// debts). Processes up to batch_size vaults per call. Resets global_debt_index
// to 1e18 when complete (EVM continueDebtMigration parity).
// The caller must pass the vault accounts for the batch range as remaining
// accounts, in vault-list order.

pub fn continue_debt_migration(ctx: Context<ContinueDebtMigration>, batch_size: u64) -> Result<()> {
    let global = &mut ctx.accounts.global_state;
    require!(global.migration_batch_start > 0, WrapSynthError::MigrationNotInProgress);

    let start = (global.migration_batch_start - 1) as usize;
    let count = global.vault_count as usize;
    let mut end = start.saturating_add(batch_size as usize);
    if end > count {
        end = count;
    }

    let old_index = global.migration_old_index;
    let remaining = &ctx.remaining_accounts;
    require!(remaining.len() == end - start, WrapSynthError::InvalidValue);

    for (i, acc) in remaining.iter().enumerate() {
        require!(acc.is_writable, WrapSynthError::InvalidValue);
        let expected_lp = global.vault_list[start + i];
        let (expected_pda, _) = Pubkey::find_program_address(
            &[VAULT_SEED, expected_lp.as_ref()],
            ctx.program_id,
        );
        require!(acc.key() == expected_pda, WrapSynthError::Unauthorized);

        // Manual deserialize/mutate/serialize (avoids Account lifetime issues)
        let mut data = acc.try_borrow_mut_data()?;
        let mut vault = Vault::try_deserialize(&mut &data[..])?;
        if vault.normalized_debt > 0 {
            vault.normalized_debt = (vault.normalized_debt as u128 * old_index as u128
                / DEBT_INDEX_PRECISION as u128) as u64;
        }
        let mut out = Vec::with_capacity(Vault::LEN);
        vault.try_serialize(&mut out)?;
        data[..out.len()].copy_from_slice(&out);
    }

    if end >= count {
        global.migration_batch_start = 0;
        global.global_debt_index = INITIAL_DEBT_INDEX;
        msg!("Debt index migration complete: {} vaults rescaled", count);
    } else {
        global.migration_batch_start = (end + 1) as u64;
    }
    Ok(())
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct TriggerBuyAndBurn<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(mut)]
    pub wsxmr_mint: InterfaceAccount<'info, Mint>,

    /// ATA holding purchased wsXMR to be burned (program-owned)
    #[account(mut)]
    pub burn_wsxmr_ata: InterfaceAccount<'info, TokenAccount>,

    /// Keeper's PendingReturns to receive collateral reward
    #[account(
        init_if_needed,
        payer = keeper,
        space = PendingReturns::LEN,
        seeds = [PENDING_RETURNS_SEED, keeper.key().as_ref()],
        bump,
    )]
    pub keeper_pending_returns: Account<'info, PendingReturns>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ContinueDebtWipe<'info> {
    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,
    // Vault accounts for the batch range are passed as remaining accounts and
    // validated against the global vault list in the handler.
}

#[derive(Accounts)]
pub struct ContinueDebtMigration<'info> {
    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,
    // Vault accounts for the batch range are passed as remaining accounts and
    // validated against the global vault list in the handler.
}
