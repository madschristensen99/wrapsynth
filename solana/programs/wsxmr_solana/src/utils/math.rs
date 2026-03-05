use anchor_lang::prelude::*;
use crate::error::ErrorCode;
use crate::constants::{COLLATERAL_RATIO, LIQUIDATION_RATIO};

pub fn calculate_collateral_ratio(
    collateral_value_usd: u128,
    debt_value_usd: u128,
) -> Result<u16> {
    if debt_value_usd == 0 {
        return Ok(u16::MAX);
    }
    
    let ratio = collateral_value_usd
        .checked_mul(100)
        .ok_or(error!(ErrorCode::MathOverflow))?
        .checked_div(debt_value_usd)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    if ratio > u16::MAX as u128 {
        Ok(u16::MAX)
    } else {
        Ok(ratio as u16)
    }
}

pub fn check_vault_health(
    collateral_value_usd: u128,
    debt_value_usd: u128,
    min_ratio: u16,
) -> Result<bool> {
    let ratio = calculate_collateral_ratio(collateral_value_usd, debt_value_usd)?;
    Ok(ratio >= min_ratio)
}

pub fn calculate_required_collateral(
    debt_value_usd: u128,
    collateral_price_usd: u128,
    collateral_decimals: u8,
) -> Result<u64> {
    let required_value = debt_value_usd
        .checked_mul(COLLATERAL_RATIO as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?
        .checked_div(100)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    let required_collateral = required_value
        .checked_mul(10u128.pow(collateral_decimals as u32))
        .ok_or(error!(ErrorCode::MathOverflow))?
        .checked_div(collateral_price_usd)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    if required_collateral > u64::MAX as u128 {
        return Err(error!(ErrorCode::MathOverflow));
    }
    
    Ok(required_collateral as u64)
}

pub fn calculate_liquidation_collateral(
    debt_value_usd: u128,
    collateral_price_usd: u128,
    collateral_decimals: u8,
) -> Result<u64> {
    let liquidation_value = debt_value_usd
        .checked_mul(LIQUIDATION_RATIO as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?
        .checked_div(100)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    let liquidation_collateral = liquidation_value
        .checked_mul(10u128.pow(collateral_decimals as u32))
        .ok_or(error!(ErrorCode::MathOverflow))?
        .checked_div(collateral_price_usd)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    if liquidation_collateral > u64::MAX as u128 {
        return Err(error!(ErrorCode::MathOverflow));
    }
    
    Ok(liquidation_collateral as u64)
}

pub fn apply_bps_fee(amount: u64, fee_bps: u16) -> Result<u64> {
    let fee = (amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?
        .checked_div(10_000)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    Ok(fee as u64)
}
