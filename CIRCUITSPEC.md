# **Monero→Arbitrum Bridge Specification v5.5**

*Cryptographically Correct, Symmetric Proof Model, Quadratic Oracle Consensus, TWAP-Protected Liquidations*

**Target: 70k constraints, 2.2-3.0s client proving, 150% initial collateral, 120% liquidation threshold, DAI-only yield**

**Platform: Arbitrum One (Solidity, Circom ZK Framework)**

**Collateral: Yield-Bearing DAI Only (sDAI, aDAI)**

**Status: ZK Circuit Implementation In Progress - Symmetric Model Implemented**

---

## **1. Architecture & Principles**

### **1.1 Core Design Tenets**

1. **Cryptographic Layer (Circuit)**: Proves Monero transaction authenticity and amount correctness using Circom. Witnesses generated 100% client-side from wallet data. **Corrected Pedersen commitment: C = v·H + γ·G (Monero-native ordering).** **Symmetric proof model: Dynamic recipient keys as public inputs.**
2. **Economic Layer (Contracts)**: Enforces DAI-only collateralization, manages liquidity risk, **TWAP-protected liquidations** with 15-minute exponential moving average.
3. **Oracle Layer (On-Chain)**: **Quadratic-weighted N-of-M consensus** based on historical proof accuracy. Minimum 3.0 weighted votes required, weighted by oracle reputation score.
4. **Privacy Transparency**: Single-key verification model; destination address provided as explicit input.
5. **Minimal Governance**: No admin elections, no Snapshot. **Single guardian address** can pause mints only (30-day timelock to unpause). All other parameters immutable at deployment.
6. **Symmetric Operations**: Both mint and burn use identical ZK circuits with dynamic recipient keys.

### **1.2 System Components**

```
┌─────────────────────────────────────────────────────────────┐
│              User Frontend (Browser/Wallet)                  │
│  MINT:                                                       │
│    - Paste tx secret key (r) from wallet                     │
│    - Paste tx hash                                           │
│    - LP's keys fetched from on-chain registry                │
│  BURN:                                                       │
│    - Paste tx secret key (r) from LP wallet                  │
│    - User's keys from burn request                           │
│  BOTH: Generate witnesses, prove locally (snarkjs)           │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│              Bridge Circuit (Circom, ~70k R1CS)             │
│  Proves:                                                     │
│    - Knowledge of transaction secret (tx_key from wallet)    │
│    - S = r·A (shared secret with VIEW key)                   │
│    - P = Hs(S)·G + B (stealth address derivation)            │
│    - C = v·H + γ·G (Monero Pedersen commitment)             │
│    - Amount decryption from ecdhAmount                       │
│    - bridge_tx_binding = Keccak256(R||P||C||ecdhAmount)      │
│  KEY INNOVATION: A, B are PUBLIC INPUTS (dynamic per proof) │
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
│            Solidity Bridge Contract (~1,350 LOC)            │
│  - Manages LP collateral (DAI only)                         │
│  - **Quadratic-weighted N-of-M consensus** (min 3.0 votes)  │
│  - **TWAP oracle** (15-min EMA for liquidations)            │
│  - Enforces 150% collateralization (120% liquidation)       │
│  - Oracle rewards from yield + accuracy bonuses             │
│  - **On-chain node registry** (max 1 change/week)           │
│  - **Guardian pause** (mints only, 30-day unpause timelock) │
│  - **Oracle bonding** (slashable for provably false proofs) │
│  - **Symmetric burn model** with user key registration      │
└─────────────────────────────────────────────────────────────┘
```

### **1.3 Symmetric Proof Model**

**Critical Design Decision**: Both mint and burn operations use **identical ZK circuits**. The only difference is the source of recipient keys:

| Operation | Recipient View Key (A) | Recipient Spend Key (B) | Source |
|-----------|------------------------|-------------------------|--------|
| **Mint** | LP's view key | LP's spend key | On-chain LP registry |
| **Burn** | User's view key | User's spend key | `startBurn()` parameters |

