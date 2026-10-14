use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::{transfer_checked, Token2022, TransferChecked};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::state::{CoLPPosition, GlobalState, Vault};
use crate::utils::{
    get_collateral_price, get_xmr_price,
    math::{calculate_collateral_ratio, collateral_to_usd, get_actual_debt, usd_to_collateral},
    whirlpool::*,
};
// ─── set_max_co_lp_range ─────────────────────────────────────────────────────

pub fn set_max_co_lp_range(ctx: Context<SetMaxCoLPRange>, bps: u16) -> Result<()> {
    require!(
        bps >= MIN_CO_LP_RANGE_BPS && bps <= MAX_CO_LP_RANGE_BPS,
        WrapSynthError::InvalidConfig
    );
    ctx.accounts.vault.max_co_lp_range_bps = bps;
    msg!("Co-LP max range set: {} bps", bps);
    Ok(())
}

// ─── user_open_co_lp ─────────────────────────────────────────────────────────
// User pairs wsXMR with the vault's idle QQQx collateral to open a concentrated
// position on Orca Whirlpools. The vault manager (GlobalState PDA) is the
// position authority; the position NFT is held in a program-owned ATA.

pub fn user_open_co_lp<'info>(
    mut ctx: Context<'_, '_, '_, 'info, UserOpenCoLP<'info>>,
    wsxmr_amount: u64,
    nonce: u64,
) -> Result<()> {
    require!(wsxmr_amount > 0, WrapSynthError::ZeroAmount);
    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);
    // The co-LP PDA nonce must be the next global request nonce
    require!(
        nonce == ctx.accounts.global_state.load()?.request_nonce + 1,
        WrapSynthError::InvalidValue
    );

    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &QQQX_USD_FEED_ID,
    )?;

    // Whirlpool-internal CPI accounts are passed via remaining_accounts (kept out
    // of the named struct to avoid a ~4KB try_accounts stack overflow):
    //   [0] token_vault_a  [1] token_vault_b  [2] metadata_update_auth
    //   [3] whirlpool_program  [4] memo_program
    let ra = ctx.remaining_accounts;
    require!(ra.len() >= 5, WrapSynthError::InvalidValue);
    let token_vault_a = ra[0].clone();
    let token_vault_b = ra[1].clone();
    let metadata_update_auth = ra[2].clone();
    let memo_program = ra[4].clone();

    // QQQx needed = wsXMR value in USD → shares
    let wsxmr_usd = wsxmr_amount as u128 * xmr_price / WSXMR_DECIMALS as u128;
    let collateral_needed = usd_to_collateral(wsxmr_usd, col_price);

    // Idle collateral check (total model: available = collateral - locked - deployed)
    let available = vault
        .collateral_amount
        .saturating_sub(vault.locked_collateral)
        .saturating_sub(vault.deployed_collateral);
    require!(
        available >= collateral_needed,
        WrapSynthError::InsufficientCollateral
    );

    // Read the whirlpool to derive the range + vaults
    let whirlpool_data = read_whirlpool(&ctx.accounts.whirlpool)?;
    let range_bps = if vault.max_co_lp_range_bps > 0 {
        vault.max_co_lp_range_bps
    } else {
        DEFAULT_CO_LP_RANGE_BPS
    };
    let (tick_lower, tick_upper) = compute_range_ticks(
        whirlpool_data.tick_current_index,
        range_bps,
        whirlpool_data.tick_spacing,
    );

    // Verify the whirlpool is the QQQx/wsXMR pool
    require!(
        whirlpool_data.token_mint_a == ctx.accounts.collateral_mint.key()
            || whirlpool_data.token_mint_b == ctx.accounts.collateral_mint.key(),
        WrapSynthError::InvalidValue
    );
    require!(
        whirlpool_data.token_mint_a == ctx.accounts.wsxmr_mint.key()
            || whirlpool_data.token_mint_b == ctx.accounts.wsxmr_mint.key(),
        WrapSynthError::InvalidValue
    );
    let collateral_is_a = whirlpool_data.token_mint_a == ctx.accounts.collateral_mint.key();

    // Compute liquidity from the token amounts (centered range → both legs in range)
    let sqrt_price = whirlpool_data.sqrt_price;
    let sqrt_lower = sqrt_price_at_tick(tick_lower);
    let sqrt_upper = sqrt_price_at_tick(tick_upper);
    let liquidity = compute_liquidity(
        collateral_needed,
        wsxmr_amount,
        sqrt_price,
        sqrt_lower,
        sqrt_upper,
    );

    // The whirlpool program creates + initializes the position NFT mint and its
    // token account inside open_position_with_token_extensions — we only pass a
    // fresh signer keypair (position_mint) and the derived position ATA.
    let gs_key = ctx.accounts.global_state.key();
    let gs_bump = ctx.accounts.global_state.load()?.bump;
    let gs_seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[gs_bump]];
    let gs_signer = &[gs_seeds];
    let mint_key = ctx.accounts.position_mint.key();

    // ── Fund the position owner token accounts ──
    // User wsXMR → position_wsxmr_ata (program-owned)
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_wsxmr_ata.to_account_info(),
                mint: ctx.accounts.wsxmr_mint.to_account_info(),
                to: ctx.accounts.position_wsxmr_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        wsxmr_amount,
        ctx.accounts.wsxmr_mint.decimals,
    )?;

    // Vault QQQx → position_collateral_ata (program-owned)
    let vault_bump = vault.bump;
    let vault_key = vault.lp_address;
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, vault_key.as_ref(), &[vault_bump]];
    let vault_signer = &[vault_seeds];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault_collateral_ata.to_account_info(),
                mint: ctx.accounts.collateral_mint.to_account_info(),
                to: ctx.accounts.position_collateral_ata.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            vault_signer,
        ),
        collateral_needed,
        ctx.accounts.collateral_mint.decimals,
    )?;

    // ── CPI: open_position_with_token_extensions ──
    let position_pda = ctx.accounts.position.key();
    msg!("dbg: before open_position");
    let open_ix = open_position_ix(
        &ctx.accounts.user.key(),
        &gs_key,
        &position_pda,
        &mint_key,
        &ctx.accounts.position_token_account.key(),
        &ctx.accounts.whirlpool.key(),
        &ctx.accounts.token_program.key(),
        &ctx.accounts.system_program.key(),
        &ctx.accounts.associated_token_program.key(),
        metadata_update_auth.key,
        tick_lower,
        tick_upper,
        true, // with_token_metadata_extension
    );
    anchor_lang::solana_program::program::invoke_signed(
        &open_ix,
        &[
            ctx.accounts.user.to_account_info(),
            ctx.accounts.global_state.to_account_info(),
            ctx.accounts.position.to_account_info(),
            ctx.accounts.position_mint.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.whirlpool.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.associated_token_program.to_account_info(),
            metadata_update_auth.to_account_info(),
        ],
        gs_signer,
    )?;
    msg!("dbg: open_position done");

    // ── CPI: increase_liquidity_v2 ──
    // ModifyLiquidityV2 takes 15 named accounts; QQQx/wsXMR have no transfer hooks
    // so no remaining_accounts are needed. Order mints/owner/vault in pool A/B order
    // (a = token_mint_a).
    let (mint_a_info, mint_b_info, owner_a_info, owner_b_info, owner_a, owner_b) =
        if collateral_is_a {
            (
                ctx.accounts.collateral_mint.to_account_info(),
                ctx.accounts.wsxmr_mint.to_account_info(),
                ctx.accounts.position_collateral_ata.to_account_info(),
                ctx.accounts.position_wsxmr_ata.to_account_info(),
                ctx.accounts.position_collateral_ata.key(),
                ctx.accounts.position_wsxmr_ata.key(),
            )
        } else {
            (
                ctx.accounts.wsxmr_mint.to_account_info(),
                ctx.accounts.collateral_mint.to_account_info(),
                ctx.accounts.position_wsxmr_ata.to_account_info(),
                ctx.accounts.position_collateral_ata.to_account_info(),
                ctx.accounts.position_wsxmr_ata.key(),
                ctx.accounts.position_collateral_ata.key(),
            )
        };
    let inc_ix = increase_liquidity_ix(
        &ctx.accounts.whirlpool.key(),
        &ctx.accounts.token_program.key(),
        &ctx.accounts.token_program.key(),
        memo_program.key,
        &gs_key,
        &position_pda,
        &ctx.accounts.position_token_account.key(),
        &whirlpool_data.token_mint_a,
        &whirlpool_data.token_mint_b,
        &owner_a,
        &owner_b,
        token_vault_a.key,
        token_vault_b.key,
        &ctx.accounts.tick_array_lower.key(),
        &ctx.accounts.tick_array_upper.key(),
        liquidity,
        collateral_needed,
        wsxmr_amount,
    );
    anchor_lang::solana_program::program::invoke_signed(
        &inc_ix,
        &[
            ctx.accounts.whirlpool.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            memo_program.clone(),
            ctx.accounts.global_state.to_account_info(),
            ctx.accounts.position.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            mint_a_info,
            mint_b_info,
            owner_a_info,
            owner_b_info,
            token_vault_a.clone(),
            token_vault_b.clone(),
            ctx.accounts.tick_array_lower.to_account_info(),
            ctx.accounts.tick_array_upper.to_account_info(),
        ],
        gs_signer,
    )?;

    // ── Sweep leftovers back ──
    sweep_leftovers(&mut ctx, collateral_needed, wsxmr_amount, collateral_is_a)?;

    // ── Record the position ──
    let co_lp = &mut ctx.accounts.co_lp_position;
    co_lp.vault = ctx.accounts.vault.key();
    co_lp.user = ctx.accounts.user.key();
    co_lp.collateral_original = collateral_needed;
    co_lp.wsxmr_original = wsxmr_amount;
    co_lp.tick_lower = tick_lower;
    co_lp.tick_upper = tick_upper;
    co_lp.liquidity = liquidity;
    co_lp.position_address = position_pda;
    co_lp.created_at = Clock::get()?.unix_timestamp;
    co_lp.nonce = nonce;
    co_lp.bump = ctx.bumps.co_lp_position;
    // Advance the global request nonce so each request uses a fresh nonce.
    ctx.accounts.global_state.load_mut()?.request_nonce = nonce;

    let vault = &mut ctx.accounts.vault;
    vault.deployed_collateral = vault
        .deployed_collateral
        .checked_add(collateral_needed)
        .ok_or(WrapSynthError::MathOverflow)?;

    // Vault health check after deployment
    let global = &ctx.accounts.global_state.load()?;
    let actual_debt = get_actual_debt(vault.normalized_debt, global.global_debt_index);
    let available_after = vault
        .collateral_amount
        .saturating_sub(vault.locked_collateral)
        .saturating_sub(vault.deployed_collateral);
    let col_usd = collateral_to_usd(available_after, col_price);
    let debt_usd = actual_debt as u128 * xmr_price / WSXMR_DECIMALS as u128;
    let ratio = calculate_collateral_ratio(col_usd, debt_usd);
    require!(
        ratio >= COLLATERAL_RATIO,
        WrapSynthError::InsufficientCollateral
    );

    msg!(
        "Co-LP opened: {} QQQx + {} wsXMR, ticks [{}, {}]",
        collateral_needed,
        wsxmr_amount,
        tick_lower,
        tick_upper
    );
    Ok(())
}

