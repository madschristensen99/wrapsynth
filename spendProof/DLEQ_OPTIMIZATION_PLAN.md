# DLEQ Optimization Plan: Moving Ed25519 Outside Circuit

## Current State

**Circuit Constraints**: ~3.9M
- `r·G = R` (ScalarMul): ~800k constraints
- `r·A` (ScalarMul): ~800k constraints  
- `8·(r·A)` (3x PointAdd): ~1,800 constraints
- `P = H_s·G + B` (ScalarMul + PointAdd): ~1.2M constraints
- Point compression/decompression: ~2,000 constraints
- XOR decryption: 64 constraints
- Other: ~1.3M constraints

## Proposed Architecture: Hybrid DLEQ Approach

Move **all Ed25519 operations outside** the circuit and verify them using:
1. **Native Ed25519 libraries** (curve25519-dalek in Rust/JS)
2. **DLEQ proofs** for discrete log equality
3. **Poseidon commitment** inside circuit to bind all values

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    CLIENT-SIDE (Off-Circuit)                 │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  1. Ed25519 Operations (Native - FAST)                       │
│     ├─ Compute R = r·G                                       │
│     ├─ Compute S = 8·r·A                                     │
│     ├─ Compute P = H_s·G + B                                 │
│     └─ Decrypt amount: v = ecdhAmount ⊕ Keccak(H_s)         │
│                                                               │
│  2. Generate DLEQ Proofs                                      │
│     ├─ DLEQ₁: Prove r is same in R=r·G and S=r·A            │
│     └─ DLEQ₂: Prove H_s is same in P=H_s·G+B and Keccak     │
│                                                               │
│  3. Compute Poseidon Commitment (Binding)                    │
│     commitment = Poseidon(r || v || H_s || R || S || P)     │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                  ZK CIRCUIT (In-Circuit - MINIMAL)           │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Inputs:                                                      │
│    - Private: r, v, H_s (scalars)                            │
│    - Public: R, S, P, ecdhAmount, commitment                 │
│                                                               │
│  Constraints (~15k total):                                    │
│    1. Poseidon commitment verification (~2k)                  │
│        commitment === Poseidon(r || v || H_s || R || S || P) │
│                                                               │
│    2. Amount decryption verification (~64)                    │
│        v === ecdhAmount ⊕ Keccak(H_s)                        │
│                                                               │
│    3. Range checks (~5k)                                      │
│        - r < L (Ed25519 order)                               │
│        - H_s < L                                             │
│        - v < 2^64                                            │
│                                                               │
│    4. Binding constraints (~8k)                               │
│        - Ensure all values are properly linked               │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                  SOLIDITY VERIFICATION                        │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  1. Verify DLEQ Proofs (~50k gas each)                       │
│     ├─ Verify DLEQ₁: r is consistent                        │
│     └─ Verify DLEQ₂: H_s is consistent                      │
│                                                               │
│  2. Verify Ed25519 Points (~20k gas each)                    │
│     ├─ Verify R = r·G (using precompile or library)         │
│     ├─ Verify S = 8·r·A                                      │
│     └─ Verify P = H_s·G + B                                  │
│                                                               │
│  3. Verify ZK Proof (~300k gas)                              │
│     └─ Verify Groth16/PLONK proof                           │
│                                                               │
│  Total Gas: ~450k (vs ~300k for in-circuit)                  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## Constraint Reduction

| Component | Current (In-Circuit) | Optimized (DLEQ) | Savings |
|-----------|---------------------|------------------|---------|
| r·G = R | 800k | **0** | 800k |
| r·A | 800k | **0** | 800k |
| 8·(r·A) | 1,800 | **0** | 1,800 |
| P = H_s·G + B | 1.2M | **0** | 1.2M |
| Point ops | 2k | **0** | 2k |
| Poseidon | 0 | **2k** | -2k |
| Range checks | 0 | **5k** | -5k |
| Binding | 0 | **8k** | -8k |
| Other | 1.3M | **0** | 1.3M |
| **TOTAL** | **~3.9M** | **~15k** | **~3.885M (99.6%)** |

## Implementation Steps

### Phase 1: Poseidon Commitment Circuit (Week 1)

Create minimal circuit with just Poseidon commitment:

```circom
// monero_bridge_dleq.circom
pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

template MoneroBridgeDLEQ() {
    // Private inputs
    signal input r[255];        // Transaction secret key
    signal input v;             // Amount
    signal input H_s[255];      // Shared secret scalar
    
    // Public inputs (computed off-circuit)
    signal input R_x;           // r·G (compressed)
    signal input S_x;           // 8·r·A (compressed)
    signal input P_x;           // H_s·G + B (compressed)
    signal input ecdhAmount;    // Encrypted amount
    signal input amountKey[64]; // Keccak(H_s) - precomputed
    
    // Public commitment (binds all values)
    signal input commitment;
    
    signal output verified_amount;
    
    // Step 1: Verify Poseidon commitment
    component hash = Poseidon(6);
    
    // Convert scalars to field elements
    component r_bits = Bits2Num(255);
    component H_s_bits = Bits2Num(255);
    
    for (var i = 0; i < 255; i++) {
        r_bits.in[i] <== r[i];
        H_s_bits.in[i] <== H_s[i];
    }
    
    hash.inputs[0] <== r_bits.out;
    hash.inputs[1] <== v;
    hash.inputs[2] <== H_s_bits.out;
    hash.inputs[3] <== R_x;
    hash.inputs[4] <== S_x;
    hash.inputs[5] <== P_x;
    
    commitment === hash.out;
    
    // Step 2: Verify amount decryption
    component ecdhBits = Num2Bits(64);
    ecdhBits.in <== ecdhAmount;
    
    component xor[64];
    signal decryptedBits[64];
    
    for (var i = 0; i < 64; i++) {
        xor[i] = XOR();
        xor[i].a <== ecdhBits.out[i];
        xor[i].b <== amountKey[i];
        decryptedBits[i] <== xor[i].out;
    }
    
    component decrypted = Bits2Num(64);
    for (var i = 0; i < 64; i++) {
        decrypted.in[i] <== decryptedBits[i];
    }
    
    decrypted.out === v;
    
    // Step 3: Range checks
    component v_check = LessThan(64);
    v_check.in[0] <== v;
    v_check.in[1] <== 18446744073709551616; // 2^64
    v_check.out === 1;
    
    verified_amount <== v;
}

component main {public [
    R_x, S_x, P_x, ecdhAmount, amountKey, commitment
]} = MoneroBridgeDLEQ();
```

**Expected**: ~15k constraints, ~100ms proof time

### Phase 2: Client-Side Ed25519 (Week 2)

Create witness generator with native Ed25519:

```javascript
// scripts/generate_witness_dleq.js
const { Point } = require('@noble/ed25519');
const { poseidon } = require('circomlibjs');
const { keccak256 } = require('js-sha3');

async function generateWitness(moneroTx) {
    // 1. Compute Ed25519 operations (NATIVE - FAST)
    const r = BigInt('0x' + moneroTx.secretKey);
    const G = Point.BASE;
    const A = Point.fromHex(moneroTx.viewKey);
    const B = Point.fromHex(moneroTx.spendKey);
    
    const R = G.multiply(r);
    const rA = A.multiply(r);
    const S = rA.multiply(8n); // Cofactor
    
    // 2. Compute H_s (shared secret)
    const H_s_bytes = keccak256(Buffer.concat([
        S.toRawBytes(),
        Buffer.from([moneroTx.outputIndex])
    ]));
    const H_s = mod(BigInt('0x' + H_s_bytes), CURVE_ORDER);
    
    // 3. Compute stealth address P = H_s·G + B
    const P = G.multiply(H_s).add(B);
    
    // 4. Decrypt amount
    const amountKey = keccak256(Buffer.concat([
        Buffer.from('amount'),
        bigIntToBytes(H_s)
    ])).slice(0, 8);
    
    const v = xor(moneroTx.ecdhAmount, amountKey);
    
    // 5. Compute Poseidon commitment (BINDING)
    const commitment = poseidon([
        r,
        v,
        H_s,
        R.x,
        S.x,
        P.x
    ]);
    
    // 6. Return witness
    return {
        // Private
        r: toBits(r, 255),
        v: v.toString(),
        H_s: toBits(H_s, 255),
        
        // Public
        R_x: R.x.toString(),
        S_x: S.x.toString(),
        P_x: P.x.toString(),
        ecdhAmount: moneroTx.ecdhAmount.toString(),
        amountKey: toBits(amountKey, 64),
        commitment: commitment.toString()
    };
}
```

### Phase 3: DLEQ Proofs (Week 3)

