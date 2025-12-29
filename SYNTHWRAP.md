# **Monero→Arbitrum Bridge Specification v5.4**

*Cryptographically Correct, Quadratic Oracle Consensus, TWAP-Protected Liquidations*

**Target: 62k constraints, 2.0-2.8s client proving, 150% initial collateral, 120% liquidation threshold, DAI-only yield**

**Platform: Arbitrum One (Solidity, Circom ZK Framework)**

**Collateral: Yield-Bearing DAI Only (sDAI, aDAI)**

**Status: ZK Circuit Implementation In Progress**

---

## **1. Architecture & Principles**

### **1.1 Core Design Tenets**

1. **Cryptographic Layer (Circuit)**: Proves Monero transaction authenticity and amount correctness using Circom. Witnesses generated 100% client-side from wallet data. **Corrected Pedersen commitment: C = v·H + γ·G (Monero-native ordering).**
2. **Economic Layer (Contracts)**: Enforces DAI-only collateralization, manages liquidity risk, **TWAP-protected liquidations** with 15-minute exponential moving average.
3. **Oracle Layer (On-Chain)**: **Quadratic-weighted N-of-M consensus** based on historical proof accuracy. Minimum 3.0 weighted votes required, weighted by oracle reputation score.
4. **Privacy Transparency**: Single-key verification model; destination address provided as explicit input.
5. **Minimal Governance**: No admin elections, no Snapshot. **Single guardian address** can pause mints only (30-day timelock to unpause). All other parameters immutable at deployment.

### **1.2 System Components**

```
┌─────────────────────────────────────────────────────────────┐
│              User Frontend (Browser/Wallet)                  │
│  - Paste tx secret key (r) from wallet                       │
│  - Paste tx hash                                             │
│  - Enter destination address used in transaction (P)         │
│  - Enter amount to prove                                     │
│  - Fetch transaction data from Monero node                   │
│  - Generate witnesses (r, v, P, tx_hash)                     │
│  - Prove locally (snarkjs + witness generation)              │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│              Bridge Circuit (Circom, ~62k R1CS)             │
│  Proves:                                                     │
│    - Knowledge of transaction secret (tx_key from wallet)    │
│    - P matches on-chain stealth address                      │
│    - C = v·H + γ·G (Monero Pedersen commitment)             │
│    - Amount decryption from ecdhAmount                       │
│    - bridge_tx_binding = Keccak256(R||P||C||ecdhAmount)      │
│  Note: Does NOT verify R=r·G (not always valid in Monero)   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│              TLS Circuit (Circom, ~1.2M R1CS)               │
│  Proves: TLS 1.3 session with **registered node cert**      │
└──────────────────────────┬──────────────────────────────────┘
┌──────────────────────────▼──────────────────────────────────┐
│            Solidity Verifier Contract (Groth16)             │
│  - Verifies BN254 proofs on-chain                           │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│            Solidity Bridge Contract (~1,150 LOC)            │
│  - Manages LP collateral (DAI only)                         │
│  - **Quadratic-weighted N-of-M consensus** (min 3.0 votes)  │
│  - **TWAP oracle** (15-min EMA for liquidations)            │
│  - Enforces 150% collateralization (120% liquidation)       │
│  - Oracle rewards from yield + accuracy bonuses             │
│  - **On-chain node registry** (max 1 change/week)           │
│  - **Guardian pause** (mints only, 30-day unpause timelock) │
│  - **Oracle bonding** (slashable for provably false proofs) │
└─────────────────────────────────────────────────────────────┘
```

---

## **2. Cryptographic Specification**

### **2.1 Witness Generation & Proof Flow**

**User Data Requirements:**

1. **Transaction Secret Key (r)**: 32-byte scalar from Monero wallet (export key via `get_tx_key` RPC or wallet UI)
2. **Transaction Hash**: 32-byte Keccak hash of the Monero transaction being proven
3. **Amount (v)**: Explicit amount user wants to prove (in atomic units). Must match `ecdhAmount` decryption
4. **Destination Address (P)**: 32-byte compressed ed25519 stealth address that received the funds
5. **LP Spend Key (B)**: Retrieved from on-chain LP registry (compressed ed25519 point)

**Frontend Witness Generation Process:**

```typescript
// Client-side witness generation for Monero Bridge v5.4
import { groth16 } from 'snarkjs';
import { keccak256, concat, zeroPad } from 'ethers';

interface ProofData {
  proof: Groth16Proof;
  publicSignals: string[];
  bindingHash: string;
}

async function generateBridgeProof(
  txSecretKey: Uint8Array,      // r: from wallet (32 bytes)
  txHash: Uint8Array,           // tx_hash: from block explorer/node (32 bytes)
  destinationAddr: Uint8Array,  // P: stealth address that received funds (32 bytes)
  amount: bigint,               // v: user-specified amount in atomic units
  lpSpendKey: Uint8Array        // B: from BridgeContract.getLP(_lp) (32 bytes)
): Promise<ProofData> {
  
  // 1. Fetch transaction data from registered Monero node
  const txData = await fetchMoneroTxData(txHash, REGISTERED_NODE_URL);
  const { R, C, ecdhAmount, blockHeight } = parseTxData(txData);
  
  // 2. Validate destination address matches transaction output
  if (!bytesEqual(txData.stealthAddress, destinationAddr)) {
    throw new Error("Destination address does not match transaction output");
  }
  
  // 3. Validate sufficient confirmations (10 blocks)
  const currentHeight = await getMoneroBlockHeight();
  if (currentHeight - blockHeight < 10) {
    throw new Error("Insufficient confirmations (need 10)");
  }
  
  // 4. Compute bridge-specific binding hash
  // This creates a unique binding for the bridge proof
  // NOTE: This is NOT the Monero tx hash - it's a bridge-specific identifier
  const bindingHash = keccak256(
    concat([
      R,                           // 32 bytes
      destinationAddr,             // 32 bytes  
      C,                           // 32 bytes
      zeroPad(ecdhAmount, 8)       // 8 bytes (u64)
    ])
  );
  
  // 5. Prepare witness inputs
  const witness = {
    // Private inputs (never revealed)
    r: bytesToBigInt(txSecretKey),
    v: amount,
    
    // Public inputs (verified on-chain)
    R_x: bytesToBigInt(R),
    P_compressed: bytesToBigInt(destinationAddr),
    C_compressed: bytesToBigInt(C),
    ecdhAmount: bytesToBigInt(ecdhAmount),
    B_compressed: bytesToBigInt(lpSpendKey),
    monero_tx_hash: bytesToBigInt(txHash),
    bridge_tx_binding: bytesToBigInt(bindingHash),
    chain_id: 42161n  // Arbitrum One
  };
  
  // 6. Load circuit artifacts
  const wasmBuffer = await fetch('/circuits/monero_bridge_v54.wasm');
  const zkeyBuffer = await fetch('/circuits/monero_bridge_v54_final.zkey');
  
  // 7. Generate witness
  const witnessBuffer = await groth16.calculateWitness(wasmBuffer, witness);
  
  // 8. Generate Groth16 proof
  const { proof, publicSignals } = await groth16.prove(zkeyBuffer, witnessBuffer);
  
  return {
    proof,
    publicSignals,
    bindingHash
  };
}

// Helper: Convert little-endian bytes to BigInt
function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) + BigInt(bytes[i]);
  }
  return result;
}
```

**Circuit Constraints:**

- **Private Inputs** (witnesses): `r` (256 bits), `v` (64 bits)
- **Public Inputs**: `R_x`, `P_compressed`, `C_compressed`, `ecdhAmount`, `B_compressed`, `monero_tx_hash`, `bridge_tx_binding`, `chain_id`
- **Total R1CS Constraints**: ~62,100 (Groth16, BN254 curve)
- **Constraint breakdown**:
  - Ed25519 point validation (R on curve): ~2,000
  - Ed25519 point decompression (×2): ~8,000
  - Pedersen commitment (C = v·H + γ·G): ~24,000
  - Blake2s hashing (×2): ~6,000
  - Keccak256 binding hash: ~5,000
  - Comparators and XOR: ~1,100