/// Sweep any leftover tokens from the program-owned position ATAs back to the
/// vault (QQQx) and user (wsXMR).
#[allow(clippy::too_many_arguments)]
fn sweep_leftovers(
    ctx: &mut Context<UserOpenCoLP>,
    collateral_needed: u64,
    wsxmr_amount: u64,
    collateral_is_a: bool,
) -> Result<()> {
    let gs_bump = ctx.accounts.global_state.load()?.bump;
    let gs_seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[gs_bump]];
    let gs_signer = &[gs_seeds];

    // position_collateral_ata always holds QQQx and position_wsxmr_ata always holds
    // wsXMR — the pool's a/b ordering does NOT change which ATA holds which token,
    // so there is no swap here (the a/b ordering only matters for the whirlpool
    // increase/decrease_liquidity account ordering, handled by owner_a/b above).
    let collateral_ata = ctx.accounts.position_collateral_ata.to_account_info();
    let wsxmr_ata = ctx.accounts.position_wsxmr_ata.to_account_info();
    let _ = collateral_is_a;

    // Read balances and sweep
    let collateral_balance = collateral_ata.try_borrow_data()?;
    let collateral_amt = if collateral_balance.len() >= 64 {
        u64::from_le_bytes(collateral_balance[64..72].try_into().unwrap())
    } else {
        0
    };
    drop(collateral_balance);
    if collateral_amt > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: collateral_ata,
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.vault_collateral_ata.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                gs_signer,
            ),
            collateral_amt,
            ctx.accounts.collateral_mint.decimals,
        )?;
        ctx.accounts.vault.collateral_amount = ctx
            .accounts
            .vault
            .collateral_amount
            .saturating_sub(collateral_needed.saturating_sub(collateral_amt));
    }

    let wsxmr_balance = wsxmr_ata.try_borrow_data()?;
    let wsxmr_amt = if wsxmr_balance.len() >= 64 {
        u64::from_le_bytes(wsxmr_balance[64..72].try_into().unwrap())
    } else {
        0
    };
    drop(wsxmr_balance);
    if wsxmr_amt > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: wsxmr_ata,
                    mint: ctx.accounts.wsxmr_mint.to_account_info(),
                    to: ctx.accounts.user_wsxmr_ata.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                gs_signer,
            ),
            wsxmr_amt,
            ctx.accounts.wsxmr_mint.decimals,
        )?;
    }
    let _ = wsxmr_amount;
    Ok(())
}

