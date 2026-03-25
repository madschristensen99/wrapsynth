# WrapSynth Solana Port — Implementation Specification

**Version:** 1.0  
**Date:** March 25, 2026  
**Source:** VaultManager.sol, wsXMRLiquidityRouter.sol, wsXMR.sol (Solidity ^0.8.19, Gnosis Chain)

---

## 1. Executive Summary

This document specifies the complete port of the WrapSynth protocol — a Monero-to-EVM synthetic bridge — from Solidity/Gnosis Chain to Solana using the Anchor framework. The protocol mints wsXMR, an overcollateralized synthetic Monero token, via LP vaults that use sDAI as collateral and secp256k1 PTLC atomic swaps for cross-chain settlement.

The port requires fundamental architectural changes due to Solana's account model, rent system, parallel transaction execution, and 10MB account size limit. This spec maps every EVM contract, state variable, function, and invariant to Solana-native equivalents.

---

## 2. Architecture Overview

### 2.1 EVM Architecture (Current)

```
wsXMR (ERC-20)              — Immutable token, mint/burn gated by VaultManager
VaultManager                — Core CDP engine: vaults, minting, burning, liquidation, buy-and-burn
wsXMRLiquidityRouter        — Uniswap V3 co-LP matchmaking, position management
Secp256k1 (inherited)       — On-chain scalar multiplication verification for PTLC secrets
GnosisAddresses (library)   — Hardcoded addresses for xDAI, sDAI, Uniswap router, etc.
```

### 2.2 Solana Architecture (Target)

```
wrapsynth_token             — SPL Token 2022 mint (mint/freeze authority = vault_manager PDA)
wrapsynth_vault_manager     — Anchor program: vaults, minting, burning, liquidation, yield, buy-and-burn
wrapsynth_liquidity_router  — Anchor program: Orca Whirlpool co-LP matchmaking
```

Each Anchor program owns its own PDAs. Cross-program invocation (CPI) replaces Solidity's internal calls and interface imports.

### 2.3 Key Differences

| Concept | EVM (Current) | Solana (Target) |
|---|---|---|
| Token standard | ERC-20 (custom mint/burn) | SPL Token 2022 with mint authority PDA |
| State storage | Contract storage slots | PDAs with defined account structs |
| Reentrancy guard | OpenZeppelin ReentrancyGuard | Anchor's `#[access_control]` + account locking |
| Collateral | sDAI (ERC-4626 yield vault) | SPL stake pool receipt token or Marinade mSOL |
| DEX | Uniswap V3 (concentrated liquidity) | Orca Whirlpool (concentrated liquidity) |
| Oracle | Pyth pull-based | Pyth pull-based (native on Solana) |
| Mapping iteration | `vaultList[]` array | PDA enumeration via `getProgramAccounts` or on-chain linked list |
| Access control | `msg.sender` checks | Signer constraints in Anchor `#[derive(Accounts)]` |
| ETH griefing deposits | Native ETH via `msg.value` | Wrapped SOL via associated token account |
| Decimal precision | Various (8, 12, 18) | SPL default 9 (wsXMR: 8, collateral: 9) |

---

## 3. Program Specifications

### 3.1 `wrapsynth_token` — wsXMR SPL Token

**Approach:** Do NOT deploy a custom program. Use SPL Token 2022 with the VaultManager program PDA as both `mint_authority` and `freeze_authority`.

```rust
// Mint PDA derivation
seeds = [b"wsxmr_mint"]
bump = <computed>
```

**Mint configuration:**
- Decimals: `8` (matches EVM)
- Supply: Uncapped (minted/burned by vault manager)
- Freeze authority: Vault manager PDA (optional, for emergency pause)
- Extensions: `TransferFee` (optional, for protocol revenue)

**Mint/Burn:** The vault manager program signs CPI calls to `spl_token_2022::instruction::mint_to` and `spl_token_2022::instruction::burn` using its PDA signer seeds.

**EVM Equivalence:**
| wsXMR.sol | Solana |
|---|---|
| `constructor()` sets `vaultManager = msg.sender` | Mint authority = vault manager PDA |
| `mint(address, uint256)` | CPI `mint_to` with PDA signer |
| `burn(address, uint256)` | CPI `burn` with PDA signer |
| `decimals() returns 8` | Mint account `decimals = 8` |
| ERC20Permit (gasless approve) | SPL Token 2022 `TransferHook` or off-chain `approve` + durable nonces |

---

### 3.2 `wrapsynth_vault_manager` — Core Protocol

#### 3.2.1 Account Structures

**GlobalState PDA** — Single instance, replaces contract-level storage variables.

```rust
#[account]
pub struct GlobalState {
    pub authority: Pubkey,           // Deployer/admin (for one-time setup like router)
    pub wsxmr_mint: Pubkey,          // wsXMR SPL Token 2022 mint
    pub collateral_mint: Pubkey,     // Collateral SPL token (mSOL, jitoSOL, etc.)
    pub liquidity_router: Pubkey,    // Authorized router program
    pub pyth_xmr_feed: Pubkey,      // Pyth XMR/USD price account
    pub pyth_collateral_feed: Pubkey,// Pyth collateral/USD price account
    
    pub global_total_debt: u64,      // Total wsXMR debt across all vaults
    pub global_debt_index: u64,      // Debt multiplier (scaled by 1e18 → use u128 intermediates)
    pub yield_war_chest: u64,        // Accumulated yield for buy-and-burn (in collateral)
    pub global_lp_principal: u64,    // Total original deposits
    pub global_lp_principal_shares: u64,
    pub global_pending_collateral: u64, // Pending withdrawals (sDAI equivalent)
    pub global_pending_sol: u64,     // Pending SOL withdrawals
    pub global_bad_debt: u64,        // Unbacked wsXMR from liquidation shortfalls
    pub global_pending_burn_debt: u64,
    pub last_buy_timestamp: i64,     // Unix timestamp of last buy-and-burn
    pub vault_count: u32,            // Active vault count
    pub request_nonce: u64,          // Global nonce for request ID generation
    
    pub bump: u8,                    // PDA bump
}
// Size: ~250 bytes + padding
```

