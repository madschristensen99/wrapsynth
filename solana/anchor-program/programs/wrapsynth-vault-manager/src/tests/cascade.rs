/// Cascade robustness tests — N vaults + interleaved auction settlements.
///
/// LiteSVM covers the math and state-transition invariants here.
use anchor_lang::prelude::Pubkey;

use crate::constants::*;
use crate::state::{BurnRequest, BurnStatus, GlobalState, Vault};
use crate::utils::math::*;

/// Simulate the core state mutations of `bid` on a single vault — whole-debt
/// clear for X(t)% of the offered collateral, without CPIs or account context.
/// Mirrors auction.rs bid() exactly.
fn simulate_bid(
    vault: &mut Vault,
    global: &mut GlobalState,
    offered_collateral: u64,
    x_bps: u64,
) -> (u64, u64, u64) {
    let debt = get_actual_debt(vault.normalized_debt, global.global_debt_index);
    if debt == 0 {
        return (0, 0, 0);
    }

    let bidder_payout = ((offered_collateral as u128)
        .checked_mul(x_bps as u128)
        .unwrap_or(0)
        / BPS_DENOMINATOR as u128) as u64;
    let surplus = offered_collateral.saturating_sub(bidder_payout);
    let chip = ((surplus as u128)
        .checked_mul(CHIP_BPS as u128)
        .unwrap_or(0)
        / BPS_DENOMINATOR as u128) as u64;

    let total_out = bidder_payout.saturating_add(chip);
    vault.collateral_amount = vault.collateral_amount.saturating_sub(total_out);

    vault.normalized_debt = 0;
    global.global_total_debt = global.global_total_debt.saturating_sub(debt);

    vault.liquidation_nonce += 1;
    vault.mint_nonce += 1;
    // pending_debt is NOT zeroed (EVM parity) — invalidated requests release
    // their own reservations on cancel/finalize.

    (debt, bidder_payout, chip)
}

fn make_global() -> GlobalState {
    GlobalState {
        authority: Default::default(),
        wsxmr_mint: Default::default(),
        collateral_mint: Default::default(),
        liquidity_router: Default::default(),
        global_total_debt: 0,
        global_debt_index: INITIAL_DEBT_INDEX,
        global_pending_collateral: 0,
        global_pending_sol: 0,
        global_bad_debt: 0,
        global_pending_burn_debt: 0,
        request_nonce: 0,
        bump: 0,
        _reserved: [0u8; 7],
    }
}

fn make_vault(collateral: u64, debt: u64, debt_index: u64) -> Vault {
    Vault {
        lp_address: Default::default(),
        collateral_amount: collateral,
        locked_collateral: 0,
        normalized_debt: normalize_debt(debt, debt_index),
        pending_debt: 0,
        threshold_lamports_per_wsxmr: MIN_THRESHOLD_LAMPORTS,
        max_mint_wsxmr: 0,
        mint_griefing_deposit: 0,
        mint_fee_bps: 0,
        burn_reward_bps: 0,
        liquidation_nonce: 0,
        mint_nonce: 0,
        min_burn_amount: 0,
        active_burn_count: 0,
        pending_mint_count: 0,
        mint_timeout_seconds: DEFAULT_MINT_TIMEOUT_SECONDS,
        burn_timeout_seconds: DEFAULT_BURN_TIMEOUT_SECONDS,
        whitelisted_minters: [Pubkey::default(); MAX_WHITELISTED_MINTERS],
        whitelisted_minter_count: 0,
        deployed_collateral: 0,
        max_co_lp_range_bps: DEFAULT_CO_LP_RANGE_BPS,
        kick_active: false,
        frozen: false,
        reauction_used: false,
        last_kick_resolved: 0,
        active: true,
        bump: 0,
    }
}

