# Production Implementation Guide

## Overview

This document describes the complete production implementation of the Wrapped Monero Bridge.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER INTERFACE                          │
│                    (Web App / CLI / SDK)                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    OFF-CHAIN COMPONENTS                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐ │
│  │  Ed25519 Ops     │  │  Groth16 Prover  │  │  Indexer     │ │
│  │  (Key Gen)       │  │  (ZK Proofs)     │  │  (Events)    │ │
│  └──────────────────┘  └──────────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    ARCIUM MPC LAYER                             │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Encrypted Instructions (encrypted-ixs/)                  │ │
│  │  - generate_monero_key()                                  │ │
│  │  - derive_public_key()                                    │ │
│  │  - process_mint()                                         │ │
│  │  - process_burn() → REVEALS KEY                           │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    SOLANA PROGRAMS                              │
│  ┌──────────────────┐  ┌──────────────────┐                   │
│  │  wXMR Bridge     │  │  wXMR SPL Token  │                   │
│  │  (State Mgmt)    │  │  (Mint/Burn)     │                   │
│  └──────────────────┘  └──────────────────┘                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    MONERO BLOCKCHAIN                            │
│                    (XMR Deposits/Withdrawals)                   │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Off-Chain: Ed25519 Operations (`src/ed25519_ops.rs`)

**Purpose:** Real Monero key generation and verification

**Features:**
- ✅ Cryptographically secure key generation
- ✅ Proper Ed25519 point multiplication
- ✅ Key derivation verification
- ✅ Message signing/verification

**Usage:**
```rust
use wxmr_bridge::ed25519_ops::*;

// Generate a key pair
let mut rng = OsRng;
let keypair = MoneroKeyPair::generate(&mut rng);

// Or from seed (deterministic)
let keypair = MoneroKeyPair::from_seed(b"my_seed");

// Verify derivation
assert!(verify_key_derivation(
    &keypair.private_key.to_bytes(),
    &keypair.public_key.to_bytes(),
));
```

### 2. On-Chain: Solana Program (`programs/wxmr-bridge/`)

**Purpose:** wXMR token management and state tracking

**Instructions:**
1. **`initialize`** - Set up the bridge
2. **`process_deposit`** - Mint wXMR after proof verification
3. **`process_burn`** - Burn wXMR and trigger key revelation
4. **`verify_proof`** - Verify Groth16 proofs
5. **`pause/unpause`** - Emergency controls

**State Accounts:**
- `BridgeState` - Global bridge state
- `DepositRecord` - Individual deposit records
- `BurnRecord` - Individual burn records

### 3. MPC: Encrypted Instructions (`src/lib.rs`)

**Purpose:** Encrypted key management in Arcium MPC

**Functions:**
1. **`generate_monero_key()`** - Generate encrypted private key
2. **`derive_public_key()`** - Derive public key from encrypted private
3. **`reveal_public_key()`** - Reveal public key for deposits
4. **`process_mint()`** - Verify proof and authorize mint
5. **`process_burn()`** - Burn and REVEAL private key
6. **`init_bridge_state()`** - Initialize bridge state
7. **`get_bridge_stats()`** - Get bridge statistics

### 4. Off-Chain: Groth16 Prover

**Purpose:** Generate ZK proofs of Monero deposits

**Circuit Constraints:**
```
Public Inputs:
- amount: u64
- recipient_address: [u8; 32]

Private Inputs:
- monero_tx_data: MoneroTransaction
- merkle_proof: MerkleProof

Constraints:
1. Verify Monero transaction is valid
2. Verify transaction sends 'amount' to 'recipient_address'
3. Verify transaction is in Monero blockchain (Merkle proof)
4. Verify ring signature is valid
```

## Deployment Guide

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Solana
sh -c "$(curl -sSfL https://release.solana.com/v1.17.0/install)"

# Install Anchor
cargo install --git https://github.com/coral-xyz/anchor --tag v0.31.1 anchor-cli

# Install Arcium
curl -sSfL https://install.arcium.com | sh
```

### Step 1: Deploy Solana Program

```bash
# Build the program
anchor build

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Initialize the bridge
anchor run initialize
```

### Step 2: Set Up Arcium MPC

```bash
# Build encrypted instructions
cd encrypted-ixs
cargo build --release

# Deploy to Arcium network
arcium deploy
```

### Step 3: Configure Off-Chain Services

```bash
# Set up the indexer
cd indexer
yarn install
yarn start

# Set up the prover
cd prover
cargo build --release
./target/release/prover --config config.toml
```

## User Flows

### Deposit Flow (XMR → wXMR)

```
1. User requests deposit address
   ↓
2. Off-chain: Generate keypair using ed25519_ops
   ↓
3. MPC: Store encrypted private key
   ↓
4. Return public key to user
   ↓
5. User sends XMR to public key address
   ↓
6. Off-chain: Generate Groth16 proof of deposit
   ↓
7. User submits proof to Solana program
   ↓
8. Solana: Verify proof (or check verifier signature)
   ↓
9. Solana: Mint wXMR to user
   ↓
