/// Yield synchronization logic for sUSDe (value-accruing yield-bearing stablecoin).
///
/// sUSDe accrues value via a rising redemption rate (sUSDe→USDe), tracked by the
/// Pyth SUSDE/USDE.RR feed. We track principal in USDe-value terms at deposit,
/// then harvest yield when (shares × current_rate) > principal_value.
///
/// Yield buffer = CR + 10 (190%) post-harvest to give headroom for volatile collateral.

use crate::constants::*;
use crate::utils::math::*;

pub const YIELD_DUST_THRESHOLD: u64 = 100_000_000; // 0.1 USDe in 9-decimal units

// YIELD_BUFFER_RATIO is defined in crate::constants (CR + 10 headroom).
// It is imported here via `use crate::constants::*` in the consuming modules.

/// Calculates how many sUSDe shares can be extracted as yield.
///
/// Parameters:
///   collateral_amount      – vault's liquid sUSDe shares (9 decimals)
///   locked_collateral      – sUSDe shares locked in pending burns
///   principal_value        – original deposit value in USDe terms (9 decimals)
///   redemption_rate        – current sUSDe→USDe rate (18-decimal: USDe per share)
///   actual_debt            – current actual debt (wsXMR, 8 decimals)
///   pending_debt           – reserved debt capacity (wsXMR, 8 decimals)
///   xmr_price              – XMR/USD 18-decimal
///   collateral_price       – sUSDe/USD 18-decimal (market price for solvency)
///
/// Returns the number of sUSDe shares that can safely be moved to yield_war_chest.
pub fn calculate_extractable_yield(
    collateral_amount: u64,
    locked_collateral: u64,
    principal_value: u64,
    redemption_rate: u64,
    actual_debt: u64,
    pending_debt: u64,
    xmr_price: u64,
    collateral_price: u64,
) -> u64 {
    if collateral_amount == 0 || principal_value == 0 {
        return 0;
    }

    // Current value = collateral_amount * redemption_rate / 1e18
    // (collateral_amount is in 9-decimal sUSDe shares, rate is 18-decimal)
    let current_value = ((collateral_amount as u128)
        .saturating_mul(redemption_rate as u128)
        / PRICE_PRECISION as u128) as u64;

    // Yield exists when current value > principal value
    if current_value <= principal_value {
        return 0;
    }

    // Yield in USDe terms
    let yield_value = current_value - principal_value;

    // Dust check on value (not share count)
    if yield_value < YIELD_DUST_THRESHOLD {
        return 0;
    }

    // Convert yield back to sUSDe shares: yield_shares = yield_value * 1e18 / rate
    let mut yield_shares = ((yield_value as u128)
        .saturating_mul(PRICE_PRECISION as u128)
        / redemption_rate as u128) as u64;

    if yield_shares == 0 || yield_shares > collateral_amount {
        return 0;
    }

    let total_obligations = actual_debt.saturating_add(pending_debt);

    if total_obligations > 0 {
        // Minimum collateral needed = debt_usd * YIELD_BUFFER_RATIO / 100
        // (YIELD_BUFFER_RATIO = CR + 10, currently 190%)
        let debt_usd = ((total_obligations as u128)
            .saturating_mul(xmr_price as u128)
            / WSXMR_DECIMALS as u128) as u64;
        let min_col_usd = (debt_usd as u128)
            .saturating_mul(YIELD_BUFFER_RATIO as u128)
            / RATIO_PRECISION as u128;
        let min_col_shares = usd_to_collateral(min_col_usd as u64, collateral_price)
            .saturating_add(locked_collateral);

        if collateral_amount <= min_col_shares {
            return 0;
        }

        let max_extractable = collateral_amount - min_col_shares;
        if yield_shares > max_extractable {
            yield_shares = max_extractable;
        }
    }

    yield_shares
}
