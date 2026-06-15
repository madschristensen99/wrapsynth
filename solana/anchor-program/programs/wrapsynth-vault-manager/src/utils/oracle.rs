/// Oracle price fetching — reads Pyth PriceUpdateV2 accounts directly from raw bytes.
///
/// We avoid depending on pyth-solana-receiver-sdk as an anchor Account type to sidestep
/// anchor version conflicts. Instead we pass `&AccountInfo` and deserialize manually.
///
/// # DUAL-SOURCE ORACLE DESIGN: SOURCE-OF-TRUTH RULES
///
/// This module implements a two-source oracle design for JitoSOL collateral:
///
/// 1. **Market Price (Pyth JitoSOL/USD)** — THE SOLVENCY SOURCE OF TRUTH
///    - Used for: mint collateralization checks, burn health checks, liquidation thresholds,
///      yield buffer min-collateral USD calculations
///    - Function: `get_collateral_price(&pyth_account, max_age, &JITOSOL_USD_FEED_ID)`
///    - Why: Reflects real market conditions including depegs. This is the price at which
///      the protocol can actually liquidate positions or realize collateral value.
///
/// 2. **Stake Pool Rate (JitoSOL→SOL exchange rate)** — YIELD ACCOUNTING ONLY
///    - Used for: yield principal/current-value accounting (tracking staking rewards)
///    - Function: `get_jitosol_exchange_rate(&stake_pool_account)`
///    - Why: Monotonically increasing (staking rewards accrue), but CANNOT reflect depegs.
///      Using this for solvency would blind the protocol to tail risk scenarios where
///      JitoSOL trades below its redemption value (liquidity crisis, smart contract risk, etc).
///
/// **CRITICAL**: Never use the stake pool rate for any solvency/health calculation. The
/// stake pool rate is purely for measuring yield (current_value - principal). All debt
/// safety checks MUST use the market price to protect against depeg scenarios.
///
/// # DEPEG GUARD
///
/// The dual-source design enables a depeg detection mechanism:
/// - Fair value = stake_pool_rate × SOL/USD (theoretical redemption value)
/// - Market price = JitoSOL/USD Pyth feed (actual trading price)
/// - If market < fair_value × (1 - DEPEG_TOLERANCE_BPS/10000), JitoSOL is depegging
/// - Action: Pause new mints (no new debt against depegging asset), allow liquidations/burns
///
/// # PYTH PRICEUPDATE V2 ON-CHAIN LAYOUT
///
/// Layout after 8-byte discriminator [0xc8, 0x8c, 0x29, 0x47, 0x6e, 0x23, 0x15, 0x1c]:
///   write_authority: [u8; 32]         = bytes 8..40
///   verification_level: u8 + padding  = bytes 40..42 (enum variant)
///   price_message: PriceFeedMessage
///     feed_id:    [u8; 32]            = bytes 42..74
///     price:      i64                 = bytes 74..82
///     conf:       u64                 = bytes 82..90
///     exponent:   i32                 = bytes 90..94
///     publish_time: i64               = bytes 94..102
///     prev_publish_time: i64          = bytes 102..110
///     ema_price:  i64                 = bytes 110..118
///     ema_conf:   u64                 = bytes 118..126
///   posted_slot: u64                  = bytes 126..134
///
/// This layout is pinned to pyth-solana-receiver-sdk v0.2.x. If the SDK version changes,
/// verify the discriminator and layout against live mainnet feeds via Hermes API.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::WrapSynthError;

/// Parsed Pyth price data extracted from a PriceUpdateV2 account.
pub struct PythPrice {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
    pub ema_price: i64,
}