**Vault PDA** — One per LP, derived from LP pubkey.

```rust
#[account]
pub struct Vault {
    pub lp_address: Pubkey,
    pub collateral_amount: u64,      // Collateral token amount (not shares — see §3.2.2)
    pub locked_collateral: u64,      // Reserved for pending burns
    pub normalized_debt: u64,        // Normalized debt (actual = normalized * index / 1e18)
    pub pending_debt: u64,           // Reserved capacity for pending mints
    pub max_mint_bps: u16,           // Single mint size limit (basis points)
    pub mint_griefing_deposit: u64,  // SOL lamports required for mint requests
    pub mint_fee_bps: u16,           // Fee LP charges (basis points)
    pub burn_reward_bps: u16,        // Reward LP pays for burning (basis points)
    pub liquidation_nonce: u64,      // Incremented on liquidation
    pub mint_nonce: u64,             // Incremented on liquidation to invalidate mints
    pub min_burn_amount: u64,        // LP-configurable minimum burn
    pub principal_deposits: u64,     // Original deposit value
    pub principal_shares: u64,       // Original deposit shares
    pub active: bool,
    pub bump: u8,
}
// PDA seeds: [b"vault", lp_address.as_ref()]
// Size: ~170 bytes
```

**MintRequest PDA** — One per active mint.

```rust
#[account]
pub struct MintRequest {
    pub request_id: [u8; 32],        // Keccak256-equivalent hash
    pub initiator: Pubkey,           // Who paid the griefing deposit
    pub recipient: Pubkey,           // Destination for minted wsXMR
    pub lp_vault: Pubkey,            // LP vault pubkey
    pub xmr_amount: u64,            // XMR atomic units (12 decimals)
    pub wsxmr_amount: u64,          // wsXMR amount (8 decimals)
    pub fee_amount: u64,            // Portion going to LP
    pub claim_commitment: [u8; 32], // secp256k1 commitment
    pub timeout: i64,               // Unix timestamp
    pub griefing_deposit: u64,      // SOL lamports deposited
    pub normalized_debt_amount: u64,
    pub vault_mint_nonce: u64,      // Snapshot for invalidation
    pub status: MintStatus,
    pub bump: u8,
}
// PDA seeds: [b"mint_request", request_id.as_ref()]
// Size: ~280 bytes

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum MintStatus {
    Invalid,
    Pending,
    Ready,
    Completed,
    Cancelled,
}
```

**BurnRequest PDA** — One per active burn.

```rust
#[account]
pub struct BurnRequest {
    pub request_id: [u8; 32],
    pub user: Pubkey,
    pub lp_vault: Pubkey,
    pub wsxmr_amount: u64,
    pub xmr_amount: u64,
    pub locked_collateral: u64,
    pub reward_collateral: u64,
    pub secret_hash: [u8; 32],
    pub deadline: i64,
    pub vault_liquidation_nonce: u64,
    pub normalized_debt_amount: u64,
    pub status: BurnStatus,
    pub bump: u8,
}
// PDA seeds: [b"burn_request", request_id.as_ref()]
// Size: ~260 bytes

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum BurnStatus {
    Invalid,
    Requested,
    Proposed,
    Committed,
    Completed,
    Slashed,
    Cancelled,
}
```

**PendingReturns PDA** — Per-user per-token withdrawal queue.

```rust
#[account]
pub struct PendingReturns {
    pub owner: Pubkey,
    pub collateral_amount: u64,  // Pending collateral withdrawals
    pub sol_amount: u64,         // Pending SOL withdrawals
    pub bump: u8,
}
// PDA seeds: [b"pending_returns", owner.as_ref()]
```

#### 3.2.2 Collateral Strategy

**Problem:** sDAI (ERC-4626 yield-bearing stablecoin) does not exist on Solana.

**Solution Options (ranked):**

1. **Marinade mSOL** — Liquid staked SOL. Yield-bearing, deep liquidity, programmatic deposit/redeem. The collateral is SOL-denominated, which changes the risk profile (SOL/XMR volatility instead of USD/XMR). Requires adjusting collateral ratios upward (e.g., 200% instead of 150%).

2. **JitoSOL** — Similar to mSOL with MEV rewards. Same SOL-denomination considerations.

3. **USDC + Solend/MarginFi yield** — Deposit USDC into a lending protocol, receive yield-bearing receipt tokens. Closest to sDAI semantics (USD-denominated + yield). Adds composability risk.

4. **Native USDC with off-chain yield tracking** — Simplest but loses the automatic yield accrual that funds buy-and-burn.

**Recommendation:** Option 3 (USDC + lending protocol receipt token) preserves the economic design most faithfully. The `_syncVaultYield` logic maps directly to comparing receipt token value vs. principal.

For the remainder of this spec, `COLLATERAL` refers to whichever yield-bearing receipt token is chosen. The program should be parameterized so the collateral mint is set at `initialize` time.

