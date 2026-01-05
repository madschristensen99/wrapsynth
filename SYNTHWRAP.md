# **Monero→Arbitrum Bridge Specification v7.0**

*Hybrid ZK Architecture: Ed25519 DLEQ + PLONK Proofs + Output Merkle Trees*

**Current: ~4.2M constraints, Output Merkle Tree verification, zkTLS-ready, 150% initial collateral, 120% liquidation threshold, DAI-only yield**

**Platform: Base Sepolia (Testnet) → Arbitrum One (Mainnet)**

**Collateral: Yield-Bearing DAI Only (sDAI, aDAI)**

**Status: ✅ Ed25519 DLEQ Verified On-Chain | ✅ Output Merkle Tree Implemented | ⚠️ Requires Security Audit**

---

## **1. Architecture & Principles**

### **1.1 Core Design Tenets**

1. **Cryptographic Layer (Hybrid)**: 
   - **Off-Chain**: Ed25519 operations (R=r·G, S=8·r·A, P=H_s·G+B) using @noble/ed25519
   - **On-Chain**: Ed25519 DLEQ proof verification (proves log_G(R) = log_A(rA) = r)
   - **In-Circuit**: Poseidon commitment binding all witness values (~1,167 constraints)
   - **Status**: ✅ DLEQ verified on Base Sepolia | ⚠️ Requires audit
2. **Economic Layer (Contracts)**: Enforces DAI-only collateralization, manages liquidity risk, **TWAP-protected liquidations** with 15-minute exponential moving average.
3. **Oracle Layer (On-Chain)**: **Quadratic-weighted N-of-M consensus** based on historical proof accuracy. Minimum 3.0 weighted votes required, weighted by oracle reputation score.
4. **Privacy Transparency**: Single-key verification model; destination address provided as explicit input.
5. **Minimal Governance**: No admin elections, no Snapshot. **Single guardian address** can pause mints only (30-day timelock to unpause). All other parameters immutable at deployment.

### **1.2 System Components**

