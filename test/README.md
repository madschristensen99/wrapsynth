# WrapSynth Test Suite

Comprehensive test suite for the WrapSynth Monero bridge protocol.

## Test Structure

### 1. LP Registration and Deposit
- ✅ LP registration with valid parameters
- ✅ Collateral deposit in wstETH
- ✅ Fee validation (rejects excessive fees)

### 2. Oracle Block Posting
- ✅ Oracle posts Monero blocks with merkle roots
- ✅ Non-oracle accounts are rejected
- ✅ Block data validation

### 3. Mint Flow - Valid Transaction
- ✅ User creates mint intent with deposit
- ✅ Valid ZK proof verification
- ✅ DLEQ proof validation
- ✅ Ed25519 signature verification
- ✅ Merkle proof validation (TX and output)
- ✅ Successful minting of wrapped XMR

### 4. Invalid Proof Variants (Security Tests)
- ✅ Wrong block height - rejected
- ✅ Double-spend (already used output) - rejected
- ✅ Tampered proof data - rejected
- ✅ Invalid merkle proofs - rejected
- ✅ Mismatched output data - rejected

### 5. Burn Flow
- ✅ User requests burn with anti-griefing deposit
- ✅ LP fulfills burn by sending XMR
- ✅ Burn timeout and default handling
- ✅ Collateral seizure on default

## Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npx hardhat test test/WrappedMonero.comprehensive.test.js

# Run with gas reporting
REPORT_GAS=true npx hardhat test

# Run with coverage
npx hardhat coverage
```

## Test Scenarios Covered

### Happy Path
1. LP registers and deposits 10 wstETH collateral
2. Oracle posts Monero block with merkle roots
3. User creates mint intent for 1 XMR
4. User submits valid proof and mints wrapped XMR
5. User requests burn for 0.5 XMR
6. LP fulfills burn by sending XMR to user's Monero address

### Attack Vectors Tested
1. **Double-spend**: Attempting to mint twice with same Monero output
2. **Wrong block**: Using proof for block not posted by oracle
3. **Tampered proofs**: Modified ZK proofs, DLEQ, or Ed25519 signatures
4. **Invalid merkle proofs**: Incorrect transaction or output merkle paths
5. **Excessive fees**: LP trying to set fees above 5% maximum
6. **Unauthorized oracle**: Non-oracle attempting to post blocks

## Mock Contracts

The test suite uses mock contracts for isolated testing:

- **MockPlonkVerifier**: Simulates PLONK proof verification
- **MockWstETH**: ERC20 token simulating wstETH
- **MockPyth**: Simulates Pyth oracle price feeds

## Test Data

All test data uses realistic formats:
- Monero addresses: Valid base58 encoded addresses
- Transaction hashes: 32-byte hex strings
- Merkle proofs: Arrays of 32-byte hashes
- ZK proofs: 768-byte PLONK proofs
- Public signals: 70 field elements

## Coverage Goals

- ✅ Line coverage: >90%
- ✅ Branch coverage: >85%
- ✅ Function coverage: >95%
- ✅ All critical paths tested

## Adding New Tests

To add new test scenarios:

1. Create a new `describe` block in the test file
2. Use `loadFixture(deployFixture)` for clean state
3. Follow the pattern: Setup → Action → Assert
4. Add descriptive console.log messages for clarity

## Known Limitations

- Mock verifier always returns true (doesn't validate actual proofs)
- Simplified Pyth oracle (no real price feeds)
- No network latency simulation
- No multi-block reorganization tests

For integration tests with real proofs, see `scripts/lpServer/proofGeneration/`.