#### 3.2.3 Yield Tracking Adaptation

The EVM contract uses `ISavingsDAI.convertToAssets()` and `ISavingsDAI.convertToShares()` for yield calculations. On Solana:

```rust
// If using a lending protocol receipt token:
fn get_collateral_value(shares: u64, lending_pool: &AccountInfo) -> u64 {
    // CPI to lending protocol's "convert_to_assets" equivalent
    // or read the exchange rate from the pool's state account
}

fn get_shares_for_value(value: u64, lending_pool: &AccountInfo) -> u64 {
    // Inverse conversion
}
```

The `_syncVaultYield` function becomes:

```rust
fn sync_vault_yield(vault: &mut Vault, global: &mut GlobalState, lending_pool: &AccountInfo) {
    if vault.collateral_amount == 0 || vault.principal_shares == 0 {
        return;
    }
    
    let current_value = get_collateral_value(vault.collateral_amount, lending_pool);
    let principal_value = get_collateral_value(vault.principal_shares, lending_pool);
    
    if current_value <= principal_value {
        return; // No yield
    }
    
    let yield_value = current_value - principal_value;
    let yield_shares = get_shares_for_value(yield_value, lending_pool);
    
    // Safety cap
    let max_yield = vault.collateral_amount.saturating_sub(vault.principal_shares);
    let yield_shares = yield_shares.min(max_yield);
    
    if yield_shares <= YIELD_DUST_THRESHOLD {
        return;
    }
    
    // Health check before extraction (same logic as EVM)
    // ... [collateral ratio check with 155% buffer] ...
    
    vault.collateral_amount -= yield_shares;
    global.yield_war_chest += yield_shares;
}
```

#### 3.2.4 Constants

All constants port directly. Key values:

```rust
pub const COLLATERAL_RATIO: u64 = 150;
pub const LIQUIDATION_RATIO: u64 = 120;
pub const LIQUIDATION_BONUS: u64 = 110;
pub const RATIO_PRECISION: u64 = 100;
pub const MAX_MINT_TIMEOUT: i64 = 7200;       // 2 hours
pub const MINT_READY_EXTENSION: i64 = 7200;    // 2 hours
pub const BURN_REQUEST_TIMEOUT: i64 = 3600;    // 1 hour
pub const BURN_COMMIT_TIMEOUT: i64 = 7200;     // 2 hours
pub const BPS_DENOMINATOR: u64 = 10000;
pub const MAX_MARGIN_BPS: u64 = 1000;
pub const COOLDOWN_PERIOD: i64 = 86400;        // 24 hours
pub const BUY_CHUNK_PERCENT: u64 = 20;
pub const EMA_TRIGGER_THRESHOLD: u64 = 99;
pub const MEV_SLIPPAGE_BPS: u64 = 100;
pub const KEEPER_REWARD_BPS: u64 = 200;
pub const MIN_BURN_AMOUNT: u64 = 1_000_000;    // 0.01 wsXMR (8 decimals)
pub const BURN_LOCK_RATIO: u64 = 130;
pub const WSXMR_DECIMALS: u64 = 100_000_000;   // 1e8
pub const MAX_BURN_REQUESTS_PER_VAULT: u32 = 50;
pub const LIQUIDATION_BURN_BATCH_SIZE: u32 = 20;
pub const XMR_TO_WSXMR_DIVISOR: u64 = 10_000;  // 1e4
pub const PRICE_MAX_AGE: u64 = 120;             // 2 minutes
pub const LIQUIDITY_PRICE_MAX_AGE: u64 = 30;    // 30 seconds
```

#### 3.2.5 Instructions

Each Solidity function maps to an Anchor instruction. The instruction set:

**Initialization:**

| Instruction | EVM Equivalent | Notes |
|---|---|---|
| `initialize` | `constructor` | Creates GlobalState PDA, initializes wsXMR mint |
| `set_liquidity_router` | `setLiquidityRouter` | One-time setup, authority-gated |

**Vault Management:**

| Instruction | EVM Equivalent | Notes |
|---|---|---|
| `create_vault` | `createVault` | Creates Vault PDA for signer |
| `deposit_collateral` | `depositCollateral` | Transfers tokens, CPI to lending protocol |
| `deposit_collateral_shares` | `depositSDAI` | Direct receipt token deposit |
| `withdraw_collateral` | `withdrawCollateral` | Health check, CPI to lending protocol redeem |
| `set_mint_griefing_deposit` | `setMintGriefingDeposit` | LP config |
| `set_vault_market_metrics` | `setVaultMarketMetrics` | Fee/reward config |
| `set_max_mint_bps` | `setMaxMintBps` | Chunk size limit |
| `set_min_burn_amount` | `setMinBurnAmount` | Minimum burn |
| `deactivate_vault` | `deactivateVault` | Close PDA, recover rent |

**Minting Flow:**

| Instruction | EVM Equivalent | Notes |
|---|---|---|
| `initiate_mint` | `initiateMint` / `initiateMintWithPriceUpdate` | Creates MintRequest PDA |
| `set_mint_ready` | `setMintReady` | LP confirms XMR lock |
| `finalize_mint` | `finalizeMint` | Secret verification, token minting |
| `cancel_mint` | `cancelMint` | Permissionless cleanup after timeout |

**Burning Flow (3-step handshake):**

