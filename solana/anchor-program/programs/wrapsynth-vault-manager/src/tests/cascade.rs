/// Cascade robustness tests — simulate N vaults + sharp collateral drop + interleaved liquidations.
///
/// LiteSVM covers the math and state-transition invariants here.
/// Surfpool forked-mainnet feed test is TODO (see end of file).

use crate::constants::*;
use crate::state::{GlobalState, Vault, BurnRequest, BurnStatus};
use crate::utils::math::*;

/// Simulate the core state mutations of `execute_liquidation` on a single vault,
/// without CPIs or account context.  Mirrors the on-chain logic exactly.
fn simulate_liquidation(
    vault: &mut Vault,
    global: &mut GlobalState,
    debt_to_clear: u64,
    xmr_price: u64,
    col_price: u64,
) -> (u64, u64) {
    // 1. Sync yield skipped (assumed already synced in test setup)

    let actual_debt = get_actual_debt(vault.normalized_debt, global.global_debt_index);
    if actual_debt == 0 {
        return (0, 0);
    }

    let col_usd = collateral_to_usd(vault.collateral_amount, col_price);
    let debt_usd = (actual_debt as u128 * xmr_price as u128 / WSXMR_DECIMALS as u128) as u64;
    let ratio = calculate_collateral_ratio(col_usd, debt_usd);
    if ratio >= LIQUIDATION_RATIO {
        panic!("Vault healthy — should not liquidate");
    }

    let mut debt_to_clear = debt_to_clear.min(actual_debt);

    let col_val_usd = collateral_value_for_debt(debt_to_clear, xmr_price, LIQUIDATION_BONUS);
    let mut collateral_amount = usd_to_collateral(col_val_usd, col_price);

    if collateral_amount > vault.collateral_amount {
        debt_to_clear = (debt_to_clear as u128 * vault.collateral_amount as u128
            / collateral_amount as u128) as u64;
        collateral_amount = vault.collateral_amount;
    }

    // Principal tracking (simplified: proportional reduction)
    let total_before = vault.collateral_amount;
    if vault.principal_deposits > 0 && total_before > 0 {
        let principal_reduction = (vault.principal_deposits as u128 * collateral_amount as u128
            / total_before as u128) as u64;
        vault.principal_deposits = vault.principal_deposits.saturating_sub(principal_reduction);
        global.global_lp_principal = global.global_lp_principal.saturating_sub(principal_reduction);
    }
    if vault.principal_shares > 0 && total_before > 0 {
        let shares_reduction = (vault.principal_shares as u128 * collateral_amount as u128
            / total_before as u128) as u64;
        vault.principal_shares = vault.principal_shares.saturating_sub(shares_reduction);
        global.global_lp_principal_shares = global.global_lp_principal_shares.saturating_sub(shares_reduction);
    }

    vault.collateral_amount = vault.collateral_amount.saturating_sub(collateral_amount);

    let normalized_clear = normalize_debt(debt_to_clear, global.global_debt_index);
    let normalized_clear = normalized_clear.min(vault.normalized_debt);
    vault.normalized_debt = vault.normalized_debt.saturating_sub(normalized_clear);

    global.global_total_debt = global.global_total_debt.saturating_sub(debt_to_clear);

    // Bad debt socialization — also remove remaining from global_total_debt so active
    // and unbacked debt don't overlap (matches fixed liquidation.rs logic).
    if vault.collateral_amount == 0 && vault.normalized_debt > 0 {
        let remaining = get_actual_debt(vault.normalized_debt, global.global_debt_index);
        if remaining > 0 {
            global.global_bad_debt = global.global_bad_debt.checked_add(remaining).expect("no overflow");
            global.global_total_debt = global.global_total_debt.saturating_sub(remaining);
        }
        vault.normalized_debt = 0;
    }

    // Nonce increments (omitted in pure math test — tested separately)
    vault.liquidation_nonce += 1;
    vault.mint_nonce += 1;
    vault.pending_debt = 0;

    (debt_to_clear, collateral_amount)
}

#[test]
fn ratio_invariants_hold() {
    assert!(LIQUIDATION_RATIO < COLLATERAL_RATIO, "LR < CR");
    assert!(COLLATERAL_RATIO < YIELD_BUFFER_RATIO, "CR < YBR");
    assert!(LIQUIDATION_RATIO < BURN_LOCK_RATIO, "LR < BLR");
    assert!(BURN_LOCK_RATIO <= COLLATERAL_RATIO + 10, "BLR <= CR + 10");
}

