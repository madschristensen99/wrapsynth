/// Oracle price fetching — reads Pyth PriceUpdateV2 accounts directly from raw bytes.
///
/// We avoid depending on pyth-solana-receiver-sdk as an anchor Account type to sidestep
/// anchor version conflicts. Instead we pass `&AccountInfo` and deserialize manually.
///
/// Pyth PriceUpdateV2 on-chain layout (after 8-byte discriminator):
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
pub fn parse_pyth_price(account: &AccountInfo) -> Result<PythPrice> {
    let data = account.try_borrow_data()?;
    // Minimum length: 8 disc + 32 + 2 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8 = 134
    require!(data.len() >= 134, WrapSynthError::StalePrice);

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