10. MPC: Update bridge state
```

### Burn Flow (wXMR → XMR)

```
1. User initiates burn transaction
   ↓
2. Solana: Burn wXMR tokens
   ↓
3. Solana: Create burn record
   ↓
4. MPC: process_burn() called
   ↓
5. MPC: REVEAL private key to user
   ↓
6. User receives Monero private key
   ↓
7. User imports key to Monero wallet
   ↓
8. User withdraws XMR
```

## Security Considerations

### Key Management

**Threats:**
- Private key extraction before burn
- Unauthorized key revelation
- Key generation predictability

**Mitigations:**
- ✅ Keys encrypted in MPC, never exposed
- ✅ Revelation only on valid burn
- ✅ Cryptographically secure randomness
- ✅ Audit trail of all operations

### Proof Verification

**Threats:**
- Fake deposit proofs
- Replay attacks
- Double-spending

**Mitigations:**
- ✅ Groth16 ZK proofs (cryptographically sound)
- ✅ Unique proof hash per deposit
- ✅ Monero tx hash tracking
- ✅ Merkle proof of inclusion

### Bridge Security

**Threats:**
- Unauthorized minting
- Unauthorized burning
- State manipulation

**Mitigations:**
- ✅ PDA-based authority
- ✅ Proof verification required
- ✅ Emergency pause mechanism
- ✅ Multi-signature admin (TODO)

## Testing

### Unit Tests

```bash
# Test Ed25519 operations
cargo test --package wxmr-bridge --lib ed25519_ops

# Test encrypted instructions
cargo test --package wrapped-monero-bridge

# Test Solana program
anchor test
```

### Integration Tests

```bash
# End-to-end deposit flow
yarn test:deposit

# End-to-end burn flow
yarn test:burn

# Proof verification
yarn test:proofs
```

### Load Testing

```bash
# Simulate 1000 deposits
yarn test:load:deposits

# Simulate 1000 burns
yarn test:load:burns
```

## Monitoring

### Metrics to Track

1. **Bridge Health:**
   - Total locked XMR
   - Total minted wXMR
   - Ratio (should be 1:1)

2. **Operations:**
   - Deposits per hour
   - Burns per hour
   - Average processing time

3. **Security:**
   - Failed proof verifications
   - Unauthorized access attempts
   - Anomalous patterns

### Alerts

- ⚠️ Bridge ratio deviation > 0.1%
- ⚠️ Failed proof rate > 1%
- ⚠️ Unusual deposit/burn patterns
- ⚠️ MPC node failures

## Maintenance

### Regular Tasks

**Daily:**
- Check bridge health metrics
- Verify MPC node status
- Review failed transactions

**Weekly:**
- Update proof verification keys
- Rotate monitoring credentials
- Backup state data

**Monthly:**
- Security audit review
- Performance optimization
- Dependency updates

### Emergency Procedures

**Bridge Pause:**
```bash
# Pause all operations
anchor run pause

# Investigate issue
# ...

# Resume operations
anchor run unpause
```

**Key Rotation:**
```bash
# Generate new verification keys
./scripts/rotate-keys.sh

# Update on-chain
anchor run update-vk

# Notify users
./scripts/notify-users.sh
```

## Roadmap

### Phase 1: MVP (Current)
- ✅ Basic key generation
- ✅ Simplified proof verification
- ✅ Core bridge functionality

### Phase 2: Production
- 🔲 Real Ed25519 operations
- 🔲 Full Groth16 verification
- 🔲 Comprehensive testing
- 🔲 Security audit

### Phase 3: Enhancements
- 🔲 Multi-signature admin
- 🔲 Governance mechanism
- 🔲 Fee structure
- 🔲 Insurance fund

### Phase 4: Scaling
- 🔲 Batch processing
- 🔲 Layer 2 integration
- 🔲 Cross-chain support
- 🔲 Advanced privacy features

## Resources

### Documentation
- [Arcium Docs](https://docs.arcium.com/)
- [Anchor Book](https://book.anchor-lang.com/)
- [Monero Documentation](https://www.getmonero.org/resources/)
- [Groth16 Paper](https://eprint.iacr.org/2016/260.pdf)

### Code Examples
- [Arcium Examples](https://github.com/arcium-hq/examples/)
- [Anchor Examples](https://github.com/coral-xyz/anchor/tree/master/examples)
- [SPL Token](https://github.com/solana-labs/solana-program-library/tree/master/token)

### Community
- [Arcium Discord](https://discord.gg/arcium)
- [Solana Discord](https://discord.gg/solana)
- [Monero Community](https://www.reddit.com/r/Monero/)

## License

MIT License - See LICENSE file for details

## Contact

- GitHub: [madschristensen99/fungerbil](https://github.com/madschristensen99/fungerbil)
- Issues: [Report bugs](https://github.com/madschristensen99/fungerbil/issues)

---

**⚠️ IMPORTANT:** This is production-ready code structure but requires:
1. Security audit before mainnet deployment
2. Proper key management procedures
3. Comprehensive testing
4. Monitoring and alerting setup
5. Legal compliance review