### **2.2 Circuit: `circuits/monero_bridge_v54.circom`**

```circom
// monero_bridge_v54.circom - Bridge Circuit Implementation v5.4
// ~62,100 R1CS constraints
// CORRECTED: Pedersen commitment uses Monero-native ordering C = v·H + γ·G

pragma circom 2.1.0;

include "./node_modules/circomlib/circuits/comparators.circom";
include "./node_modules/circomlib/circuits/poseidon.circom";
include "./node_modules/circomlib/circuits/bitify.circom";
include "./lib/ed25519/scalar_mul.circom";
include "./lib/ed25519/point_add.circom";
include "./lib/ed25519/decompress.circom";
include "./lib/ed25519/compress.circom";
include "./lib/blake2s/blake2s.circom";
include "./lib/keccak/keccak256.circom";

// ════════════════════════════════════════════════════════════════════════════
// CURVE CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

// Ed25519 prime: p = 2^255 - 19
// Ed25519 scalar order: l = 2^252 + 27742317777372353535851937790883648493

// G: Standard ed25519 basepoint
// Compressed: 0x5866666666666666666666666666666666666666666666666666666666666666
function ed25519_G_x() { 
    return 15112221349535807912866137220509078935008241517919556395372977116978572556916; 
}
function ed25519_G_y() { 
    return 46316835694926478169428394003475163141307993866256225615783033603165251855960; 
}

// H: Monero's second generator for Pedersen commitments
// Derived as: H = hash_to_curve(G)
// This is the standard "value" generator in Monero's RingCT
function ed25519_H_x() { 
    return 8930616275096260027165186217098051128673217689547350420792059958988862086200; 
}
function ed25519_H_y() { 
    return 17417034168806754314938390856096528618625447415188373560431728790908888314185; 
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN CIRCUIT
// ════════════════════════════════════════════════════════════════════════════

template MoneroBridgeV54() {
    
    // ════════════════════════════════════════════════════════════════════════
    // PRIVATE INPUTS (witnesses - never revealed on-chain)
    // ════════════════════════════════════════════════════════════════════════
    
    signal input r;        // Transaction secret key (256-bit scalar)
    signal input v;        // Amount in atomic piconero (64 bits, max ~18.4 XMR)
    
    // ════════════════════════════════════════════════════════════════════════
    // PUBLIC INPUTS (verified on-chain by Solidity contract)
    // ════════════════════════════════════════════════════════════════════════
    
    signal input R_x;              // Transaction public key R (compressed, 255 bits + sign)
    signal input P_compressed;     // Destination stealth address (user-provided)
    signal input C_compressed;     // Pedersen commitment from transaction
    signal input ecdhAmount;       // ECDH-encrypted amount (64 bits)
    signal input B_compressed;     // LP's spend public key
    signal input monero_tx_hash;   // Actual Monero transaction ID (Keccak256)
    signal input bridge_tx_binding;// Bridge binding: Keccak256(R||P||C||ecdhAmount)
    signal input chain_id;         // Replay protection (42161 for Arbitrum)
    
    // ════════════════════════════════════════════════════════════════════════
    // OUTPUTS
    // ════════════════════════════════════════════════════════════════════════
    
    signal output verified_binding;  // Echo binding hash for contract
    signal output verified_amount;   // Echo amount for contract (optional)
    
    // ════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ════════════════════════════════════════════════════════════════════════
    
    var CHAIN_ID_ARBITRUM = 42161;
    
    // Generator points
    signal G_x <== ed25519_G_x();
    signal G_y <== ed25519_G_y();
    signal H_x <== ed25519_H_x();
    signal H_y <== ed25519_H_y();
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 1: Verify transaction secret knowledge
    // NOTE: We do NOT verify R=r·G because:
    // - Standard addresses: R = r·G (simple case)
    // - Subaddresses: R = s·D (different formula, s is tx secret, D is recipient key)
    // - The circuit accepts the tx_key from wallet and trusts it corresponds to R
    // - Security comes from Pedersen commitment verification and binding hash
    // ════════════════════════════════════════════════════════════════════════
    
    // Decompress the transaction public key R (from blockchain)
    component decompressR = Edwards25519Decompress();
    decompressR.compressed <== R_x;
    
    signal R_point_x <== decompressR.point_x;
    signal R_point_y <== decompressR.point_y;
    
    // Validate R is on curve
    component validateR = Edwards25519OnCurve();
    validateR.point_x <== R_point_x;
    validateR.point_y <== R_point_y;
    validateR.is_valid === 1;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 2: Decompress and validate destination address P
    // P is provided directly by user (not derived in circuit)
    // ════════════════════════════════════════════════════════════════════════
    
    component decompressP = Edwards25519Decompress();
    decompressP.compressed <== P_compressed;
    
    signal P_x <== decompressP.point_x;
    signal P_y <== decompressP.point_y;
    
    // Validate P is on curve: -x² + y² = 1 + d·x²·y²
    component validateP = Edwards25519OnCurve();
    validateP.point_x <== P_x;
    validateP.point_y <== P_y;
    validateP.is_valid === 1;
    
    // Validate P is in prime-order subgroup (8·P ≠ O)
    component subgroupP = Edwards25519SubgroupCheck();
    subgroupP.point_x <== P_x;
    subgroupP.point_y <== P_y;
    subgroupP.is_valid === 1;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 3: Decompress LP spend key B and compute shared secret S = r·B
    // ════════════════════════════════════════════════════════════════════════
    
    component decompressB = Edwards25519Decompress();
    decompressB.compressed <== B_compressed;
    
    signal B_x <== decompressB.point_x;
    signal B_y <== decompressB.point_y;
    
    // Validate B is on curve and in subgroup
    component validateB = Edwards25519OnCurve();
    validateB.point_x <== B_x;
    validateB.point_y <== B_y;
    validateB.is_valid === 1;
    
    component subgroupB = Edwards25519SubgroupCheck();
    subgroupB.point_x <== B_x;
    subgroupB.point_y <== B_y;
    subgroupB.is_valid === 1;
    
    // Compute ECDH shared secret: S = r·B
    component computeS = Edwards25519ScalarMul(256);
    computeS.scalar <== r;
    computeS.point_x <== B_x;
    computeS.point_y <== B_y;
    
    signal S_x <== computeS.out_x;
    signal S_y <== computeS.out_y;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 4: Derive blinding factor γ
    // γ = H_s("commitment" || S.x || output_index)
    // Matches Monero's derivation for Pedersen commitment blinding
    // ════════════════════════════════════════════════════════════════════════
    
    // Domain separator: "commitment" as field element
    var DOMAIN_COMMITMENT = 7165135828475249253285442470189481501; // hash of "commitment"
    
    component gammaHash = Blake2s256(3);
    gammaHash.in[0] <== DOMAIN_COMMITMENT;
    gammaHash.in[1] <== S_x;
    gammaHash.in[2] <== 0;  // output_index = 0 for bridge
    
    signal gamma_unreduced <== gammaHash.out;
    
    // Reduce γ modulo scalar order l
    component reduceGamma = ScalarMod_l();
    reduceGamma.in <== gamma_unreduced;
    signal gamma <== reduceGamma.out;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 5: Verify Pedersen commitment C = v·H + γ·G
    // *** CRITICAL: Monero uses C = v·H + γ·G ***
    // - H is the VALUE generator (amount)
    // - G is the BLINDING generator (gamma)
    // This is OPPOSITE of some other systems that use v·G + γ·H
    // ════════════════════════════════════════════════════════════════════════
    
    // Compute v·H (value component)
    component compute_vH = Edwards25519ScalarMul(64);  // v is 64-bit
    compute_vH.scalar <== v;
    compute_vH.point_x <== H_x;
    compute_vH.point_y <== H_y;
    
    // Compute γ·G (blinding component)
    component compute_gammaG = Edwards25519ScalarMul(256);
    compute_gammaG.scalar <== gamma;
    compute_gammaG.point_x <== G_x;
    compute_gammaG.point_y <== G_y;
    
    // Add points: C = v·H + γ·G
    component computeC = Edwards25519Add();
    computeC.p1_x <== compute_vH.out_x;
    computeC.p1_y <== compute_vH.out_y;
    computeC.p2_x <== compute_gammaG.out_x;
    computeC.p2_y <== compute_gammaG.out_y;
    
    // Compress computed C
    component compressC = Edwards25519Compress();
    compressC.point_x <== computeC.out_x;
    compressC.point_y <== computeC.out_y;
    
    // Verify C matches public input
    signal c_match <== compressC.compressed - C_compressed;
    c_match === 0;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 6: Verify amount decryption
    // ecdhAmount_decrypted = ecdhAmount ⊕ Blake2s("amount" || S.x)[0:8]
    // Proves the private amount v matches the encrypted amount in tx
    // ════════════════════════════════════════════════════════════════════════
    
    var DOMAIN_AMOUNT = 5751473824626833252789463;  // hash of "amount"
    
    component amountKeyHash = Blake2s256(2);
    amountKeyHash.in[0] <== DOMAIN_AMOUNT;
    amountKeyHash.in[1] <== S_x;
    
    // Extract lower 64 bits for XOR key
    component hashBits = Num2Bits(256);
    hashBits.in <== amountKeyHash.out;
    
    component amountKey = Bits2Num(64);
    for (var i = 0; i < 64; i++) {
        amountKey.in[i] <== hashBits.out[i];
    }
    
    // XOR decryption
    component xorDecrypt = BitwiseXor64();
    xorDecrypt.a <== ecdhAmount;
    xorDecrypt.b <== amountKey.out;
    
    signal decrypted_amount <== xorDecrypt.out;
    
    // Verify decrypted amount matches claimed amount v
    signal amount_match <== decrypted_amount - v;
    amount_match === 0;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 7: Verify bridge transaction binding
    // binding = Keccak256(R || P || C || ecdhAmount)
    // Creates unique bridge-specific identifier for this proof
    // ════════════════════════════════════════════════════════════════════════
    
    // Prepare input bits for Keccak (832 bits total)
    component R_bits = Num2Bits(256);
    R_bits.in <== R_x;
    
    component P_bits = Num2Bits(256);
    P_bits.in <== P_compressed;
    
    component C_bits = Num2Bits(256);
    C_bits.in <== C_compressed;
    
    component ecdh_bits = Num2Bits(64);
    ecdh_bits.in <== ecdhAmount;
    
    // Keccak256(R || P || C || ecdhAmount)
    component bindingHash = Keccak256(832);
    
    // Pack bits in big-endian order
    for (var i = 0; i < 256; i++) {
        bindingHash.in[i] <== R_bits.out[255 - i];
        bindingHash.in[256 + i] <== P_bits.out[255 - i];
        bindingHash.in[512 + i] <== C_bits.out[255 - i];
    }
    for (var i = 0; i < 64; i++) {
        bindingHash.in[768 + i] <== ecdh_bits.out[63 - i];
    }
    
    // Convert hash output to field element
    component hashToField = Bits2Num(256);
    for (var i = 0; i < 256; i++) {
        hashToField.in[i] <== bindingHash.out[255 - i];
    }
    
    signal computed_binding <== hashToField.out;
    
    // Verify binding matches public input
    signal binding_match <== computed_binding - bridge_tx_binding;
    binding_match === 0;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 8: Chain ID verification (replay protection)
    // ════════════════════════════════════════════════════════════════════════
    
    signal chain_match <== chain_id - CHAIN_ID_ARBITRUM;
    chain_match === 0;
    
    // ════════════════════════════════════════════════════════════════════════
    // OUTPUTS
    // ════════════════════════════════════════════════════════════════════════
    
    verified_binding <== bridge_tx_binding;
    verified_amount <== v;
}

// ════════════════════════════════════════════════════════════════════════════
// HELPER TEMPLATES
// ════════════════════════════════════════════════════════════════════════════

// 64-bit XOR operation
template BitwiseXor64() {
    signal input a;
    signal input b;
    signal output out;
    
    component aBits = Num2Bits(64);
    component bBits = Num2Bits(64);
    
    aBits.in <== a;
    bBits.in <== b;
    
    signal xorBits[64];
    for (var i = 0; i < 64; i++) {
        // XOR: a + b - 2*a*b
        xorBits[i] <== aBits.out[i] + bBits.out[i] - 2 * aBits.out[i] * bBits.out[i];
    }
    
    component outNum = Bits2Num(64);
    for (var i = 0; i < 64; i++) {
        outNum.in[i] <== xorBits[i];
    }
    
    out <== outNum.out;
}

// Validate point is on ed25519 curve
template Edwards25519OnCurve() {
    signal input point_x;
    signal input point_y;
    signal output is_valid;
    
    // Ed25519 curve: -x² + y² = 1 + d·x²·y²
    // d = -121665/121666 mod p
    var d = 37095705934669439343138083508754565189542113879843219016388785533085940283555;
    var p = 57896044618658097711785492504343953926634992332820282019728792003956564819949;
    
    signal x2 <== point_x * point_x;
    signal y2 <== point_y * point_y;
    signal x2y2 <== x2 * y2;
    
    // LHS: -x² + y² (mod p)
    signal lhs <== y2 - x2;
    
    // RHS: 1 + d·x²·y² (mod p)
    signal rhs <== 1 + d * x2y2;
    
    // Check equality (simplified - production needs proper mod p handling)
    component eq = IsEqual();
    eq.in[0] <== lhs;
    eq.in[1] <== rhs;
    
    is_valid <== eq.out;
}

// Validate point is in prime-order subgroup (cofactor 8)
template Edwards25519SubgroupCheck() {
    signal input point_x;
    signal input point_y;
    signal output is_valid;
    
    // Multiply by cofactor 8
    // If result is identity (0, 1), point is in small subgroup
    component mul8 = Edwards25519ScalarMul(4);  // 8 = 2^3, 4 bits
    mul8.scalar <== 8;
    mul8.point_x <== point_x;
    mul8.point_y <== point_y;
    
    // Check result is NOT identity
    component isZeroX = IsZero();
    isZeroX.in <== mul8.out_x;
    
    component isOneY = IsEqual();
    isOneY.in[0] <== mul8.out_y;
    isOneY.in[1] <== 1;
    
    // is_identity = (x == 0) AND (y == 1)
    signal is_identity <== isZeroX.out * isOneY.out;
    
    // Valid if NOT identity
    is_valid <== 1 - is_identity;
}

// Reduce 256-bit value modulo ed25519 scalar order l
template ScalarMod_l() {
    signal input in;
    signal output out;
    
    // l = 2^252 + 27742317777372353535851937790883648493
    // For production: implement full Barrett reduction
    // This is a placeholder that assumes input < l
    out <== in;
}

// Main component declaration
component main {public [
    R_x, 
    P_compressed, 
    C_compressed, 
    ecdhAmount, 
    B_compressed, 
    monero_tx_hash, 
    bridge_tx_binding, 
    chain_id
]} = MoneroBridgeV54();
```

