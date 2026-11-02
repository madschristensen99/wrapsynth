/// Safe math helpers — oracle-free, threshold-relative accounting.
/// All intermediate calculations use u128 to prevent overflow on u64 inputs.
///
/// Threshold semantics (EVM wsXmrStorage parity):
///   threshold = lamports of collateral per 1e8 wsXMR (u128, LP-declared)
///   par(wsxmr) = wsxmr * threshold / WSXMR_DECIMALS  → lamports
use crate::constants::*;
use crate::state::Vault;

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

/// Par settlement amount in lamports: collateral owed per wsXMR at the given
/// declared threshold (lamports-per-1e8-wsXMR).
/// EVM _parCollateral parity.
pub fn par_lamports(wsxmr_amount: u64, threshold: u128) -> u64 {
    ((wsxmr_amount as u128)
        .checked_mul(threshold)
        .unwrap_or(0)
        / WSXMR_DECIMALS as u128) as u64
}

/// Lamports of collateral the vault must hold against wsXMR debt at its own
/// declared threshold. EVM _requiredCollateral parity.
pub fn required_lamports(wsxmr_debt: u64, threshold: u128) -> u64 {
    par_lamports(wsxmr_debt, threshold)
}

/// Par-value lock for mint key bonds and the set_mint_ready par lock:
/// par collateral at the declared threshold × MINT_LOCK_RATIO (110%).
/// EVM _parLockFor parity.
pub fn par_lock_for(wsxmr_amount: u64, threshold: u128) -> u64 {
    ((wsxmr_amount as u128)
        .checked_mul(threshold)
        .unwrap_or(0)
        .checked_mul(MINT_LOCK_RATIO as u128)
        .unwrap_or(0)
        / WSXMR_DECIMALS as u128
        / RATIO_PRECISION as u128) as u64
}

/// Free (seizable / mint-eligible) collateral: total minus locked.
/// Key bonds and burn locks never count as free. EVM _freeCollateral parity.
pub fn free_collateral(v: &Vault) -> u64 {
    v.collateral_amount.saturating_sub(v.locked_collateral)
}

/// INFORMATIONAL ONLY — self-declared coverage:
///   free_collateral / (debt × threshold) × RATIO_PRECISION.
/// 100+ = vault covers debt at its own declared threshold. Not a solvency
/// oracle — the LP sets the threshold. EVM getVaultHealth parity.
pub fn coverage_ratio(free: u64, debt: u64, threshold: u128) -> u64 {
    let required = required_lamports(debt, threshold);
    if required == 0 {
        return u64::MAX;
    }
    ((free as u128)
        .checked_mul(RATIO_PRECISION as u128)
        .unwrap_or(0)
        / required as u128) as u64
}

/// Threshold-derived mint capacity, quote-capped — EVM getMintCapacity parity.
/// Mirrors the bond-reserved coverage check in initiate_mint:
///   free·1e8 >= T·(D0 + pending + x) + MINT_LOCK_RATIO·x·T/100
///   x <= (free·1e8 − T·(D0+pending))·100 / (T·(100 + MINT_LOCK_RATIO))
pub fn mint_capacity(v: &Vault, global_debt_index: u64) -> u64 {
    if !v.active {
        return 0;
    }
    let threshold = v.threshold_lamports_per_wsxmr;
    if threshold < MIN_THRESHOLD_LAMPORTS {
        return 0;
    }
    let free = free_collateral(v);
    if free == 0 {
        return 0;
    }
    let actual_debt = get_actual_debt(v.normalized_debt, global_debt_index);
    let headroom = (free as u128).checked_mul(WSXMR_DECIMALS as u128).unwrap_or(0);
    let committed = threshold
        .checked_mul((actual_debt as u128).checked_add(v.pending_debt as u128).unwrap_or(0))
        .unwrap_or(u128::MAX);
    if headroom <= committed {
        return 0;
    }
    let capacity = ((headroom - committed)
        .checked_mul(RATIO_PRECISION as u128)
        .unwrap_or(0))
        / (threshold * (RATIO_PRECISION as u128 + MINT_LOCK_RATIO as u128));
    let mut cap = capacity.min(u64::MAX as u128) as u64;
    if v.max_mint_wsxmr > 0 && cap > v.max_mint_wsxmr {
        cap = v.max_mint_wsxmr;
    }
    cap
}