| Instruction | EVM Equivalent | Notes |
|---|---|---|
| `request_burn` | `requestBurn` | Burns wsXMR, locks collateral |
| `request_burn_from_router` | `requestBurnFromRouter` | CPI from router |
| `propose_hash` | `proposeHash` | LP sets secretHash |
| `confirm_monero_lock` | `confirmMoneroLock` | User confirms, starts timer |
| `finalize_burn` | `finalizeBurn` | LP reveals secret |
| `claim_slashed_collateral` | `claimSlashedCollateral` | User claims after LP timeout |
| `cancel_burn` | `cancelBurn` | Permissionless cleanup |

**Liquidation:**

| Instruction | EVM Equivalent | Notes |
|---|---|---|
| `liquidate` | `liquidate` | Complex — see §3.2.6 |

**Buy-and-Burn:**

| Instruction | EVM Equivalent | Notes |
|---|---|---|
| `trigger_buy_and_burn` | `triggerBuyAndBurn` | Keeper function, see §3.2.7 |

**Utilities:**

| Instruction | EVM Equivalent | Notes |
|---|---|---|
| `withdraw_returns` | `withdrawReturns` | Pull-pattern withdrawal |
| `update_pyth_prices` | `updatePythPrices` | Pyth CPI (simpler on Solana — native) |
| `reconcile_global_debt` | `reconcileGlobalDebt` | Requires iterating vault PDAs |
| `cleanup_user_mint_requests` | `cleanupUserMintRequests` | PDA close pattern instead |
| `cleanup_user_burn_requests` | `cleanupUserBurnRequests` | PDA close pattern instead |

#### 3.2.6 Liquidation — Solana Adaptation

The EVM `liquidate()` function iterates over `vaultBurnRequests[_lpVault]` to resolve active burns before seizing collateral. On Solana, this is problematic because:

1. You can't iterate unknown accounts in a single transaction
2. Transaction size limits constrain the number of remaining accounts

**Solution: Two-phase liquidation**

**Phase 1: `resolve_burn_for_liquidation`** — Called once per active burn request. Resolves it (re-mint to user or slash to user). Can be batched into multiple transactions.

```rust
pub fn resolve_burn_for_liquidation(
    ctx: Context<ResolveBurnForLiquidation>,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let burn_request = &mut ctx.accounts.burn_request;
    
    // Verify vault is actually liquidatable
    require!(is_liquidatable(vault, &ctx.accounts.pyth_xmr, &ctx.accounts.pyth_collateral), ...);
    
    // Same logic as EVM liquidate()'s inner loop:
    match burn_request.status {
        BurnStatus::Requested | BurnStatus::Proposed => {
            // Re-mint wsXMR to user, restore debt
            burn_request.status = BurnStatus::Cancelled;
            // CPI: mint wsXMR to user
            // Restore vault.normalized_debt
            // Unlock collateral
        }
        BurnStatus::Committed => {
            // User confirmed Monero lock — slash to user
            burn_request.status = BurnStatus::Slashed;
            // Transfer locked collateral to user's PendingReturns
        }
        _ => return Err(...)
    }
    Ok(())
}
```

**Phase 2: `execute_liquidation`** — After all burns are resolved (or none exist), execute the actual liquidation.

```rust
pub fn execute_liquidation(
    ctx: Context<ExecuteLiquidation>,
    debt_to_clear: u64,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    
    // Verify no unresolved burns remain
    // (tracked via a counter on the Vault account)
    require!(vault.active_burn_count == 0, ...);
    
    // Standard liquidation logic (same as EVM)
    // ...
}
```

**Active Burn Tracking:** Add `active_burn_count: u32` to the Vault struct. Increment in `request_burn`, decrement on completion/cancellation/resolution.

#### 3.2.7 Buy-and-Burn — Solana Adaptation

The EVM `triggerBuyAndBurn` swaps sDAI→wsXMR on Uniswap V3 then burns. On Solana:

1. **Swap:** CPI to Orca Whirlpool (or Jupiter aggregator) to swap collateral→wsXMR
2. **Burn:** CPI to SPL Token to burn the purchased wsXMR
3. **Debt index update:** Same O(1) math as EVM

```rust
pub fn trigger_buy_and_burn(
    ctx: Context<TriggerBuyAndBurn>,
) -> Result<()> {
    let global = &mut ctx.accounts.global_state;
    let clock = Clock::get()?;
    
    // 1. Cooldown check
    require!(clock.unix_timestamp >= global.last_buy_timestamp + COOLDOWN_PERIOD, ...);
    
    // 2. EMA vs Spot check (Pyth provides both natively on Solana)
    let spot = get_pyth_price(&ctx.accounts.pyth_xmr_feed)?;
    let ema = get_pyth_ema_price(&ctx.accounts.pyth_xmr_feed)?;
    require!(spot.price <= (ema.price * EMA_TRIGGER_THRESHOLD) / 100, ...);
    
    // 3. Calculate chunk
    let total_chunk = (global.yield_war_chest * BUY_CHUNK_PERCENT) / 100;
    let keeper_reward = (total_chunk * KEEPER_REWARD_BPS) / BPS_DENOMINATOR;
    let spend_amount = total_chunk - keeper_reward;
    
    global.yield_war_chest -= total_chunk;
    global.last_buy_timestamp = clock.unix_timestamp;
    
    // 4. Transfer keeper reward
    // CPI: transfer collateral tokens to keeper
    
    // 5. CPI: Swap on Orca Whirlpool (collateral → wsXMR)
    // With oracle-derived minimum output for MEV protection
    
    // 6. CPI: Burn purchased wsXMR
    
    // 7. Update debt index (same O(1) math as EVM)
    
    Ok(())
}
```

