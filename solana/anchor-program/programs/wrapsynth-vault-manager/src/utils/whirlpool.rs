/// Orca Whirlpools integration — hand-rolled CPI (no whirlpool crate dependency).
///
/// The `orca_whirlpools_client` crate pulls solana-program 2.x/3.x which conflicts
/// with anchor 0.30.1's solana-program 1.18.26, so the CPI instructions and account
/// layouts are built manually — the same approach as `oracle.rs` for Pyth.
///
/// # LAYOUT VERIFICATION (mainnet whirlpool program v2.5.x)
///
/// Whirlpool account (verified against the `swaps` crate live-swap offsets):
///   tick_spacing:        u16   @ 41
///   liquidity:           u128  @ 49
///   sqrt_price:          u128  @ 65
///   tick_current_index:  i32   @ 81
///   token_mint_a:        Pubkey @ 101
///   token_vault_a:       Pubkey @ 133
///   token_mint_b:        Pubkey @ 181
///   token_vault_b:       Pubkey @ 213
///
/// Position account (orca-so/whirlpools `state/position.rs`):
///   whirlpool:           Pubkey @ 8
///   position_mint:       Pubkey @ 40
///   liquidity:           u128   @ 72
///   tick_lower_index:    i32    @ 88
///   tick_upper_index:    i32    @ 92
///   fee_owed_a:          u64    @ 116
///   fee_owed_b:          u64    @ 140
///
/// Instruction discriminators are sha256("global:<ix>")[0..8] (Anchor program).
/// The v2 token-extension instruction set is required because wsXMR is a
/// Token-2022 mint (mixed-token-program pools).
///
/// NOTE: CPI account layouts must be re-verified against the live program before
/// mainnet deployment — they cannot be unit-tested without the target program.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::pubkey::Pubkey;

use crate::constants::*;
use crate::errors::WrapSynthError;

/// Orca Whirlpools mainnet program ID
pub fn whirlpool_program_id() -> Pubkey {
    ORCA_WHIRLPOOLS_PROGRAM_ID.parse().unwrap()
}

/// Anchor instruction discriminator: sha256("global:<name>")[0..8]
fn discriminator(name: &str) -> [u8; 8] {
    let hash = anchor_lang::solana_program::hash::hash(format!("global:{}", name).as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&hash.to_bytes()[..8]);
    out
}

// ─── Whirlpool account reader ────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub struct WhirlpoolData {
    pub tick_spacing: u16,
    pub liquidity: u128,
    pub sqrt_price: u128,
    pub tick_current_index: i32,
    pub token_mint_a: Pubkey,
    pub token_vault_a: Pubkey,
    pub token_mint_b: Pubkey,
    pub token_vault_b: Pubkey,
}

pub fn read_whirlpool(account: &AccountInfo) -> Result<WhirlpoolData> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 245, WrapSynthError::StalePrice);

    let tick_spacing = u16::from_le_bytes(data[41..43].try_into().unwrap());
    let liquidity = u128::from_le_bytes(data[49..65].try_into().unwrap());
    let sqrt_price = u128::from_le_bytes(data[65..81].try_into().unwrap());
    let tick_current_index = i32::from_le_bytes(data[81..85].try_into().unwrap());
    let token_mint_a = Pubkey::new_from_array(data[101..133].try_into().unwrap());
    let token_vault_a = Pubkey::new_from_array(data[133..165].try_into().unwrap());
    let token_mint_b = Pubkey::new_from_array(data[181..213].try_into().unwrap());
    let token_vault_b = Pubkey::new_from_array(data[213..245].try_into().unwrap());

    Ok(WhirlpoolData {
        tick_spacing,
        liquidity,
        sqrt_price,
        tick_current_index,
        token_mint_a,
        token_vault_a,
        token_mint_b,
        token_vault_b,
    })
}

// ─── Position account reader ─────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub struct PositionData {
    pub liquidity: u128,
    pub tick_lower_index: i32,
    pub tick_upper_index: i32,
    pub fee_owed_a: u64,
    pub fee_owed_b: u64,
}

pub fn read_position(account: &AccountInfo) -> Result<PositionData> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 148, WrapSynthError::InvalidValue);

    let liquidity = u128::from_le_bytes(data[72..88].try_into().unwrap());
    let tick_lower_index = i32::from_le_bytes(data[88..92].try_into().unwrap());
    let tick_upper_index = i32::from_le_bytes(data[92..96].try_into().unwrap());
    let fee_owed_a = u64::from_le_bytes(data[116..124].try_into().unwrap());
    let fee_owed_b = u64::from_le_bytes(data[140..148].try_into().unwrap());

    Ok(PositionData {
        liquidity,
        tick_lower_index,
        tick_upper_index,
        fee_owed_a,
        fee_owed_b,
    })
}

// ─── Tick math ───────────────────────────────────────────────────────────────

