/// Oracle price fetching — reads Pyth PriceUpdateV2 accounts directly from raw bytes.
///
/// We avoid depending on pyth-solana-receiver-sdk as an anchor Account type to sidestep
/// anchor version conflicts. Instead we pass `&AccountInfo` and deserialize manually.
///
/// # DUAL-SOURCE ORACLE DESIGN: SOURCE-OF-TRUTH RULES
///
/// This module implements a two-source oracle design for QQQx collateral:
///
/// 1. **Market Price (Pyth Crypto.QQQX/USD)** — THE SOLVENCY SOURCE OF TRUTH
///    - Used for: mint collateralization checks, burn health checks, liquidation
///      thresholds, co-LP sizing
///    - Function: `get_collateral_price(&pyth_account, max_age, &QQQX_USD_FEED_ID)`
///    - Why: Reflects real market conditions 24/7 (crypto-class feed, no market
///      hours). This is the price at which the protocol can actually realize
///      collateral value, including issuer/distress discounts.
///
/// 2. **Fair Value (Pyth QQQX/USD EMA)** — DISCOUNT GUARD ONLY
///    - Used for: mint-time discount guard (QQQx trading sharply below its own
///      EMA signals issuer/custody distress or a market break)
///    - Function: `get_collateral_ema_price(&pyth_collateral_account)`
///    - Why: Pyth's EMA is published inside the same QQQX/USD message, so no
///      second feed account is needed. It is a robust smoothed fair-value
///      proxy and — unlike an underlying-QQQ feed — it already reflects the
///      Token-2022 scaledUiAmount multiplier (dividends/splits).
///
/// **CRITICAL**: Never use the EMA for any solvency/health calculation. It is
/// purely a fair-value reference for the discount guard. All debt safety
/// checks MUST use the market spot price.
///
/// # DISCOUNT GUARD
///
/// - Fair value = QQQX/USD EMA (24/7, multiplier-aware)
/// - Threshold = EMA × (10000 - DEPEG_TOLERANCE_BPS) / 10000
/// - If spot < threshold → acute discount → pause new mints
///   (liquidations/burns still settle at market spot)
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

    Ok(PythPrice {
        feed_id,
        price,
        conf,
        exponent,
        publish_time,
        ema_price,
    })
}

/// Normalize a Pyth price (with exponent) to 18-decimal USD precision.
/// Mirrors EVM VaultManager normalization exactly.
fn normalize_pyth_price(price: i64, exponent: i32) -> Result<u128> {
    if price <= 0 {
        return err!(WrapSynthError::StalePrice);
    }
    let p = price as u128;
    let normalized: u128 = if exponent >= 0 {
        p.checked_mul(10u128.pow(exponent as u32))
            .ok_or(WrapSynthError::MathOverflow)?
            .checked_mul(1_000_000_000_000_000_000u128)
            .ok_or(WrapSynthError::MathOverflow)?
    } else {
        let abs_exp = (-exponent) as u32;
        if abs_exp >= 18 {
            p / 10u128.pow(abs_exp - 18)
        } else {
            p.checked_mul(10u128.pow(18 - abs_exp))
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
    require!(
        age >= 0 && (age as u64) <= max_age_secs,
        WrapSynthError::StalePrice
    );
    // Confidence check: conf * 10 <= price
    require!(
        parsed.conf.saturating_mul(10) <= parsed.price as u64,
        WrapSynthError::StalePrice
    );
    Ok(())
}

/// Fetch XMR/USD spot price, normalized to 18 decimals.
pub fn get_xmr_price(price_account: &AccountInfo, max_age_secs: u64) -> Result<u128> {
    let parsed = parse_pyth_price(price_account)?;
    validate_price(&parsed, max_age_secs, &XMR_USD_FEED_ID)?;
    normalize_pyth_price(parsed.price, parsed.exponent)
}

/// Fetch QQQx collateral/USD price, normalized to 18 decimals.
pub fn get_collateral_price(
    price_account: &AccountInfo,
    max_age_secs: u64,
    feed_id: &[u8; 32],
) -> Result<u128> {
    let parsed = parse_pyth_price(price_account)?;
    validate_price(&parsed, max_age_secs, feed_id)?;
    normalize_pyth_price(parsed.price, parsed.exponent)
}

/// Fetch the QQQx EMA price from the same QQQX/USD message.
///
/// Used as the fair-value reference for the discount guard: Pyth's EMA is a
/// 24/7 available smoothed price that captures the scaledUiAmount fair value
/// without depending on the slower QQQX/QQQ.RR redemption-rate feed.
pub fn get_collateral_ema_price(price_account: &AccountInfo, max_age_secs: u64) -> Result<u128> {
    let parsed = parse_pyth_price(price_account)?;
    validate_price(&parsed, max_age_secs, &QQQX_USD_FEED_ID)?;
    normalize_pyth_price(parsed.ema_price, parsed.exponent)
}

/// Check for QQQx market discount (distress) condition.
///
/// Compares the market QQQX/USD spot price against its own EMA (fair-value
/// proxy). If spot trades more than DEPEG_TOLERANCE_BPS below the EMA, QQQx is
/// under acute discount pressure — likely issuer/custody distress — and new
/// mints must pause. Liquidations and burns stay permissionless (they use the
/// market price regardless).
///
/// # Arguments
/// * `qqqx_market_price` - QQQX/USD spot from Pyth (18 decimals)
/// * `qqqx_ema_price` - QQQX/USD EMA from Pyth (18 decimals)
pub fn check_discount_guard(qqqx_market_price: u128, qqqx_ema_price: u128) -> Result<()> {
    let threshold = qqqx_ema_price
        .checked_mul((BPS_DENOMINATOR - DEPEG_TOLERANCE_BPS) as u128)
        .ok_or(WrapSynthError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(WrapSynthError::MathOverflow)?;

    // If market spot < threshold, distress discount detected
    require!(
        qqqx_market_price >= threshold,
        WrapSynthError::CollateralDepegged
    );

    Ok(())
}