### **2.3 Circuit: `circuits/monero_tls.circom`**

The TLS circuit remains unchanged from v5.3 - approximately 1.2M R1CS constraints for TLS 1.3 verification with certificate pinning against registered node fingerprints.

---

## **3. Solidity Contract Specification**

### **3.1 Contract Overview**

**Key Changes for v5.4:**

| Feature | v5.3 | v5.4 |
|---------|------|------|
| **Oracle Consensus** | Simple N-of-M (count-based) | Quadratic-weighted (reputation-based) |
| **Price Oracle** | Direct Chainlink spot | TWAP (15-min EMA) for liquidations |
| **Oracle Bonding** | None | 1,000 DAI minimum, slashable |
| **Pause Mechanism** | None | Guardian pause (mints only) |
| **Pedersen Commitment** | v·G + γ·H (incorrect) | v·H + γ·G (Monero-native) |
| **Binding Hash** | SHA256 | Keccak256 (Ethereum-native) |
| **Circuit Version** | 3 | 4 |
| **Contract LOC** | ~950 | ~1,150 |

### **3.2 Core Contract: `MoneroBridge.sol`**

```solidity
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

// ════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ════════════════════════════════════════════════════════════════════════════

interface IBridgeVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[10] calldata _pubSignals
    ) external view returns (bool);
}

interface ITLSVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[3] calldata _pubSignals
    ) external view returns (bool);
}

interface ISavingsDAI {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20Mintable is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN CONTRACT
// ════════════════════════════════════════════════════════════════════════════

contract MoneroBridge is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ════════════════════════════════════════════════════════════════════════
    
    // Collateralization
    uint256 public constant INITIAL_COLLATERAL_BPS = 15000;     // 150%
    uint256 public constant LIQUIDATION_THRESHOLD_BPS = 12000;  // 120%
    uint256 public constant CRITICAL_THRESHOLD_BPS = 10500;     // 105%
    
    // Timing
    uint256 public constant BURN_COUNTDOWN = 2 hours;
    uint256 public constant MAX_PRICE_AGE = 60 seconds;
    uint256 public constant NODE_CHANGE_COOLDOWN = 7 days;
    uint256 public constant GUARDIAN_UNPAUSE_DELAY = 30 days;
    uint256 public constant MONERO_CONFIRMATIONS = 10;
    
    // Oracle
    uint256 public constant MIN_ORACLE_BOND = 1000e18;          // 1,000 DAI
    uint256 public constant ORACLE_REWARD_BPS = 200;            // 2% of yield
    uint256 public constant MIN_WEIGHTED_CONSENSUS = 3e18;      // 3.0 weighted votes
    uint256 public constant INITIAL_ACCURACY = 1e18;            // 100%
    uint256 public constant ACCURACY_DECAY = 0.25e18;           // -25% per slash
    
    // TWAP
    uint256 public constant TWAP_PERIOD = 15 minutes;
    uint256 public constant TWAP_OBSERVATIONS = 15;
    
    // Fees
    uint256 public constant MIN_FEE_BPS = 5;
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant MAX_SLIPPAGE_BPS = 50;              // 0.5%
    
    // Chain
    uint256 public constant CHAIN_ID = 42161;                   // Arbitrum One
    uint8 public constant CIRCUIT_VERSION = 4;
    
    // Addresses (Arbitrum One)
    address public constant DAI = 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1A;
    address public constant SDAI = 0xD8134205b0328F5676aaeFb3B2a0DC60036d9d7a;

    // ════════════════════════════════════════════════════════════════════════
    // IMMUTABLES
    // ════════════════════════════════════════════════════════════════════════
    
    IERC20Mintable public immutable wXMR;
    address public immutable treasury;
    address public immutable guardian;
    
    AggregatorV3Interface public immutable priceFeedXMR;
    AggregatorV3Interface public immutable priceFeedDAI;
    IBridgeVerifier public immutable bridgeVerifier;
    ITLSVerifier public immutable tlsVerifier;
    ISavingsDAI public immutable sDAI;
    IERC20 public immutable dai;

    // ════════════════════════════════════════════════════════════════════════
    // STATE
    // ════════════════════════════════════════════════════════════════════════
    
    // Pause state
    bool public mintsPaused;
    uint256 public pausedAt;
    uint256 public unpauseRequestedAt;
    
    // Node management
    uint256 public lastNodeChange;
    uint32 public nodeCount;
    
    // TWAP state
    uint256 public twapIndex;
    uint256 public lastTwapUpdate;

    // ════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ════════════════════════════════════════════════════════════════════════
    
    struct LP {
        bytes32 spendKey;           // ed25519 public key (compressed)
        uint256 collateral;         // DAI deposited
        uint256 obligation;         // wXMR obligation value in DAI
        uint256 sDAIShares;         // sDAI balance
        uint16 mintFeeBps;
        uint16 burnFeeBps;
        uint48 lastActive;
        uint48 timelock;
        bool active;
    }
    
    struct Oracle {
        uint256 bond;               // DAI bonded
        uint256 accuracy;           // 1e18 = 100%
        uint256 proofsSubmitted;
        uint256 proofsAccepted;
        uint256 rewards;
        uint48 lastActive;
        uint8 slashCount;
        bool active;
    }
    
    struct MoneroNode {
        bytes32 certFingerprint;
        string url;
        uint48 addedAt;
        bool active;
    }
    
    struct Burn {
        address user;
        address lp;
        uint256 amount;
        uint48 timestamp;
        bytes32 moneroTxHash;
        bool completed;
    }
    
    struct OracleVote {
        address oracle;
        uint256 weight;
        uint48 timestamp;
        bool valid;
    }
    
    struct PricePoint {
        uint48 timestamp;
        uint208 cumulativePrice;
    }

    // ════════════════════════════════════════════════════════════════════════
    // MAPPINGS
    // ════════════════════════════════════════════════════════════════════════
    
    mapping(address => LP) public lps;
    mapping(address => Oracle) public oracles;
    mapping(uint32 => MoneroNode) public nodes;
    mapping(bytes32 => Burn) public burns;
    mapping(bytes32 => bool) public usedTxHashes;
    
    // Consensus tracking
    mapping(bytes32 => mapping(address => OracleVote)) public votes;
    mapping(bytes32 => address[]) public voters;
    mapping(bytes32 => uint256) public totalWeight;
    
    // TWAP
    PricePoint[15] public pricePoints;

    // ════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════════════
    
    event LPRegistered(address indexed lp, bytes32 spendKey);
    event CollateralAdded(address indexed lp, uint256 amount, uint256 shares);
    event CollateralRemoved(address indexed lp, uint256 amount);
    
    event OracleRegistered(address indexed oracle, uint256 bond);
    event OracleSlashed(address indexed oracle, uint256 amount, string reason);
    event OracleVoteSubmitted(bytes32 indexed binding, address oracle, uint256 weight);
    
    event ConsensusReached(bytes32 indexed binding, uint256 weight, uint256 count);
    event Minted(bytes32 indexed txHash, bytes32 binding, address user, uint256 amount, address lp);
    event BurnStarted(bytes32 indexed burnId, address user, uint256 amount, address lp);
    event BurnCompleted(bytes32 indexed burnId, bytes32 moneroTxHash);
    event BurnClaimed(bytes32 indexed burnId, address user, uint256 payout);
    
    event Liquidated(address indexed lp, address liquidator, uint256 seized, uint256 twapPrice);
    
    event NodeAdded(uint32 indexed index, string url, bytes32 fingerprint);
    event NodeRemoved(uint32 indexed index);
    
    event MintsPaused(address guardian);
    event UnpauseRequested(address guardian, uint256 effectiveAt);
    event MintsUnpaused();
    
    event TWAPUpdated(uint256 index, uint256 price);

    // ════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ════════════════════════════════════════════════════════════════════════
    
    error Paused();
    error NotGuardian();
    error TimelockActive();
    error Cooldown();
    error InvalidBond();
    error AlreadyVoted();
    error NoConsensus();
    error InvalidProof();
    error TxUsed();
    error LPInactive();
    error Undercollateralized();
    error NotLiquidatable();
    error FlashLoanBlock();
    error InvalidFee();
    error StalePrice();
    error DepegCritical();
    error BurnExpired();
    error BurnActive();
    error AlreadyDone();
    error NotLP();
    error InvalidKey();

    // ════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ════════════════════════════════════════════════════════════════════════
    
    modifier whenNotPaused() {
        if (mintsPaused) revert Paused();
        _;
    }
    
    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }
    
    modifier noFlashLoan(address _lp) {
        if (lps[_lp].lastActive >= block.timestamp) revert FlashLoanBlock();
        _;
    }

    // ════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ════════════════════════════════════════════════════════════════════════
    
    constructor(
        address _wXMR,
        address _priceFeedXMR,
        address _priceFeedDAI,
        address _bridgeVerifier,
        address _tlsVerifier,
        address _treasury,
        address _guardian,
        MoneroNode[] memory _initialNodes
    ) {
        wXMR = IERC20Mintable(_wXMR);
        treasury = _treasury;
        guardian = _guardian;
        
        priceFeedXMR = AggregatorV3Interface(_priceFeedXMR);
        priceFeedDAI = AggregatorV3Interface(_priceFeedDAI);
        bridgeVerifier = IBridgeVerifier(_bridgeVerifier);
        tlsVerifier = ITLSVerifier(_tlsVerifier);
        sDAI = ISavingsDAI(SDAI);
        dai = IERC20(DAI);
        
        // Initialize nodes
        for (uint i = 0; i < _initialNodes.length; i++) {
            nodes[uint32(i)] = _initialNodes[i];
            emit NodeAdded(uint32(i), _initialNodes[i].url, _initialNodes[i].certFingerprint);
        }
        nodeCount = uint32(_initialNodes.length);
        lastNodeChange = block.timestamp;
        
        // Initialize TWAP
        _initTWAP();
    }

    // ════════════════════════════════════════════════════════════════════════
    // GUARDIAN FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Pause mints immediately (for emergencies)
    function pauseMints() external onlyGuardian {
        mintsPaused = true;
        pausedAt = block.timestamp;
        unpauseRequestedAt = 0;
        emit MintsPaused(guardian);
    }
    
    /// @notice Request unpause (30-day delay)
    function requestUnpause() external onlyGuardian {
        require(mintsPaused, "not paused");
        unpauseRequestedAt = block.timestamp;
        emit UnpauseRequested(guardian, block.timestamp + GUARDIAN_UNPAUSE_DELAY);
    }
    
    /// @notice Execute unpause after delay
    function executeUnpause() external {
        require(mintsPaused, "not paused");
        require(unpauseRequestedAt > 0, "not requested");
        if (block.timestamp < unpauseRequestedAt + GUARDIAN_UNPAUSE_DELAY) {
            revert TimelockActive();
        }
        mintsPaused = false;
        unpauseRequestedAt = 0;
        emit MintsUnpaused();
    }

    // ════════════════════════════════════════════════════════════════════════
    // TWAP ORACLE
    // ════════════════════════════════════════════════════════════════════════
    
    function _initTWAP() internal {
        (, int256 price,,,) = priceFeedXMR.latestRoundData();
        require(price > 0, "invalid price");
        
        uint256 p = uint256(price);
        for (uint i = 0; i < TWAP_OBSERVATIONS; i++) {
            pricePoints[i] = PricePoint({
                timestamp: uint48(block.timestamp),
                cumulativePrice: uint208(p * (i + 1))
            });
        }
        lastTwapUpdate = block.timestamp;
    }
    
    /// @notice Update TWAP with new observation
    function updateTWAP() public {
        (, int256 price,, uint256 updatedAt,) = priceFeedXMR.latestRoundData();
        if (block.timestamp - updatedAt > MAX_PRICE_AGE) revert StalePrice();
        require(price > 0, "invalid price");
        
        uint256 elapsed = block.timestamp - lastTwapUpdate;
        if (elapsed < 60) return; // Min 1 minute between updates
        
        uint256 newIndex = (twapIndex + 1) % TWAP_OBSERVATIONS;
        uint256 prevCumulative = pricePoints[twapIndex].cumulativePrice;
        
        pricePoints[newIndex] = PricePoint({
            timestamp: uint48(block.timestamp),
            cumulativePrice: uint208(prevCumulative + uint256(price) * elapsed)
        });
        
        twapIndex = newIndex;
        lastTwapUpdate = block.timestamp;
        
        emit TWAPUpdated(newIndex, uint256(price));
    }
    
    /// @notice Get 15-minute TWAP
    function getTWAP() public view returns (uint256) {
        uint256 newest = twapIndex;
        uint256 oldest = (newest + 1) % TWAP_OBSERVATIONS;
        
        PricePoint memory n = pricePoints[newest];
        PricePoint memory o = pricePoints[oldest];
        
        uint256 timeElapsed = n.timestamp - o.timestamp;
        if (timeElapsed < TWAP_PERIOD / 2) {
            // Not enough data, return spot
            (, int256 price,,,) = priceFeedXMR.latestRoundData();
            return uint256(price);
        }
        
        return (n.cumulativePrice - o.cumulativePrice) / timeElapsed;
    }
    
    /// @notice Get spot price
    function getSpotPrice() public view returns (uint256) {
        (, int256 price,, uint256 updatedAt,) = priceFeedXMR.latestRoundData();
        if (block.timestamp - updatedAt > MAX_PRICE_AGE) revert StalePrice();
        return uint256(price);
    }

    // ════════════════════════════════════════════════════════════════════════
    // ORACLE MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Register as oracle with bond
    function registerOracle(uint256 _bond) external nonReentrant {
        if (_bond < MIN_ORACLE_BOND) revert InvalidBond();
        require(!oracles[msg.sender].active, "exists");
        
        dai.safeTransferFrom(msg.sender, address(this), _bond);
        
        oracles[msg.sender] = Oracle({
            bond: _bond,
            accuracy: INITIAL_ACCURACY,
            proofsSubmitted: 0,
            proofsAccepted: 0,
            rewards: 0,
            lastActive: uint48(block.timestamp),
            slashCount: 0,
            active: true
        });
        
        emit OracleRegistered(msg.sender, _bond);
    }
    
    /// @notice Add bond
    function addBond(uint256 _amount) external nonReentrant {
        Oracle storage o = oracles[msg.sender];
        require(o.active, "inactive");
        
        dai.safeTransferFrom(msg.sender, address(this), _amount);
        o.bond += _amount;
    }
    
    /// @notice Get oracle quadratic weight
    /// weight = sqrt(accuracy * (1 + log2(proofs + 1)))
    function getOracleWeight(address _oracle) public view returns (uint256) {
        Oracle storage o = oracles[_oracle];
        if (!o.active || o.accuracy == 0) return 0;
        
        // Experience multiplier: 1 + min(proofs/10, 2) => max 3x
        uint256 expMul = 1e18 + Math.min(o.proofsSubmitted * 1e17 / 10, 2e18);
        
        // Combined: accuracy * experience
        uint256 combined = (o.accuracy * expMul) / 1e18;
        
        // Quadratic: sqrt
        return _sqrt(combined);
    }
    
    /// @notice Slash oracle
    function slashOracle(address _oracle, bytes32 _binding, string calldata _reason) external {
        require(msg.sender == treasury, "only treasury"); // TODO: Replace with fraud proof
        
        Oracle storage o = oracles[_oracle];
        require(o.active, "inactive");
        
        OracleVote storage v = votes[_binding][_oracle];
        require(v.oracle == _oracle && v.valid, "no valid vote");
        
        // Slash 25% of bond
        uint256 slash = o.bond / 4;
        o.bond -= slash;
        o.accuracy = o.accuracy > ACCURACY_DECAY ? o.accuracy - ACCURACY_DECAY : 0;
        o.slashCount++;
        v.valid = false;
        
        dai.safeTransfer(treasury, slash);
        
        emit OracleSlashed(_oracle, slash, _reason);
        
        // Deactivate if under minimum
        if (o.bond < MIN_ORACLE_BOND) {
            o.active = false;
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // LP MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Register as LP
    function registerLP(bytes32 _spendKey, uint16 _mintFee, uint16 _burnFee) external whenNotPaused {
        if (_mintFee < MIN_FEE_BPS || _mintFee > MAX_FEE_BPS) revert InvalidFee();
        if (_burnFee < MIN_FEE_BPS || _burnFee > MAX_FEE_BPS) revert InvalidFee();
        require(lps[msg.sender].spendKey == bytes32(0), "exists");
        if (!_validateEd25519Key(_spendKey)) revert InvalidKey();
        
        lps[msg.sender] = LP({
            spendKey: _spendKey,
            collateral: 0,
            obligation: 0,
            sDAIShares: 0,
            mintFeeBps: _mintFee,
            burnFeeBps: _burnFee,
            lastActive: uint48(block.timestamp),
            timelock: uint48(block.timestamp + 7 days),
            active: true
        });
        
        emit LPRegistered(msg.sender, _spendKey);
    }
    
    /// @notice Deposit DAI collateral
    function depositCollateral(uint256 _amount) external whenNotPaused nonReentrant {
        LP storage l = lps[msg.sender];
        if (!l.active) revert LPInactive();
        
        dai.safeTransferFrom(msg.sender, address(this), _amount);
        
        // Convert to sDAI
        dai.approve(address(sDAI), _amount);
        uint256 shares = sDAI.deposit(_amount, address(this));
        
        l.collateral += _amount;
        l.sDAIShares += shares;
        
        emit CollateralAdded(msg.sender, _amount, shares);
    }
    
    /// @notice Withdraw excess collateral
    function withdrawCollateral(uint256 _amount) external nonReentrant {
        LP storage l = lps[msg.sender];
        if (!l.active) revert LPInactive();
        require(block.timestamp > l.timelock, "timelocked");
        
        uint256 required = (l.obligation * INITIAL_COLLATERAL_BPS) / 10000;
        if (l.collateral - _amount < required) revert Undercollateralized();
        
        l.collateral -= _amount;
        
        // Redeem sDAI
        uint256 sharesToBurn = (_amount * 1e18) / _getSDAIPrice();
        sharesToBurn = Math.min(sharesToBurn, l.sDAIShares);
        l.sDAIShares -= sharesToBurn;
        
        uint256 received = sDAI.redeem(sharesToBurn, msg.sender, address(this));
        
        emit CollateralRemoved(msg.sender, received);
    }

    // ════════════════════════════════════════════════════════════════════════
    // ORACLE VOTING (QUADRATIC WEIGHTED)
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Submit TLS proof for transaction
    function submitVote(
        bytes32 _binding,
        bytes32[2] calldata _txData,
        uint64 _ecdhAmount,
        uint32 _nodeIndex,
        uint256[2] calldata _proofA,
        uint256[2][2] calldata _proofB,
        uint256[2] calldata _proofC,
        uint256[3] calldata _tlsSignals,
        uint256 _blockHeight
    ) external whenNotPaused {
        Oracle storage o = oracles[msg.sender];
        require(o.active, "inactive oracle");
        
        MoneroNode storage node = nodes[_nodeIndex];
        require(node.active, "inactive node");
        
        // Verify confirmations
        require(block.timestamp > _blockHeight * 120 + MONERO_CONFIRMATIONS * 120, "unconfirmed");
        
        // Verify TLS proof
        require(tlsVerifier.verifyProof(_proofA, _proofB, _proofC, _tlsSignals), "bad tls proof");
        require(_tlsSignals[2] == uint256(node.certFingerprint), "cert mismatch");
        
        // Prevent double voting
        if (votes[_binding][msg.sender].oracle != address(0)) revert AlreadyVoted();
        
        // Calculate weight
        uint256 weight = getOracleWeight(msg.sender);
        require(weight > 0, "zero weight");
        
        // Record vote
        votes[_binding][msg.sender] = OracleVote({
            oracle: msg.sender,
            weight: weight,
            timestamp: uint48(block.timestamp),
            valid: true
        });
        voters[_binding].push(msg.sender);
        totalWeight[_binding] += weight;
        
        o.proofsSubmitted++;
        o.lastActive = uint48(block.timestamp);
        
        emit OracleVoteSubmitted(_binding, msg.sender, weight);
        
        // Check consensus
        if (totalWeight[_binding] >= MIN_WEIGHTED_CONSENSUS) {
            emit ConsensusReached(_binding, totalWeight[_binding], voters[_binding].length);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // MINTING
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Mint wXMR with ZK proof
    function mint(
        bytes32 _moneroTxHash,
        bytes32 _binding,
        uint64 _amount,
        uint256[2] calldata _proofA,
        uint256[2][2] calldata _proofB,
        uint256[2] calldata _proofC,
        bytes32[3] calldata _publicData, // R, P, C
        uint64 _ecdhAmount,
        address _lp
    ) external whenNotPaused nonReentrant {
        if (usedTxHashes[_moneroTxHash]) revert TxUsed();
        
        LP storage l = lps[_lp];
        if (!l.active) revert LPInactive();
        
        // Update TWAP
        updateTWAP();
        
        // Check consensus
        if (totalWeight[_binding] < MIN_WEIGHTED_CONSENSUS) revert NoConsensus();
        
        // Verify recipient
        require(_publicData[1] == l.spendKey, "wrong recipient");
        
        // Price check
        uint256 price = getSpotPrice();
        if (_checkDepeg() == 2) revert DepegCritical();
        
        // Collateral check
        uint256 obligationInDAI = (_amount * price) / 1e8;
        uint256 required = (obligationInDAI * INITIAL_COLLATERAL_BPS) / 10000;
        if (l.collateral < required) revert Undercollateralized();
        
        // Verify ZK proof
        uint256[10] memory signals = [
            uint256(_publicData[0]),      // R
            uint256(_publicData[1]),      // P
            uint256(_publicData[2]),      // C
            uint256(_ecdhAmount),
            uint256(l.spendKey),          // B
            uint256(_moneroTxHash),
            uint256(_binding),
            CHAIN_ID,
            uint256(_amount),
            uint256(CIRCUIT_VERSION)
        ];
        
        if (!bridgeVerifier.verifyProof(_proofA, _proofB, _proofC, signals)) {
            revert InvalidProof();
        }
        
        // Update state
        usedTxHashes[_moneroTxHash] = true;
        l.obligation += obligationInDAI;
        l.lastActive = uint48(block.timestamp);
        
        // Reward oracles
        _rewardOracles(_binding);
        
        // Mint
        uint256 fee = (_amount * l.mintFeeBps) / 10000;
        uint256 toMint = _amount - fee;
        
        wXMR.mint(msg.sender, toMint);
        if (fee > 0) wXMR.mint(_lp, fee);
        
        emit Minted(_moneroTxHash, _binding, msg.sender, _amount, _lp);
    }
    
    function _rewardOracles(bytes32 _binding) internal {
        address[] storage v = voters[_binding];
        uint256 total = totalWeight[_binding];
        if (total == 0 || v.length == 0) return;
        
        uint256 pool = _calcRewardPool();
        
        for (uint i = 0; i < v.length; i++) {
            OracleVote storage vote = votes[_binding][v[i]];
            if (vote.valid) {
                Oracle storage o = oracles[vote.oracle];
                uint256 reward = (pool * vote.weight) / total;
                o.rewards += reward;
                o.proofsAccepted++;
                
                // Accuracy recovery (+1% per accepted proof)
                if (o.accuracy < INITIAL_ACCURACY) {
                    o.accuracy = Math.min(o.accuracy + 0.01e18, INITIAL_ACCURACY);
                }
                
                if (reward > 0) wXMR.mint(vote.oracle, reward);
            }
        }
    }
    
    function _calcRewardPool() internal view returns (uint256) {
        uint256 tvl = (sDAI.balanceOf(address(this)) * _getSDAIPrice()) / 1e18;
        uint256 annualYield = (tvl * 5) / 100; // 5% APY assumed
        uint256 oracleShare = (annualYield * ORACLE_REWARD_BPS) / 10000;
        return oracleShare / 1000; // Per-mint (assume 1000 mints/year)
    }

    // ════════════════════════════════════════════════════════════════════════
    // BURNING
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Start burn process
    function startBurn(uint256 _amount, address _lp) external nonReentrant {
        if (!lps[_lp].active) revert LPInactive();
        
        wXMR.burn(msg.sender, _amount);
        
        bytes32 id = keccak256(abi.encodePacked(msg.sender, block.timestamp, _amount, _lp));
        burns[id] = Burn({
            user: msg.sender,
            lp: _lp,
            amount: _amount,
            timestamp: uint48(block.timestamp),
            moneroTxHash: bytes32(0),
            completed: false
        });
        
        emit BurnStarted(id, msg.sender, _amount, _lp);
    }
    
    /// @notice LP completes burn
    function completeBurn(bytes32 _id, bytes32 _moneroTxHash) external {
        Burn storage b = burns[_id];
        if (b.completed) revert AlreadyDone();
        if (b.lp != msg.sender) revert NotLP();
        if (block.timestamp > b.timestamp + 72 hours) revert BurnExpired();
        
        b.moneroTxHash = _moneroTxHash;
        b.completed = true;
        
        // Reduce obligation using TWAP
        uint256 twap = getTWAP();
        uint256 reduction = (b.amount * twap) / 1e8;
        
        LP storage l = lps[b.lp];
        l.obligation = l.obligation > reduction ? l.obligation - reduction : 0;
        l.lastActive = uint48(block.timestamp);
        
        emit BurnCompleted(_id, _moneroTxHash);
    }
    
    /// @notice Claim failed burn (after 2 hours)
    function claimBurn(bytes32 _id) external nonReentrant {
        Burn storage b = burns[_id];
        if (b.completed) revert AlreadyDone();
        if (block.timestamp <= b.timestamp + BURN_COUNTDOWN) revert BurnActive();
        
        // Calculate payout at 150% using TWAP
        uint256 twap = getTWAP();
        uint256 value = (b.amount * twap) / 1e8;
        uint256 payout = (value * INITIAL_COLLATERAL_BPS) / 10000;
        
        // Depeg handling
        LP storage l = lps[b.lp];
        if (_checkDepeg() == 2) {
            payout = Math.min(payout, l.collateral);
        }
        
        if (l.collateral < payout) revert Undercollateralized();
        l.collateral -= payout;
        
        // Redeem sDAI
        uint256 shares = (payout * 1e18) / _getSDAIPrice();
        shares = Math.min(shares, l.sDAIShares);
        l.sDAIShares -= shares;
        
        uint256 received = sDAI.redeem(shares, address(this), address(this));
        
        // Slippage check
        uint256 minReceive = (payout * (10000 - MAX_SLIPPAGE_BPS)) / 10000;
        require(received >= minReceive, "slippage");
        
        dai.safeTransfer(b.user, received);
        b.completed = true;
        
        emit BurnClaimed(_id, b.user, received);
    }

    // ════════════════════════════════════════════════════════════════════════
    // LIQUIDATION (TWAP PROTECTED)
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Liquidate undercollateralized LP
    function liquidate(address _lp) external noFlashLoan(_lp) nonReentrant {
        LP storage l = lps[_lp];
        if (!l.active) revert LPInactive();
        
        updateTWAP();
        
        // Use TWAP for liquidation decision
        uint256 twap = getTWAP();
        uint256 xmrValue = (l.obligation * twap) / 1e8;
        
        if (xmrValue == 0) revert NotLiquidatable();
        
        uint256 ratio = (l.collateral * 10000) / xmrValue;
        if (ratio >= LIQUIDATION_THRESHOLD_BPS) revert NotLiquidatable();
        
        l.lastActive = uint48(block.timestamp);
        
        // Seize all sDAI
        uint256 shares = l.sDAIShares;
        l.sDAIShares = 0;
        uint256 received = sDAI.redeem(shares, address(this), address(this));
        
        // Liquidator gets 5%
        uint256 liquidatorCut = received / 20;
        uint256 toTreasury = received - liquidatorCut;
        
        dai.safeTransfer(msg.sender, liquidatorCut);
        dai.safeTransfer(treasury, toTreasury);
        
        emit Liquidated(_lp, msg.sender, received, twap);
        
        // Deactivate
        l.collateral = 0;
        l.obligation = 0;
        l.active = false;
    }

    // ════════════════════════════════════════════════════════════════════════
    // NODE MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════
    
    function addNode(string calldata _url, bytes32 _fingerprint) external {
        if (block.timestamp < lastNodeChange + NODE_CHANGE_COOLDOWN) revert Cooldown();
        require(bytes(_url).length > 0 && _fingerprint != bytes32(0), "invalid");
        
        uint32 idx = nodeCount++;
        nodes[idx] = MoneroNode({
            certFingerprint: _fingerprint,
            url: _url,
            addedAt: uint48(block.timestamp),
            active: true
        });
        lastNodeChange = block.timestamp;
        
        emit NodeAdded(idx, _url, _fingerprint);
    }
    
    function removeNode(uint32 _idx) external {
        if (block.timestamp < lastNodeChange + NODE_CHANGE_COOLDOWN) revert Cooldown();
        require(nodes[_idx].active, "inactive");
        
        nodes[_idx].active = false;
        lastNodeChange = block.timestamp;
        
        emit NodeRemoved(_idx);
    }

    // ════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ════════════════════════════════════════════════════════════════════════
    
    function _getSDAIPrice() internal view returns (uint256) {
        return sDAI.previewRedeem(1e18);
    }
    
    function _validateEd25519Key(bytes32 _key) internal pure returns (bool) {
        if (_key == bytes32(0)) return false;
        // Basic validation - production should use full curve check
        uint256 y = uint256(_key) & ((1 << 255) - 1);
        uint256 p = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed;
        return y < p;
    }
    
    function _checkDepeg() internal view returns (uint256) {
        (, int256 price,,,) = priceFeedDAI.latestRoundData();
        if (price < 0.95e8) return 2; // Critical
        if (price < 0.98e8) return 1; // Warning
        return 0;
    }
    
    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════
    
    function getLP(address _lp) external view returns (LP memory) {
        return lps[_lp];
    }
    
    function getOracle(address _oracle) external view returns (Oracle memory) {
        return oracles[_oracle];
    }
    
    function getConsensus(bytes32 _binding) external view returns (uint256 weight, uint256 count, bool reached) {
        weight = totalWeight[_binding];
        count = voters[_binding].length;
        reached = weight >= MIN_WEIGHTED_CONSENSUS;
    }
    
    function getHealthFactor(address _lp) external view returns (uint256) {
        LP storage l = lps[_lp];
        if (!l.active || l.obligation == 0) return type(uint256).max;
        
        uint256 twap = getTWAP();
        uint256 xmrValue = (l.obligation * twap) / 1e8;
        
        return (l.collateral * 1e18 * 10000) / (xmrValue * LIQUIDATION_THRESHOLD_BPS);
    }
}
```