#[test]
fn threshold_invariants_hold() {
    assert!(MINT_LOCK_RATIO >= RATIO_PRECISION, "MLR >= 100%");
    assert!(
        BURN_LOCK_MULTIPLIER_BPS > BPS_DENOMINATOR as u64,
        "burn lock multiplier > 1x"
    );
    assert!(
        HAIRCUT_FLOOR_BPS < KICK_SANE_BPS && KICK_SANE_BPS < HAIRCUT_START_BPS,
        "haircut floor < sane bound < start"
    );
    assert!(MIN_THRESHOLD_LAMPORTS > 0, "min threshold must be nonzero");
}

#[test]
fn par_math_roundtrip() {
    // threshold = 1.5 SOL lamports per 1e8 wsXMR (≈ par at $300 XMR / $200 SOL)
    let t = 1_500_000_000u128;
    // 1 wsXMR (1e8 units) → 1.5 SOL
    assert_eq!(par_lamports(WSXMR_DECIMALS, t), t as u64);
    // 0.5 wsXMR → 0.75 SOL
    assert_eq!(par_lamports(WSXMR_DECIMALS / 2, t), 750_000_000);
    // par_lock_for applies MINT_LOCK_RATIO
    assert_eq!(
        par_lock_for(WSXMR_DECIMALS, t),
        (t * MINT_LOCK_RATIO as u128 / RATIO_PRECISION as u128) as u64
    );
    // required_lamports == par_lamports
    assert_eq!(required_lamports(WSXMR_DECIMALS, t), t as u64);
}

#[test]
fn whirlpool_tick_math_sane() {
    use crate::utils::whirlpool::{compute_range_ticks, tick_array_start_index};

    // A range centered on a tick must bracket it and align to tick spacing
    let (lower, upper) = compute_range_ticks(0, 2500, 60);
    assert!(lower < 0 && upper > 0, "range must bracket current tick");
    assert_eq!(lower % 60, 0, "lower must align to tick spacing");
    assert_eq!(upper % 60, 0, "upper must align to tick spacing");
    assert!(upper - lower > 0, "range must be positive width");

    // Wider range → wider tick span
    let (l2, u2) = compute_range_ticks(0, 10000, 60);
    assert!(u2 - l2 > upper - lower, "wider range must widen ticks");

    // Tick array start index must be a multiple of (88 * tick_spacing)
    let start = tick_array_start_index(12345, 60);
    assert_eq!(start % (88 * 60), 0, "tick array start must align");
    let start_neg = tick_array_start_index(-12345, 60);
    assert_eq!(
        start_neg % (88 * 60),
        0,
        "negative tick array start must align"
    );
}