/// Parse a PriceUpdateV2 AccountInfo into a PythPrice struct.
///
/// Validates the account discriminator to ensure we're reading the correct account type.
/// The discriminator [0xc8, 0x8c, 0x29, 0x47, 0x6e, 0x23, 0x15, 0x1c] is the first 8 bytes
/// of sha256("account:PriceUpdateV2") from pyth-solana-receiver-sdk.
pub fn parse_pyth_price(account: &AccountInfo) -> Result<PythPrice> {
    let data = account.try_borrow_data()?;
    // Minimum length: 8 disc + 32 + 2 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8 = 134
    require!(data.len() >= 134, WrapSynthError::StalePrice);

    // Verify PriceUpdateV2 discriminator (first 8 bytes)
    const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [0xc8, 0x8c, 0x29, 0x47, 0x6e, 0x23, 0x15, 0x1c];
    require!(
        data[0..8] == PRICE_UPDATE_V2_DISCRIMINATOR,
        WrapSynthError::StalePrice
    );

    // Skip 8-byte discriminator
    // Skip 32-byte write_authority
    // Skip 2-byte verification_level (enum u8 + 1 padding byte)
    let offset = 8 + 32 + 2;

    let feed_id: [u8; 32] = data[offset..offset + 32].try_into().unwrap();
    let price = i64::from_le_bytes(data[offset + 32..offset + 40].try_into().unwrap());
    let conf = u64::from_le_bytes(data[offset + 40..offset + 48].try_into().unwrap());
    let exponent = i32::from_le_bytes(data[offset + 48..offset + 52].try_into().unwrap());
    let publish_time = i64::from_le_bytes(data[offset + 52..offset + 60].try_into().unwrap());
    // prev_publish_time at offset+60..+68, skip it
    let ema_price = i64::from_le_bytes(data[offset + 68..offset + 76].try_into().unwrap());

    Ok(PythPrice { feed_id, price, conf, exponent, publish_time, ema_price })
}

/// Normalize a Pyth price (with exponent) to 18-decimal USD precision.
/// Mirrors EVM VaultManager normalization exactly.
fn normalize_pyth_price(price: i64, exponent: i32) -> Result<u64> {
    if price <= 0 {
        return err!(WrapSynthError::StalePrice);
    }
    let p = price as u64;
    let normalized: u64 = if exponent >= 0 {
        p.checked_mul(10u64.pow(exponent as u32))
            .ok_or(WrapSynthError::MathOverflow)?
            .checked_mul(1_000_000_000_000_000_000u64)
            .ok_or(WrapSynthError::MathOverflow)?
    } else {
        let abs_exp = (-exponent) as u32;
        if abs_exp >= 18 {
            p / 10u64.pow(abs_exp - 18)
        } else {
            p.checked_mul(10u64.pow(18 - abs_exp))
                .ok_or(WrapSynthError::MathOverflow)?
        }
    };
    require!(normalized > 0, WrapSynthError::PriceNormalizedToZero);
    Ok(normalized)
}

/// Validate price freshness and confidence.
fn validate_price(parsed: &PythPrice, max_age_secs: u64, expected_feed: &[u8; 32]) -> Result<()> {
    require!(parsed.feed_id == *expected_feed, WrapSynthError::StalePrice);
    let clock = Clock::get()?;
    let age = clock.unix_timestamp.saturating_sub(parsed.publish_time);
    require!(age >= 0 && (age as u64) <= max_age_secs, WrapSynthError::StalePrice);
    // Confidence check: conf * 10 <= price
    require!(
        parsed.conf.saturating_mul(10) <= parsed.price as u64,
        WrapSynthError::StalePrice
    );
    Ok(())
}

/// Fetch XMR/USD spot price, normalized to 18 decimals.
pub fn get_xmr_price(price_account: &AccountInfo, max_age_secs: u64) -> Result<u64> {
    let parsed = parse_pyth_price(price_account)?;
    validate_price(&parsed, max_age_secs, &XMR_USD_FEED_ID)?;
    normalize_pyth_price(parsed.price, parsed.exponent)
}

/// Fetch XMR EMA price, normalized to 18 decimals.
///
/// **EMA DIVERGENCE NOTE**: This function reads Pyth's published EMA price directly from
/// the price feed message, NOT a locally-maintained EMA accumulator. This differs from the
/// EVM VaultManager's `xmrEmaPrice` which maintains a 10-period EMA with alpha=182/1000.
///
/// Pyth's EMA uses their own smoothing window (typically confidence-weighted), so the
/// buy-and-burn trigger condition (spot <= ema * 99/100) keys off Pyth's EMA semantics,
/// not the EVM's 10-period moving average. This behavioral difference is acceptable for
/// Solana deployment but should be reviewed if cross-chain EMA consistency is required.
pub fn get_xmr_ema_price(price_account: &AccountInfo, max_age_secs: u64) -> Result<u64> {
    let parsed = parse_pyth_price(price_account)?;
    // Freshness validated via spot price publish_time (same message)
    let clock = Clock::get()?;
    let age = clock.unix_timestamp.saturating_sub(parsed.publish_time);
    require!(age >= 0 && (age as u64) <= max_age_secs, WrapSynthError::StalePrice);
    require!(parsed.feed_id == XMR_USD_FEED_ID, WrapSynthError::StalePrice);
    normalize_pyth_price(parsed.ema_price, parsed.exponent)
}

