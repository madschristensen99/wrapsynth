# Monero Bridge Circuit

A zero-knowledge circuit for proving Monero transaction ownership and amount decryption using PLONK.

## 🎯 Overview

This circuit enables privacy-preserving bridging of Monero to Ethereum by proving:
1. Knowledge of transaction private key `r`
2. Correct ECDH decryption of transaction amount
3. Valid Poseidon commitment binding all values
4. Range checks on scalars

**Architecture:** Hybrid approach combining off-chain Ed25519 operations with in-circuit ZK proofs (~1,167 constraints).

## 📋 Prerequisites

### Required Tools

1. **Circom** (v2.1.0+)
   ```bash
   # Install Rust
   curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
   
   # Install Circom
   git clone https://github.com/iden3/circom.git
   cd circom
   cargo build --release
   cargo install --path circom
   ```

2. **snarkjs**
   ```bash
   npm install -g snarkjs
   ```

3. **Node.js** (v16+)

## 🚀 Quick Start

### 1. Compile the Circuit

Simply run:
```bash
./compile.sh
```

This will:
- ✅ Install dependencies (circomlib)
- ✅ Compile circuit to R1CS
- ✅ Download Powers of Tau ceremony file
- ✅ Setup PLONK proving system
- ✅ Export verification key
- ✅ Generate Solidity verifier contract

### 2. Verify Compilation

Check the generated files:
```bash
ls -lh build/
```

You should see:
- `monero_bridge.r1cs` - Constraint system
- `monero_bridge.sym` - Symbol table
- `monero_bridge_js/` - WASM witness calculator
- `monero_bridge_final.zkey` - PLONK proving key
- `verification_key.json` - Verification key
- `MoneroBridgeVerifier.sol` - Solidity verifier

## 📊 Circuit Statistics

```
Template instances: 84
Non-linear constraints: 550
Linear constraints: 617
Total constraints: 1,167
Public inputs: 69
Private inputs: 511
Wires: 1,738
```

## 🔧 Manual Compilation

If you prefer step-by-step compilation:

```bash
# 1. Install dependencies
npm install

# 2. Compile circuit
circom monero_bridge.circom --r1cs --wasm --sym -l node_modules -o build

# 3. View circuit info
snarkjs r1cs info build/monero_bridge.r1cs

# 4. Download Powers of Tau (if needed)
wget -O build/powersOfTau28_hez_final_15.ptau \
  https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau

# 5. PLONK setup
snarkjs plonk setup \
  build/monero_bridge.r1cs \
  build/powersOfTau28_hez_final_15.ptau \
  build/monero_bridge_final.zkey

# 6. Export verification key
snarkjs zkey export verificationkey \
  build/monero_bridge_final.zkey \
  build/verification_key.json

# 7. Generate Solidity verifier
snarkjs zkey export solidityverifier \
  build/monero_bridge_final.zkey \
  build/MoneroBridgeVerifier.sol
```

## 🧪 Testing the Circuit

### Create Test Input

Create `input.json`:
```json
{
  "r": ["0", "1", "0", ...],
  "v": "1000000000000",
  "H_s_scalar": ["1", "0", "1", ...],
  "R_x": "12345...",
  "S_x": "67890...",
  "P_x": "11223...",
  "ecdhAmount": "9876543210",
  "amountKey": ["1", "0", "1", ...],
  "commitment": "54321..."
}
```

### Generate Witness

```bash
cd build/monero_bridge_js
node generate_witness.js monero_bridge.wasm ../../input.json witness.wtns
cd ../..
```

### Generate Proof

```bash
snarkjs plonk prove \
  build/monero_bridge_final.zkey \
  build/monero_bridge_js/witness.wtns \
  proof.json \
  public.json
```

### Verify Proof

```bash
snarkjs plonk verify \
  build/verification_key.json \
  public.json \
  proof.json
```

## 📐 Circuit Inputs

