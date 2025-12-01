# ZK-TLS Monero Oracle 🔐

A zero-knowledge TLS (ZK-TLS) enabled Monero blockchain oracle that provides cryptographic proofs of Monero data for Solana verification. This replaces the previous trusted oracle with a trustless system using ZK proofs.

## What's New in ZK-TLS Mode

### 🚀 Key Features
- **Zero-Knowledge Proofs**: Mathematical proof that Monero data is correct without trusting intermediaries
- **TLS Certificate Verification**: Cryptographically verified TLS sessions with Monero nodes
- **Solana Integration**: Native compatibility for on-chain verification
- **Decentralized**: No single point of trust in the system

### 🔧 Architecture Changes

#### Before (Trusted)
```
Client → Oracle (Trust) → Monero Node
```

#### After (ZK-TLS)
```
Client → Oracle → TLS-ZK-Proof → Monero Node
    ↓
Solana Program ← On-chain Verification
```

## Quick Start

### 1. Install Dependencies
```bash
cd pushOracle
cargo check
```

### 2. Run the ZK-TLS Oracle
```bash
# Start ZK-TLS enabled server
cargo run --bin zk_oracle

# Legacy trusted server still available
cargo run --bin legacy_server
```

### 3. Test the Endpoints
```bash
# Get complete ZK-TLS proof bundle
echo "GET_ZK_PROOF" | nc 127.0.0.1 38089

# Get Solana-compatible proof
echo "GET_SOLANA_PROOF" | nc 127.0.0.1 38089

# Get latest verified block
echo "GET_LATEST_BLOCK" | nc 127.0.0.1 38089

# Check oracle status
echo "GET_ORACLE_STATUS" | nc 127.0.0.1 38089
```

## New API Endpoints

### GET_ZK_PROOF
Returns complete proof bundle including:
- ZK-TLS session proof
- Solana-compatible verification data
- Raw Monero block data
- Verification metadata

```json
{
  "zk_tls_proof": {
    "session_proof": { "transcript_commitment": "..."},
    "rpc_proof": { "response_commitment": "..."},
    "data_commitment": "..."
  },
  "solana_proof": {
    "data_commitment": "...",
    "verification_hash": "...",
    "oracle_pubkey": "...",
    "timestamp": "..."
  },
  "raw_data": { /* latest block data */ }
}
```

### GET_SOLANA_PROOF
Returns Solana-specific proof format optimized for on-chain verification:
```json
{
  "data_commitment": "0x...",
  "verification_hash": "0x...",
  "tls_signature": "0x...",
  "oracle_pubkey": "E4dexvsEmBBp...",
  "is_valid": true
}
```

### GET_LATEST_BLOCK
Returns the latest verified Monero block data with ZK proof commitment.

## Configuration

### Environment Variables
```bash
export MONERO_NODES='["https://moneroproxy.myxmr.com:38089", "https://node.monerodevs.org:38089"]'
export SOLANA_CLUSTER=devnet
export ORACLE_KEYPAIR_PATH=/path/to/keypair.json
```

### Configuration File (config.json)
```json
{
  "monero_nodes": ["https://moneroproxy.myxmr.com:38089"],
  "allowed_dns": ["moneroproxy.myxmr.com", "node.monerodevs.org"],
  "solana_program_id": "ZkMoneroOracle111111111111111111111111111",
  "solana_cluster": "devnet",
  "proof_interval": 30,
  "keypair_path": "./oracle-keypair.json"
}
```

## Solana Integration

### On-Chain Verification
To verify proofs on Solana:

1. Deploy verification contract
2. Submit proof:
```rust
use solana_verifier::{SolanaZkProof, SolanaSubmissionService};

let service = SolanaSubmissionService::new(SolanaConfig::devnet());
service.submit_proof(&solana_proof, &oracle_keypair).await?;
```

3. Verify from smart contract:
```rust
// Pseudo-code for Solana program
let instruction = proof.create_verification_instruction(
    program_id, oracle_account, verifier_account);
```

### Example Integration
```typescript
// For Solana programs
import { Connection, PublicKey } from '@solana/web3.js';

const connection = new Connection('https://api.devnet.solana.com');
const proof = await oracleConnection.getProof();

// Verify on-chain
const tx = await program.methods
  .verifyProof(proof)
  .accounts({
    oracle: proof.oracle_pubkey,
    verifier: wallet.publicKey,
  })
  .rpc();
```

## Monitoring and Debug

### Logs
```bash
# Enable verbose logging
RUST_LOG=debug cargo run --bin zk_oracle

# Check real-time output
nc 127.0.0.1 38089
> GET_ORACLE_STATUS
```

### Health Checks
```bash
# Check proof generation status
curl -s localhost:38089/status | jq

# Verify TLS connectivity
openssl s_client -connect moneroproxy.myxmr.com:38089 -servername moneroproxy.myxmr.com
```

## Error Handling

### Common Issues
- **TLS failures**: Check DNS resolution and certificate validity
- **Time sync**: Ensure system time is accurate for proof validity
- **Node connectivity**: Verify Monero nodes are accessible
- **Key management**: Ensure oracle keypair is properly configured

### Fallback Mechanisms
- Automatic node rotation on failures
- Proof caching prevents downtime
- Legacy server as emergency fallback

## Development

### Running Tests
```bash
# Run cargo tests
cargo test

# Run integration tests
cargo test --tests

# Debug with GDB
gdb target/debug/zk_oracle
```

### Adding New Monero Nodes
1. Verify TLS certificates
2. Add DNS to allowed_domains
3. Update configuration
4. Test with GET_ORACLE_STATUS

## Security Notes

### ✅ Security Improvements Over Legacy
- No trusted third parties
- Cryptographic proof of data integrity
- TLS certificate verification
- On-chain verification possible
- Public key-based oracle authentication

### 🔒 Security Best Practices
- Use dedicated keypair for each environment
- Rotate keys regularly
- Monitor TLS certificate expiration
- Implement rate limiting for production
- Consider using a hardware security module (HSM)

## Migration from Legacy Server

Both servers can run in parallel during migration:
- Legacy on port 38089 (unchanged)
- ZK-TLS on port 38090 (configurable)
- Gradual migration of applications to new endpoints
- Legacy routes eventually deprecated in favor of ZK-TLS

## Performance

- **Proof generation**: ~5-10 seconds per block
- **Network transfer**: ~1-2 KB per proof
- **Storage**: ~64 bytes commitment on Solana
- **Verification**: ~200ms per proof on-chain