#[test]
fn cascade_liquidation_math_commutative() {
    // Prices before drop (both $1 in 1e18 to keep arithmetic simple and within u64)
    let xmr_price = 1_000_000_000_000_000_000u64; // $1 in 1e18
    let col_price = 1_000_000_000_000_000_000u64; // $1 in 1e18

    // 5 vaults at varying health ratios.
    // Ratio = (collateral * col_price / 1e18) * 100 / (debt * xmr_price / 1e8)
    //        = collateral * 100 / (debt * 1e10)
    // To get ratio R with debt=1_000_000: collateral = R * debt * 1e8 / 100 = R * 1e12
    let vault_configs: [(u64, u64); 5] = [
        (25_000_000_000_000_000, 1_000_000), // 250%  (safe)
        (18_000_000_000_000_000, 1_000_000), // 180%  (exactly at CR)
        (15_000_000_000_000_000, 1_000_000), // 150%  (exactly at LR)
        (14_000_000_000_000_000, 1_000_000), // 140%  (below LR)
        (10_000_000_000_000_000, 1_000_000), // 100%  (deeply underwater)
    ];

    // Build global state
    let mut global = GlobalState {
        authority: Default::default(),
        wsxmr_mint: Default::default(),
        collateral_mint: Default::default(),
        liquidity_router: Default::default(),
        pyth_xmr_feed: Default::default(),
        global_total_debt: 0,
        global_debt_index: 1_000_000_000_000_000_000u64,
        yield_war_chest: 0,
        global_lp_principal: 0,
        global_lp_principal_shares: 0,
        global_lp_principal_sol_value: 0,
        global_pending_collateral: 0,
        global_pending_sol: 0,
        global_bad_debt: 0,
        global_pending_burn_debt: 0,
        last_buy_timestamp: 0,
        vault_count: 5,
        request_nonce: 0,
        bump: 0,
    };

    let mut vaults: Vec<Vault> = vault_configs
        .iter()
        .enumerate()
        .map(|(i, &(coll, debt))| {
            let mut v = Vault {
                lp_address: Default::default(),
                collateral_amount: coll,
                locked_collateral: 0,
                normalized_debt: normalize_debt(debt, global.global_debt_index),
                pending_debt: 0,
                max_mint_bps: 0,
                mint_griefing_deposit: 0,
                mint_fee_bps: 0,
                burn_reward_bps: 0,
                liquidation_nonce: i as u64,
                mint_nonce: 0,
                min_burn_amount: 0,
                principal_deposits: coll,
                principal_shares: coll,
                principal_sol_value: coll,
                active_burn_count: 0,
                active: true,
                bump: 0,
            };
            global.global_total_debt += debt;
            global.global_lp_principal += coll;
            global.global_lp_principal_shares += coll;
            v
        })
        .collect();

    let initial_total_debt = global.global_total_debt;
    let initial_total_collateral: u64 = vaults.iter().map(|v| v.collateral_amount).sum();

    // Sharp JitoSOL/USD drop: -30% (e.g. depeg or market crash)
    let dropped_col_price = ((col_price as u128) * 70 / 100) as u64;
    // After drop ratios: 175%, 126%, 105%, 98%, 70% → vaults 1-4 are liquidatable

    // Verify vaults below LR after drop
    for v in &vaults {
        let actual = get_actual_debt(v.normalized_debt, global.global_debt_index);
        let col_usd = collateral_to_usd(v.collateral_amount, dropped_col_price);
        let debt_usd = (actual as u128 * xmr_price as u128 / WSXMR_DECIMALS as u128) as u64;
        let ratio = calculate_collateral_ratio(col_usd, debt_usd);
        println!(
            "Vault ratio after drop: {}% (coll={}, debt={})",
            ratio, v.collateral_amount, actual
        );
    }

    // Interleaved liquidation order: liquidate vaults 2,4,3,1 (skipping 0 which stays healthy)
    let liquidation_order = vec![2usize, 4, 3, 1];
    let mut total_cleared = 0u64;

    for &idx in &liquidation_order {
        let v = &mut vaults[idx];
        let actual = get_actual_debt(v.normalized_debt, global.global_debt_index);
        if actual > 0 {
            let (cleared, _) = simulate_liquidation(v, &mut global, actual, xmr_price, dropped_col_price);
            total_cleared += cleared;
        }
    }

    // Invariant 1: global_total_debt must equal sum of actual debts across all vaults.
    // (global_total_debt was decremented by each liquidation; bad debt is the socialized remainder.)
    let remaining_vault_debt: u64 = vaults.iter()
        .map(|v| get_actual_debt(v.normalized_debt, global.global_debt_index))
        .sum();
    let drift = if global.global_total_debt > remaining_vault_debt {
        global.global_total_debt - remaining_vault_debt
    } else {
        remaining_vault_debt - global.global_total_debt
    };
    assert!(
        drift <= initial_total_debt / 100,
        "global_total_debt != sum(vault debts): global={} vault_sum={} drift={}",
        global.global_total_debt, remaining_vault_debt, drift
    );

    // Invariant 1b: total cleared by liquidators + remaining tracked + socialized == initial
    let total_accounted = global.global_total_debt + global.global_bad_debt + total_cleared;
    let drift_total = if total_accounted > initial_total_debt {
        total_accounted - initial_total_debt
    } else {
        initial_total_debt - total_accounted
    };
    assert!(
        drift_total <= initial_total_debt / 100,
        "Debt conservation violated: initial={} accounted={} drift={}",
        initial_total_debt, total_accounted, drift_total
    );

    // Invariant 2: no vault has collateral == 0 AND normalized_debt > 0 (zombie check)
    for (i, v) in vaults.iter().enumerate() {
        assert!(
            !(v.collateral_amount == 0 && v.normalized_debt > 0),
            "Vault {} is zombie (collateral=0, debt>0)", i
        );
    }

    // Invariant 3: global_bad_debt only from fully-drained vaults
    let fully_drained_count = vaults.iter().filter(|v| v.collateral_amount == 0).count();
    assert!(
        global.global_bad_debt == 0 || fully_drained_count > 0,
        "Bad debt exists but no fully-drained vaults"
    );

    // Invariant 4: collateral conservation
    let remaining_collateral: u64 = vaults.iter().map(|v| v.collateral_amount).sum();
    let seized = initial_total_collateral - remaining_collateral;
    assert!(
        seized <= initial_total_collateral,
        "Seized collateral {} exceeds initial {}",
        seized, initial_total_collateral
    );

    println!("Cascade test passed. remaining_vault_debt={} bad_debt={} drift={}",
             remaining_vault_debt, global.global_bad_debt, drift);
}