// ─── collect_co_lp_fees ──────────────────────────────────────────────────────
// LP or user collects accrued fees: QQQx → vault collateral ATA, wsXMR → user.

pub fn collect_co_lp_fees<'info>(
    ctx: Context<'_, '_, '_, 'info, CollectCoLPFees<'info>>,
) -> Result<()> {
    let co_lp = &ctx.accounts.co_lp_position;
    require!(
        ctx.accounts.caller.key() == co_lp.vault || ctx.accounts.caller.key() == co_lp.user,
        WrapSynthError::Unauthorized
    );

    // Whirlpool-internal CPI accounts via remaining_accounts:
    //   [0] token_vault_a  [1] token_vault_b  [2] whirlpool_program  [3] memo_program
    //   [4] tick_array_lower  [5] tick_array_upper  (position's range arrays —
    //       needed by update_fees_and_rewards to recompute fee_owed_*)
    let ra = ctx.remaining_accounts;
    require!(ra.len() >= 6, WrapSynthError::InvalidValue);
    let token_vault_a = ra[0].clone();
    let token_vault_b = ra[1].clone();
    let memo_program = ra[3].clone();
    let tick_array_lower = ra[4].clone();
    let tick_array_upper = ra[5].clone();

    let whirlpool_data = read_whirlpool(&ctx.accounts.whirlpool)?;
    let collateral_is_a = whirlpool_data.token_mint_a == ctx.accounts.collateral_mint.key();

    let gs_bump = ctx.accounts.global_state.load()?.bump;
    let gs_seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[gs_bump]];
    let gs_signer = &[gs_seeds];

    let (owner_a, owner_b) = if collateral_is_a {
        (
            ctx.accounts.position_collateral_ata.key(),
            ctx.accounts.position_wsxmr_ata.key(),
        )
    } else {
        (
            ctx.accounts.position_wsxmr_ata.key(),
            ctx.accounts.position_collateral_ata.key(),
        )
    };

    // collect_fees_v2 only transfers position.fee_owed_* — it does NOT recompute
    // them. We must first run update_fees_and_rewards so the swap's accrued fees
    // land in fee_owed_* before we claim them.
    let update_ix = update_fees_and_rewards_ix(
        &ctx.accounts.whirlpool.key(),
        &co_lp.position_address,
        &tick_array_lower.key(),
        &tick_array_upper.key(),
    );
    anchor_lang::solana_program::program::invoke(
        &update_ix,
        &[
            ctx.accounts.whirlpool.to_account_info(),
            ctx.accounts.position.to_account_info(),
            tick_array_lower.clone(),
            tick_array_upper.clone(),
        ],
    )?;

    let collect_ix = collect_fees_ix(
        &ctx.accounts.whirlpool.key(),
        &ctx.accounts.global_state.key(),
        &co_lp.position_address,
        &ctx.accounts.position_token_account.key(),
        &whirlpool_data.token_mint_a,
        &whirlpool_data.token_mint_b,
        &owner_a,
        &whirlpool_data.token_vault_a,
        &owner_b,
        &whirlpool_data.token_vault_b,
        &ctx.accounts.token_program.key(),
        &ctx.accounts.token_program.key(),
        memo_program.key,
    );
    anchor_lang::solana_program::program::invoke_signed(
        &collect_ix,
        &[
            ctx.accounts.whirlpool.to_account_info(),
            ctx.accounts.global_state.to_account_info(),
            ctx.accounts.position.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.collateral_mint.to_account_info(),
            ctx.accounts.wsxmr_mint.to_account_info(),
            ctx.accounts.position_collateral_ata.to_account_info(),
            token_vault_a.clone(),
            ctx.accounts.position_wsxmr_ata.to_account_info(),
            token_vault_b.clone(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            memo_program.clone(),
        ],
        gs_signer,
    )?;

    // Distribute: QQQx fees → vault collateral ATA, wsXMR fees → user ATA
    let collateral_balance = read_token_balance(&ctx.accounts.position_collateral_ata)?;
    if collateral_balance > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.position_collateral_ata.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.vault_collateral_ata.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                gs_signer,
            ),
            collateral_balance,
            ctx.accounts.collateral_mint.decimals,
        )?;
        ctx.accounts.vault.collateral_amount = ctx
            .accounts
            .vault
            .collateral_amount
            .checked_add(collateral_balance)
            .ok_or(WrapSynthError::MathOverflow)?;
    }

    let wsxmr_balance = read_token_balance(&ctx.accounts.position_wsxmr_ata)?;
    if wsxmr_balance > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.position_wsxmr_ata.to_account_info(),
                    mint: ctx.accounts.wsxmr_mint.to_account_info(),
                    to: ctx.accounts.user_wsxmr_ata.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                gs_signer,
            ),
            wsxmr_balance,
            ctx.accounts.wsxmr_mint.decimals,
        )?;
    }

    msg!(
        "Co-LP fees collected: {} QQQx, {} wsXMR",
        collateral_balance,
        wsxmr_balance
    );
    Ok(())
}

