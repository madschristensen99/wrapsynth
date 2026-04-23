/// Safe math helpers mirroring the Solidity contract's arithmetic.
/// All intermediate calculations use u128 to prevent overflow on u64 inputs.

use crate::constants::*;

/// Compute actual debt from normalized debt and current global debt index.
/// actual_debt = normalized_debt * global_debt_index / 1e18
pub fn get_actual_debt(normalized_debt: u64, global_debt_index: u64) -> u64 {
    ((normalized_debt as u128)
        .checked_mul(global_debt_index as u128)
        .unwrap_or(0)
        / DEBT_INDEX_PRECISION as u128) as u64
}

/// Ceiling division: normalized = ceil(actual * 1e18 / index)
/// Matches Solidity: (amount * 1e18 + index - 1) / index
pub fn normalize_debt(actual_amount: u64, global_debt_index: u64) -> u64 {
    let numerator = (actual_amount as u128)
        .checked_mul(DEBT_INDEX_PRECISION as u128)
        .unwrap_or(u128::MAX)
        .checked_add(global_debt_index as u128 - 1)
        .unwrap_or(u128::MAX);
    (numerator / global_debt_index as u128) as u64
}

/// Collateral value in USD (18 decimals).
/// collateral_amount (9-decimal shares) * collateral_price (18-decimal USD/share) / 1e18
pub fn collateral_to_usd(collateral_amount: u64, collateral_price: u64) -> u64 {
    ((collateral_amount as u128)
        .checked_mul(collateral_price as u128)
        .unwrap_or(0)
        / PRICE_PRECISION as u128) as u64
}

/// Convert USD value (18 decimals) to collateral shares.
pub fn usd_to_collateral(usd_value: u64, collateral_price: u64) -> u64 {
    if collateral_price == 0 {
        return 0;
    }
    ((usd_value as u128)
        .checked_mul(PRICE_PRECISION as u128)
        .unwrap_or(0)
        / collateral_price as u128) as u64
}

/// Collateral ratio = (collateral_usd * 100) / debt_usd.
/// Returns u64::MAX when debt is zero (infinite health).
pub fn calculate_collateral_ratio(collateral_usd: u64, debt_usd: u64) -> u64 {
    if debt_usd == 0 {
        return u64::MAX;
    }
    ((collateral_usd as u128)
        .checked_mul(RATIO_PRECISION as u128)
        .unwrap_or(0)
        / debt_usd as u128) as u64
}

/// USD value of debt at 150% collateral ratio (used for collateral locking checks).
/// debt_amount is in wsXMR (8 decimals), xmr_price is 18-decimal USD.
/// Returns USD value (18 decimals).
pub fn collateral_value_for_debt(debt_amount: u64, xmr_price: u64, ratio: u64) -> u64 {
    let debt_usd = (debt_amount as u128)
        .checked_mul(xmr_price as u128)
        .unwrap_or(0)
        / WSXMR_DECIMALS as u128;
    ((debt_usd.checked_mul(ratio as u128).unwrap_or(0)) / RATIO_PRECISION as u128) as u64
}

/// Full collateral ratio check combining prices.
pub fn check_collateral_ratio(
    collateral_amount: u64,
    collateral_price: u64,
    debt_amount: u64,
    xmr_price: u64,
    required_ratio: u64,
) -> bool {
    if debt_amount == 0 {
        return true;
    }
    let col_usd = collateral_to_usd(collateral_amount, collateral_price);
    let debt_usd = ((debt_amount as u128)
        .checked_mul(xmr_price as u128)
        .unwrap_or(0)
        / WSXMR_DECIMALS as u128) as u64;
    let ratio = calculate_collateral_ratio(col_usd, debt_usd);
    ratio >= required_ratio
}
