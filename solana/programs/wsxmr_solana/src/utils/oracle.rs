use anchor_lang::prelude::*;
use crate::error::ErrorCode;

// Placeholder for oracle integration - to be implemented with Pyth or Switchboard
pub fn get_price_from_pyth(
    _price_update: &AccountInfo,
    _feed_id_hex: &str,
    _max_age: u64,
    _clock: &Clock,
) -> Result<(i64, i32)> {
    // TODO: Implement actual Pyth oracle integration
    // For now, return mock price: $150 with -8 exponent (150 * 10^8 = 15000000000)
    Ok((15000000000, -8))
}

pub fn calculate_usd_value(
    amount: u64,
    price: i64,
    exponent: i32,
    decimals: u8,
) -> Result<u128> {
    let amount_u128 = amount as u128;
    let price_abs = price.abs() as u128;
    
    let value = amount_u128
        .checked_mul(price_abs)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    let adjusted_value = if exponent < 0 {
        value.checked_div(10u128.pow((-exponent) as u32))
            .ok_or(error!(ErrorCode::MathOverflow))?
    } else {
        value.checked_mul(10u128.pow(exponent as u32))
            .ok_or(error!(ErrorCode::MathOverflow))?
    };
    
    let final_value = adjusted_value
        .checked_div(10u128.pow(decimals as u32))
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    Ok(final_value)
}