/// Convert a Q64.64 sqrt price to a tick index (f64 approximation — sufficient
/// for computing a range around the current price; Orca uses a lookup table for
/// exactness, but range placement tolerates sub-tick error).
pub fn tick_from_sqrt_price(sqrt_price_x64: u128) -> i32 {
    if sqrt_price_x64 == 0 {
        return 0;
    }
    let price = (sqrt_price_x64 as f64) / 18446744073709551616.0; // / 2^64
    let tick = (price * price).ln() / 1.0001f64.ln();
    tick.floor() as i32
}

/// Compute the lower/upper ticks for a range of `range_bps` (e.g. 2500 = ±12.5%)
/// centered on the current tick.
pub fn compute_range_ticks(
    current_tick: i32,
    range_bps: u16,
    tick_spacing: u16,
) -> (i32, i32) {
    let half_range = (range_bps as f64) / 20000.0; // 2500 bps → ±12.5%
    let price = 1.0001f64.powi(current_tick);
    let lower_price = price * (1.0 - half_range);
    let upper_price = price * (1.0 + half_range);
    let lower_tick = (lower_price.ln() / 1.0001f64.ln()).floor() as i32;
    let upper_tick = (upper_price.ln() / 1.0001f64.ln()).ceil() as i32;

    // Align to tick spacing
    let spacing = tick_spacing as i32;
    let lower = (lower_tick / spacing) * spacing;
    let upper = ((upper_tick + spacing - 1) / spacing) * spacing;
    (lower, upper)
}

/// Start index of the tick array containing `tick` (for PDA derivation).
pub fn tick_array_start_index(tick: i32, tick_spacing: u16) -> i32 {
    let spacing = tick_spacing as i32;
    let ticks_in_array = 88 * spacing;
    let start = (tick / ticks_in_array) * ticks_in_array;
    if tick < 0 && tick % ticks_in_array != 0 {
        start - ticks_in_array
    } else {
        start
    }
}

/// Derive the Orca tick-array PDA for a whirlpool + start index.
pub fn tick_array_address(whirlpool: &Pubkey, start_index: i32) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"tick_array",
            whirlpool.as_ref(),
            &start_index.to_le_bytes(),
        ],
        &whirlpool_program_id(),
    )
}

/// Derive the Orca Position PDA from the position mint.
pub fn position_address(position_mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"position", position_mint.as_ref()],
        &whirlpool_program_id(),
    )
}

// ─── CPI instruction builders (v2 token-extension set) ───────────────────────

/// open_position_with_token_extensions — creates a Position PDA and mints the
/// position NFT to `position_token_account`.
#[allow(clippy::too_many_arguments)]
pub fn open_position_ix(
    funder: &Pubkey,
    owner: &Pubkey,
    position: &Pubkey,
    position_mint: &Pubkey,
    position_token_account: &Pubkey,
    whirlpool: &Pubkey,
    token2022_program: &Pubkey,
    system_program: &Pubkey,
    associated_token_program: &Pubkey,
    metadata_update_auth: &Pubkey,
    tick_lower: i32,
    tick_upper: i32,
    tick_spacing: u16,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + 4 + 4 + 2);
    data.extend_from_slice(&discriminator("open_position_with_token_extensions"));
    data.extend_from_slice(&tick_lower.to_le_bytes());
    data.extend_from_slice(&tick_upper.to_le_bytes());
    data.extend_from_slice(&tick_spacing.to_le_bytes());

    Instruction {
        program_id: whirlpool_program_id(),
        accounts: vec![
            AccountMeta::new(*funder, true),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new(*position, false),
            AccountMeta::new(*position_mint, false),
            AccountMeta::new(*position_token_account, false),
            AccountMeta::new_readonly(*whirlpool, false),
            AccountMeta::new_readonly(*token2022_program, false),
            AccountMeta::new_readonly(*system_program, false),
            AccountMeta::new_readonly(*associated_token_program, false),
            AccountMeta::new_readonly(*metadata_update_auth, false),
        ],
        data,
    }
}

/// increase_liquidity_v2 — adds liquidity to an existing position.
#[allow(clippy::too_many_arguments)]
pub fn increase_liquidity_ix(
    whirlpool: &Pubkey,
    token_program_a: &Pubkey,
    token_program_b: &Pubkey,
    memo_program: &Pubkey,
    position_authority: &Pubkey,
    position: &Pubkey,
    position_token_account: &Pubkey,
    token_mint_a: &Pubkey,
    token_mint_b: &Pubkey,
    token_owner_account_a: &Pubkey,
    token_owner_account_b: &Pubkey,
    token_vault_a: &Pubkey,
    token_vault_b: &Pubkey,
    tick_array_lower: &Pubkey,
    tick_array_upper: &Pubkey,
    liquidity: u128,
    token_max_a: u64,
    token_max_b: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + 16 + 8 + 8);
    data.extend_from_slice(&discriminator("increase_liquidity_v2"));
    data.extend_from_slice(&liquidity.to_le_bytes());
    data.extend_from_slice(&token_max_a.to_le_bytes());
    data.extend_from_slice(&token_max_b.to_le_bytes());

    Instruction {
        program_id: whirlpool_program_id(),
        accounts: vec![
            AccountMeta::new(*whirlpool, false),
            AccountMeta::new_readonly(*token_program_a, false),
            AccountMeta::new_readonly(*token_program_b, false),
            AccountMeta::new_readonly(*memo_program, false),
            AccountMeta::new_readonly(*position_authority, true),
            AccountMeta::new(*position, false),
            AccountMeta::new(*position_token_account, false),
            AccountMeta::new_readonly(*token_mint_a, false),
            AccountMeta::new_readonly(*token_mint_b, false),
            AccountMeta::new(*token_owner_account_a, false),
            AccountMeta::new(*token_owner_account_b, false),
            AccountMeta::new(*token_vault_a, false),
            AccountMeta::new(*token_vault_b, false),
            AccountMeta::new(*tick_array_lower, false),
            AccountMeta::new(*tick_array_upper, false),
        ],
        data,
    }
}

