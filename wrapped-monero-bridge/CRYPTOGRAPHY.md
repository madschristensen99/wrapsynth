# Cryptography Implementation

## Overview

This document explains the cryptographic operations used in the Wrapped Monero Bridge.

## Key Generation

### Monero Private Keys

Monero uses **Ed25519/Curve25519** cryptography. A private key is a 32-byte scalar.

**In Production:**
- Use cryptographically secure random number generation
- Apply proper scalar reduction (mod curve order)
- Follow Monero's key derivation standards

**Current Implementation (Arcis-compatible):**
```rust
// Simplified Keccak256-like mixing for MPC environment
// Real implementation would use:
// crypto::derive_private_key_from_seed(seed)
```

The current implementation uses a mixing function that:
1. Takes a seed and expands it to 32 bytes
2. Applies multiple rounds of mixing (addition and multiplication)
3. Ensures the key is non-zero

### Public Key Derivation

**In Production:**
- Public Key = Private Key × G (base point multiplication on Curve25519)
- Compress the resulting point to 32 bytes

**Current Implementation (Arcis-compatible):**
```rust
// Hash-based derivation using Keccak256-like mixing
// This is deterministic and one-way
// Real implementation would use:
// crypto::derive_public_key_from_private(private_key)
```

The current implementation:
1. Mixes private key with domain separator "monero_pubkey_v1"
2. Applies 3 rounds of Keccak-like permutation
3. Produces a deterministic 32-byte public key

