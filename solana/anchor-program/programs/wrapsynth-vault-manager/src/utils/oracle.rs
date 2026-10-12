/// Oracle price fetching — reads Pyth PriceUpdateV2 accounts directly from raw bytes.
///
/// We avoid depending on pyth-solana-receiver-sdk as an anchor Account type to sidestep
/// anchor version conflicts. Instead we pass `&AccountInfo` and deserialize manually.
///
/// # DUAL-SOURCE ORACLE DESIGN: SOURCE-OF-TRUTH RULES
///
/// This module implements a two-source oracle design for sUSDe collateral:
///
/// 1. **Market Price (Pyth sUSDe/USD)** — THE SOLVENCY SOURCE OF TRUTH
///    - Used for: mint collateralization checks, burn health checks, liquidation thresholds,
///      yield buffer min-collateral USD calculations
///    - Function: `get_collateral_price(&pyth_account, max_age, &SUSDE_USD_FEED_ID)`
///    - Why: Reflects real market conditions including depegs. This is the price at which
///      the protocol can actually liquidate positions or realize collateral value.
///
/// 2. **Redemption Rate (Pyth sUSDe→USDe)** — YIELD ACCOUNTING ONLY
///    - Used for: yield principal/current-value accounting (tracking staking rewards)
///    - Function: `get_collateral_redemption_rate(&pyth_rr_account)`
///    - Why: Monotonically increasing (yield accrues), but CANNOT reflect depegs.
///      Using this for solvency would blind the protocol to tail risk scenarios where
///      sUSDe trades below its redemption value (liquidity crisis, smart contract risk, etc).
///
/// **CRITICAL**: Never use the redemption rate for any solvency/health calculation. The
/// redemption rate is purely for measuring yield (current_value - principal). All debt
/// safety checks MUST use the market price to protect against depeg scenarios.
///
/// # DEPEG GUARD
///
/// The dual-source design enables a depeg detection mechanism:
/// - Fair value = sUSDe→USDe redemption rate (≈ USD, since USDe is pegged 1:1)
/// - Market price = sUSDe/USD Pyth feed (actual trading price)
/// - If market < fair_value × (1 - DEPEG_TOLERANCE_BPS/10000), sUSDe is depegging
/// - Action: Pause new mints (no new debt against depegging asset), allow liquidations/burns
///
/// Note: using the redemption rate directly as fair value (instead of rate × USDe/USD)
/// errs toward triggering the guard if USDe itself depegs — the market price drops while
/// the rate stays near 1.0 — which is the conservative (safe) direction.
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

/// Read the sUSDe→USDe redemption rate from the Pyth SUSDE/USDE.RR feed.
///
/// Returns the rate in 18-decimal precision (USDe per sUSDe share). The rate
/// grows as Ethena staking rewards accrue — the yield-accounting analog of the
/// JitoSOL stake-pool exchange rate, but read from Pyth so no external CPI is
/// needed and the existing PriceUpdateV2 parsing is reused.
pub fn get_collateral_redemption_rate(price_account: &AccountInfo) -> Result<u64> {
    let parsed = parse_pyth_price(price_account)?;
    validate_price(&parsed, PRICE_MAX_AGE, &SUSDE_USDE_RR_FEED_ID)?;
    normalize_pyth_price(parsed.price, parsed.exponent)
}

/// Check for sUSDe depeg condition.
///
/// Compares the market sUSDe/USD price against the redemption rate (fair value,
/// ≈ USD since USDe is pegged 1:1). If the market price diverges below the fair
/// value by more than DEPEG_TOLERANCE_BPS, returns Err to signal a depeg.
///
/// **Depeg Logic**:
/// - Fair value = sUSDe→USDe redemption rate (18 decimals, ≈ $1)
/// - Threshold = fair_value × (10000 - DEPEG_TOLERANCE_BPS) / 10000
/// - If market_price < threshold, sUSDe is depegging
///
/// **Action on depeg**: Caller should pause new mints (no new debt against depegging asset)
/// while still allowing liquidations and burns at the market price.
///
/// # Arguments
/// * `susde_market_price` - sUSDe/USD from Pyth (18 decimals)
/// * `redemption_rate` - sUSDe→USDe from Pyth SUSDE/USDE.RR (18 decimals)
pub fn check_depeg_guard(
    susde_market_price: u64,
    redemption_rate: u64,
) -> Result<()> {
    // Fair value ≈ redemption rate (USDe is pegged 1:1 to USD)
    let fair_value = redemption_rate;

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
        susde_market_price >= threshold,
        WrapSynthError::CollateralDepegged
    );

    Ok(())
}