/// collect_fees_v2 — collects accrued fees into the owner token accounts.
#[allow(clippy::too_many_arguments)]
pub fn collect_fees_ix(
    whirlpool: &Pubkey,
    position_authority: &Pubkey,
    position: &Pubkey,
    position_token_account: &Pubkey,
    token_mint_a: &Pubkey,
    token_mint_b: &Pubkey,
    token_owner_account_a: &Pubkey,
    token_vault_a: &Pubkey,
    token_owner_account_b: &Pubkey,
    token_vault_b: &Pubkey,
    token_program_a: &Pubkey,
    token_program_b: &Pubkey,
    memo_program: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: whirlpool_program_id(),
        accounts: vec![
            AccountMeta::new(*whirlpool, false),
            AccountMeta::new_readonly(*position_authority, true),
            AccountMeta::new(*position, false),
            AccountMeta::new(*position_token_account, false),
            AccountMeta::new_readonly(*token_mint_a, false),
            AccountMeta::new_readonly(*token_mint_b, false),
            AccountMeta::new(*token_owner_account_a, false),
            AccountMeta::new(*token_vault_a, false),
            AccountMeta::new(*token_owner_account_b, false),
            AccountMeta::new(*token_vault_b, false),
            AccountMeta::new_readonly(*token_program_a, false),
            AccountMeta::new_readonly(*token_program_b, false),
            AccountMeta::new_readonly(*memo_program, false),
        ],
        data: discriminator("collect_fees_v2").to_vec(),
    }
}

/// decrease_liquidity_v2 — removes liquidity, sending tokens to the owner accounts.
#[allow(clippy::too_many_arguments)]
pub fn decrease_liquidity_ix(
    whirlpool: &Pubkey,
    token_program_a: &Pubkey,
    token_program_b: &Pubkey,
    memo_program: &Pubkey,
    position_authority: &Pubkey,
    position: &Pubkey,
    position_token_account: &Pubkey,
    token_mint_a: &Pubkey,
    token_mint_b: &Pubkey,
    token_owner_account_a: &Pubkey,
    token_owner_account_b: &Pubkey,
    token_vault_a: &Pubkey,
    token_vault_b: &Pubkey,
    tick_array_lower: &Pubkey,
    tick_array_upper: &Pubkey,
    liquidity: u128,
    token_min_a: u64,
    token_min_b: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + 16 + 8 + 8);
    data.extend_from_slice(&discriminator("decrease_liquidity_v2"));
    data.extend_from_slice(&liquidity.to_le_bytes());
    data.extend_from_slice(&token_min_a.to_le_bytes());
    data.extend_from_slice(&token_min_b.to_le_bytes());

    Instruction {
        program_id: whirlpool_program_id(),
        accounts: vec![
            AccountMeta::new(*whirlpool, false),
            AccountMeta::new_readonly(*token_program_a, false),
            AccountMeta::new_readonly(*token_program_b, false),
            AccountMeta::new_readonly(*memo_program, false),
            AccountMeta::new_readonly(*position_authority, true),
            AccountMeta::new(*position, false),
            AccountMeta::new(*position_token_account, false),
            AccountMeta::new_readonly(*token_mint_a, false),
            AccountMeta::new_readonly(*token_mint_b, false),
            AccountMeta::new(*token_owner_account_a, false),
            AccountMeta::new(*token_owner_account_b, false),
            AccountMeta::new(*token_vault_a, false),
            AccountMeta::new(*token_vault_b, false),
            AccountMeta::new(*tick_array_lower, false),
            AccountMeta::new(*tick_array_upper, false),
        ],
        data,
    }
}

/// close_position — burns the position NFT and closes the Position account.
pub fn close_position_ix(
    position_authority: &Pubkey,
    receiver: &Pubkey,
    position: &Pubkey,
    position_mint: &Pubkey,
    position_token_account: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: whirlpool_program_id(),
        accounts: vec![
            AccountMeta::new_readonly(*position_authority, true),
            AccountMeta::new(*receiver, false),
            AccountMeta::new(*position, false),
            AccountMeta::new(*position_mint, false),
            AccountMeta::new(*position_token_account, false),
            AccountMeta::new_readonly(*token_program, false),
        ],
        data: discriminator("close_position").to_vec(),
    }
}