**Why Hash-Based?**
- Arcis MPC doesn't support elliptic curve point multiplication
- Hash-based derivation is:
  - One-way (can't derive private from public)
  - Deterministic (same private → same public)
  - Collision-resistant

## ZK Proof Verification (Groth16)

### What the Proof Proves

The Groth16 ZK proof demonstrates:
1. A valid Monero transaction exists on the blockchain
2. The transaction sends the claimed amount of XMR
3. The transaction is sent to the specified Monero address
4. The prover knows the transaction details without revealing them

### Proof Structure

```rust
pub struct DepositRequest {
    amount: u64,
    // Groth16 proof components (compressed)
    proof_a: [u8; 32],      // Point A
    proof_b_1: [u8; 32],    // Point B (part 1)
    proof_b_2: [u8; 32],    // Point B (part 2)
    proof_c: [u8; 32],      // Point C
    // Public inputs
    public_input_amount: u64,
    public_input_recipient: [u8; 32],
}
```

### Verification Equation

**Full Groth16 Verification:**
```
e(A, B) = e(α, β) · e(IC, γ) · e(C, δ)
```

Where:
- `e()` is a pairing operation on BN254 curve
- `α, β, γ, δ` are verification key parameters
- `IC = vk.ic[0] + Σ(public_input[i] · vk.ic[i+1])`

**Current Implementation:**
```rust
// Basic sanity checks (Arcis-compatible)
1. Verify public inputs match claimed values
2. Verify proof components are non-zero
3. Verify amount is reasonable (0 < amount < 1B)

// Full pairing verification would be done off-chain
```

### Why Not Full Verification in MPC?

Groth16 verification requires:
- **Pairing operations** on BN254 elliptic curve
- **Point arithmetic** (addition, scalar multiplication)
- **Field arithmetic** in large prime fields

These operations are:
- Too complex for Arcis MPC environment
- Computationally expensive
- Better suited for off-chain verification or specialized circuits

### Production Approach

**Hybrid Verification:**

1. **Off-Chain Verifier:**
   ```rust
   // Use ark-groth16 library
   use ark_groth16::Groth16;
   use ark_bn254::Bn254;
   
   let valid = Groth16::<Bn254>::verify(
       &verification_key,
       &public_inputs,
       &proof
   )?;
   ```

2. **On-Chain (Arcis MPC):**
   - Verify proof was checked by trusted verifier
   - Check signature from verifier
   - Verify public inputs match
   - Authorize mint

3. **Alternative: Solana Program:**
   - Deploy Groth16 verifier as Solana program
   - Use Solana's compute for verification
   - Arcis MPC only handles key management

## Security Considerations

### Current Implementation

**Strengths:**
- ✅ Keys generated in MPC, never exposed
- ✅ Deterministic key derivation
- ✅ One-way public key derivation
- ✅ Selective key revelation (only on burn)

**Limitations:**
- ⚠️ Not using real Ed25519 curve operations
- ⚠️ Simplified proof verification
- ⚠️ No protection against replay attacks
- ⚠️ No key rotation mechanism

### Production Requirements

**Cryptography:**
1. **Real Ed25519 Operations:**
   - Use proper curve25519-dalek library
   - Implement off-chain or in specialized circuit
   - Verify results in MPC

2. **Proper Randomness:**
   - Use hardware RNG or VRF
   - Combine multiple entropy sources
   - Ensure unpredictability

3. **Key Management:**
   - Implement key rotation
   - Add multi-signature requirements
   - Create emergency recovery procedures

**ZK Proofs:**
1. **Trusted Setup:**
   - Perform multi-party computation for setup
   - Destroy toxic waste
   - Publish verification keys

2. **Circuit Design:**
   - Verify Monero transaction structure
   - Check ring signatures
   - Validate amount commitments
   - Prevent double-spending

3. **Proof Generation:**
   - Run prover off-chain
   - Submit proof on-chain
   - Verify in Solana program or trusted verifier

**Additional Security:**
1. **Rate Limiting:**
   - Limit deposits per address
   - Implement time delays
   - Add withdrawal limits

2. **Monitoring:**
   - Track all deposits/burns
   - Alert on suspicious activity
   - Maintain audit logs

3. **Upgradability:**
   - Design for protocol upgrades
   - Add governance mechanism
   - Plan for emergency shutdown

## References

### Monero Cryptography
- [Monero Cryptography](https://www.getmonero.org/resources/moneropedia/cryptography.html)
- [Ed25519 Curve](https://ed25519.cr.yp.to/)
- [Curve25519](https://cr.yp.to/ecdh.html)

### Groth16 ZK-SNARKs
- [Groth16 Paper](https://eprint.iacr.org/2016/260.pdf)
- [arkworks Library](https://github.com/arkworks-rs)
- [BN254 Curve](https://eips.ethereum.org/EIPS/eip-197)

### Implementation Libraries
- [curve25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek)
- [ed25519-dalek](https://github.com/dalek-cryptography/ed25519-dalek)
- [ark-groth16](https://github.com/arkworks-rs/groth16)
- [sha3](https://github.com/RustCrypto/hashes)

## Testing

### Unit Tests

The `crypto.rs` module includes tests for:
- Key derivation (deterministic)
- Proof serialization/deserialization
- Basic proof verification

Run tests:
```bash
cargo test
```

### Integration Testing

For production, implement:
1. **Key Generation Tests:**
   - Verify randomness
   - Check key validity
   - Test edge cases

2. **Proof Verification Tests:**
   - Valid proofs pass
   - Invalid proofs fail
   - Malformed proofs rejected

3. **End-to-End Tests:**
   - Full deposit flow
   - Full burn flow
   - Error handling

## Migration Path

### Phase 1: Current (Demo)
- ✅ Arcis-compatible key generation
- ✅ Hash-based public key derivation
- ✅ Basic proof validation

### Phase 2: Hybrid
- Add off-chain Ed25519 operations
- Implement Groth16 verifier in Solana
- Verify results in Arcis MPC

### Phase 3: Production
- Full cryptographic implementation
- Audited ZK circuits
- Secure key management
- Monitoring and governance

---

**Note:** This is a proof-of-concept. The current cryptographic implementation is simplified for demonstration and MPC compatibility. Production deployment requires full cryptographic implementation and security audits.