```
┌─────────────────────────────────────────────────────────────┐
│              User Frontend (Browser/Wallet)                  │
│  - Paste tx secret key (r) from wallet                       │
│  - Paste tx hash + output index                              │
│  - Enter LP address (A, B) + amount                          │
│  - Fetch transaction data from Monero node                   │
│  - Fetch Merkle proofs (TX + output) from oracle/node       │
│  - Generate Ed25519 operations (R, S, P) - @noble/ed25519   │
│  - Generate DLEQ proof (c, s, K1, K2)                        │
│  - Generate PLONK proof (~4.2M constraints, server-side)     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│   Security-Hardened Circuit (Circom, ~4.2M constraints)     │
│  Proves:                                                     │
│    - Poseidon commitment binding witness values             │
│    - Amount decryption correctness (v XOR ecdhAmount)       │
│    - Stealth address derivation (P = H_s·G + B)             │
│    - Scalar range checks (r < L, H_s < L)                   │
│    - 64-bit amount range check (v < 2^64)                   │
│    - Point validation and decompression                      │
│                                                              │
│  ⚠️  Requires security audit                               │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│         Ed25519 DLEQ Verification (Solidity)               │
│  Verifies:                                                   │
│    - DLEQ proof: log_G(R) = log_A(rA) = r                   │
│    - Ed25519 point operations using precompile (0x05)       │
│    - Challenge: c = H(G, A, R, rA, K1, K2) mod L            │
│    - Response: s·G = K1 + c·R  AND  s·A = K2 + c·rA        │
│                                                              │
│  ✅ Verified on Base Sepolia (Gas: ~4.1M)                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│         Output Merkle Tree Verification (NEW!)              │
│  Verifies:                                                   │
│    - TX exists in block (txMerkleRoot)                      │
│    - Output data authentic (outputMerkleRoot)               │
│    - Leaf = Hash(txHash||index||ecdhAmount||pubKey||commit) │
│    - Prevents amount fraud (ecdhAmount verified)            │
│                                                              │
│  ✅ zkTLS-ready: One proof per block (not per TX)          │
│  ✅ No oracle liveness per transaction                      │
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

## **2. Zero-Knowledge Proof System**

### **2.1 Circuit Overview**

The MoneroBridge circuit (~4.2M constraints) cryptographically proves:

1. **Secret Key Knowledge**: Proves r·G = R without revealing r
2. **Destination Correctness**: Proves funds sent to LP address (A, B)
3. **Amount Verification**: Decrypts and verifies ecdhAmount matches claimed value

**Key Properties:**
- Client-side witness generation (browser-based)
- PLONK proof system with universal setup (no trusted ceremony needed)
- Replay protection via on-chain tx_hash tracking

### **2.2 Proof Generation Flow**

1. **Fetch Transaction Data**: Retrieve Monero tx from registered node
2. **Validate Confirmations**: Require 10+ block confirmations
3. **Compute Witnesses**: Generate circuit inputs (secret key, amount, addresses)
4. **Generate Proof**: Create Groth16 proof client-side using snarkjs
5. **Submit On-Chain**: Send proof + public inputs to bridge contract

### **2.3 Output Merkle Tree Architecture (NEW in v7.0)**

**Problem Solved**: Prevents amount fraud without requiring oracle liveness per transaction.

**How It Works:**

1. **Oracle Posts Blocks** (every 2 minutes):
   - Fetches Monero block from RPC
   - Extracts all transaction outputs
   - Computes two Merkle roots:
     - `txMerkleRoot`: Merkle root of all TX hashes (proves TX exists)
     - `outputMerkleRoot`: Merkle root of all output data (proves amounts authentic)
   - Posts to contract: `(blockHeight, blockHash, txMerkleRoot, outputMerkleRoot)`

2. **User Submits Proof**:
   - Fetches output data from any Monero node
   - Fetches Merkle proofs (TX proof + output proof)
   - Submits: `(zkProof, outputData, txMerkleProof, outputMerkleProof)`

3. **Contract Verifies**:
   - TX exists in block (via txMerkleProof)
   - Output data is authentic (via outputMerkleProof)
   - ecdhAmount matches oracle-posted data
   - ZK proof proves ownership

**Merkle Leaf Structure:**
```solidity
leaf = keccak256(abi.encodePacked(
    txHash,
    outputIndex,
    ecdhAmount,      // CRITICAL: Prevents amount fraud
    outputPubKey,
    commitment
));
```

**Benefits:**
- ✅ **No oracle liveness per TX**: Oracle posts once per block
- ✅ **Amount fraud impossible**: ecdhAmount committed in Merkle tree
- ✅ **zkTLS-ready**: One zkTLS proof covers entire block
- ✅ **Scalable**: Unlimited transactions per block
- ✅ **User autonomy**: Can get data from any Monero node

**Gas Costs:**
- Oracle: ~200k gas per block (every 2 min)
- User: ~50k gas for Merkle proofs + ~600k for ZK proof

### **2.4 Technical Summary**

- **Constraint Count**: ~4.2M (2.6M non-linear + 1.6M linear)
- **Proof System**: PLONK with universal setup
- **Key Operations**: Ed25519 scalar multiplications, point operations, Keccak256 hashing
- **Optimization**: H_s_scalar precomputed off-circuit (saves ~150k constraints)
- **Merkle Trees**: Dual-root system (TX existence + output authenticity)



---

## **3. Economic Model & Collateralization**

### **3.1 Collateral Requirements**

- **Initial Collateral**: 150% of minted wXMR value in DAI
- **Liquidation Threshold**: 120% collateralization ratio
- **Accepted Collateral**: Yield-bearing DAI only (sDAI, aDAI)
- **Collateral Custody**: Non-custodial - LPs maintain control

### **3.2 Liquidation Mechanics**

- **Price Oracle**: TWAP (15-minute exponential moving average) via Chainlink
- **Liquidation Trigger**: Collateral ratio falls below 120%
- **Liquidation Penalty**: 5% bonus to liquidator
- **Partial Liquidations**: Allowed to restore healthy ratio

### **3.3 Oracle Consensus Model**

**Quadratic-Weighted N-of-M Voting:**
- Minimum 3.0 weighted votes required for proof acceptance
- Oracle reputation score based on historical accuracy
- Vote weight = (reputation_score)²
- Slashing for provably false attestations

**Oracle Requirements:**
- Minimum 1,000 DAI bond (slashable)
- Run registered Monero node
- Verify ZK proofs on-chain
- Attest to transaction validity

### **3.4 Fee Structure**

- **Mint Fee**: 0.3% (paid to LPs)
- **Burn Fee**: 0.3% (paid to LPs)
- **Oracle Rewards**: From yield + accuracy bonuses
- **LP Yield**: From collateral (sDAI/aDAI) + bridge fees

### **3.5 Risk Parameters**

| Parameter | Value | Rationale |
|-----------|-------|----------|
| Initial Collateral | 150% | Buffer against volatility |
| Liquidation Threshold | 120% | Safety margin for liquidators |
| TWAP Window | 15 minutes | Balance responsiveness vs manipulation |
| Min Oracle Bond | 1,000 DAI | Skin in the game |
| Min Weighted Votes | 3.0 | Decentralization + security |
| Guardian Unpause Delay | 30 days | Time for community response |

---

## **4. Integration & Deployment**

### **4.1 Universal Setup (PLONK)**
1. Use existing universal setup parameters (no ceremony needed)
2. Compile circuit to PLONK format
3. Generate verification key from circuit

### **4.2 Solidity Verifier Contract**
1. Export verifier contract: `snarkjs zkey export solidityverifier`
2. Deploy to Arbitrum One
3. Integrate with bridge contract for proof verification

### **4.3 Frontend Integration**
1. Bundle circuit WASM and proving key
2. Implement witness generation in browser
3. Generate proofs client-side using snarkjs
4. Submit proofs to bridge contract



---

## **5. Solidity Contract Specification**

### **5.1 Contract Overview**

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

### **5.2 Core Contract: `MoneroBridgeDLEQ.sol`**

**Key Components:**
- **PLONK Verifier**: Verifies circuit proofs (~1,167 constraints)
- **Ed25519 DLEQ**: Verifies discrete log equality proofs on-chain
- **Collateral Management**: DAI-based collateralization (150% initial, 120% liquidation)
- **Oracle System**: Quadratic-weighted consensus for price feeds
- **TWAP Protection**: 15-minute exponential moving average for liquidations

**Main Functions:**
- `mint()`: Verify DLEQ + PLONK proofs, mint wXMR
- `burn()`: Burn wXMR, release collateral
- `liquidate()`: Liquidate undercollateralized positions
- `verifyDLEQ()`: On-chain Ed25519 DLEQ verification

**Contract deployed on Base Sepolia**: `0x9241b6cE1b969F9BDf64a26CE933915d1b8dA0AD`

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


## **10. License & Disclaimer**

**License:** MIT (Circom), GPL-3.0 (Solidity)

This is experimental cryptographic software. Trusted setup ceremony and security audits pending before mainnet deployment.

---

## **11. Current Deployment Status**

### **Base Sepolia Testnet (Active)**
- **Contract**: `0xA8C386AD6bf98599Cc19B6794F3077B3d9D5328f` (MoneroBridge v7.0)
- **Verifier**: `0xF2D165DB863CE0e1967B30C6B44734254027aF04` (PlonkVerifier)
- **Network**: Base Sepolia (Chain ID: 84532)
- **Status**: ✅ Ed25519 DLEQ + PLONK + Output Merkle Tree verification working
- **Test TX**: [0x612c8cdaacb335e2f56b355f2943a2662ca37452d3f7cfddb44c311d7df01033](https://sepolia.basescan.org/tx/0x612c8cdaacb335e2f56b355f2943a2662ca37452d3f7cfddb44c311d7df01033)
- **Gas Used**: 4,104,653

### **Test Results**
- ✅ All 4 Monero transactions verified (3 stagenet + 1 mainnet)
- ✅ DLEQ proof generation: 100% success rate
- ✅ On-chain verification: PASSING
- ✅ Output Merkle Tree: Implemented and ready
- ✅ Circuit constraints: ~4.2M (security-hardened)
- ✅ Proof time: 3-10 minutes (server-side)
- ✅ zkTLS-ready architecture

### **Architecture v7.0 Features**
- ✅ Dual Merkle tree system (TX + output)
- ✅ Amount fraud prevention
- ✅ No oracle liveness per transaction
- ✅ Stealth address derivation verification
- ✅ Scalar range checks (r < L, H_s < L)
- ⚠️ Requires security audit before mainnet

---

*Document Version: 7.0.0*
*Last Updated: January 2026*
*Authors: FUNGERBIL Team*

**v7.0 Changes:**
- Added Output Merkle Tree architecture for amount fraud prevention
- Upgraded circuit to ~4.2M constraints with security hardening
- Implemented dual Merkle root system (TX + output)
- zkTLS-ready: No oracle liveness per transaction
- Stealth address derivation verification
- Scalar range checks (r < L, H_s < L)