/// Fetch collateral/USD price, normalized to 18 decimals.
pub fn get_collateral_price(
    price_account: &AccountInfo,
    max_age_secs: u64,
    feed_id: &[u8; 32],
) -> Result<u64> {
    let parsed = parse_pyth_price(price_account)?;
    validate_price(&parsed, max_age_secs, feed_id)?;
    normalize_pyth_price(parsed.price, parsed.exponent)
}

/// Read JitoSOL→SOL exchange rate from the SPL stake pool account.
///
/// Returns the exchange rate as: (total_lamports * 1e18) / pool_token_supply
/// This gives SOL per JitoSOL share in 18-decimal precision.
///
/// Uses spl-stake-pool crate for safe deserialization to avoid layout fragility.
pub fn get_jitosol_exchange_rate(stake_pool_account: &AccountInfo) -> Result<u64> {
    use spl_stake_pool::state::StakePool;
    
    let data = stake_pool_account.try_borrow_data()?;
    
    // Deserialize using spl-stake-pool's official struct
    let stake_pool = StakePool::try_from_slice(&data)
        .map_err(|_| WrapSynthError::StalePrice)?;
    
    let total_lamports = stake_pool.total_lamports;
    let pool_token_supply = stake_pool.pool_token_supply;
    
    require!(pool_token_supply > 0, WrapSynthError::PriceNormalizedToZero);
    
    // Exchange rate = (total_lamports * 1e18) / pool_token_supply
    // Both total_lamports and pool_token_supply are in lamports (9 decimals)
    let rate = (total_lamports as u128)
        .checked_mul(PRICE_PRECISION as u128)
        .ok_or(WrapSynthError::MathOverflow)?
        .checked_div(pool_token_supply as u128)
        .ok_or(WrapSynthError::MathOverflow)?;
    
    require!(rate > 0 && rate <= u64::MAX as u128, WrapSynthError::PriceNormalizedToZero);
    Ok(rate as u64)
}

/// Check for JitoSOL depeg condition.
///
/// Compares the market JitoSOL/USD price against the theoretical fair value computed from
/// the stake pool exchange rate and SOL/USD price. If the market price diverges below the
/// fair value by more than DEPEG_TOLERANCE_BPS, returns Err to signal a depeg.
///
/// **Depeg Logic**:
/// - Fair value = (jitosol_exchange_rate × sol_usd_price) / 1e18
/// - Threshold = fair_value × (10000 - DEPEG_TOLERANCE_BPS) / 10000
/// - If market_price < threshold, JitoSOL is depegging
///
/// **Action on depeg**: Caller should pause new mints (no new debt against depegging asset)
/// while still allowing liquidations and burns at the market price.
///
/// # Arguments
/// * `jitosol_market_price` - JitoSOL/USD from Pyth (18 decimals)
/// * `jitosol_exchange_rate` - JitoSOL→SOL from stake pool (18 decimals, SOL per JitoSOL)
/// * `sol_usd_price` - SOL/USD from Pyth (18 decimals)
pub fn check_depeg_guard(
    jitosol_market_price: u64,
    jitosol_exchange_rate: u64,
    sol_usd_price: u64,
) -> Result<()> {
    // Fair value = exchange_rate × sol_price / 1e18
    let fair_value = (jitosol_exchange_rate as u128)
        .checked_mul(sol_usd_price as u128)
        .ok_or(WrapSynthError::MathOverflow)?
        .checked_div(PRICE_PRECISION as u128)
        .ok_or(WrapSynthError::MathOverflow)?;
    
    require!(fair_value <= u64::MAX as u128, WrapSynthError::MathOverflow);
    let fair_value = fair_value as u64;
    
    // Threshold = fair_value × (10000 - tolerance_bps) / 10000
    let threshold = (fair_value as u128)
        .checked_mul((BPS_DENOMINATOR - DEPEG_TOLERANCE_BPS) as u128)
        .ok_or(WrapSynthError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(WrapSynthError::MathOverflow)?;
    
    require!(threshold <= u64::MAX as u128, WrapSynthError::MathOverflow);
    let threshold = threshold as u64;
    
    // If market price < threshold, depeg detected
    require!(
        jitosol_market_price >= threshold,
        WrapSynthError::CollateralDepegged
    );
    
    Ok(())
}