// ─── unwind_co_lp ────────────────────────────────────────────────────────────
// LP or user closes the position: decrease liquidity, collect fees, close.

pub fn unwind_co_lp<'info>(ctx: Context<'_, '_, '_, 'info, UnwindCoLP<'info>>) -> Result<()> {
    let co_lp = &ctx.accounts.co_lp_position;
    require!(
        ctx.accounts.caller.key() == co_lp.vault || ctx.accounts.caller.key() == co_lp.user,
        WrapSynthError::Unauthorized
    );

    // Whirlpool-internal CPI accounts via remaining_accounts:
    //   [0] token_vault_a  [1] token_vault_b  [2] whirlpool_program  [3] memo_program
    let ra = ctx.remaining_accounts;
    require!(ra.len() >= 4, WrapSynthError::InvalidValue);
    let token_vault_a = ra[0].clone();
    let token_vault_b = ra[1].clone();
    let memo_program = ra[3].clone();

    let whirlpool_data = read_whirlpool(&ctx.accounts.whirlpool)?;
    let position_data = read_position(&ctx.accounts.position)?;
    let collateral_is_a = whirlpool_data.token_mint_a == ctx.accounts.collateral_mint.key();

    let gs_bump = ctx.accounts.global_state.load()?.bump;
    let gs_seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[gs_bump]];
    let gs_signer = &[gs_seeds];

    let (owner_a, owner_b) = if collateral_is_a {
        (
            ctx.accounts.position_collateral_ata.key(),
            ctx.accounts.position_wsxmr_ata.key(),
        )
    } else {
        (
            ctx.accounts.position_wsxmr_ata.key(),
            ctx.accounts.position_collateral_ata.key(),
        )
    };

    // 1. Decrease liquidity to zero
    if position_data.liquidity > 0 {
        let dec_ix = decrease_liquidity_ix(
            &ctx.accounts.whirlpool.key(),
            &ctx.accounts.token_program.key(),
            &ctx.accounts.token_program.key(),
            memo_program.key,
            &ctx.accounts.global_state.key(),
            &co_lp.position_address,
            &ctx.accounts.position_token_account.key(),
            &whirlpool_data.token_mint_a,
            &whirlpool_data.token_mint_b,
            &owner_a,
            &owner_b,
            &whirlpool_data.token_vault_a,
            &whirlpool_data.token_vault_b,
            &ctx.accounts.tick_array_lower.key(),
            &ctx.accounts.tick_array_upper.key(),
            position_data.liquidity,
            0,
            0,
        );
        anchor_lang::solana_program::program::invoke_signed(
            &dec_ix,
            &[
                ctx.accounts.whirlpool.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                memo_program.clone(),
                ctx.accounts.global_state.to_account_info(),
                ctx.accounts.position.to_account_info(),
                ctx.accounts.position_token_account.to_account_info(),
                ctx.accounts.collateral_mint.to_account_info(),
                ctx.accounts.wsxmr_mint.to_account_info(),
                ctx.accounts.position_collateral_ata.to_account_info(),
                ctx.accounts.position_wsxmr_ata.to_account_info(),
                token_vault_a.clone(),
                token_vault_b.clone(),
                ctx.accounts.tick_array_lower.to_account_info(),
                ctx.accounts.tick_array_upper.to_account_info(),
            ],
            gs_signer,
        )?;
    }

    // 2. Collect remaining fees
    let collect_ix = collect_fees_ix(
        &ctx.accounts.whirlpool.key(),
        &ctx.accounts.global_state.key(),
        &co_lp.position_address,
        &ctx.accounts.position_token_account.key(),
        &whirlpool_data.token_mint_a,
        &whirlpool_data.token_mint_b,
        &owner_a,
        &whirlpool_data.token_vault_a,
        &owner_b,
        &whirlpool_data.token_vault_b,
        &ctx.accounts.token_program.key(),
        &ctx.accounts.token_program.key(),
        memo_program.key,
    );
    anchor_lang::solana_program::program::invoke_signed(
        &collect_ix,
        &[
            ctx.accounts.whirlpool.to_account_info(),
            ctx.accounts.global_state.to_account_info(),
            ctx.accounts.position.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.collateral_mint.to_account_info(),
            ctx.accounts.wsxmr_mint.to_account_info(),
            ctx.accounts.position_collateral_ata.to_account_info(),
            token_vault_a.clone(),
            ctx.accounts.position_wsxmr_ata.to_account_info(),
            token_vault_b.clone(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            memo_program.clone(),
        ],
        gs_signer,
    )?;

    // 3. Close the position (burns the Token-2022 NFT + closes mint/position)
    let close_ix = close_position_with_token_extensions_ix(
        &ctx.accounts.global_state.key(),
        &ctx.accounts.global_state.key(),
        &co_lp.position_address,
        &ctx.accounts.position_mint.key(),
        &ctx.accounts.position_token_account.key(),
        &ctx.accounts.token_program.key(),
    );
    anchor_lang::solana_program::program::invoke_signed(
        &close_ix,
        &[
            ctx.accounts.global_state.to_account_info(),
            ctx.accounts.global_state.to_account_info(),
            ctx.accounts.position.to_account_info(),
            ctx.accounts.position_mint.to_account_info(),
            ctx.accounts.position_token_account.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        gs_signer,
    )?;

    // 4. Distribute proceeds: QQQx → vault, wsXMR → user
    let collateral_balance = read_token_balance(&ctx.accounts.position_collateral_ata)?;
    if collateral_balance > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.position_collateral_ata.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.vault_collateral_ata.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                gs_signer,
            ),
            collateral_balance,
            ctx.accounts.collateral_mint.decimals,
        )?;
        ctx.accounts.vault.collateral_amount = ctx
            .accounts
            .vault
            .collateral_amount
            .checked_add(collateral_balance)
            .ok_or(WrapSynthError::MathOverflow)?;
    }

    let wsxmr_balance = read_token_balance(&ctx.accounts.position_wsxmr_ata)?;
    if wsxmr_balance > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.position_wsxmr_ata.to_account_info(),
                    mint: ctx.accounts.wsxmr_mint.to_account_info(),
                    to: ctx.accounts.user_wsxmr_ata.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                gs_signer,
            ),
            wsxmr_balance,
            ctx.accounts.wsxmr_mint.decimals,
        )?;
    }

    // 5. Release the deployed collateral tracking
    let vault = &mut ctx.accounts.vault;
    vault.deployed_collateral = vault
        .deployed_collateral
        .saturating_sub(co_lp.collateral_original);

    let co_lp = &mut ctx.accounts.co_lp_position;
    co_lp.liquidity = 0;

    msg!(
        "Co-LP unwound: {} QQQx, {} wsXMR returned",
        collateral_balance,
        wsxmr_balance
    );
    Ok(())
}

