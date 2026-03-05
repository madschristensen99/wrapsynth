# WrapSynth Solana Architecture

## Overview

WrapSynth Solana is a trustless bridge bringing Monero (XMR) to the Solana blockchain using atomic swaps, collateralized vaults, and cryptographic commitments. This document details the architectural decisions and implementation specifics.

## Core Design Principles

### 1. Account-Based State Model

Unlike EVM's shared contract storage, Solana uses an account-based model where each piece of state lives in its own account. This enables:

- **Parallel transaction processing**: Non-conflicting transactions execute simultaneously
- **Rent-exempt accounts**: Accounts with sufficient SOL are permanent
- **Deterministic addressing**: PDAs provide predictable account addresses

### 2. Program Derived Addresses (PDAs)

PDAs are deterministic addresses derived from seeds, enabling:

- **Canonical accounts**: One vault per LP+collateral combination
- **Program signing**: PDAs can sign CPIs without private keys
- **Composability**: Other programs can derive and interact with our accounts

### 3. Fixed-Point Mathematics

Solana doesn't support floating-point in BPF. We use:

- **u128 for intermediate calculations**: Prevents overflow
- **18-decimal precision for debt index**: `1e18` base unit
- **Checked arithmetic**: All operations use `.checked_*()` methods

## State Architecture

### GlobalState PDA

**Seeds**: `[b"global_state"]`

```rust
pub struct GlobalState {
    pub mint_authority_bump: u8,      // Bump for mint authority PDA
    pub global_debt_index: u64,       // Starts at 1e18, scales debt
    pub yield_war_chest: u64,         // Accumulated yield tokens
    pub global_lp_principal: u64,     // Sum of all LP principals
    pub last_buy_timestamp: i64,      // Cooldown for strategies
    pub price_max_age: u64,           // Max Pyth price staleness
    pub wsxmr_mint: Pubkey,           // SPL token mint
    pub admin: Pubkey,                // Admin authority
}
```

**Purpose**: 
- Central coordination point for protocol
- Holds mint authority for wsXMR token
- Tracks global debt scaling factor
- Manages yield accumulation

**Debt Index Mechanism**:
```
actual_debt = (normalized_debt × global_debt_index) / 1e18
```

This allows O(1) debt updates across all vaults when yield is harvested.

### Vault PDA

**Seeds**: `[b"vault", lp_pubkey, collateral_mint]`

```rust
pub struct Vault {
    pub lp_address: Pubkey,           // LP owner
    pub collateral_mint: Pubkey,      // Collateral token type
    pub collateral_amount: u64,       // Total collateral deposited
    pub locked_collateral: u64,       // Reserved for active burns
    pub normalized_debt: u64,         // Debt scaled by index
    pub pending_debt: u64,            // Reserved for pending mints
    pub lp_principal: u64,            // Original deposit for yield calc
    pub mint_fee_bps: u16,            // Fee charged on mints (0-10000)
    pub burn_reward_bps: u16,         // Reward given on burns (0-10000)
    pub max_mint_bps: u16,            // Max mint as % of debt (0-10000)
    pub mint_griefing_deposit: u64,   // SOL required to initiate mint
    pub active: bool,                 // Vault operational status
}
```

**Purpose**:
- Individual LP collateralized debt position
- Isolated risk per LP
- Customizable parameters per vault

**Health Calculation**:
```
collateral_ratio = (collateral_value_usd × 100) / debt_value_usd
healthy = collateral_ratio ≥ 150%
liquidatable = collateral_ratio < 120%
```

### MintRequest PDA

**Seeds**: `[b"mint_request", request_id]`

```rust
pub struct MintRequest {
    pub request_id: [u8; 32],         // Unique identifier
    pub lp_vault: Pubkey,             // Vault fulfilling request
    pub initiator: Pubkey,            // Who paid griefing deposit
    pub recipient: Pubkey,            // Who receives wsXMR
    pub wsxmr_amount: u64,            // Amount to mint
    pub fee_amount: u64,              // Fee to LP
    pub claim_commitment: [u8; 32],   // Hash(secret) for atomic swap
    pub timeout: i64,                 // Unix timestamp deadline
    pub griefing_deposit: u64,        // SOL locked as spam prevention
    pub status: u8,                   // 0-4: Invalid/Pending/Ready/Completed/Cancelled
}
```

