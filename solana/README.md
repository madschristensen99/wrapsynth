# WrapSynth Solana - Monero Bridge on Solana

A trustless bridge bringing Monero (XMR) to Solana using atomic swaps, collateralized vaults, and the Anchor framework.

## Architecture Overview

This is a Solana implementation of the WrapSynth protocol, transitioning from EVM's shared-state contract model to Solana's highly parallelized, account-based architecture using Program Derived Addresses (PDAs).

### Key Differences from EVM Version

- **Account-based state** instead of contract storage mappings
- **PDAs (Program Derived Addresses)** for deterministic account derivation
- **Native Rust cryptography** (k256 crate) instead of ecrecover
- **Pyth pull oracle** integration with confidence checks
- **Fixed-point math** (u128) to avoid floating-point issues
- **Normalized debt indexing** for O(1) yield distribution

## State Accounts (PDAs)

### GlobalState
- Seeds: `[b"global_state"]`
- Tracks systemic debt, protocol yield, and mint authority
- Fields: debt index, yield war chest, LP principal, price settings

### Vault
- Seeds: `[b"vault", lp_pubkey, collateral_mint]`
- Individual LP collateralized debt position
- Fields: collateral, debt, fees, griefing deposits, status

### MintRequest
- Seeds: `[b"mint_request", request_id]`
- Tracks user mint requests with atomic swap commitments
- Fields: amounts, commitment, timeout, status

### BurnRequest
- Seeds: `[b"burn_request", request_id]`
- Manages wsXMR → XMR conversion with 3-step handshake
- Fields: amounts, secret hash, deadline, locked collateral

## Core Instructions

### Initialization
- `initialize_global` - Bootstrap global state and wsXMR mint

### Vault Management
- `create_vault` - Create new LP vault
- `deposit_collateral` - Add collateral to vault
- `withdraw_collateral` - Remove collateral (if health allows)
- `set_vault_params` - Configure fees and limits

### Mint Flow (XMR → wsXMR)
1. `initiate_mint` - User creates mint request with commitment
2. `confirm_mint` - LP confirms XMR receipt off-chain
3. `finalize_mint` - User reveals secret, receives wsXMR
4. `cancel_mint` - Cancel if LP doesn't respond

### Burn Flow (wsXMR → XMR)
1. `request_burn` - User burns wsXMR tokens
2. `propose_burn` - LP locks collateral and proposes secret
3. `commit_burn` - User commits after receiving XMR
4. `finalize_burn` - LP reveals secret, unlocks collateral
5. `claim_slashed_collateral` - User claims if LP times out

### Liquidation & Yield
- `liquidate` - Liquidate undercollateralized vaults
- `harvest_yield` - Extract yield from vault positions

## Security Features

### Collateralization Ratios
- **Minimum Ratio**: 150% overcollateralization
- **Liquidation Threshold**: 120%
- **Liquidation Bonus**: 110% (10% bonus to liquidator)

### Cryptographic Security
- **secp256k1 verification** using k256 crate
- **Atomic swap commitments** prevent fund loss
- **24-hour timeouts** with slashing for non-compliance

### Oracle Security
- **Pyth Network** pull-based price feeds
- **Confidence checks**: Max 10% variance allowed
- **Staleness checks**: Configurable max age

## Building & Testing

### Prerequisites
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"

# Install Anchor
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest
avm use latest
```

### Build
```bash
cd solana
anchor build
```

### Test
```bash
anchor test
```

### Deploy to Devnet
```bash
anchor deploy --provider.cluster devnet
```

### Deploy to Mainnet
```bash
anchor deploy --provider.cluster mainnet
```

## Program Structure

```
programs/wsxmr_solana/src/
├── lib.rs                      # Program entry point
├── constants.rs                # Protocol constants
├── error.rs                    # Error codes
├── state/                      # State account definitions
│   ├── global_state.rs
│   ├── vault.rs
│   ├── mint_request.rs
│   └── burn_request.rs
├── utils/                      # Utility functions
│   ├── crypto.rs              # secp256k1 verification
│   ├── oracle.rs              # Pyth integration
│   └── math.rs                # Fixed-point math
└── instructions/              # Instruction handlers
    ├── initialize_global.rs
    ├── create_vault.rs
    ├── deposit_collateral.rs
    ├── withdraw_collateral.rs
    ├── set_vault_params.rs
    ├── initiate_mint.rs
    ├── confirm_mint.rs
    ├── finalize_mint.rs
    ├── cancel_mint.rs
    ├── request_burn.rs
    ├── propose_burn.rs
    ├── commit_burn.rs
    ├── finalize_burn.rs
    ├── claim_slashed_collateral.rs
    ├── cancel_burn.rs
    ├── liquidate.rs
    └── harvest_yield.rs
```

## Dependencies

- **anchor-lang**: ^0.31.0 - Anchor framework
- **anchor-spl**: ^0.31.0 - SPL token integration
- **pyth-solana-receiver-sdk**: ^0.2.0 - Pyth oracle
- **k256**: ^0.13 - secp256k1 cryptography
- **sha2**: ^0.10 - Hashing functions

## Economic Parameters

```rust
COLLATERAL_RATIO = 150        // 150% minimum collateral
LIQUIDATION_RATIO = 120       // 120% liquidation threshold
LIQUIDATION_BONUS = 110       // 110% liquidator reward
BURN_TIMEOUT = 24 hours       // LP must reveal secret
MAX_MINT_TIMEOUT = 7 days     // Maximum mint timeout
WSXMR_DECIMALS = 8            // Token decimals
```

## Pyth Price Feeds

| Asset | Feed ID |
|-------|---------|
| XMR/USD | `46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d` |
| ETH/USD | `31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1` |

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | MathOverflow | Computational overflow in u128 |
| 6001 | VaultNotActive | Vault is disabled |
| 6002 | InsufficientCollateral | Vault health too low |
| 6003 | OracleConfidenceTooWide | Price confidence > 10% |
| 6004 | OraclePriceStale | Price update too old |
| 6005 | InvalidSecret | Secret verification failed |
| 6006 | Unauthorized | Invalid signer |
| 6007 | DeadlineNotReached | Timeout not reached |
| 6008 | ExceedsMaxMintBounds | Mint exceeds vault limits |

## Comparison: EVM vs Solana

| Feature | EVM (Gnosis) | Solana |
|---------|--------------|--------|
| State Model | Contract storage | Account-based PDAs |
| Parallelization | Sequential | Highly parallel |
| Crypto | ecrecover tricks | Native k256 crate |
| Oracle | Pyth (push) | Pyth (pull) |
| Math | Solidity | Fixed-point u128 |
| Gas Costs | ~$0.01-0.05 | ~$0.0001-0.001 |

## License

MIT License

## Disclaimer

⚠️ **EXPERIMENTAL SOFTWARE** - Not audited. Use at your own risk.

Before production deployment:
- Professional security audit required
- Extensive testing on devnet
- Economic modeling and stress testing
- Legal and regulatory review

---

Built with ❤️ for privacy and decentralization on Solana