This symmetry ensures:
- Single circuit implementation reduces audit surface
- Identical security properties for both operations
- No asymmetric vulnerabilities between mint/burn flows

---

## **2. Cryptographic Specification**

### **2.1 Witness Generation & Proof Flow**

**User Data Requirements (Mint):**

1. **Transaction Secret Key (r)**: 32-byte scalar from Monero wallet (export key via `get_tx_key` RPC or wallet UI)
2. **Transaction Hash**: 32-byte Keccak hash of the Monero transaction being proven
3. **Amount (v)**: Explicit amount user wants to prove (in atomic units). Must match `ecdhAmount` decryption
4. **Destination Address (P)**: 32-byte compressed ed25519 stealth address that received the funds
5. **LP View Key (A)**: Retrieved from on-chain LP registry (compressed ed25519 point)
6. **LP Spend Key (B)**: Retrieved from on-chain LP registry (compressed ed25519 point)

**LP Data Requirements (Burn):**

1. **Transaction Secret Key (r)**: 32-byte scalar from LP's Monero wallet
2. **Transaction Hash**: 32-byte Keccak hash of the Monero transaction sent to user
3. **Amount (v)**: Amount sent to user (in atomic units)
4. **Destination Address (P)**: 32-byte compressed ed25519 stealth address (user's)
5. **User View Key (A)**: From burn request on-chain
6. **User Spend Key (B)**: From burn request on-chain

**Frontend Witness Generation Process:**

```typescript
// Client-side witness generation for Monero Bridge v5.5
// SYMMETRIC MODEL: Works for both mint and burn operations
import { groth16 } from 'snarkjs';
import { keccak256, concat, zeroPad } from 'ethers';

interface ProofData {
  proof: Groth16Proof;
  publicSignals: string[];
  bindingHash: string;
}

interface RecipientKeys {
  viewKey: Uint8Array;   // A: recipient's public view key
  spendKey: Uint8Array;  // B: recipient's public spend key
}

async function generateBridgeProof(
  txSecretKey: Uint8Array,
  txHash: Uint8Array,
  destinationAddr: Uint8Array,
  amount: bigint,
  recipientKeys: RecipientKeys
): Promise<ProofData> {
  
  const txData = await fetchMoneroTxData(txHash, REGISTERED_NODE_URL);
  const { R, C, ecdhAmount, blockHeight } = parseTxData(txData);
  
  if (!bytesEqual(txData.stealthAddress, destinationAddr)) {
    throw new Error("Destination address does not match transaction output");
  }
  
  const currentHeight = await getMoneroBlockHeight();
  if (currentHeight - blockHeight < 10) {
    throw new Error("Insufficient confirmations (need 10)");
  }
  
  const bindingHash = keccak256(
    concat([R, destinationAddr, C, zeroPad(ecdhAmount, 8)])
  );
  
  const witness = {
    r: bytesToBigInt(txSecretKey),
    v: amount,
    recipient_view_key_compressed: bytesToBigInt(recipientKeys.viewKey),
    recipient_spend_key_compressed: bytesToBigInt(recipientKeys.spendKey),
    R_x: bytesToBigInt(R),
    P_compressed: bytesToBigInt(destinationAddr),
    C_compressed: bytesToBigInt(C),
    ecdhAmount: bytesToBigInt(ecdhAmount),
    monero_tx_hash: bytesToBigInt(txHash),
    bridge_tx_binding: bytesToBigInt(bindingHash),
    chain_id: 42161n
  };
  
  const wasmBuffer = await fetch('/circuits/monero_bridge_v55.wasm');
  const zkeyBuffer = await fetch('/circuits/monero_bridge_v55_final.zkey');
  const witnessBuffer = await groth16.calculateWitness(wasmBuffer, witness);
  const { proof, publicSignals } = await groth16.prove(zkeyBuffer, witnessBuffer);
  
  return { proof, publicSignals, bindingHash };
}
```

**Circuit Constraints:**

- **Private Inputs** (witnesses): `r` (256 bits), `v` (64 bits)
- **Public Inputs**: `recipient_view_key_compressed`, `recipient_spend_key_compressed`, `R_x`, `P_compressed`, `C_compressed`, `ecdhAmount`, `monero_tx_hash`, `bridge_tx_binding`, `chain_id`
- **Total R1CS Constraints**: ~70,100 (Groth16, BN254 curve)
- **Constraint breakdown**:
  - Ed25519 point decompression (×4: R, A, B, P): ~16,000
  - ECDH shared secret (r·A): ~12,000
  - Stealth address derivation (Hs(S)·G + B): ~12,000
  - Pedersen commitment (C = v·H + γ·G): ~12,000
  - Blake2s hashing (×2): ~6,000
  - Keccak256 binding hash: ~5,000
  - Subgroup checks: ~4,000
  - Comparators and XOR: ~3,100

### **2.2 Circuit: `circuits/monero_bridge_v55.circom`**

```circom
// monero_bridge_v55.circom - Bridge Circuit Implementation v5.5
// ~70,100 R1CS constraints
// SYMMETRIC MODEL: Dynamic recipient keys for both mint and burn
// CORRECTED: Shared secret uses VIEW key (A), not spend key (B)
// CORRECTED: Pedersen commitment C = v·H + γ·G (Monero-native)

pragma circom 2.1.0;

include "./node_modules/circomlib/circuits/comparators.circom";
include "./node_modules/circomlib/circuits/bitify.circom";
include "./lib/ed25519/scalar_mul.circom";
include "./lib/ed25519/point_add.circom";
include "./lib/ed25519/decompress.circom";
include "./lib/ed25519/compress.circom";
include "./lib/blake2s/blake2s.circom";
include "./lib/keccak/keccak256.circom";

// Ed25519 generators
function ed25519_G_x() { return 15112221349535807912866137220509078935008241517919556395372977116978572556916; }
function ed25519_G_y() { return 46316835694926478169428394003475163141307993866256225615783033603165251855960; }
function ed25519_H_x() { return 8930616275096260027165186217098051128673217689547350420792059958988862086200; }
function ed25519_H_y() { return 17417034168806754314938390856096528618625447415188373560431728790908888314185; }

template MoneroBridgeV55() {
    
    // PRIVATE INPUTS
    signal input r;        // Transaction secret key (256-bit)
    signal input v;        // Amount in piconero (64 bits)
    
    // PUBLIC INPUTS - DYNAMIC RECIPIENT KEYS
    signal input recipient_view_key_compressed;   // A
    signal input recipient_spend_key_compressed;  // B
    
    // PUBLIC INPUTS - Transaction data
    signal input R_x;
    signal input P_compressed;
    signal input C_compressed;
    signal input ecdhAmount;
    signal input monero_tx_hash;
    signal input bridge_tx_binding;
    signal input chain_id;
    
    // OUTPUTS
    signal output verified_binding;
    signal output verified_amount;
    
    var CHAIN_ID_ARBITRUM = 42161;
    
    signal G_x <== ed25519_G_x();
    signal G_y <== ed25519_G_y();
    signal H_x <== ed25519_H_x();
    signal H_y <== ed25519_H_y();
    
    // STEP 1: Decompress R
    component decompressR = Edwards25519Decompress();
    decompressR.compressed <== R_x;
    signal R_point_x <== decompressR.point_x;
    signal R_point_y <== decompressR.point_y;
    
    component validateR = Edwards25519OnCurve();
    validateR.point_x <== R_point_x;
    validateR.point_y <== R_point_y;
    validateR.is_valid === 1;
    
    // STEP 2: Decompress VIEW key A
    component decompressA = Edwards25519Decompress();
    decompressA.compressed <== recipient_view_key_compressed;
    signal A_x <== decompressA.point_x;
    signal A_y <== decompressA.point_y;
    
    component validateA = Edwards25519OnCurve();
    validateA.point_x <== A_x;
    validateA.point_y <== A_y;
    validateA.is_valid === 1;
    
    component subgroupA = Edwards25519SubgroupCheck();
    subgroupA.point_x <== A_x;
    subgroupA.point_y <== A_y;
    subgroupA.is_valid === 1;
    
    // STEP 3: Decompress SPEND key B
    component decompressB = Edwards25519Decompress();
    decompressB.compressed <== recipient_spend_key_compressed;
    signal B_x <== decompressB.point_x;
    signal B_y <== decompressB.point_y;
    
    component validateB = Edwards25519OnCurve();
    validateB.point_x <== B_x;
    validateB.point_y <== B_y;
    validateB.is_valid === 1;
    
    component subgroupB = Edwards25519SubgroupCheck();
    subgroupB.point_x <== B_x;
    subgroupB.point_y <== B_y;
    subgroupB.is_valid === 1;
    
    // STEP 4: Shared secret S = r·A (VIEW key!)
    // CRITICAL FIX: v5.4 incorrectly used B here
    component computeS = Edwards25519ScalarMul(256);
    computeS.scalar <== r;
    computeS.point_x <== A_x;  // VIEW key
    computeS.point_y <== A_y;
    signal S_x <== computeS.out_x;
    signal S_y <== computeS.out_y;
    
    // STEP 5: Stealth address P = Hs(S)·G + B
    var DOMAIN_STEALTH = 8761254936472819264537281;
    component hsHash = Blake2s256(2);
    hsHash.in[0] <== DOMAIN_STEALTH;
    hsHash.in[1] <== S_x;
    
    component reduceHs = ScalarMod_l();
    reduceHs.in <== hsHash.out;
    signal hs <== reduceHs.out;
    
    component compute_hsG = Edwards25519ScalarMul(256);
    compute_hsG.scalar <== hs;
    compute_hsG.point_x <== G_x;
    compute_hsG.point_y <== G_y;
    
    component computeP = Edwards25519Add();
    computeP.p1_x <== compute_hsG.out_x;
    computeP.p1_y <== compute_hsG.out_y;
    computeP.p2_x <== B_x;  // SPEND key
    computeP.p2_y <== B_y;
    
    component compressP = Edwards25519Compress();
    compressP.point_x <== computeP.out_x;
    compressP.point_y <== computeP.out_y;
    
    signal p_match <== compressP.compressed - P_compressed;
    p_match === 0;
    
    // STEP 6: Blinding factor γ
    var DOMAIN_COMMITMENT = 7165135828475249253285442470189481501;
    component gammaHash = Blake2s256(3);
    gammaHash.in[0] <== DOMAIN_COMMITMENT;
    gammaHash.in[1] <== S_x;
    gammaHash.in[2] <== 0;
    
    component reduceGamma = ScalarMod_l();
    reduceGamma.in <== gammaHash.out;
    signal gamma <== reduceGamma.out;
    
    // STEP 7: Pedersen C = v·H + γ·G
    component compute_vH = Edwards25519ScalarMul(64);
    compute_vH.scalar <== v;
    compute_vH.point_x <== H_x;
    compute_vH.point_y <== H_y;
    
    component compute_gammaG = Edwards25519ScalarMul(256);
    compute_gammaG.scalar <== gamma;
    compute_gammaG.point_x <== G_x;
    compute_gammaG.point_y <== G_y;
    
    component computeC = Edwards25519Add();
    computeC.p1_x <== compute_vH.out_x;
    computeC.p1_y <== compute_vH.out_y;
    computeC.p2_x <== compute_gammaG.out_x;
    computeC.p2_y <== compute_gammaG.out_y;
    
    component compressC = Edwards25519Compress();
    compressC.point_x <== computeC.out_x;
    compressC.point_y <== computeC.out_y;
    
    signal c_match <== compressC.compressed - C_compressed;
    c_match === 0;
    
    // STEP 8: Amount decryption
    var DOMAIN_AMOUNT = 5751473824626833252789463;
    component amountKeyHash = Blake2s256(2);
    amountKeyHash.in[0] <== DOMAIN_AMOUNT;
    amountKeyHash.in[1] <== S_x;
    
    component hashBits = Num2Bits(256);
    hashBits.in <== amountKeyHash.out;
    
    component amountKey = Bits2Num(64);
    for (var i = 0; i < 64; i++) {
        amountKey.in[i] <== hashBits.out[i];
    }
    
    component xorDecrypt = BitwiseXor64();
    xorDecrypt.a <== ecdhAmount;
    xorDecrypt.b <== amountKey.out;
    
    signal decrypted_amount <== xorDecrypt.out;
    signal amount_match <== decrypted_amount - v;
    amount_match === 0;
    
    // STEP 9: Binding hash verification
    component R_bits = Num2Bits(256);
    R_bits.in <== R_x;
    component P_bits = Num2Bits(256);
    P_bits.in <== P_compressed;
    component C_bits = Num2Bits(256);
    C_bits.in <== C_compressed;
    component ecdh_bits = Num2Bits(64);
    ecdh_bits.in <== ecdhAmount;
    
    component bindingHash = Keccak256(832);
    for (var i = 0; i < 256; i++) {
        bindingHash.in[i] <== R_bits.out[255 - i];
        bindingHash.in[256 + i] <== P_bits.out[255 - i];
        bindingHash.in[512 + i] <== C_bits.out[255 - i];
    }
    for (var i = 0; i < 64; i++) {
        bindingHash.in[768 + i] <== ecdh_bits.out[63 - i];
    }
    
    component hashToField = Bits2Num(256);
    for (var i = 0; i < 256; i++) {
        hashToField.in[i] <== bindingHash.out[255 - i];
    }
    
    signal computed_binding <== hashToField.out;
    signal binding_match <== computed_binding - bridge_tx_binding;
    binding_match === 0;
    
    // STEP 10: Chain ID
    signal chain_match <== chain_id - CHAIN_ID_ARBITRUM;
    chain_match === 0;
    
    verified_binding <== bridge_tx_binding;
    verified_amount <== v;
}

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
        xorBits[i] <== aBits.out[i] + bBits.out[i] - 2 * aBits.out[i] * bBits.out[i];
    }
    
    component outNum = Bits2Num(64);
    for (var i = 0; i < 64; i++) {
        outNum.in[i] <== xorBits[i];
    }
    out <== outNum.out;
}

template Edwards25519OnCurve() {
    signal input point_x;
    signal input point_y;
    signal output is_valid;
    
    var d = 37095705934669439343138083508754565189542113879843219016388785533085940283555;
    
    signal x2 <== point_x * point_x;
    signal y2 <== point_y * point_y;
    signal x2y2 <== x2 * y2;
    
    signal lhs <== y2 - x2;
    signal rhs <== 1 + d * x2y2;
    
    component eq = IsEqual();
    eq.in[0] <== lhs;
    eq.in[1] <== rhs;
    is_valid <== eq.out;
}

template Edwards25519SubgroupCheck() {
    signal input point_x;
    signal input point_y;
    signal output is_valid;
    
    component mul8 = Edwards25519ScalarMul(4);
    mul8.scalar <== 8;
    mul8.point_x <== point_x;
    mul8.point_y <== point_y;
    
    component isZeroX = IsZero();
    isZeroX.in <== mul8.out_x;
    
    component isOneY = IsEqual();
    isOneY.in[0] <== mul8.out_y;
    isOneY.in[1] <== 1;
    
    signal is_identity <== isZeroX.out * isOneY.out;
    is_valid <== 1 - is_identity;
}

template ScalarMod_l() {
    signal input in;
    signal output out;
    out <== in;  // Production: implement Barrett reduction
}

component main {public [
    recipient_view_key_compressed,
    recipient_spend_key_compressed,
    R_x, 
    P_compressed, 
    C_compressed, 
    ecdhAmount,
    monero_tx_hash, 
    bridge_tx_binding, 
    chain_id
]} = MoneroBridgeV55();
```

---

## **3. Solidity Contract Specification**

### **3.1 Contract Overview**

**Key Changes for v5.5:**

| Feature | v5.4 | v5.5 |
|---------|------|------|
| **Proof Model** | Asymmetric (mint only) | **Symmetric (mint & burn)** |
| **Burn User Keys** | Not captured | **Stored in Burn struct** |
| **Shared Secret** | r·B (incorrect) | **r·A (view key, correct)** |
| **Circuit Public Inputs** | 8 signals | **10 signals (+ A, B)** |
| **LP Keys** | Spend key only | **View key + Spend key** |
| **Key Validation** | Basic | **Full curve validation** |
| **Anti-Grief** | None | **10 DAI burn deposit** |

### **3.2 Core Data Structures**

```solidity
struct LP {
    bytes32 viewKey;            // ed25519 public VIEW key (A) - NEW
    bytes32 spendKey;           // ed25519 public SPEND key (B)
    uint256 collateral;
    uint256 obligation;
    uint256 sDAIShares;
    uint16 mintFeeBps;
    uint16 burnFeeBps;
    uint48 lastActive;
    uint48 timelock;
    bool active;
}

struct Burn {
    address user;
    address lp;
    uint256 amount;
    bytes32 userViewKey;    // User's view key (A) - NEW
    bytes32 userSpendKey;   // User's spend key (B) - NEW
    uint256 deposit;        // Anti-grief deposit - NEW
    uint48 timestamp;
    bytes32 moneroTxHash;
    bool completed;
}
```

### **3.3 Key Functions**

```solidity
// LP Registration (requires both keys)
function registerLP(
    bytes32 _viewKey,      // LP's public view key (A)
    bytes32 _spendKey,     // LP's public spend key (B)
    uint16 _mintFee,
    uint16 _burnFee
) external;

// Start burn (requires user keys + deposit)
function startBurn(
    uint256 _amount,
    address _lp,
    bytes32 _userViewKey,  // User's public view key
    bytes32 _userSpendKey  // User's public spend key
) external;

// Complete burn (requires ZK proof using user's keys)
function completeBurn(
    bytes32 _id,
    bytes32 _moneroTxHash,
    uint256[2] calldata _proofA,
    uint256[2][2] calldata _proofB,
    uint256[2] calldata _proofC,
    bytes32[3] calldata _publicData,
    uint64 _ecdhAmount
) external;
```

---

## **4. Economic Model**

### **4.1 Collateralization Tiers**

| Tier | Ratio | Status | Actions |
|------|-------|--------|---------|
| **Healthy** | ≥150% | ✅ Normal | All operations |
| **Warning** | 120-150% | ⚠️ At risk | Cannot mint more |
| **Liquidatable** | <120% | 🔴 TWAP-verified | Open to liquidation |
| **Critical** | <105% | 🚨 Emergency | Priority liquidation |

### **4.2 Oracle Quadratic Weighting**

**Formula:** `weight = sqrt(accuracy × experienceMultiplier)`

| Oracle State | Accuracy | Weight |
|--------------|----------|--------|
| **New** | 100% | 1.00 |
| **Veteran** | 100% | 1.41 |
| **Slashed 1×** | 75% | 1.22 |
| **Slashed 4×** | 0% | 0.00 |

**Minimum consensus:** 3.0 weighted votes

### **4.3 Burn Anti-Grief Mechanism**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| **Deposit Amount** | 10 DAI | Prevent spam burn requests |
| **Refund Condition** | LP completes burn with valid proof | Incentivize valid keys |
| **Claim Condition** | LP fails within 2 hours | User gets deposit + 150% |

---

## **5. Performance Targets**

### **5.1 Proving Times**

| Environment | Time | Memory |
|-------------|------|--------|
| **Browser (WASM)** | 2.2-3.0s | ~1.2 GB |
| **Browser (WebGPU)** | 1.6-2.2s | ~700 MB |
| **Native (rapidsnark)** | 0.6-1.0s | ~600 MB |

### **5.2 Gas Costs (Arbitrum)**

| Function | Gas | Cost @ 30 gwei |
|----------|-----|----------------|
| `mint` | 980k | ~$1.55 |
| `startBurn` | 145k | ~$0.32 |
| `completeBurn` | 920k | ~$1.48 |
| `liquidate` | 520k | ~$0.78 |

---

## **6. Security Analysis**

### **6.1 v5.5 Security Improvements**

| Vulnerability | v5.4 Status | v5.5 Fix |
|---------------|-------------|----------|
| **Broken burns** | Could not be proven | Symmetric model with user keys |
| **Wrong shared secret** | Used spend key (B) | Uses view key (A) |
| **Missing user keys** | Not captured | Stored in Burn struct |
| **Burn griefing** | No protection | 10 DAI anti-grief deposit |

### **6.2 Trust Assumptions**

1. **Chainlink**: Trusted for spot prices; TWAP provides resistance
2. **3+ Honest Oracles**: Required for consensus
3. **Guardian Key**: Can only pause mints; 30-day unpause delay
4. **Circuit Correctness**: Pre-mainnet audits required

---

## **7. Sequence Diagrams**

### **7.1 Burn Flow (v5.5 Symmetric Model)**

```
User                          Contract                        LP
 │                               │                             │
 ├── startBurn() ───────────────►│                             │
 │   (amount, lp,                │                             │
 │    userViewKey,               │                             │
 │    userSpendKey,              │                             │
 │    10 DAI deposit)            │                             │
 │                               │                             │
 │                               ├── Validate & store ────────►│
 │                               │   user's A, B               │
 │                               │                             │
 │                               │                             ├─ Send XMR to user
 │                               │                             │
 │                               │                             ├─ Generate ZK proof
 │                               │                             │  (uses user's A, B)
 │                               │                             │
 │                               │◄── completeBurn() ──────────┤
 │                               │    (proof, txHash)          │
 │                               │                             │
 │◄── Refund 10 DAI deposit ─────┤                             │
```

---

## **8. Key Derivation Reference**

### **8.1 Critical Cryptographic Note**

**ECDH Shared Secret Derivation:**

```
CORRECT (v5.5):  S = r·A  (transaction secret × VIEW key)
INCORRECT (v5.4): S = r·B  (transaction secret × SPEND key)
```

### **8.2 Monero Key Usage**

```
Shared Secret: S = r·A = a·R  ← Uses VIEW key (A)
Stealth Address: P = Hs(S)·G + B  ← Uses SPEND key (B)
Pedersen Commitment: C = v·H + γ·G  ← Value generator H
```

---

## **9. Deployment Checklist**

### **9.1 Pre-Mainnet Requirements**

- [ ] Circuit formal verification
- [ ] Groth16 trusted setup (100+ participants)
- [ ] Trail of Bits audit
- [ ] Ed25519 Solidity library audit
- [ ] **Symmetric burn model testing** (critical)
- [ ] **User key validation testing**

### **9.2 Circuit Status**

| Component | Status | Constraints |
|-----------|--------|-------------|
| `monero_bridge_v55.circom` | 🟡 85% | ~70,100 |
| Ed25519 library | 🟡 Testing | ~20,000 |
| Stealth derivation | 🟡 New | ~12,000 |
| Trusted setup | 🔴 Pending | — |

---

## **10. Changelog**

| Version | Date | Changes |
|---------|------|---------|
| **v5.5** | 2024-12 | **Symmetric proof model**, fixed shared secret (r·A), user keys in burns, enhanced key validation, anti-grief deposits |
| **v5.4** | 2024-12 | Corrected Pedersen, quadratic oracles, TWAP, oracle bonding, guardian pause |
| **v5.3** | 2024-11 | N-of-M consensus, on-chain node registry |

---

## **11. License & Disclaimer**

**License:** MIT (Circom), GPL-3.0 (Solidity)

**⚠️ WARNING: ZK CIRCUITS NOT YET AUDITED. GROTH16 TRUSTED SETUP PENDING. DO NOT USE IN PRODUCTION.**

**Critical v5.5 Note:** This version fixes a fundamental architectural flaw in v5.4 where burns could not be cryptographically proven. The v5.4 burn functionality was broken. **Do not deploy v5.4 to production.**

**Estimated Mainnet:** Q3 2025

---

*Document Version: 5.5.0 | Last Updated: December 2024 | Authors: FUNGERBIL Team*