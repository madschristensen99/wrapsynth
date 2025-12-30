# Monero→Arbitrum Bridge Circuit v5.4

Zero-knowledge circuit for proving Monero transaction authenticity and amount correctness. This circuit enables trustless bridging of XMR to Arbitrum One by verifying Pedersen commitments and ECDH-encrypted amounts without revealing transaction details.

**⚠️ WARNING: This is experimental software. Not audited. Do not use in production.**

## Features

- **Cryptographically Correct**: Uses Monero-native Pedersen commitment ordering (C = v·H + γ·G)
- **Privacy-Preserving**: Transaction secret key `r` never leaves the client
- **Ethereum-Compatible**: Keccak256 binding hash for on-chain verification
- **Cross-Chain Security**: Chain ID verification prevents replay attacks

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              User Frontend (Browser/Wallet)                  │
│  - Witness generation from Monero wallet data                │
│  - Client-side proof generation (snarkjs)                   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│              Bridge Circuit (Circom, ~62k R1CS)             │
│  Proves:                                                     │
│    - R = r·G (knowledge of tx secret key)                   │
│    - C = v·H + γ·G (Monero Pedersen commitment)             │
│    - v = ecdhAmount ⊕ H_s(γ) (amount decryption)            │
│    - binding = Keccak256(R||P||C||ecdhAmount)               │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│            Solidity Verifier Contract (Groth16)             │
│  - BN254 pairing-based verification                         │
│  - ~200k gas on Arbitrum                                    │
└─────────────────────────────────────────────────────────────┘
```

## Installation

### Prerequisites

- Node.js >= 18.0.0
- Circom 2.1.0+
- snarkjs 0.7.4+

### Setup

```bash
# Clone repository
git clone https://github.com/fungerbil/monero-bridge-circuit
cd monero-bridge-circuit

# Install dependencies
npm install

# Install circom (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
git clone https://github.com/iden3/circom.git
cd circom
cargo build --release
cargo install --path circom
cd ..
```

### Install External Libraries

This circuit depends on several external libraries:

```bash
# Install from npm
npm install circomlib

# Clone additional libraries (for full Ed25519 support)
# Electron-Labs ed25519-circom (archived but functional)
git clone https://github.com/Electron-Labs/ed25519-circom.git node_modules/ed25519-circom

# vocdoni keccak256-circom
git clone https://github.com/vocdoni/keccak256-circom.git node_modules/keccak256-circom

# bkomuves hash-circuits (for Blake2s)
git clone https://github.com/bkomuves/hash-circuits.git node_modules/hash-circuits
```

## Usage

### 1. Compile Circuit

```bash
# Compile with constraint output
npm run compile

# Or manually:
circom circuits/monero_bridge_v54.circom --r1cs --wasm --sym -o build
```

### 2. Trusted Setup

Download a Powers of Tau file (2^22 constraints minimum):

```bash
# Download from Hermez ceremony
wget https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_22.ptau -O pot22_final.ptau

# Generate circuit-specific keys
npm run setup

# Contribute to phase 2
npm run contribute
```

### 3. Generate Proof

```javascript
const { groth16 } = require('snarkjs');
const { keccak256 } = require('ethers');

async function generateProof(walletData) {
    // Prepare inputs
    const input = {
        // Private inputs
        r: walletData.txSecretKey,  // 256 bits binary
        v: walletData.amount,       // 64-bit integer
        
        // Public inputs
        R_x: walletData.R,
        P_compressed: walletData.destinationAddress,
        C_compressed: walletData.commitment,
        ecdhAmount: walletData.encryptedAmount,
        B_compressed: walletData.lpSpendKey,
        monero_tx_hash: walletData.txHash,
        bridge_tx_binding: computeBinding(walletData),
        chain_id: 42161n  // Arbitrum One
    };
    
    // Generate proof
    const { proof, publicSignals } = await groth16.fullProve(
        input,
        'build/monero_bridge_v54_js/monero_bridge_v54.wasm',
        'build/monero_bridge_v54_final.zkey'
    );
    
    return { proof, publicSignals };
}
```

### 4. Verify On-Chain

```solidity
import "./BridgeVerifier.sol";