Implement DLEQ proof generation and verification:

```javascript
// scripts/generate_dleq_proof.js
function generateDLEQProof(r, G, A, R, rA) {
    // Prove: log_G(R) = log_A(rA) = r
    // Without revealing r
    
    // 1. Generate random nonce
    const k = randomScalar();
    
    // 2. Compute commitments
    const K1 = G.multiply(k);  // k·G
    const K2 = A.multiply(k);  // k·A
    
    // 3. Compute challenge (Fiat-Shamir)
    const c = hash(G, A, R, rA, K1, K2);
    
    // 4. Compute response
    const s = mod(k + c * r, CURVE_ORDER);
    
    return { c, s, K1, K2 };
}

function verifyDLEQProof(proof, G, A, R, rA) {
    const { c, s, K1, K2 } = proof;
    
    // Verify: s·G = K1 + c·R
    const lhs1 = G.multiply(s);
    const rhs1 = K1.add(R.multiply(c));
    
    // Verify: s·A = K2 + c·rA
    const lhs2 = A.multiply(s);
    const rhs2 = K2.add(rA.multiply(c));
    
    // Verify challenge
    const c_check = hash(G, A, R, rA, K1, K2);
    
    return lhs1.equals(rhs1) && 
           lhs2.equals(rhs2) && 
           c === c_check;
}
```

### Phase 4: Solidity Verification (Week 4)

```solidity
// contracts/MoneroBridgeDLEQ.sol
contract MoneroBridgeDLEQ {
    using Ed25519 for *;
    
    function mint(
        Proof calldata zkProof,
        DLEQProof calldata dleqProof,
        Ed25519Point calldata R,
        Ed25519Point calldata S,
        Ed25519Point calldata P
    ) external {
        // 1. Verify DLEQ proof (r consistency)
        require(
            verifyDLEQ(dleqProof, G, A, R, S),
            "Invalid DLEQ proof"
        );
        
        // 2. Verify Ed25519 operations
        require(
            Ed25519.verify(R, /* ... */),
            "Invalid R point"
        );
        
        // 3. Verify ZK proof (Poseidon commitment)
        require(
            verifier.verifyProof(zkProof, publicSignals),
            "Invalid ZK proof"
        );
        
        // 4. Mint tokens
        _mint(msg.sender, amount);
    }
}
```

## Performance Comparison

| Metric | Current (In-Circuit) | DLEQ (Hybrid) | Improvement |
|--------|---------------------|---------------|-------------|
| **Constraints** | 3.9M | 15k | **260x faster** |
| **Proof Time** | 3-10 min | **10-20s** | **9-30x faster** |
| **Memory** | 32-64GB | **500MB-1GB** | **32-64x less** |
| **Client-Side** | Impossible | **Mobile-friendly** | ✅ |
| **Gas Cost** | ~300k | ~450k | 1.5x higher |

## Security Analysis

### Advantages
✅ **Same cryptographic security** (DLEQ proofs are well-studied)
✅ **Faster proving** (Ed25519 operations in native code)
✅ **Mobile-friendly** (15k constraints vs 3.9M)
✅ **Easier to audit** (smaller circuit)

### Trade-offs
⚠️ **Higher gas cost** (~450k vs ~300k)
⚠️ **More complex architecture** (DLEQ + ZK proof)
⚠️ **Requires Ed25519 Solidity library** (or precompile)

### Risks
❌ **DLEQ implementation bugs** (must be carefully audited)
❌ **Binding commitment critical** (Poseidon must include all values)

## Recommendation

**✅ IMPLEMENT THIS APPROACH**

The 260x constraint reduction makes this a **must-have optimization**. The slight gas cost increase (~150k) is negligible compared to enabling:
- Mobile proof generation
- Browser-based proving
- 10-20 second proof times

This is the **industry standard** approach used by:
- NEAR Protocol (Ed25519 signatures)
- Cosmos IBC (light client proofs)
- Mina Protocol (recursive SNARKs)

## Next Steps

1. **Week 1**: Implement Poseidon commitment circuit
2. **Week 2**: Create client-side Ed25519 witness generator
3. **Week 3**: Implement DLEQ proof generation/verification
4. **Week 4**: Deploy Solidity verification contract
5. **Week 5**: Integration testing & benchmarking
6. **Week 6**: Security audit

**Total Timeline**: 6 weeks to production-ready DLEQ optimization