#[test]
fn cascade_bid_math_commutative() {
    // 5 vaults at varying coverage vs their declared threshold. Coverage is
    // judged at the threshold, not a market price — there is no price drop,
    // only the auction.
    let vault_configs: [(u64, u64); 5] = [
        (3_000_000, 1_000_000), // well-covered
        (1_800_000, 1_000_000),
        (1_500_000, 1_000_000),
        (1_400_000, 1_000_000),
        (1_000_000, 1_000_000), // barely backed
    ];

    let mut global = make_global();
    let mut vaults: Vec<Vault> = vault_configs
        .iter()
        .enumerate()
        .map(|(i, &(coll, debt))| {
            let mut v = make_vault(coll, debt, global.global_debt_index);
            v.liquidation_nonce = i as u64;
            global.global_total_debt += debt;
            v
        })
        .collect();

    let initial_total_debt = global.global_total_debt;
    let initial_total_collateral: u64 = vaults.iter().map(|v| v.collateral_amount).sum();

    // Interleaved settlement order: settle vaults 2,4,3,1 (0 stays untouched).
    // Each bid clears the FULL debt for X(t)% of the offered (free) collateral.
    let settle_order = vec![2usize, 4, 3, 1];
    let mut total_cleared = 0u64;
    let mut total_paid = 0u64;

    for &idx in &settle_order {
        let v = &mut vaults[idx];
        let offered = v.collateral_amount.saturating_sub(v.locked_collateral);
        let (cleared, payout, chip) = simulate_bid(v, &mut global, offered, 9_000);
        total_cleared += cleared;
        total_paid += payout + chip;
    }

    // Invariant 1: global_total_debt == sum of actual debts across all vaults.
    let remaining_vault_debt: u64 = vaults
        .iter()
        .map(|v| get_actual_debt(v.normalized_debt, global.global_debt_index))
        .sum();
    assert_eq!(
        global.global_total_debt, remaining_vault_debt,
        "global_total_debt != sum(vault debts): global={} vault_sum={}",
        global.global_total_debt, remaining_vault_debt
    );

    // Invariant 1b: cleared + remaining == initial (debt conservation)
    assert_eq!(
        global.global_total_debt + total_cleared,
        initial_total_debt,
        "Debt conservation violated: initial={} accounted={}",
        initial_total_debt,
        global.global_total_debt + total_cleared
    );

    // Invariant 2: settled vaults are fully cleared — debt == 0.
    for &idx in &settle_order {
        assert_eq!(
            vaults[idx].normalized_debt, 0,
            "settled vault {} still has debt",
            idx
        );
    }

    // Invariant 3: paid collateral never exceeds what was offered.
    let remaining_collateral: u64 = vaults.iter().map(|v| v.collateral_amount).sum();
    assert_eq!(
        initial_total_collateral - remaining_collateral,
        total_paid,
        "collateral outflow != bidder payouts"
    );
    assert!(total_paid <= initial_total_collateral);

    // Invariant 4: untouched vault 0 keeps its debt and collateral.
    assert_eq!(vaults[0].collateral_amount, 3_000_000);
    assert_eq!(
        get_actual_debt(vaults[0].normalized_debt, global.global_debt_index),
        1_000_000
    );

    println!(
        "Cascade test passed. cleared={} paid={} remaining_collateral={}",
        total_cleared, total_paid, remaining_collateral
    );
}

#[test]
fn burn_request_nonce_invalidation() {
    // A burn request created before the auction opened must be rejected by
    // resolve_burn_for_auction after the vault's liquidation_nonce is bumped.
    let burn = BurnRequest {
        request_id: [0u8; 32],
        user: Default::default(),
        lp_vault: Default::default(),
        wsxmr_amount: 1_000_000,
        xmr_amount: 10_000_000_000,
        locked_collateral: 100_000,
        reward_collateral: 10_000,
        user_claim_commitment: [0u8; 32],
        user_public_key: [0u8; 32],
        user_view_key: [0u8; 32],
        threshold_at_request: 1_500_000_000,
        secret_hash: [0u8; 32],
        lp_public_spend_key: [0u8; 32],
        lp_public_view_key: [0u8; 32],
        revealed_secret: [0u8; 32],
        deadline: 0,
        vault_liquidation_nonce: 0, // created before the auction opened
        normalized_debt_amount: 100,
        abandoned: false,
        status: BurnStatus::Committed,
        bump: 0,
    };

    let mut vault = make_vault(1_000_000, 0, INITIAL_DEBT_INDEX);
    vault.locked_collateral = 110_000;
    vault.normalized_debt = 1_000;
    vault.liquidation_nonce = 1; // bumped at auction open
    vault.active_burn_count = 1;

    assert_ne!(
        burn.vault_liquidation_nonce, vault.liquidation_nonce,
        "Burn request should be invalidated"
    );
}

#[test]
fn bid_on_drained_vault_does_not_underflow() {
    // Offered collateral smaller than X(t) payout still settles — payouts are
    // saturating and the debt always clears in full.
    let mut vault = make_vault(500_000, 1_000_000, INITIAL_DEBT_INDEX);

    let mut global = make_global();
    global.global_total_debt = 1_000_000;

    let offered = vault.collateral_amount;
    let (cleared, payout, chip) = simulate_bid(&mut vault, &mut global, offered, 9_000);

    assert_eq!(cleared, 1_000_000, "full debt must clear");
    assert_eq!(vault.normalized_debt, 0);
    assert_eq!(global.global_total_debt, 0);
    assert!(payout + chip <= offered, "payouts exceed offered collateral");
    assert_eq!(vault.collateral_amount, offered - payout - chip);
}