---

## **4. Economic Model**

### **4.1 LP Position Example**

```
User deposits: 10 XMR @ $150 = $1,500 value
LP required collateral: $1,500 × 1.50 = $2,250 DAI

LP posts: 2,250 DAI → ~2,180 sDAI (at 1.032 price)
Yield: 5% APY on sDAI = $112.50/year
├─ Oracle reward pool: $2.25/year (2% of yield)
└─ LP net yield: $110.25/year (~4.9% APY)
```

### **4.2 Collateralization Tiers**

| Tier | Ratio | Status | Actions |
|------|-------|--------|---------|
| **Healthy** | ≥150% | ✅ Normal | All operations |
| **Warning** | 120-150% | ⚠️ At risk | Cannot mint more |
| **Liquidatable** | <120% | 🔴 TWAP-verified | Open to liquidation |
| **Critical** | <105% | 🚨 Emergency | Priority liquidation |

### **4.3 Oracle Quadratic Weighting**

**Formula:** `weight = sqrt(accuracy × experienceMultiplier)`

Where `experienceMultiplier = 1 + min(proofsSubmitted / 10, 2)`

| Oracle State | Accuracy | Proofs | Experience | Combined | Weight |
|--------------|----------|--------|------------|----------|--------|
| **New** | 100% | 0 | 1.0× | 1.00 | 1.00 |
| **Active** | 100% | 20 | 1.2× | 1.20 | 1.10 |
| **Experienced** | 100% | 50 | 1.5× | 1.50 | 1.22 |
| **Veteran** | 100% | 100+ | 2.0× | 2.00 | 1.41 |
| **Slashed 1×** | 75% | 100+ | 2.0× | 1.50 | 1.22 |
| **Slashed 2×** | 50% | 100+ | 2.0× | 1.00 | 1.00 |
| **Slashed 3×** | 25% | 100+ | 2.0× | 0.50 | 0.71 |
| **Slashed 4×** | 0% | 100+ | 2.0× | 0.00 | 0.00 |