contract MoneroBridge {
    IBridgeVerifier public verifier;
    
    function mint(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[10] calldata _pubSignals
    ) external {
        require(verifier.verifyProof(_pA, _pB, _pC, _pubSignals), "Invalid proof");
        // ... mint logic
    }
}
```

## Circuit Inputs

### Private Inputs (Witnesses)

| Name | Type | Description |
|------|------|-------------|
| `r` | `signal[256]` | Transaction secret key (binary) |
| `v` | `signal` | Amount in piconero (64-bit) |

### Public Inputs

| Name | Type | Description |
|------|------|-------------|
| `R_x` | `signal` | Transaction public key R |
| `P_compressed` | `signal` | Destination stealth address |
| `C_compressed` | `signal` | Pedersen commitment |
| `ecdhAmount` | `signal` | ECDH-encrypted amount |
| `B_compressed` | `signal` | LP spend public key |
| `monero_tx_hash` | `signal` | Monero transaction ID |
| `bridge_tx_binding` | `signal` | Keccak256(R||P||C||ecdhAmount) |
| `chain_id` | `signal` | Target chain ID (42161) |

### Outputs

| Name | Type | Description |
|------|------|-------------|
| `verified_binding` | `signal` | Echoed binding hash |
| `verified_amount` | `signal` | Verified amount |

## Cryptographic Details

### Pedersen Commitment (Monero-Native)

Monero uses: **C = v·H + γ·G**

Where:
- `v` = amount (value)
- `H` = generator for value commitment
- `γ` = blinding factor (derived from shared secret)
- `G` = standard Ed25519 base point

⚠️ This is **opposite** to some other systems that use C = v·G + γ·H!

### Blinding Factor Derivation

```
γ = Blake2s("commitment" || shared_secret_x || output_index) mod l
```

### Amount Decryption

```
amount = ecdhAmount ⊕ Blake2s("amount" || shared_secret_x)[0:8]
```

## External Dependencies

| Library | Source | Purpose |
|---------|--------|---------|
| circomlib | [iden3/circomlib](https://github.com/iden3/circomlib) | Basic circuits (comparators, bitify) |
| ed25519-circom | [Electron-Labs/ed25519-circom](https://github.com/Electron-Labs/ed25519-circom) | Ed25519 curve operations |
| keccak256-circom | [vocdoni/keccak256-circom](https://github.com/vocdoni/keccak256-circom) | Keccak256 hash (~151k constraints) |
| hash-circuits | [bkomuves/hash-circuits](https://github.com/bkomuves/hash-circuits) | Blake2s-256 hash |

## Constraint Breakdown

| Component | Constraints | Notes |
|-----------|-------------|-------|
| Ed25519 ScalarMul (R = r·G) | ~18,000 | Double-and-add |
| Ed25519 ScalarMul (S = r·B) | ~18,000 | ECDH shared secret |
| Pedersen Commitment | ~24,000 | v·H + γ·G |
| Blake2s (×2) | ~6,000 | γ derivation + amount key |
| Keccak256 | ~5,000 | Binding hash |
| Other (decompress, XOR) | ~1,100 | |
| **Total** | **~62,100** | |

## Performance Targets

| Environment | Proving Time | Memory |
|-------------|--------------|--------|
| Browser (WASM) | 2.0-2.8s | ~1.0 GB |
| Browser (WebGPU) | 1.4-2.0s | ~600 MB |
| Native (rapidsnark) | 0.5-0.8s | ~500 MB |

## Security Considerations

1. **Trusted Setup**: Groth16 requires a trusted setup ceremony
2. **Not Audited**: This code has not been professionally audited
3. **Ed25519 Library**: The Electron-Labs library is archived and experimental
4. **Side Channels**: Browser-based proving may be vulnerable to timing attacks

## Testing

```bash
# Run all tests
npm test

# Run specific test
npm test -- --grep "Pedersen"
```

## Project Structure

```
monero-bridge/
├── circuits/
│   ├── monero_bridge_v54.circom    # Main circuit
│   └── lib/
│       ├── ed25519/                # Ed25519 operations
│       │   ├── scalar_mul.circom
│       │   ├── point_add.circom
│       │   ├── point_compress.circom
│       │   ├── point_decompress.circom
│       │   ├── modulus.circom
│       │   └── bigint.circom
│       ├── blake2s/
│       │   └── blake2s.circom
│       └── keccak/
│           └── keccak256.circom
├── test/
│   └── monero_bridge.test.js
├── build/                          # Generated artifacts
├── package.json
└── README.md
```

## License

MIT License (circuits), GPL-3.0 (Solidity contracts)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Run tests: `npm test`
4. Submit a pull request

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| v5.4 | 2024-12 | Corrected Pedersen (v·H + γ·G), Keccak binding |
| v5.3 | 2024-11 | N-of-M oracle consensus |
| v5.2 | 2024-10 | Fixed witness model |

## References

- [Monero RingCT Paper](https://eprint.iacr.org/2015/1098)
- [Ed25519 RFC 8032](https://datatracker.ietf.org/doc/html/rfc8032)
- [Circom Documentation](https://docs.circom.io/)
- [snarkjs Documentation](https://github.com/iden3/snarkjs)

---

**Estimated Mainnet: Q3 2025**

*Document Version: 5.4.0 | Last Updated: December 2024 | Authors: FUNGERBIL Team*
