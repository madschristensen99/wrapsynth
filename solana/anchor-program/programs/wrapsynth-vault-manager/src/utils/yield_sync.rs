/// Yield synchronization logic — port of _syncVaultYield and YieldLogic.sol.
///
/// On Solana there is no sDAI `convertToAssets()`. The caller must pass the
/// current exchange rate (collateral_value_per_share: how many USD-equivalent
/// units one collateral share is worth, in 18-decimal precision) alongside the
/// principal that was deposited. This rate is read from the lending protocol's
/// pool state account by the instruction handler before calling sync_vault_yield.

use crate::constants::*;
use crate::utils::math::*;

pub const YIELD_DUST_THRESHOLD: u64 = 100;
/// Buffer ratio for yield extraction: must maintain 155% after harvest
pub const YIELD_BUFFER_RATIO: u64 = 155;

/// Calculates how many collateral shares can be extracted as yield.
///
/// Parameters (all denominated consistently):
///   collateral_amount      – vault's liquid collateral shares
///   locked_collateral      – shares locked in pending burns
///   principal_shares       – original deposit shares (basis for yield detection)
///   actual_debt            – current actual debt (wsXMR, 8 decimals)
///   pending_debt           – reserved debt capacity (wsXMR, 8 decimals)
///   xmr_price              – XMR/USD 18-decimal
///   collateral_price       – collateral/USD 18-decimal
///
/// Returns the number of shares that can safely be moved to yield_war_chest.
pub fn calculate_extractable_yield(
    collateral_amount: u64,
    locked_collateral: u64,
    principal_shares: u64,
    actual_debt: u64,
    pending_debt: u64,
    xmr_price: u64,
    collateral_price: u64,
) -> u64 {
    if collateral_amount == 0 || principal_shares == 0 {
        return 0;
    }

    // Yield is detected when current shares > original principal shares.
    // This mirrors the sDAI `convertToAssets` comparison in YieldLogic.sol:
    //   totalDaiValue = collateralAmount * rate / 1e18
    //   if totalDaiValue <= principalDeposits → no yield
    // Here we work directly in shares: collateral_amount vs principal_shares.
    if collateral_amount <= principal_shares {
        return 0;
    }

    let mut yield_shares = collateral_amount - principal_shares;

    if yield_shares < YIELD_DUST_THRESHOLD || yield_shares > collateral_amount {
        return 0;
    }

    let total_obligations = actual_debt.saturating_add(pending_debt);

    if total_obligations > 0 {
        // Minimum collateral needed = debt_usd * 155% / collateral_price
        // (155% buffer — slightly above COLLATERAL_RATIO=150% to give headroom)
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