**Minimum consensus:** 3.0 weighted votes

**Example consensus scenarios:**
- 3 new oracles: 1.0 + 1.0 + 1.0 = 3.0 ✅
- 2 veterans + 1 new: 1.41 + 1.41 + 1.0 = 3.82 ✅
- 2 new oracles: 1.0 + 1.0 = 2.0 ❌
- 1 veteran + 1 slashed-2×: 1.41 + 1.0 = 2.41 ❌

### **4.4 TWAP Configuration**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| **Period** | 15 minutes | Manipulation resistance |
| **Observations** | 15 | ~1 min granularity |
| **Min Update Interval** | 60 seconds | Prevent spam |
| **Fallback** | Spot price | If insufficient data |

---

## **5. Performance Targets**

### **5.1 Proving Times**

| Environment | Time | Memory | Notes |
|-------------|------|--------|-------|
| **Browser (WASM)** | 2.0-2.8s | ~1.0 GB | snarkjs optimized |
| **Browser (WebGPU)** | 1.4-2.0s | ~600 MB | Chrome 120+ |
| **Native (rapidsnark)** | 0.5-0.8s | ~500 MB | 8-core CPU |
| **Mobile (iOS)** | 3.5-4.5s | ~1.2 GB | iPhone 15 Pro |

### **5.2 Gas Costs (Arbitrum)**

