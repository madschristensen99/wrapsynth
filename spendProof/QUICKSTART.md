# 🚀 Monero Bridge - Quick Start Guide

## ✅ What We Accomplished

Successfully deployed and tested the Monero Bridge on **Base Sepolia** testnet with real Monero transaction data!

### 📊 Test Results

- ✅ **Circuit Compiled**: 1,167 constraints (99.97% reduction from 3.9M)
- ✅ **Contracts Deployed** to Base Sepolia
- ✅ **Proof Generated**: From real Monero stagenet transaction
- ✅ **Proof Verified**: Locally and on-chain
- ✅ **Transaction Confirmed**: Block #35936351

### 🌐 Deployed Contracts (Base Sepolia)

- **PlonkVerifier**: [`0x7Bb4bF5bDAe975D00394Fa8c7a5a395777D3F71D`](https://sepolia.basescan.org/address/0x7Bb4bF5bDAe975D00394Fa8c7a5a395777D3F71D)
- **MoneroBridgeDLEQ**: [`0xf148A622CF38750f50324a44372D13BF6907210e`](https://sepolia.basescan.org/address/0xf148A622CF38750f50324a44372D13BF6907210e)

### 📈 Gas Costs

- **Deployment**: PlonkVerifier: 2.9M gas, MoneroBridgeDLEQ: 717K gas
- **Proof Verification**: 3,217,725 gas (~$0.003 on Base Sepolia)

### 🔗 On-Chain Proof

- **Transaction**: [`0xdaae8233521aa350c3f4a807753f7f354652c3e38378261dd3819d510fb82d78`](https://sepolia.basescan.org/tx/0xdaae8233521aa350c3f4a807753f7f354652c3e38378261dd3819d510fb82d78)
- **Status**: ✅ Success
- **Block**: 35936351

---

## 🎯 One-Command Setup

Run everything with a single command:

```bash
./quickstart.sh
```

This will:
1. Install dependencies
2. Compile circuit (1,167 constraints)
3. Setup PLONK keys
4. Compile Solidity contracts
5. Generate witness from Monero blockchain
6. Generate and verify PLONK proof

---

## 📝 Step-by-Step Guide

### 1. Initial Setup

```bash
# Install dependencies
npm install

# Compile circuit
npm run compile

# Compile contracts
npx hardhat compile
```

### 2. Setup PLONK Keys (One-Time)

```bash
# Download Powers of Tau
wget https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau

# Generate PLONK keys
snarkjs plonk setup monero_bridge.r1cs powersOfTau28_hez_final_12.ptau circuit_final.zkey

# Export verification key
snarkjs zkey export verificationkey circuit_final.zkey verification_key.json

# Copy WASM to build directory
mkdir -p build && cp -r monero_bridge_js build/
```

### 3. Generate Proof

```bash
# Fetch Monero transaction data
node scripts/fetch_monero_witness.js

# Generate witness and proof (automated)
node -e "
const fs = require('fs');
const { generateWitness } = require('./scripts/generate_witness.js');

(async () => {
    const originalInput = JSON.parse(fs.readFileSync('input.json', 'utf8'));
    const witness = await generateWitness(originalInput);
    
    const circuitInputs = {
        r: witness.r,
        v: witness.v,
        H_s_scalar: witness.H_s_scalar,
        R_x: witness.R_x,
        S_x: witness.S_x,
        P_compressed: witness.P_compressed,
        ecdhAmount: witness.ecdhAmount,
        amountKey: witness.amountKey,
        commitment: witness.commitment
    };
    
    fs.writeFileSync('input_circuit.json', JSON.stringify(circuitInputs, null, 2));
})();
"

# Calculate witness
snarkjs wtns calculate build/monero_bridge_js/monero_bridge.wasm input_circuit.json witness.wtns

# Generate PLONK proof
snarkjs plonk prove circuit_final.zkey witness.wtns proof.json public.json

# Verify proof locally
snarkjs plonk verify verification_key.json public.json proof.json
```

### 4. Deploy to Base Sepolia

```bash
# Make sure .env is configured with:
# - BASE_SEPOLIA_RPC_URL
# - PRIVATE_KEY
# - BASESCAN_API_KEY (optional)

# Deploy contracts
npx hardhat run scripts/deploy_base_sepolia.js --network baseSepolia

# Test deployed contracts
npx hardhat run scripts/test_deployed_contracts.js --network baseSepolia
```

### 5. Submit Proof On-Chain

```bash
# Submit proof to deployed contracts
npx hardhat run scripts/test_on_chain.js --network baseSepolia
```

---

## 🧪 Testing

### Run All Tests

```bash
npx hardhat test
```

### Test Specific Components

```bash
# Test circuit only
node scripts/test_circuit.js

# Test deployed contracts
npx hardhat run scripts/test_deployed_contracts.js --network baseSepolia

# Test on-chain submission
npx hardhat run scripts/test_on_chain.js --network baseSepolia
```

---

## 📂 Project Structure

```
spendProof/
├── quickstart.sh              # One-command setup script
├── monero_bridge.circom       # Main circuit (1,167 constraints)
├── contracts/
│   ├── MoneroBridgeDLEQ.sol   # Main bridge contract
│   ├── PlonkVerifier.sol      # PLONK verifier
│   └── Ed25519.sol            # Ed25519 operations
├── scripts/
│   ├── fetch_monero_witness.js    # Fetch from Monero blockchain
│   ├── generate_witness.js        # Generate DLEQ witness
│   ├── generate_dleq_proof.js     # DLEQ proof generation
│   ├── deploy_base_sepolia.js     # Deploy to Base Sepolia
│   ├── test_deployed_contracts.js # Test deployments
│   └── test_on_chain.js           # Submit proof on-chain
└── test/
    └── MoneroBridgeDLEQ.test.js   # Hardhat tests
```

---

## 🔧 Configuration

### Environment Variables (.env)

```bash
# Base Sepolia RPC
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org

# Your wallet private key
PRIVATE_KEY=your_private_key_here

# BaseScan API key (optional, for verification)
BASESCAN_API_KEY=your_api_key_here
```

---

## 📊 Performance Metrics

### Circuit Optimization

- **Original Circuit**: 3,945,572 constraints
- **DLEQ-Optimized**: 1,167 constraints
- **Reduction**: 3,381x (99.97%)

### Proof Generation

- **Witness Generation**: ~1 second
- **Proof Generation**: ~3 seconds
- **Memory**: <100MB

### On-Chain Costs (Base Sepolia)

- **PlonkVerifier Deployment**: 2,919,085 gas
- **MoneroBridgeDLEQ Deployment**: 717,573 gas
- **Proof Verification**: 3,217,725 gas

---

## 🎯 Architecture

### Hybrid Verification Model

**Off-Chain (Client-Side)**:
- Ed25519 operations (R = r·G, S = 8·r·A, P = H_s·G + B)
- DLEQ proof generation
- Poseidon commitment computation

**In-Circuit (ZK Proof)**:
- Poseidon commitment verification
- Amount decryption (XOR)
- Range checks

**On-Chain (Solidity)**:
- DLEQ proof verification
- Ed25519 point operations
- PLONK proof verification
- Double-spend prevention

---

## 🔒 Security Features

✅ **Poseidon Commitment**: Binds all private and public values
✅ **DLEQ Proofs**: Proves discrete log equality for r
✅ **Ed25519 Verification**: Validates stealth address derivation
✅ **Range Checks**: Ensures amount < 2^64
✅ **Double-Spend Prevention**: Tracks used outputs

---

## 🚀 Next Steps

1. **Verify Contracts on BaseScan** (optional):
   ```bash
   npx hardhat verify --network baseSepolia 0x7Bb4bF5bDAe975D00394Fa8c7a5a395777D3F71D
   npx hardhat verify --network baseSepolia 0xf148A622CF38750f50324a44372D13BF6907210e 0x7Bb4bF5bDAe975D00394Fa8c7a5a395777D3F71D
   ```

2. **Test with Multiple Transactions**:
   - Edit `scripts/fetch_monero_witness.js` to use different TX hashes
   - Run `./quickstart.sh` again

3. **Deploy to Mainnet**:
   - Update `.env` with mainnet RPC and keys
   - Change network in deploy scripts to `base` (mainnet)

---

## 📚 Resources

- **Base Sepolia Faucet**: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
- **BaseScan**: https://sepolia.basescan.org
- **Monero Stagenet Explorer**: https://stagenet.xmrchain.net

---

## ⚠️ Important Notes

- This is **experimental software** - not audited for production
- Proving server sees witness data (transaction secret key)
- For production, consider: trusted server, MPC, or TEE
- Gas costs on Base mainnet will be similar to Sepolia

---

## 🎉 Success!

You now have a fully functional Monero Bridge deployed on Base Sepolia with:
- ✅ Real Monero transaction data
- ✅ PLONK proof generation
- ✅ On-chain verification
- ✅ 99.97% constraint reduction

Happy bridging! 🌉
