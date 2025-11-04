# PushOracle - Monero ZK Proof Data Oracle

A trusted oracle that fetches and serves raw Monero blockchain data for ZK proof verification. This is a temporary centralized solution that will eventually be replaced with a decentralized ZK-TLS oracle network managed by wXMR governance.

## What This Is

PushOracle is a Rust-based TCP server that:
1. **Connects to a Monero node** (`http://node.monerodevs.org:38089`)
2. **Fetches real blockchain data** including block headers, transaction hashes, and commitment data
3. **Provides standardized endpoints** for ZK proof verification
4. **Serves data in formats** consumable by zero-knowledge circuits

## Current Architecture

### Components
- **`xmrData.rs`** - Core Monero blockchain data structures for ZK proofs
  - Block headers (version, prev_id, merkle_root, timestamp, nonce, height)
  - Transaction data (tx_hash, pub_key, amount, rct_type, key_images, output_pk, commitments)
  - Methods to serialize to byte arrays for ZK circuits

- **`server.rs`** - TCP-based oracle server
  - Background data fetching every 30 seconds
  - Two main endpoints:
    - `GET_BLOCK_DATA` - Returns structured JSON of block and transaction data
    - `GET_ZK_BYTES` - Returns raw bytes for direct ZK proof consumption

### Build & Run
```bash
cd pushOracle
cargo check     # Verify builds
cargo run       # Start server on port 38089
# Server will auto-fetch from http://node.monerodevs.org:38089
```

## Current Usage

**TCP Client Example:**
```bash
# Get structured data
echo "GET_BLOCK_DATA" | nc 127.0.0.1 38089

# Get bytes for ZK circuits
echo "GET_ZK_BYTES" | nc 127.0.0.1 38089
```

## Future Roadmap: Decentralized ZK-TLS Oracle Network

### Phase 1: ZK-TLS Implementation (Q1 2024)
- Replace trusted oracle with **ZK-TLS proofs** that don't require trusting individual nodes
- **Zero-knowledge verification** of Monero node responses without revealing private data
- **On-chain verification** of TLS session integrity

### Phase 2: Governance Token (wXMR)
- **wXMR holders manage** approved Monero node URLs on-chain
- **Governance votes** add/remove node endpoints
- **Slashing mechanisms** for node misreporting
- **Staked wXMR** required for oracle participation

### Phase 3: Distributed Network
- **Multiple ZK oracles** run by wXMR stakers
- **Consensus mechanism** for agreeing on correct data
- **Fraud proofs** to challenge incorrect ZK proofs
- **Decentralized incentive alignment** via wXMR rewards

### Phase 4: Advanced Features
- **Cross-consensus proofs** between multiple nodes
- **Sub-block finality** using Monero mempool data
- **Real-time validation** of spends and outputs
- **Integration with wXMR bridge** for atomic swaps

## Technical Migration Path

### From Trusted → Trustless
1. **Current**: Single trusted node (`node.monerodevs.org`)
2. **ZK-TLS v1**: Prove specific node responses without trust
3. **Governance Layer**: wXMR token holders vote on node endpoints
4. **Network**: Multiple staked validators provide ZK-TLS proofs
5. **Final State**: Fully decentralized with governance via wXMR

### Security Model Evolution
- **Today**: Trust the oracle operator
- **ZK-TLS**: Trust the cryptographic proof over specific URLs
- **Governance**: Trust the wXMR token voting mechanism
- **Network**: Trust the distributed consensus system

## API Changes (Future)

**Current:**
```
GET_BLOCK_DATA -> "centralized data"
```

**Future:**
```
GET_ZK_PROOF -> "ZK-TLS proof from staked wXMR validator"
GET_GOVERNANCE_NODES -> "List of approved node URLs"
GET_VALIDATOR_REGISTRY -> "wXMR staker address mappings"
```

## Integration Notes

- **Temporary**: Use this for testing ZK circuits on real Monero data
- **Future**: Switch to ZK-TLS proofs for production
- **Bridge Impact**: Existing wXMR bridge will migrate to use new proofs seamlessly
- **Governance**: wXMR holders vote on new node additions/removals

---

**Status**: Phase 0 (Trusted Oracle) ✅  
**Next**: Built-in ZK-TLS circuits for phase 1