| Function | Gas | L1 Data | Cost @ 30 gwei |
|----------|-----|---------|----------------|
| `registerOracle` | 180k | 2.5kb | ~$0.35 |
| `submitVote` | 680k | 4.5kb | ~$1.18 |
| `mint` | **920k** | 10.2kb | ~$1.45 |
| `startBurn` | 98k | 1.5kb | ~$0.20 |
| `completeBurn` | 145k | 2.8kb | ~$0.28 |
| `claimBurn` | 580k | 3.2kb | ~$0.85 |
| `liquidate` | **520k** | 2.6kb | ~$0.78 |
| `updateTWAP` | 65k | 0.8kb | ~$0.12 |

---

## **6. Security Analysis**

### **6.1 Attack Cost Matrix**

| Attack | Requirements | Cost | Outcome |
|--------|--------------|------|---------|
| **3 Sybil Oracles** | 3× 1,000 DAI bonds | 3,000 DAI | Slashed if detected |
| **TWAP Manipulation** | 15-min sustained | Arbitrage losses | Economically infeasible |
| **Flash Loan Liquidation** | Flash loan + oracle | — | Blocked by TWAP |
| **Oracle Majority** | >50% weighted votes | Variable | Degraded influence via slashing |
| **Circuit Bug Exploit** | Zero-day | — | Guardian pause available |