### Private Inputs (Witness)
- `r[255]` - Transaction secret key (255-bit scalar)
- `v` - Amount in atomic piconero (64 bits)
- `H_s_scalar[255]` - Shared secret scalar

### Public Inputs
- `R_x` - Transaction public key x-coordinate
- `S_x` - Shared secret point x-coordinate
- `P_x` - Stealth address x-coordinate
- `ecdhAmount` - ECDH-encrypted amount (64 bits)
- `amountKey[64]` - Amount encryption key bits
- `commitment` - Poseidon commitment

### Output
- `verified_amount` - Decrypted amount

## 🏗️ Architecture

### Off-Circuit (Client-side - Native Ed25519)
1. Compute `R = r·G` (transaction public key)
2. Compute `S = 8·r·A` (shared secret)
3. Compute `P = H_s·G + B` (stealth address)
4. Decrypt amount: `v = ecdhAmount ⊕ Keccak(H_s)`
5. Generate DLEQ proofs

### In-Circuit (ZK-SNARK)
1. ✅ Verify Poseidon commitment
2. ✅ Verify amount decryption (XOR)
3. ✅ Range checks on scalars

### On-Chain (Solidity)
1. Verify DLEQ proofs
2. Verify Ed25519 operations
3. Verify ZK proof

## 🔐 Security Considerations

⚠️ **EXPERIMENTAL SOFTWARE - NOT AUDITED**

This circuit is for research and development only. Before production use:

1. **Security Audit** - Professional cryptographic review
2. **Formal Verification** - Mathematical proof of correctness
3. **Extensive Testing** - Edge cases and attack vectors
4. **Peer Review** - Community scrutiny

### Known Limitations

- Amount verification disabled for subaddress support
- Simplified range checks (top 3 bits only)
- No ring signature verification (done off-chain)

## 📁 File Structure

```
circuit/
├── monero_bridge.circom      # Main circuit file
├── compile.sh                # Compilation script
├── package.json              # Node dependencies
├── README.md                 # This file
└── build/                    # Generated files (gitignored)
    ├── monero_bridge.r1cs
    ├── monero_bridge.sym
    ├── monero_bridge_js/
    ├── monero_bridge_cpp/
    ├── monero_bridge_final.zkey
    ├── verification_key.json
    ├── MoneroBridgeVerifier.sol
    └── powersOfTau28_hez_final_15.ptau
```

## 🐛 Troubleshooting

### "circom: command not found"
Install Circom following prerequisites above.

### "Cannot find module 'circomlib'"
```bash
npm install
```

### "Powers of Tau download fails"
The script will automatically try an alternative URL. If it still fails, manually download:
```bash
wget -O build/powersOfTau28_hez_final_15.ptau \
  https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau
```

### "Out of memory"
The circuit requires ~2GB RAM. Try:
- Close other applications
- Use a machine with more RAM
- Compile on a cloud instance

### Compilation errors
Ensure you're using Circom 2.1.0+ and the latest circomlib:
```bash
circom --version
npm update circomlib
```

## 🔗 Integration

The generated `MoneroBridgeVerifier.sol` can be deployed to Ethereum and integrated with your bridge contracts:

```solidity
import "./MoneroBridgeVerifier.sol";

contract MoneroBridge {
    PlonkVerifier public verifier;
    
    function verifyProof(
        uint256[24] calldata _proof,
        uint256[69] calldata _pubSignals
    ) public view returns (bool) {
        return verifier.verifyProof(_proof, _pubSignals);
    }
}
```

## 📚 Resources

- [Circom Documentation](https://docs.circom.io/)
- [snarkjs Documentation](https://github.com/iden3/snarkjs)
- [PLONK Paper](https://eprint.iacr.org/2019/953)
- [Monero Cryptography](https://www.getmonero.org/resources/moneropedia/)

## 📄 License

MIT

## 🤝 Contributing

This is experimental research software. Contributions, suggestions, and security reviews are welcome!

---

**Note:** Always verify the integrity of downloaded Powers of Tau files and use trusted sources for cryptographic ceremonies.
