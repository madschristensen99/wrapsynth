# Monero Bridge - Hybrid ZK Architecture

**Zero-knowledge proof system for trustless Monero→EVM bridging using Ed25519 + PLONK proofs**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Deployed](https://img.shields.io/badge/Deployed-Gnosis%20Chain-green)](https://gnosisscan.io/address/0xe1B76b604F12Fd20b8D490C4C1f0634521626B0B)
[![Verified](https://img.shields.io/badge/Verified-Gnosisscan-brightgreen)](https://gnosisscan.io/address/0xe1B76b604F12Fd20b8D490C4C1f0634521626B0B#code)

## 🎯 Overview

This project implements a **production-ready Monero bridge** with real PLONK verification, Ed25519 cryptography, and DeFi integration on Gnosis Chain.

### Key Features

- ✅ **Real PLONK Verification** - Not a mock, actual cryptographic proofs
- ✅ **Proof Binding Security** - Ed25519 coordinates bound to ZK proof
- ✅ **12 Decimal Precision** - Piconero-level accuracy (0.000000000001 XMR)
- ✅ **Real Monero Mainnet** - Live transaction verification
- ✅ **DeFi Integration** - Aave V3 collateral on Gnosis Chain
- ✅ **100x Cheaper Gas** - ~660k gas (~$0.0007 vs $60 on Ethereum)
- ✅ **Verified Contracts** - Full source code on Gnosisscan
- ✅ **Oracle Integration** - Automated Monero block posting

## 📖 Documentation

For detailed protocol specification, see [SYNTHWRAP.md](../SYNTHWRAP.md)

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              User Frontend (Browser/Wallet)                  │
│  - Generate Ed25519 operations (R, S, P) using @noble/ed25519│
│  - Generate DLEQ proof (c, s, K1, K2)                        │
│  - Generate PLONK proof (~1,167 constraints, <1s)            │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│     DLEQ-Optimized Circuit (Circom, ~1,167 constraints)    │
│  Proves:                                                     │
│    - Poseidon commitment binding witness values             │
│    - Amount decryption correctness (v XOR ecdhAmount)       │
│    - 64-bit range check (v < 2^64)                          │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│         Ed25519 DLEQ Verification (Solidity)               │
│  Verifies:                                                   │
│    - DLEQ proof: log_G(R) = log_A(rA) = r                   │
│    - Ed25519 point operations using precompile (0x05)       │
│    - Challenge: c = H(G, A, R, rA, K1, K2) mod L            │
│    - Response: s·G = K1 + c·R  AND  s·A = K2 + c·rA        │
└─────────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- Node.js >= 18.0.0
- Hardhat
- Circom 2.1.0+
- snarkjs

### Installation

```bash
# Clone repository
git clone https://github.com/madschristensen99/zeroxmr.git
cd zeroxmr/spendProof

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your Base Sepolia RPC and private key
```

### Compile Circuit

```bash
# Compile the DLEQ-optimized circuit
circom monero_bridge.circom --r1cs --wasm --sym -o build

# Generate verification key
snarkjs plonk setup build/monero_bridge.r1cs pot22_final.ptau circuit_final.zkey
```

### Run Tests

```bash
# Test locally
node scripts/test_circuit.js

# Test all transactions (3 stagenet + 1 mainnet)
node scripts/test_all_with_dleq.js

# Test on Base Sepolia
npx hardhat run scripts/test_on_chain.js --network baseSepolia
```

## 📝 Usage Example

```javascript
const { generateWitness } = require('./scripts/generate_witness.js');

// Prepare Monero transaction data
const inputData = {
    r: "4cbf8f2cfb622ee126f08df053e99b96aa2e8c1cfd575d2a651f3343b465800a",
    v: "20000000000",
    H_s_scalar: "...",
    A_compressed: "...",
    B_compressed: "...",
    ecdhAmount: "..."
};

// Generate witness (includes Ed25519 ops + DLEQ proof)
const witness = await generateWitness(inputData);

// Generate PLONK proof
const { proof, publicSignals } = await snarkjs.plonk.fullProve(
    witness,
    "build/monero_bridge_js/monero_bridge.wasm",
    "circuit_final.zkey"
);

// Submit to contract
await bridge.verifyAndMint(
    proof,
    publicSignals,
    witness.dleqProof,
    witness.ed25519Proof,
    txHash
);
```

## 🌐 Deployed Contracts

### Base Sepolia (Testnet)

- **MoneroBridgeDLEQ**: [`0x3D50F6177E6589413A389f8a16314E2dA20a25Ff`](https://sepolia.basescan.org/address/0x3D50F6177E6589413A389f8a16314E2dA20a25Ff)
- **PlonkVerifier**: [`0x3139CB6fa4255591D7667361ab06Fdb155558853`](https://sepolia.basescan.org/address/0x3139CB6fa4255591D7667361ab06Fdb155558853)
- **Network**: Base Sepolia (Chain ID: 84532)

### Verified Transactions

| TX | Network | Amount | Status | BaseScan |
|----|---------|--------|--------|----------|
| TX1 | Stagenet | 20 XMR | ✅ | [View](https://sepolia.basescan.org/tx/0xf53d0a2e550ca00d79680a02c5584bfdb9871bae88025d8ec2ba2447cbec211c) |
| TX2 | Stagenet | 10 XMR | ✅ | [View](https://sepolia.basescan.org/tx/0x3db5c81e177402f12b4ff2ba2acf5aebb6da93d2fe05260a057354608cf754cb) |
| TX4 | **Mainnet** | 931 XMR | ✅ | [View](https://sepolia.basescan.org/tx/0x71d089e79eda5e503c727eeefdf0b42d8f08226537098a8c0ce2d4e0592a09c7) |

## 🔒 Security Features

### Replay Protection
- ✅ Output tracking: `usedOutputs[outputId]` prevents double-spending
- ✅ Tx hash storage: `outputToTxHash[outputId]` for transparency
- ✅ Validates `txHash != bytes32(0)` before accepting

### Cryptographic Verification
- ✅ **DLEQ Proof**: Proves knowledge of secret key `r` without revealing it
- ✅ **PLONK Proof**: Verifies Poseidon commitment binding all witness values
- ✅ **Ed25519 Operations**: Verified on-chain using modular inverse precompile

### Test Results
- ✅ Real Monero transactions: All passing
- ✅ Fake data rejection: System correctly rejects invalid secret keys
- ✅ Replay attempts: Rejected with "Output already spent"

## 📊 Performance

| Metric | Value |
|--------|-------|
| Circuit Constraints | ~1,167 |
| Proof Generation | <1 second |
| Gas Cost (mint) | ~3.2M gas |
| Memory Usage | ~500 MB |

## 🛠️ Development

### Project Structure

```
spendProof/
├── contracts/
│   ├── MoneroBridgeDLEQ.sol    # Main bridge contract
│   ├── Ed25519.sol              # Ed25519 DLEQ verification
│   └── PlonkVerifier.sol        # Generated PLONK verifier
├── scripts/
│   ├── generate_dleq_proof.js   # DLEQ proof generation
│   ├── generate_witness.js      # Witness generation
│   ├── test_circuit.js          # Local testing
│   ├── test_all_with_dleq.js    # Test all transactions
│   └── test_on_chain.js         # On-chain testing
├── test/
│   ├── TestEd25519.test.js      # Ed25519 library tests
│   └── DebugDLEQOnChain.test.js # DLEQ debugging
├── lib/ed25519/                 # Ed25519 circuit library
├── monero_bridge.circom         # Main circuit
└── README.md
```

### Running Tests

```bash
# Local circuit test
node scripts/test_circuit.js

# Test all 4 transactions
node scripts/test_all_with_dleq.js

# Hardhat tests
npx hardhat test

# Deploy to Base Sepolia
npx hardhat run scripts/deploy_base_sepolia.js --network baseSepolia

# Test on-chain
npx hardhat run scripts/test_on_chain.js --network baseSepolia
```

## 📚 Technical Details

### Hybrid Architecture Benefits

**Traditional Approach (3.9M constraints):**
- Ed25519 scalar multiplication: ~2.56M constraints
- Point operations: ~1.2M constraints
- Hash functions: ~150K constraints

**Our Hybrid Approach (1,167 constraints):**
- ✅ Ed25519 operations: **Off-chain** (using @noble/ed25519)
- ✅ DLEQ proof: **On-chain verification** (Solidity)
- ✅ Poseidon commitment: **In-circuit** (~1,167 constraints)

### DLEQ Proof

Proves: `log_G(R) = log_A(rA) = r`

**Commitments:**
- `K1 = k·G`
- `K2 = k·A`

**Challenge:**
- `c = H(G, A, R, rA, K1, K2) mod L`

**Response:**
- `s = k + c·r mod L`

**Verification:**
- `s·G = K1 + c·R`
- `s·A = K2 + c·rA`

## ⚠️ Security Considerations

1. **Not Audited**: This code has not been professionally audited
2. **Testnet Only**: Currently deployed on Base Sepolia testnet
3. **Experimental**: Ed25519 verification uses Ethereum precompile (0x05)
4. **Requires Audit**: Full security audit required before mainnet deployment

## 📄 License

- **Circuits**: MIT License
- **Contracts**: GPL-3.0 License

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Run tests: `npm test`
4. Submit a pull request

## 🔗 Links

- **Protocol Spec**: [SYNTHWRAP.md](../SYNTHWRAP.md)
- **GitHub**: [madschristensen99/zeroxmr](https://github.com/madschristensen99/zeroxmr)
- **Base Sepolia Contract**: [0x3D50F6177E6589413A389f8a16314E2dA20a25Ff](https://sepolia.basescan.org/address/0x3D50F6177E6589413A389f8a16314E2dA20a25Ff)

---

## 🌐 Deployment Information

### Gnosis Chain Mainnet

**Contract Addresses:**
- **WrappedMoneroV3 (zeroXMR)**: [`0xe1B76b604F12Fd20b8D490C4C1f0634521626B0B`](https://gnosisscan.io/address/0xe1B76b604F12Fd20b8D490C4C1f0634521626B0B)
- **PlonkVerifier**: [`0x8b9b7A19d4B8D6a521834c2cd94BB419bde573ef`](https://gnosisscan.io/address/0x8b9b7A19d4B8D6a521834c2cd94BB419bde573ef)

**Token Details:**
- Name: Wrapped Monero
- Symbol: zeroXMR
- Decimals: 12 (piconero precision)
- Total Supply: 0.0008 XMR (as of deployment)

**First Successful Mint:**
- Transaction: [`0x275d1a7d5fd9cbde1dba32034fd867ad49e470addf052fe4ac3843e51de9e9dd`](https://gnosisscan.io/tx/0x275d1a7d5fd9cbde1dba32034fd867ad49e470addf052fe4ac3843e51de9e9dd)
- Amount: 0.0008 XMR (800,000,000 piconero)
- Gas Used: 660,578 (~$0.0007 on Gnosis)
- Monero TX: [`73155c18b4b6a820ace7a77973ae1004bb8b1b8c0c8a96c9c7a6957309f14d79`](https://xmrchain.net/tx/73155c18b4b6a820ace7a77973ae1004bb8b1b8c0c8a96c9c7a6957309f14d79)
- Block: 3595150

**Security Features Enabled:**
- ✅ Real PLONK proof verification
- ✅ Proof binding (Ed25519 coordinates match ZK proof)
- ✅ Replay attack protection (output tracking)
- ✅ Merkle proof verification (TX and output inclusion)
- ✅ Ed25519 curve validation
- ✅ Oracle block verification

---

**Version**: 7.0.0  
**Last Updated**: January 24, 2026  
**Status**: ✅ Production Deployment on Gnosis Chain | ⚠️ Requires Security Audit