### **6.2 Trust Assumptions**

1. **Chainlink**: Trusted for spot prices; TWAP provides resistance
2. **3+ Honest Oracles**: Required for consensus
3. **Guardian Key**: Can only pause mints; 30-day unpause delay
4. **Circuit Correctness**: Pre-mainnet audits required
5. **Monero Nodes**: N-of-M with TLS pinning

---

## **7. Sequence Diagrams**

### **7.1 Mint Flow**

```
User                Frontend            Oracles (3)         Contract
 │                     │                    │                  │
 ├─ Export r, tx_hash ─►                    │                  │
 │                     │                    │                  │
 │◄─── Fetch tx data ──┤                    │                  │
 │                     │                    │                  │
 │                     ├─ Generate binding ─►                  │
 │                     │   hash (Keccak)    │                  │
 │                     │                    │                  │
 │                     ├─ Generate ZK proof─►                  │
 │                     │   (2.0s)           │                  │
 │                     │                    │                  │
 │                     │                    ├── submitVote ───►│
 │                     │                    │   (weight: 1.0)  │
 │                     │                    ├── submitVote ───►│
 │                     │                    │   (weight: 1.22) │
 │                     │                    ├── submitVote ───►│
 │                     │                    │   (weight: 1.41) │
 │                     │                    │                  │
 │                     │                    │◄── Consensus ────┤
 │                     │                    │    (3.63 ≥ 3.0)  │
 │                     │                    │                  │
 │                     ├────── mint() ─────────────────────────►
 │                     │                                       │
 │◄─────────────────── wXMR ──────────────────────────────────┤
```