**Reconciliation:** The EVM contract iterates all vaults when `vaultList.length <= 200` for debt reconciliation. On Solana, this requires a separate cranked instruction that takes vault accounts as remaining_accounts:

```rust
pub fn reconcile_global_debt(
    ctx: Context<ReconcileGlobalDebt>,
) -> Result<()> {
    // Remaining accounts = vault PDAs to reconcile
    let mut computed_debt: u64 = 0;
    for account in ctx.remaining_accounts.iter() {
        let vault = Account::<Vault>::try_from(account)?;
        computed_debt += get_actual_debt(vault.normalized_debt, ctx.accounts.global_state.global_debt_index);
    }
    // Note: This only reconciles the vaults passed in.
    // Off-chain indexer must ensure ALL vaults are included.
    ctx.accounts.global_state.global_total_debt = computed_debt;
    Ok(())
}
```

#### 3.2.8 Secp256k1 Verification

The EVM contract inherits `Secp256k1` and uses `mulVerify(uint256 _secret, uint256 _commitment)` for PTLC secret verification (scalar multiplication on secp256k1).

**Solana native support:** Solana has a native `secp256k1_program` that verifies `ecrecover` signatures. For scalar multiplication verification:

**Option A: Use `secp256k1_recover` precompile trick (same as EVM)**

The EVM contract uses Vitalik's `ecrecover` trick to verify `secret * G == commitment`. This maps to Solana's `Secp256k1Program::new_secp256k1_instruction`.

```rust
use solana_program::secp256k1_recover::secp256k1_recover;

fn mul_verify(secret: [u8; 32], commitment: [u8; 32]) -> bool {
    // Construct a synthetic signature where:
    // - message_hash = specific value derived from secret
    // - signature = derived from secret and generator point
    // - expected recovery = commitment point
    // (Same ecrecover trick as the Solidity Secp256k1.sol)
    
    // This requires porting the exact same math from Secp256k1.sol
    // Key insight: ecrecover(hash, v, r, s) returns an address derived from
    // the public key, and we can construct hash/v/r/s such that the returned
    // address encodes our scalar multiplication result.
    
    todo!("Port Secp256k1.sol mulVerify logic")
}
```

**Option B: Use `curve25519-dalek` for Ed25519 verification**

If the protocol switches from secp256k1 to Ed25519 for the Solana port (which is more natural since Solana uses Ed25519 natively), the verification becomes:

```rust
use curve25519_dalek::scalar::Scalar;
use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;

fn mul_verify_ed25519(secret: [u8; 32], commitment: [u8; 32]) -> bool {
    let scalar = Scalar::from_bytes_mod_order(secret);
    let expected = ED25519_BASEPOINT_POINT * scalar;
    let commitment_point = CompressedEdwardsY(commitment).decompress();
    match commitment_point {
        Some(point) => point == expected,
        None => false,
    }
}
```

**Recommendation:** Stick with secp256k1 to maintain compatibility with the Monero atomic swap protocol (AthanorLabs ETH-XMR swap uses secp256k1). Use Solana's native `secp256k1_program` via instruction introspection.

#### 3.2.9 Oracle Integration

Pyth is native on Solana — no `updatePriceFeeds` transaction needed. Prices are pushed by Pyth's validator network automatically.

```rust
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

fn get_xmr_price(price_account: &Account<PriceUpdateV2>, max_age: u64) -> Result<u64> {
    let price = price_account.get_price_no_older_than(
        &Clock::get()?,
        max_age,
        &XMR_USD_FEED_ID,
    )?;
    
    // Confidence check (same as EVM: conf * 10 > price)
    require!(price.conf * 10 <= price.price as u64, StalePrice);
    
    // Normalize to 18-decimal precision (use u128 intermediates)
    normalize_pyth_price(price.price, price.exponent)
}
```

The `initiateMintWithPriceUpdate` and `createPositionWithPriceUpdate` patterns are unnecessary on Solana since Pyth prices are already on-chain. However, the caller should still include a recent Pyth price update instruction in the same transaction for freshness.

---

### 3.3 `wrapsynth_liquidity_router` — Co-LP Matchmaking

#### 3.3.1 Account Structures

**RouterState PDA** — Global router configuration.

```rust
#[account]
pub struct RouterState {
    pub vault_manager: Pubkey,
    pub wsxmr_mint: Pubkey,
    pub collateral_mint: Pubkey,
    pub whirlpool: Pubkey,           // Orca Whirlpool address
    pub pool_initialized: bool,
    pub next_position_index: u64,
    pub bump: u8,
}
// PDA seeds: [b"router_state"]
```

**LiquidityPosition PDA** — One per active position.

```rust
#[account]
pub struct LiquidityPosition {
    pub position_index: u64,
    pub whirlpool_position: Pubkey,  // Orca Whirlpool NFT position
    pub lp_provider: Pubkey,
    pub user_provider: Pubkey,
    pub collateral_amount: u64,
    pub wsxmr_amount: u64,
    pub lp_initial_value_usd: u64,
    pub user_initial_value_usd: u64,
    pub created_at: i64,
    pub bump: u8,
}
// PDA seeds: [b"lp_position", position_index.to_le_bytes()]
```

**UserRouterState PDA** — Per-user balances and tracking.

