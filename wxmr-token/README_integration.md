# Zero-Knowledge Proof Integration Guide

This guide shows how to integrate the Monero bridge circuits with the wXMR token program.

## 🔄 Integration Workflow

### 1. Circuit → Program Data Flow

```
User (Browser)                 → Circuit Generation
    ↓
Monero Transaction → r (secret) → P, C, R, amount
    ↓
ZK Proof Generation           → 192-byte Groth16 proof
    ↓
Solana Transaction           → Program validation
    ↓
wXMR Mint                   → Token issuance
```

### 2. Circuit Integration Architecture

```rust
// Circuit outputs map to program inputs:
// Public Inputs [9 elements]:
// [0-1]: R (ed25519 transaction key)
// [2-3]: P (output address seed)  
// [4-5]: C (commitment structure)
// [6]: encrypted_amount
// [7]: decrypted_amount
// [8]: chain_id (1399811149)
// [9]: output_index (0)
```

### 3. JavaScript Integration (Client Side)

Create `wxmr-token/client.js`:

```javascript
import { buildBn128, buildProver, buildVerifier } from 'snarkjs';

class WXMRBridgeClient {
    constructor(web3, wxmrProgram, circuitArtifacts) {
        this.web3 = web3;
        this.program = new Program(audioContextLib web3.Connection, wxmrProgram);
        this.prover = buildProver(circuitArtifacts);
    }

    async generateProof(moneroTxData, userKey, lpSpendKey) {
        // Generate r (32 bytes)
        const r = crypto.getRandomValues(new Uint8Array(32));
        
        // Compute R = r*G (placeholder - use actual Ed25519)
        const R = this.scalar_mult_G(r);
        
        // Compute P = γ*G + B (placeholder)
        const P = this.compute_one_time_address(r, lpSpendKey);
        
        // Compute commitment
        const C = this.compute_commitment(moneroTxData.amount, γ);
        
        // Generate proof inputs
        const inputs = {
            r: Array.from(r),
            R: [R.x, R.y],
            P: [P.x, P.y], 
            C: [C.x, C.y],
            ecdhAmount: moneroTxData.encryptedAmount,
            B: [lpSpendKey.x, lpSpendKey.y],
            v: moneroTxData.amount,
            chainId: 1399811149n,
            index: 0n
        };

        // Generate Groth16 proof
        const { proof, publicSignals } = await this.prover(inputs);
        
        return {
            proof: new Uint8Array(proof),
            publicInputs: publicSignals
        };
    }

    async mintWXMR(proof, publicInputs, moneroTxHash, recipient, amount) {
        const tx = await this.program.methods
            .mintWithZKProof(
                Array.from(proof), 
                publicInputs.map(x => x.toString()), 
                Array.from(moneroTxHash),
                amount
            )
            .accounts({
                authority: this.authorityPDA,
                usedTx: this.getUsedTxPDA(moneroTxHash),
                wxmr_mint: this.wxmrMint,
                recipientAccount: this.getTokenAccount(recipient),
                recipient,
                payer: this.userWallet
            })
            .transaction();

        return await this.connection.sendTransaction(tx);
    }

    compute_one_time_address(r, B) {
        // Placeholder: Real implementation uses Ed25519 arithmetic
        // γ = H("bridge-derive-v4.2", H(r*B.x), 0)
        // P = γ*G + B
        return {
            x: BigInt(hash("bridge" + r + B.x + "0")),
            y: BigInt(hash("bridge" + r + B.y + "0"))
        };
    }
}
```

### 4. Rust Integration (Program Side)

Add the circuit integration test to your Cargo.toml:

```toml
[dependencies]
# Add these for ZK integration
solana-zk-sdk = "1.18.0"  # BN254 curve support
ark-bn254 = "0.4.0"          # Groth16 verification
ark-groth16 = "0.4.0"
```

Create integration test in `wxmr-token/tests/zk_integration.rs`:

```rust
use solana_program_test::*;
use solana_sdk::{signature::Keypair, signer::Signer, transaction::Transaction};
use wxmr::*;

#[tokio::test]
async fn test_zk_proof_integration() {
    let program = ProgramTest::new("wxmr", id(), processor!(entry));
    let (mut banks_client, payer, recent_blockhash) = program.start().await;

    let wxmr_mint = Keypair::new();
    let zq_verifier = Keypair::new();

    // Test proof submission
    let test_proof = vec![0u8; 192]; // Mock proof
    let test_inputs = vec![
        12345678901234567890u64, 12345678901234567890u64, // R
        98765432109876543210u64, 98765432109876543210u64, // P
        55555555555555555555u64, 55555555555555555555u64, // C
        1880381539u64,             // ecdhAmount
        1000000000u64,             // v (1 XMR)
        1399811149u64,             // chainId
        0u64,                      // index
    ];

    let monero_tx_hash = [0u8; 32]; // Mock transaction hash

    let tx = Transaction::new_signed_with_payer(
        &[instruction::mint_with_zk_proof(
            &id(),
            &authority.pubkey(),
            &wxmr_mint.pubkey(),
            &recipient_account.pubkey(),
            &recipient.pubkey(),
            &payer.pubkey(),
            test_proof,
            test_inputs,
            monero_tx_hash,
            1000000000u64, // 1 XMR
        ).unwrap()],
        Some(&payer.pubkey()),
        &[&payer],
        recent_blockhash,
    );

    banks_client.process_transaction(tx).await.unwrap();
}
```

### 5. Testing the Integration

Create test Mint/Burn flows:

```bash
# 1. Build circuits
npm run compile:bridge

# 2. Generate test vectors
node test/MoneroTests.js

# 3. Start Solana local validator
solana-test-validator --reset --bpf-program WXMrTokenProgram11111111111111111111111111 target/deploy/wxmr.so

# 4. Run integration tests
cargo test -p wxmr-token --test zk_integration

# 5. Test mint with proof
cargo test -p wxmr-token --test integration -- --nocapture
```

### 6. Production Deployment Checklist

- [ ] **Circuit tested** with sample Monero transactions
- [ ] **ZK proof verification** working with Groth16
- [ ] **Solana program** updated to require proof
- [ ] **Browser client** can generate proofs in <5s
- [ ] **Edge cases** handled (replay protection, valid ranges)
- [ ] **Integration testing** complete

### 7. Quick Integration Commands

```bash
# Build everything
cargo build-sbf
npm run compile:bridge

# Start local testing
solana-test-validator --reset
solana program deploy target/deploy/wxmr.so

# Test basic functionality
cargo test --product wXMR_token
```

## 🎯 Next Steps

1. **Replace basic validation** with actual Groth16 verifier
2. **Implement Ed25519 arithmetic** in circuits
3. **Create integration CI pipeline**
4. **Add browser client** for proof generation
5. **Deploy to testnet** with real Monero stagenet