// ─── rebalance_co_lp ─────────────────────────────────────────────────────────
// Keeper-callable: unwinds the position and re-opens at a new range. For
// simplicity the re-deploy is a separate user_open_co_lp; this instruction
// drains the position and credits the vault/user (EVM rebalanceCoLP parity,
// minus the in-tx re-deploy which Solana splits across instructions).

pub fn rebalance_co_lp<'info>(
    ctx: Context<'_, '_, '_, 'info, RebalanceCoLP<'info>>,
    new_range_bps: u16,
) -> Result<()> {
    require!(
        new_range_bps >= MIN_CO_LP_RANGE_BPS
            && new_range_bps <= ctx.accounts.vault.max_co_lp_range_bps,
        WrapSynthError::InvalidConfig
    );

    // Whirlpool-internal CPI accounts via remaining_accounts:
    //   [0] token_vault_a  [1] token_vault_b  [2] whirlpool_program  [3] memo_program
    let ra = ctx.remaining_accounts;
    require!(ra.len() >= 4, WrapSynthError::InvalidValue);
    let token_vault_a = ra[0].clone();
    let token_vault_b = ra[1].clone();
    let memo_program = ra[3].clone();

    // Drain the position (decrease + collect)
    let co_lp = &ctx.accounts.co_lp_position;
    let whirlpool_data = read_whirlpool(&ctx.accounts.whirlpool)?;
    let position_data = read_position(&ctx.accounts.position)?;
    let collateral_is_a = whirlpool_data.token_mint_a == ctx.accounts.collateral_mint.key();

    let gs_bump = ctx.accounts.global_state.load()?.bump;
    let gs_seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[gs_bump]];
    let gs_signer = &[gs_seeds];

    let (owner_a, owner_b) = if collateral_is_a {
        (
            ctx.accounts.position_collateral_ata.key(),
            ctx.accounts.position_wsxmr_ata.key(),
        )
    } else {
        (
            ctx.accounts.position_wsxmr_ata.key(),
            ctx.accounts.position_collateral_ata.key(),
        )
    };

    if position_data.liquidity > 0 {
        let dec_ix = decrease_liquidity_ix(
            &ctx.accounts.whirlpool.key(),
            &ctx.accounts.token_program.key(),
            &ctx.accounts.token_program.key(),
            memo_program.key,
            &ctx.accounts.global_state.key(),
            &co_lp.position_address,
            &ctx.accounts.position_token_account.key(),
            &whirlpool_data.token_mint_a,
            &whirlpool_data.token_mint_b,
            &owner_a,
            &owner_b,
            &whirlpool_data.token_vault_a,
            &whirlpool_data.token_vault_b,
            &ctx.accounts.tick_array_lower.key(),
            &ctx.accounts.tick_array_upper.key(),
            position_data.liquidity,
            0,
            0,
        );
        anchor_lang::solana_program::program::invoke_signed(
            &dec_ix,
            &[
                ctx.accounts.whirlpool.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                memo_program.clone(),
                ctx.accounts.global_state.to_account_info(),
                ctx.accounts.position.to_account_info(),
                ctx.accounts.position_token_account.to_account_info(),
                ctx.accounts.collateral_mint.to_account_info(),
                ctx.accounts.wsxmr_mint.to_account_info(),
                ctx.accounts.position_collateral_ata.to_account_info(),
                ctx.accounts.position_wsxmr_ata.to_account_info(),
                token_vault_a.clone(),
                token_vault_b.clone(),
                ctx.accounts.tick_array_lower.to_account_info(),
                ctx.accounts.tick_array_upper.to_account_info(),
            ],
            gs_signer,
        )?;
    }

    // Distribute drained proceeds
    let collateral_balance = read_token_balance(&ctx.accounts.position_collateral_ata)?;
    if collateral_balance > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.position_collateral_ata.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.vault_collateral_ata.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                gs_signer,
            ),
            collateral_balance,
            ctx.accounts.collateral_mint.decimals,
        )?;
        ctx.accounts.vault.collateral_amount = ctx
            .accounts
            .vault
            .collateral_amount
            .checked_add(collateral_balance)
            .ok_or(WrapSynthError::MathOverflow)?;
    }
    let wsxmr_balance = read_token_balance(&ctx.accounts.position_wsxmr_ata)?;
    if wsxmr_balance > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.position_wsxmr_ata.to_account_info(),
                    mint: ctx.accounts.wsxmr_mint.to_account_info(),
                    to: ctx.accounts.user_wsxmr_ata.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                gs_signer,
            ),
            wsxmr_balance,
            ctx.accounts.wsxmr_mint.decimals,
        )?;
    }

    // Release deployed collateral; the caller re-opens via user_open_co_lp
    ctx.accounts.vault.deployed_collateral = ctx
        .accounts
        .vault
        .deployed_collateral
        .saturating_sub(co_lp.collateral_original);
    let co_lp = &mut ctx.accounts.co_lp_position;
    co_lp.liquidity = 0;

    msg!(
        "Co-LP drained for rebalance: {} QQQx, {} wsXMR",
        collateral_balance,
        wsxmr_balance
    );
    Ok(())
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Read the token balance from a token account's raw data (offset 64 = amount).
fn read_token_balance(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    if data.len() < 72 {
        return Ok(0);
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

/// Q64.64 sqrt price at a tick: 1.0001^(tick/2) * 2^64 (f64 approximation).
fn sqrt_price_at_tick(tick: i32) -> u128 {
    let sqrt_price = 1.0001f64.powf(tick as f64 / 2.0);
    (sqrt_price * 18446744073709551616.0) as u128
}

/// Compute the liquidity that consumes both token amounts for an in-range
/// centered position (Uniswap V3 liquidity math, f64 approximation).
fn compute_liquidity(
    amount_a: u64,
    amount_b: u64,
    sqrt_price: u128,
    sqrt_lower: u128,
    sqrt_upper: u128,
) -> u128 {
    let p = sqrt_price as f64 / 18446744073709551616.0;
    let pl = sqrt_lower as f64 / 18446744073709551616.0;
    let pu = sqrt_upper as f64 / 18446744073709551616.0;
    if pu <= pl {
        return 0;
    }
    let liq_a = (amount_a as f64) * p * pu / (pu - p);
    let liq_b = (amount_b as f64) * (pu - p) / (pu - pl);
    liq_a.min(liq_b) as u128
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct SetMaxCoLPRange<'info> {
    pub lp: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lp.key().as_ref()],
        bump = vault.bump,
        constraint = vault.lp_address == lp.key() @ WrapSynthError::Unauthorized,
        constraint = vault.active @ WrapSynthError::VaultNotActive,
    )]
    pub vault: Box<Account<'info, Vault>>,
}