**Purpose**:
- Tracks mint request lifecycle
- Holds griefing deposit
- Enforces atomic swap commitment

**Status Flow**:
```
Pending → Ready → Completed
   ↓
Cancelled (if timeout)
```

### BurnRequest PDA

**Seeds**: `[b"burn_request", request_id]`

```rust
pub struct BurnRequest {
    pub request_id: [u8; 32],         // Unique identifier
    pub user: Pubkey,                 // User burning wsXMR
    pub lp_vault: Pubkey,             // Vault handling burn
    pub wsxmr_amount: u64,            // Amount burned
    pub locked_collateral: u64,       // Base collateral locked
    pub reward_collateral: u64,       // Bonus for user
    pub secret_hash: [u8; 32],        // LP's secret hash
    pub deadline: i64,                // LP must reveal before this
    pub status: u8,                   // 0-6: Invalid/Requested/Proposed/Committed/Completed/Slashed/Cancelled
}
```

**Purpose**:
- Manages 3-step burn handshake
- Locks collateral during process
- Enables slashing if LP fails

**Status Flow**:
```
Requested → Proposed → Committed → Completed
                          ↓
                       Slashed (if LP timeout)
```

## Instruction Architecture

### Initialization Flow

```
initialize_global
    ↓
[GlobalState created, wsXMR mint initialized]
    ↓
create_vault (per LP)
    ↓
deposit_collateral
    ↓
set_vault_params
```

### Mint Flow (XMR → wsXMR)

```
1. User: initiate_mint
   - Pay griefing deposit
   - Provide claim_commitment = hash(secret)
   - Reserve vault capacity

2. LP: confirm_mint (off-chain XMR verified)
   - Mark request as Ready

3. User: finalize_mint
   - Reveal secret
   - Verify secret matches commitment (secp256k1)
   - Mint wsXMR to recipient
   - Mint fee to LP
   - Refund griefing deposit
   - Update vault debt

Alternative: cancel_mint (if LP doesn't confirm)
   - After timeout
   - LP gets griefing deposit
```

### Burn Flow (wsXMR → XMR)

```
1. User: request_burn
   - Burn wsXMR tokens immediately
   - Create burn request

2. LP: propose_burn
   - Lock collateral (base + reward)
   - Provide secret_hash
   - Send XMR off-chain

3. User: commit_burn
   - Verify XMR received
   - Commit to burn

4. LP: finalize_burn
   - Reveal secret
   - Verify hash(secret) == secret_hash
   - Release collateral to LP
   - Send reward to user
   - Update vault debt

Alternative: claim_slashed_collateral
   - If LP doesn't reveal secret before deadline
   - User seizes all locked collateral
```

### Liquidation Flow

```
liquidate
    ↓
Check vault health < 120%
    ↓
Burn liquidator's wsXMR
    ↓
Transfer collateral × 110% to liquidator
    ↓
Update vault debt
```

## Cryptographic Components

### secp256k1 Verification

Using the `k256` crate for native Rust cryptography:

```rust
pub fn verify_secret_commitment(secret: &[u8; 32], commitment: &[u8; 32]) -> Result<bool> {
    // Convert secret to scalar
    let scalar = Scalar::from_bytes(secret)?;
    
    // Compute point: P = secret × G
    let point = (ProjectivePoint::GENERATOR * scalar).to_affine();
    
    // Hash the point
    let hash = sha256(point.to_encoded_point(false));
    
    // Verify hash matches commitment
    Ok(hash == commitment)
}
```

This replaces EVM's `ecrecover` trick with proper elliptic curve operations.

### Atomic Swap Commitments

**Mint**: User commits to `claim_commitment = hash(secret)`, reveals secret to claim wsXMR

**Burn**: LP commits to `secret_hash`, must reveal secret to unlock collateral

Both use SHA-256 hashing for commitments.

## Oracle Integration

### Pyth Network Pull Model

Unlike EVM where Pyth pushes prices, Solana uses pull oracles:

```rust
pub fn get_price_from_pyth(
    price_update: &AccountInfo,
    feed_id_hex: &str,
    max_age: u64,
    clock: &Clock,
) -> Result<(i64, u64)> {
    // Deserialize price update account
    let price_update_account = PriceUpdateV2::try_deserialize(...)?;
    
    // Get price feed
    let price_feed = price_update_account
        .get_price_no_older_than(&clock, max_age, &feed_id)?;
    
    // Verify confidence interval < 10%
    require!(
        price_feed.conf × 10 ≤ price_feed.price,
        OracleConfidenceTooWide
    );
    
    Ok((price_feed.price, price_feed.exponent))
}
```

**Key Features**:
- Prices must be pushed in same transaction
- Staleness checks enforced
- Confidence interval validation
- Multi-feed support (XMR, ETH, etc.)

## Economic Model

### Collateralization

```
Minimum Ratio: 150%
Liquidation Threshold: 120%
Liquidation Bonus: 110% (10% profit to liquidator)
```

### Fee Structure

```
Mint Fee: 0-100% (configurable per vault, typically 0.3%)
Burn Reward: 0-100% (configurable per vault, typically 0.2%)
```

### Normalized Debt System

Allows protocol to distribute yield/losses across all vaults in O(1):

```rust
// When minting
normalized_debt += (amount × 1e18) / global_debt_index

// When burning
normalized_debt -= (amount × 1e18) / global_debt_index

// When harvesting yield
global_debt_index = (global_debt_index × total_debt_after) / total_debt_before
```

## Security Considerations

### Account Validation

Every instruction validates:
- PDA derivation matches expected seeds
- Signer authority matches expected owner
- Token mints match expected types
- Account ownership is correct

### Arithmetic Safety

All math uses checked operations:
```rust
amount.checked_add(fee).ok_or(MathOverflow)?
```

### Reentrancy Protection

Solana's account model prevents reentrancy:
- Accounts can only be borrowed once per instruction
- CPIs can't call back into same program

### Oracle Security

- Confidence interval checks (max 10%)
- Staleness checks (configurable max age)
- Multiple price feeds for redundancy

## Performance Characteristics

### Parallel Execution

Transactions touching different vaults can execute in parallel:
- Vault A mint + Vault B burn = parallel
- Vault A mint + Vault A burn = sequential

### Compute Units

Estimated compute units per instruction:
- `initialize_global`: ~50k CU
- `create_vault`: ~30k CU
- `deposit_collateral`: ~40k CU
- `initiate_mint`: ~60k CU
- `finalize_mint`: ~100k CU (crypto verification)
- `liquidate`: ~120k CU (oracle + math)

### Account Rent

All accounts are rent-exempt:
- GlobalState: ~0.003 SOL
- Vault: ~0.002 SOL
- MintRequest: ~0.002 SOL
- BurnRequest: ~0.002 SOL

## Comparison: EVM vs Solana

| Aspect | EVM (Gnosis) | Solana |
|--------|--------------|--------|
| State Model | Contract storage | Account-based PDAs |
| Parallelization | Sequential | Highly parallel |
| Crypto | ecrecover | Native k256 |
| Oracle | Push model | Pull model |
| Math | Solidity | Fixed-point u128 |
| Gas/Fees | ~$0.01-0.05 | ~$0.0001-0.001 |
| TPS | ~100 | ~3000 |

## Future Enhancements

### Planned Features

1. **Yield Strategies**: Auto-compound collateral in DeFi protocols
2. **Cross-Program Invocations**: Integrate with Orca, Raydium, etc.
3. **Governance**: On-chain parameter updates via DAO
4. **Insurance Fund**: Protocol-owned reserve for extreme events
5. **Recursive Proofs**: Reduce verification costs further

### Research Areas

1. **ZK Compression**: Reduce account storage costs
2. **Cross-Chain Messaging**: Bridge wsXMR to other chains via Wormhole
3. **Privacy Relayers**: Anonymous minting without revealing recipient
4. **Decentralized Oracle**: Multi-node Monero block verification

---

**Document Version**: 1.0.0  
**Last Updated**: March 2026  
**Architecture**: Solana + Anchor Framework