```rust
#[account]
pub struct UserRouterState {
    pub owner: Pubkey,
    pub collateral_allocation: u64,   // LP's sDAI equivalent allocation
    pub wsxmr_deposits: u64,          // User's wsXMR deposits
    pub pending_collateral_fees: u64,
    pub pending_wsxmr_fees: u64,
    pub pending_eth_refunds: u64,     // SOL refunds
    pub active_position_count: u32,
    pub approval_nonce: u64,
    pub bump: u8,
}
// PDA seeds: [b"user_router", owner.as_ref()]
```

**Approval PDA** — Mutual approval tracking.

```rust
#[account]
pub struct Approval {
    pub grantor: Pubkey,
    pub grantee: Pubkey,
    pub amount: u64,
    pub is_lp_approval: bool,  // true = LP approving user, false = user approving LP
    pub bump: u8,
}
// PDA seeds: [b"approval", grantor.as_ref(), grantee.as_ref(), &[is_lp_approval as u8]]
```

#### 3.3.2 Instructions

| Instruction | EVM Equivalent | Notes |
|---|---|---|
| `initialize_router` | constructor | Creates RouterState PDA |
| `initialize_pool` | `initializePool` | CPI to Orca Whirlpool `initialize_pool` |
| `allocate_liquidity` | `allocateLiquidity` | Transfer collateral to router ATA |
| `deallocate_liquidity` | `deallocateLiquidity` / `withdrawSDAI` | Return collateral |
| `deposit_wsxmr` | `depositWsxmr` | Transfer wsXMR to router ATA |
| `withdraw_wsxmr` | `withdrawWsXMR` | Return wsXMR |
| `increase_user_approval` | `increaseUserApproval` | Create/update Approval PDA |
| `decrease_user_approval` | `decreaseUserApproval` | Update Approval PDA |
| `increase_lp_approval` | `increaseLpApproval` | Create/update Approval PDA |
| `decrease_lp_approval` | `decreaseLpApproval` | Update Approval PDA |
| `create_position` | `createPosition` / `createPositionWithPriceUpdate` | CPI to Orca Whirlpool |
| `close_position` | `closePosition` | CPI to Orca, distribute assets |
| `collect_fees` | `collectFees` | CPI to Orca, split proportionally |
| `withdraw_fees` | `withdrawFees` | Transfer accumulated fees |
| `burn_from_internal_balance` | `burnFromInternalBalance` | CPI to vault manager |
| `withdraw_sol` | `withdrawETH` | Withdraw pending SOL refunds |

#### 3.3.3 Orca Whirlpool Integration

Orca Whirlpool is the Solana equivalent of Uniswap V3 concentrated liquidity. Key mappings:

| Uniswap V3 (EVM) | Orca Whirlpool (Solana) |
|---|---|
| `INonfungiblePositionManager.mint()` | `whirlpool::open_position` + `increase_liquidity` |
| `decreaseLiquidity()` | `whirlpool::decrease_liquidity` |
| `collect()` | `whirlpool::collect_fees` + `collect_reward` |
| `burn()` (NFT) | `whirlpool::close_position` |
| Fee tiers (500, 3000, 10000) | Tick spacing configs |
| `TICK_LOWER/UPPER = ±887220` | Full range via `MIN_TICK`/`MAX_TICK` |

Position creation:

```rust
pub fn create_position(ctx: Context<CreatePosition>, ...) -> Result<()> {
    // 1. Verify mutual approvals (both Approval PDAs)
    // 2. Deduct from UserRouterState balances
    // 3. Oracle validation (0.5% tolerance, same as EVM)
    // 4. CPI: whirlpool::open_position (creates position NFT)
    // 5. CPI: whirlpool::increase_liquidity (add tokens)
    // 6. Store LiquidityPosition PDA with actual amounts
    // 7. Return unused tokens to UserRouterState balances
    Ok(())
}
```

---

## 4. Account Size and Rent Analysis

| Account | Size (bytes) | Rent (SOL, approx) |
|---|---|---|
| GlobalState | ~300 | 0.0026 |
| Vault | ~200 | 0.0018 |
| MintRequest | ~300 | 0.0026 |
| BurnRequest | ~280 | 0.0024 |
| PendingReturns | ~80 | 0.0010 |
| RouterState | ~150 | 0.0014 |
| LiquidityPosition | ~180 | 0.0016 |
| UserRouterState | ~120 | 0.0012 |
| Approval | ~90 | 0.0010 |

MintRequest and BurnRequest PDAs should be closeable (rent-recoverable) when they reach terminal states (Completed, Cancelled, Slashed). This replaces the EVM cleanup functions.

---

## 5. Mapping Enumeration Pattern

The EVM contract uses `mapping(address => Vault)` with a parallel `address[] vaultList` for iteration. Solana doesn't have mappings. The PDA pattern replaces both:

**Discovery:** Off-chain clients use `getProgramAccounts` with discriminator + optional filters:

```typescript
const vaults = await connection.getProgramAccounts(programId, {
  filters: [
    { memcmp: { offset: 0, bytes: VAULT_DISCRIMINATOR } },
    { memcmp: { offset: 8 + 32, bytes: /* active = true */ } },
  ],
});
```

**On-chain iteration:** Not needed for most operations. For reconciliation, vault PDAs are passed as `remaining_accounts`. The off-chain indexer is responsible for completeness.

**User request tracking:** The EVM contract tracks `userMintRequests[user]` as arrays. On Solana, use `getProgramAccounts` filtered by user pubkey field. No on-chain array needed — the PDA is the canonical state.

---

## 6. Transaction Composition

Several EVM functions combine Pyth updates with core logic (e.g., `initiateMintWithPriceUpdate`). On Solana, this is handled via transaction composition:

```typescript
const tx = new Transaction();

// Instruction 1: Pyth price update (if needed)
tx.add(pythPriceUpdateInstruction);

// Instruction 2: Core operation
tx.add(initiateMintInstruction);

await sendAndConfirmTransaction(connection, tx, [signer]);
```

This is simpler and more composable than the EVM pattern of creating wrapper functions.

---

## 7. Compute Budget Considerations

Solana transactions have a 200K compute unit default (requestable up to 1.4M). Complex operations need budget:

| Operation | Estimated CUs | Notes |
|---|---|---|
| `initiate_mint` | ~50K | Oracle read + PDA creation |
| `finalize_mint` | ~80K | secp256k1 verify + token mint |
| `request_burn` | ~100K | Token burn + collateral lock + PDA creation |
| `liquidate` (per burn resolution) | ~60K | Per burn request resolved |
| `liquidate` (execution) | ~120K | Collateral seizure + token burn |
| `trigger_buy_and_burn` | ~200K+ | Oracle + DEX swap CPI + debt index update |
| `create_position` (router) | ~250K+ | Orca CPI + oracle validation |

**Mitigations:**
- Request 400K-1.4M CUs for complex operations
- Multi-instruction transactions for phased operations
- `resolve_burn_for_liquidation` batched across transactions

---

## 8. Error Handling

Map Solidity custom errors to Anchor error codes:

```rust
#[error_code]
pub enum WrapSynthError {
    #[msg("Zero address provided")]
    ZeroAddress,                    // 6000
    #[msg("Zero amount provided")]
    ZeroAmount,                     // 6001
    #[msg("Vault already exists")]
    VaultAlreadyExists,             // 6002
    #[msg("Vault does not exist")]
    VaultDoesNotExist,              // 6003
    #[msg("Vault not active")]
    VaultNotActive,                 // 6004
    #[msg("Insufficient collateral")]
    InsufficientCollateral,         // 6005
    #[msg("Fee/reward exceeds maximum")]
    ExceedsMaxMargin,               // 6006
    #[msg("Invalid mint request")]
    InvalidMintRequest,             // 6007
    #[msg("Invalid burn request")]
    InvalidBurnRequest,             // 6008
    #[msg("Mint request already exists")]
    MintAlreadyExists,              // 6009
    #[msg("Burn request already exists")]
    BurnAlreadyExists,              // 6010
    #[msg("Invalid secret")]
    InvalidSecret,                  // 6011
    #[msg("Invalid status for operation")]
    InvalidStatus,                  // 6012
    #[msg("Timeout not reached")]
    TimeoutNotReached,              // 6013
    #[msg("Deadline expired")]
    DeadlineExpired,                // 6014
    #[msg("Deadline not expired")]
    DeadlineNotExpired,             // 6015
    #[msg("Vault is healthy")]
    VaultHealthy,                   // 6016
    #[msg("Insufficient debt")]
    InsufficientDebt,               // 6017
    #[msg("Unauthorized")]
    Unauthorized,                   // 6018
    #[msg("Invalid value")]
    InvalidValue,                   // 6019
    #[msg("Stale price")]
    StalePrice,                     // 6020
    #[msg("Insufficient deposit")]
    InsufficientDeposit,            // 6021
    #[msg("Arithmetic overflow")]
    MathOverflow,                   // 6022
    #[msg("Active burns must be resolved before liquidation")]
    UnresolvedBurns,                // 6023
    #[msg("Pool not initialized")]
    PoolNotInitialized,             // 6024
}
```

---

## 9. Security Invariants to Preserve

These invariants from the EVM contract MUST hold on Solana:

1. **wsXMR supply = globalTotalDebt + globalPendingBurnDebt + globalBadDebt** (minus any bought-and-burned)
2. **Vault collateral ratio ≥ 150%** for all non-liquidatable operations
3. **Liquidation only when ratio < 120%** on unlocked collateral vs. actual debt
4. **secp256k1 secret verification** for all mint/burn finalizations
5. **Timeout enforcement** via `Clock::get()?.unix_timestamp`
6. **Permissionless cleanup** — anyone can cancel expired requests
7. **No unbacked minting** — every wsXMR is backed by ≥150% collateral at creation time
8. **Locked collateral is NOT double-counted** — cannot back both burns and new mints
9. **Liquidation nonce invalidation** — all pending mints/burns are atomically invalidated
10. **Pull-pattern withdrawals** — no push payments that could DoS
11. **Yield extraction preserves vault health** — 155% buffer ratio
12. **Buy-and-burn debt index** — reduces all vault debts proportionally in O(1)
13. **Griefing deposits** — returned to initiator if LP fails, awarded to LP if user fails

---

## 10. Testing Strategy

### 10.1 Unit Tests (Anchor)

```
tests/
├── vault_manager/
│   ├── create_vault.rs
│   ├── deposit_withdraw.rs
│   ├── mint_flow.rs           // Full PENDING → READY → COMPLETED path
│   ├── mint_cancel.rs         // Timeout scenarios
│   ├── burn_flow.rs           // Full 3-step handshake
│   ├── burn_cancel.rs         // Various cancellation paths
│   ├── burn_slash.rs          // LP timeout after COMMITTED
│   ├── liquidation.rs         // Including burn resolution
│   ├── buy_and_burn.rs        // EMA trigger, debt index math
│   ├── yield_sync.rs          // Principal vs. yield tracking
│   ├── secp256k1.rs           // Secret verification
│   └── oracle.rs              // Price normalization, staleness
├── liquidity_router/
│   ├── pool_init.rs
│   ├── allocate_deallocate.rs
│   ├── approvals.rs
│   ├── create_close_position.rs
│   ├── fee_collection.rs
│   ├── il_distribution.rs     // Impermanent loss cross-asset
│   └── burn_from_internal.rs
└── integration/
    ├── full_mint_cycle.rs
    ├── full_burn_cycle.rs
    ├── liquidation_with_burns.rs
    └── buy_and_burn_cycle.rs
```

