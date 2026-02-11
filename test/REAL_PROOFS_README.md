# Real ZK Proof Testing

## Overview

This test suite uses **REAL ZK proofs** generated with the actual PLONK verifier, not mocks. Each test generates a genuine zero-knowledge proof using the compiled circuit.

## Test Files

### 1. `WrappedMonero.comprehensive.test.js`
- **Fast unit tests** using MockPlonkVerifier
- Tests contract logic without proof generation
- Runs in ~1 second
- **2 tests passing** ✅

### 2. `WrappedMonero.realProofs.test.js` ⭐ NEW
- **Integration tests** with REAL ZK proofs
- Uses actual PlonkVerifier contract
- Generates real proofs (~3 seconds each)
- Tests end-to-end proof verification

## Running Tests

```bash
# Fast unit tests (mock verifier)
npx hardhat test test/WrappedMonero.comprehensive.test.js

# Real ZK proof tests (actual verification)
npx hardhat test test/WrappedMonero.realProofs.test.js

# Run all tests
npm test
```

## Real Proof Generation

The `test/helpers/proofGenerator.js` helper:

1. **Generates witness** using `generate_witness.js`
2. **Creates PLONK proof** with snarkjs (~3 seconds)
3. **Formats for Solidity** verification
4. **Returns proof + public signals**

### Example Usage:

```javascript
const { generateRealProof } = require("./helpers/proofGenerator");

const txData = {
    r: "0x12...",           // Transaction private key
    H_s_scalar: "0x34...",  // Stealth address component
    v: "1000000000000",     // Amount in piconero
    ecdhAmount: "0x56...",  // Encrypted amount
    // ... more fields
};

const { proof, publicSignals, dleqProof, ed25519Proof } = await generateRealProof(txData);

// Use in contract call
await wrappedMonero.mint(proof, publicSignals, dleqProof, ed25519Proof, ...);
```

## What Gets Verified

### Circuit Verification (ZK Proof)
- ✅ Poseidon commitment correctness
- ✅ Amount decryption with Keccak256
- ✅ Bit constraints (255-bit values)
- ✅ Public input consistency

### On-Chain Verification (Solidity)
- ✅ PLONK proof validity
- ✅ DLEQ proof (Discrete Log Equality)
- ✅ Ed25519 signature verification
- ✅ Merkle proof validation (TX + output)
- ✅ Double-spend prevention
- ✅ Block existence check

## Performance

| Test Type | Proof Generation | Verification | Total Time |
|-----------|-----------------|--------------|------------|
| Mock      | 0ms             | <1ms         | ~100ms     |
| Real      | ~3000ms         | ~50ms        | ~3500ms    |

## Circuit Stats

- **Constraints**: 1,371 (DLEQ-optimized)
- **PLONK constraints**: 3,145
- **Proof size**: 768 bytes
- **Public signals**: 70 field elements
- **Witness generation**: <100ms
- **Proof generation**: ~3 seconds

## Test Scenarios

### ✅ Valid Proof Test
1. LP registers and deposits collateral
2. Oracle posts Monero block
3. User creates mint intent
4. **Generate REAL ZK proof** for transaction
5. Submit proof to contract
6. Verify on-chain with PlonkVerifier
7. Mint wrapped XMR

### ✅ Invalid Proof Test
1. Generate valid proof
2. **Tamper with proof bytes**
3. Attempt to mint
4. **Expect rejection** from verifier

### 🔜 Future Tests
- [ ] Double-spend with real proofs
- [ ] Wrong block height with real proofs
- [ ] Invalid merkle proofs
- [ ] Burn flow with real proofs
- [ ] Multiple sequential mints

## Prerequisites

Before running real proof tests:

1. **Circuit must be compiled**:
   ```bash
   cd circuit
   bash compile.sh
   ```

2. **Files must exist**:
   - `circuit/build/monero_bridge_js/monero_bridge.wasm`
   - `circuit/build/monero_bridge_final.zkey`
   - `circuit/build/verification_key.json`

3. **Dependencies installed**:
   ```bash
   npm install
   ```

## Debugging

If tests fail, check:

1. **Circuit compilation**: Ensure circuit compiled successfully
2. **Witness generation**: Check console logs for witness errors
3. **Proof format**: Verify proof is properly formatted for Solidity
4. **Public signals**: Ensure all 70 signals are present
5. **Gas limits**: Real verifier uses ~500k gas

## CI/CD Integration

For continuous integration:

```yaml
# .github/workflows/test.yml
- name: Compile Circuit
  run: cd circuit && bash compile.sh

- name: Run Unit Tests (Fast)
  run: npx hardhat test test/WrappedMonero.comprehensive.test.js

- name: Run Integration Tests (Real Proofs)
  run: npx hardhat test test/WrappedMonero.realProofs.test.js
  timeout-minutes: 5
```

## Benefits of Real Proof Testing

1. **Catches circuit bugs** that mocks would miss
2. **Validates proof format** for Solidity
3. **Tests actual gas costs** of verification
4. **Ensures witness generation** works correctly
5. **Verifies DLEQ/Ed25519** proof structures
6. **Confidence for mainnet** deployment

## Next Steps

1. ✅ Create real proof test suite
2. ⏳ Add test data from actual Monero transactions
3. ⏳ Test with multiple proof variants
4. ⏳ Benchmark gas costs
5. ⏳ Add fuzzing tests with random inputs