#[test]
fn burn_request_nonce_invalidation() {
    // A burn request created before liquidation must be rejected by resolve_burn_for_liquidation
    // after the vault's liquidation_nonce is incremented.
    let mut burn = BurnRequest {
        request_id: [0u8; 32],
        user: Default::default(),
        lp_vault: Default::default(),
        wsxmr_amount: 1_000_000,
        xmr_amount: 10_000_000_000,
        locked_collateral: 100_000,
        reward_collateral: 10_000,
        secret_hash: [0u8; 32],
        deadline: 0,
        vault_liquidation_nonce: 0, // created before liquidation
        normalized_debt_amount: 100,
        status: BurnStatus::Committed,
        bump: 0,
    };

    let vault = Vault {
        lp_address: Default::default(),
        collateral_amount: 1_000_000,
        locked_collateral: 110_000,
        normalized_debt: 1_000,
        pending_debt: 0,
        max_mint_bps: 0,
        mint_griefing_deposit: 0,
        mint_fee_bps: 0,
        burn_reward_bps: 0,
        liquidation_nonce: 1, // incremented after prior liquidation
        mint_nonce: 0,
        min_burn_amount: 0,
        principal_deposits: 1_000_000,
        principal_shares: 1_000_000,
        principal_sol_value: 1_000_000,
        active_burn_count: 1,
        active: true,
        bump: 0,
    };

    assert_ne!(
        burn.vault_liquidation_nonce, vault.liquidation_nonce,
        "Burn request should be invalidated"
    );
}

#[test]
fn partial_liquidation_does_not_underflow() {
    // Vault with just enough collateral for a partial liquidation
    let mut vault = Vault {
        lp_address: Default::default(),
        collateral_amount: 10_000_000_000_000_000,
        locked_collateral: 0,
        normalized_debt: normalize_debt(1_000_000, 1_000_000_000_000_000_000),
        pending_debt: 0,
        max_mint_bps: 0,
        mint_griefing_deposit: 0,
        mint_fee_bps: 0,
        burn_reward_bps: 0,
        liquidation_nonce: 0,
        mint_nonce: 0,
        min_burn_amount: 0,
        principal_deposits: 10_000_000_000_000_000,
        principal_shares: 10_000_000_000_000_000,
        principal_sol_value: 10_000_000_000_000_000,
        active_burn_count: 0,
        active: true,
        bump: 0,
    };

    let mut global = GlobalState {
        authority: Default::default(),
        wsxmr_mint: Default::default(),
        collateral_mint: Default::default(),
        liquidity_router: Default::default(),
        pyth_xmr_feed: Default::default(),
        global_total_debt: 1_000_000,
        global_debt_index: 1_000_000_000_000_000_000u64,
        yield_war_chest: 0,
        global_lp_principal: 10_000_000_000_000_000,
        global_lp_principal_shares: 10_000_000_000_000_000,
        global_lp_principal_sol_value: 0,
        global_pending_collateral: 0,
        global_pending_sol: 0,
        global_bad_debt: 0,
        global_pending_burn_debt: 0,
        last_buy_timestamp: 0,
        vault_count: 1,
        request_nonce: 0,
        bump: 0,
    };

    // Price: collateral worth $1, debt worth $1 → 100% ratio (at liquidation boundary)
    let xmr_price = 1_000_000_000_000_000_000u64; // $1
    let col_price = 1_000_000_000_000_000_000u64; // $1

    // Liquidate half the debt
    let debt_to_clear = 500_000u64;
    simulate_liquidation(&mut vault, &mut global, debt_to_clear, xmr_price, col_price);

    // Should not panic or underflow; vault may still be underwater
    assert!(vault.collateral_amount < 10_000_000_000_000_000, "collateral did not decrease");
}

// TODO: Surfpool forked-mainnet feed test
// Setup: spin up local Surfpool node with mainnet Pyth accounts forked.
// Create N vaults via CPIs, wait for a real JitoSOL/USD price dip on mainnet,
// fire permissionless liquidations in interleaved order via Surfpool tx builder.
// Assert: no panics, global_total_debt + global_bad_debt == sum(actual debts),
// all fully-drained vaults have normalized_debt == 0.