### 10.2 Invariant Tests

Fuzz the following with random sequences of operations:

- `wsxmr_supply == sum(vault_debts) + pending_burn_debt + bad_debt`
- `sum(vault.collateral_amount) + sum(vault.locked_collateral) + war_chest + pending_collateral == total_collateral_held`
- No vault has `collateral_ratio < 150%` after any non-liquidation operation
- `global_debt_index` never reaches 0
- `global_total_debt` matches sum of all `get_actual_debt(vault.normalized_debt)`

### 10.3 Economic Simulation

Port the backtesting framework to simulate:
- Sustained XMR price increases (LP collateral stress)
- Flash crashes (liquidation cascades)
- Yield accrual over time (buy-and-burn effectiveness)
- MEV attack scenarios on buy-and-burn swaps

---

## 11. Migration and Deployment

### 11.1 Deployment Order

1. Deploy `wrapsynth_vault_manager` program
2. Call `initialize` to create GlobalState and wsXMR mint
3. Deploy `wrapsynth_liquidity_router` program
4. Call `initialize_router` with vault manager address
5. Call `set_liquidity_router` on vault manager with router address
6. Call `initialize_pool` on router to create Orca Whirlpool

### 11.2 Program Upgradability

Use Anchor's upgradable program pattern with a multisig upgrade authority. After sufficient battle-testing, freeze the program (remove upgrade authority) to match the EVM contract's immutability.

### 11.3 Rent Recovery

Terminal-state PDAs (completed/cancelled MintRequests, BurnRequests) should be closeable to recover rent. Add `close_mint_request` and `close_burn_request` instructions that verify terminal status and close the account, returning rent to a designated address.

---

## 12. Open Design Decisions

1. **Collateral asset:** mSOL (SOL-denominated) vs. USDC lending receipt (USD-denominated). Affects collateral ratios, liquidation dynamics, and correlation risk.

2. **secp256k1 vs Ed25519:** Keeping secp256k1 maintains Monero atomic swap compatibility. Switching to Ed25519 is more Solana-native but requires modifying the off-chain swap protocol.

3. **DEX for buy-and-burn:** Orca Whirlpool (direct CPI) vs. Jupiter aggregator (better routing, but more complex CPI). Jupiter is recommended for buy-and-burn to minimize slippage.

4. **Vault enumeration for reconciliation:** Off-chain indexer (Helius, Triton) vs. on-chain linked list. Indexer is simpler but adds infrastructure dependency.

5. **Transaction versioning:** Use legacy transactions or versioned transactions with address lookup tables (ALTs). ALTs reduce account overhead for complex instructions like liquidation.

6. **Maximum accounts per instruction:** Solana limits to 64 accounts per instruction (256 with ALTs). Liquidation with burn resolution may need careful account planning.

---

## 13. File Structure

```
programs/
├── wrapsynth-vault-manager/
│   └── src/
│       ├── lib.rs                    // Program entrypoint, instruction dispatch
│       ├── state/
│       │   ├── mod.rs
│       │   ├── global_state.rs
│       │   ├── vault.rs
│       │   ├── mint_request.rs
│       │   ├── burn_request.rs
│       │   └── pending_returns.rs
│       ├── instructions/
│       │   ├── mod.rs
│       │   ├── initialize.rs
│       │   ├── vault_management.rs   // create, deposit, withdraw, configure
│       │   ├── mint_flow.rs          // initiate, ready, finalize, cancel
│       │   ├── burn_flow.rs          // request, propose, confirm, finalize, slash, cancel
│       │   ├── liquidation.rs        // resolve_burn + execute
│       │   ├── buy_and_burn.rs
│       │   ├── withdrawals.rs        // withdraw_returns
│       │   └── reconciliation.rs
│       ├── utils/
│       │   ├── mod.rs
│       │   ├── math.rs              // Safe math, debt calculations, ratio checks
│       │   ├── oracle.rs            // Pyth price normalization
│       │   ├── secp256k1.rs         // Secret verification
│       │   └── yield.rs             // sync_vault_yield
│       └── errors.rs
├── wrapsynth-liquidity-router/
│   └── src/
│       ├── lib.rs
│       ├── state/
│       │   ├── mod.rs
│       │   ├── router_state.rs
│       │   ├── liquidity_position.rs
│       │   ├── user_router_state.rs
│       │   └── approval.rs
│       ├── instructions/
│       │   ├── mod.rs
│       │   ├── initialize.rs
│       │   ├── pool_management.rs
│       │   ├── allocations.rs       // allocate, deallocate, deposit, withdraw
│       │   ├── approvals.rs
│       │   ├── positions.rs         // create, close
│       │   ├── fees.rs              // collect, withdraw
│       │   └── burn_internal.rs
│       ├── utils/
│       │   ├── mod.rs
│       │   ├── orca.rs              // Whirlpool CPI helpers
│       │   └── math.rs
│       └── errors.rs
tests/
├── vault_manager/
├── liquidity_router/
└── integration/
Anchor.toml
Cargo.toml
```