#[derive(Accounts)]
#[instruction(wsxmr_amount: u64, nonce: u64)]
pub struct UserOpenCoLP<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

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
        init,
        payer = user,
        space = CoLPPosition::LEN,
        seeds = [CO_LP_POSITION_SEED, vault.key().as_ref(), user.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub co_lp_position: Box<Account<'info, CoLPPosition>>,

    /// Position NFT mint (Token-2022 with metadata extensions) — created by the program
    /// CHECK: created and initialized inside the handler
    #[account(mut)]
    pub position_mint: UncheckedAccount<'info>,

    /// ATA holding the position NFT — created by the program
    /// CHECK: created inside the handler
    #[account(mut)]
    pub position_token_account: UncheckedAccount<'info>,

    /// Orca Position PDA (derived from position_mint)
    /// CHECK: validated by the whirlpool program
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// Orca Whirlpool account (mutated by increase_liquidity)
    /// CHECK: read manually via read_whirlpool
    #[account(mut)]
    pub whirlpool: UncheckedAccount<'info>,

    /// Whirlpool-internal accounts (token_vault_a/b, token_badge_a/b,
    /// whirlpools_config_extension, metadata_update_auth, whirlpool_program) are
    /// passed via ctx.remaining_accounts — keeping them out of the struct avoids a
    /// ~4KB try_accounts stack frame overflow.
    #[account(mut)]
    /// CHECK: Whirlpool tick array — verified inside the Orca CPI.
    pub tick_array_lower: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Whirlpool tick array — verified inside the Orca CPI.
    pub tick_array_upper: UncheckedAccount<'info>,

    /// Program-owned QQQx ATA (position token_owner_account_a)
    /// CHECK: created by the caller or program
    #[account(mut)]
    pub position_collateral_ata: UncheckedAccount<'info>,

    /// Program-owned wsXMR ATA (position token_owner_account_b)
    /// CHECK: created by the caller or program
    #[account(mut)]
    pub position_wsxmr_ata: UncheckedAccount<'info>,

    #[account(mut)]
    pub user_wsxmr_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,
    pub wsxmr_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth collateral price feed — validated by oracle.rs
    pub pyth_collateral: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CollectCoLPFees<'info> {
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
        seeds = [CO_LP_POSITION_SEED, co_lp_position.vault.as_ref(), co_lp_position.user.as_ref(), co_lp_position.nonce.to_le_bytes().as_ref()],
        bump = co_lp_position.bump,
    )]
    pub co_lp_position: Box<Account<'info, CoLPPosition>>,

    /// Orca Position account
    /// CHECK: read manually via read_position
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// Orca Whirlpool account
    /// CHECK: read manually via read_whirlpool
    #[account(mut)]
    pub whirlpool: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Whirlpool position token account — verified inside the Orca CPI.
    pub position_token_account: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Position collateral vault ATA — verified inside the Orca CPI.
    pub position_collateral_ata: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Position wsXMR vault ATA — verified inside the Orca CPI.
    pub position_wsxmr_ata: UncheckedAccount<'info>,

    #[account(mut)]
    pub vault_collateral_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub user_wsxmr_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,
    pub wsxmr_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnwindCoLP<'info> {
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
        seeds = [CO_LP_POSITION_SEED, co_lp_position.vault.as_ref(), co_lp_position.user.as_ref(), co_lp_position.nonce.to_le_bytes().as_ref()],
        bump = co_lp_position.bump,
    )]
    pub co_lp_position: Box<Account<'info, CoLPPosition>>,

    /// Orca Position account
    /// CHECK: read manually via read_position
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// Orca Whirlpool account
    /// CHECK: read manually via read_whirlpool
    #[account(mut)]
    pub whirlpool: UncheckedAccount<'info>,

    /// Position NFT mint
    /// CHECK: burned by close_position
    #[account(mut)]
    pub position_mint: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Whirlpool position token account — verified inside the Orca CPI.
    pub position_token_account: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Whirlpool tick array — verified inside the Orca CPI.
    pub tick_array_lower: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Whirlpool tick array — verified inside the Orca CPI.
    pub tick_array_upper: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Position collateral vault ATA — verified inside the Orca CPI.
    pub position_collateral_ata: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Position wsXMR vault ATA — verified inside the Orca CPI.
    pub position_wsxmr_ata: UncheckedAccount<'info>,

    #[account(mut)]
    pub vault_collateral_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub user_wsxmr_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,
    pub wsxmr_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RebalanceCoLP<'info> {
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
        seeds = [CO_LP_POSITION_SEED, co_lp_position.vault.as_ref(), co_lp_position.user.as_ref(), co_lp_position.nonce.to_le_bytes().as_ref()],
        bump = co_lp_position.bump,
    )]
    pub co_lp_position: Box<Account<'info, CoLPPosition>>,

    /// Orca Position account
    /// CHECK: read manually via read_position
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// Orca Whirlpool account
    /// CHECK: read manually via read_whirlpool
    #[account(mut)]
    pub whirlpool: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Whirlpool position token account — verified inside the Orca CPI.
    pub position_token_account: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Whirlpool tick array — verified inside the Orca CPI.
    pub tick_array_lower: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Whirlpool tick array — verified inside the Orca CPI.
    pub tick_array_upper: UncheckedAccount<'info>,

    #[account(mut)]
    /// CHECK: Position collateral vault ATA — verified inside the Orca CPI.
    pub position_collateral_ata: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Position wsXMR vault ATA — verified inside the Orca CPI.
    pub position_wsxmr_ata: UncheckedAccount<'info>,

    #[account(mut)]
    pub vault_collateral_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub user_wsxmr_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,
    pub wsxmr_mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