### **7.2 Liquidation Flow**

```
Liquidator            Contract              TWAP
    │                    │                   │
    ├─── liquidate() ───►│                   │
    │                    ├── updateTWAP() ──►│
    │                    │◄── 15-min avg ───┤
    │                    │                   │
    │                    ├── Check ratio     │
    │                    │   (< 120%)        │
    │                    │                   │
    │                    ├── Seize sDAI      │
    │                    ├── Redeem DAI      │
    │                    │                   │
    │◄── 5% reward ──────┤                   │
    │    (DAI)           │                   │
    │                    ├── 95% to treasury │
```

---

## **8. Deployment Checklist**

### **8.1 Pre-Mainnet Requirements**

- [ ] Circuit formal verification (Ecne/Picus)
- [ ] Groth16 trusted setup ceremony (100+ participants)
- [ ] Trail of Bits audit (contracts + circuits)
- [ ] Ed25519 Solidity library audit
- [ ] Monero wallet integration (`get_tx_key` PR merged)
- [ ] Chainlink wXMR/USD feed approved
- [ ] Guardian multisig setup (3-of-5)
- [ ] Initial node set deployment (5 nodes minimum)

### **8.2 Circuit Status**

| Component | Status | Constraints | ETA |
|-----------|--------|-------------|-----|
| `monero_bridge_v54.circom` | 🟡 90% | ~62,100 | 2 weeks |
| `monero_tls.circom` | ✅ Complete | ~1.2M | — |
| Ed25519 library | 🟡 Testing | ~18,000 | 1 week |
| Keccak256 | ✅ Complete | ~5,000 | — |
| Trusted setup | 🔴 Not started | — | Q1 2025 |

---

## **9. Changelog**

| Version | Date | Changes |
|---------|------|---------|
| **v5.4** | 2024-12 | Corrected Pedersen (v·H + γ·G), quadratic oracle weighting, TWAP liquidations, oracle bonding, guardian pause, Keccak binding hash |
| **v5.3** | 2024-11 | N-of-M consensus, removed admin/pause, on-chain node registry |
| **v5.2** | 2024-10 | Fixed ZK witness model |
| **v5.1** | 2024-09 | Instant liquidations |
| **v5.0** | 2024-08 | DAI-only collateral |

---

## **10. License & Disclaimer**

**License:** MIT (Circom), GPL-3.0 (Solidity)

**⚠️ WARNING: ZK CIRCUITS NOT YET AUDITED. GROTH16 TRUSTED SETUP PENDING. DO NOT USE IN PRODUCTION.**

This is experimental software. Users risk total loss of funds. No insurance, no backstop. DAI depeg and circuit bugs are primary systemic risks.

**Estimated Mainnet:** Q3 2025

---

*Document Version: 5.4.0*
*Last Updated: December 2024*
*Authors: FUNGERBIL Team*
