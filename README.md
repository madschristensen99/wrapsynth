# Welcome to Zero XMR!

![Zero XMR Hero Image](images/2026-01-26-zeroxmr-hero.png)

**Zero-knowledge, permissionless wrapped Monero**

Zero XMR enables trustless bridging of Monero to DeFi chains through zero-knowledge proofs. Send XMR to a liquidity provider's address, generate a ZK proof of payment, and receive wrapped XMR tokens—all without requiring trusted intermediaries.

🌐 **[zeroxmr.com](https://zeroxmr.com)**

---

## 🚀 Current Status: Mainnet Beta on Gnosis Chain

**Deployed Contracts:**
- **WrappedMonero**: [`0xE3FF8b60B143Be56745149e7EB468999769eC1b7`](https://gnosisscan.io/address/0xE3FF8b60B143Be56745149e7EB468999769eC1b7)
- **PlonkVerifier**: [`0x4f66CAc8b001938B3ec5C2582e2c6723DD7B0e6C`](https://gnosisscan.io/address/0x4f66CAc8b001938B3ec5C2582e2c6723DD7B0e6C)
- **Network**: Gnosis Chain (ChainID: 100)
- **Initial Monero Block**: 3,597,142

**Why Gnosis Chain?**
- 100x cheaper gas costs (~$0.0003 per mint vs $30-60 on Ethereum)
- Fast block times (~5 seconds)
- Same security model as Ethereum (merged with Ethereum consensus)
- Stablecoin as native gas (xDAI)

**Architecture:**
- **Circuit**: Optimized DLEQ-based PLONK circuit with 1,167 constraints
- **Proof System**: PLONK (no trusted ceremony)
- **Oracle**: Automated Monero blockchain data feed (20-second polling)
- **Price Oracle**: Pyth Network for XMR/USD pricing

---

## 🛠️ Development Setup

### Prerequisites
- Node.js >= 18.0.0
- npm or yarn
- Circom 2.1.0+
- SnarkJS

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/zeroxmr.git
cd zeroxmr/circom-gnosis

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env and add your private key and RPC URLs
```

### Compile Circuit

```bash
# Compile the Circom circuit
npm run compile

# Setup PLONK proving key (downloads Powers of Tau)
bash scripts/setup_circuit.sh
```

### Compile Contracts

```bash
npx hardhat compile
```

### Run Tests

```bash
# Run Hardhat tests
npm run test:hardhat

# Run Gnosis Chain fork tests
npm run test:gnosis
```

### Deploy to Gnosis Chain

```bash
# Deploy contracts (fetches current Monero block height and XMR price automatically)
npx hardhat run scripts/deploy_gnosis.js --network gnosis

# Verify contracts
npx hardhat verify --network gnosis <CONTRACT_ADDRESS> --constructor-args constructor-args.js
```

### Run Oracle

```bash
# Start the Monero oracle (posts blockchain data every 20 seconds)
node oracle/monero-oracle.js
```

---

## 📁 Project Structure

```
zeroxmr/
├── circom-gnosis/
│   ├── contracts/              # Solidity contracts
│   │   ├── WrappedMonero.sol   # Main bridge contract
│   │   ├── PlonkVerifier.sol   # PLONK verifier
│   │   └── libraries/          # Ed25519 and other libraries
│   ├── scripts/                # Deployment and utility scripts
│   │   ├── deploy_gnosis.js    # Gnosis Chain deployment
│   │   ├── generate_witness.js # Witness generation
│   │   └── generate_dleq_proof.js # DLEQ proof generation
│   ├── oracle/                 # Monero blockchain oracle
│   │   ├── monero-oracle.js    # Oracle service
│   │   └── deployment.json     # Deployment addresses
│   ├── test/                   # Test files
│   ├── monero_bridge.circom    # Main circuit file
│   └── hardhat.config.js       # Hardhat configuration
└── frontend/                   # Web interface (coming soon)
```

---

## 🔬 Technical Details

### Circuit Architecture

**Hybrid Approach**: Ed25519 operations performed off-chain, verified on-chain
- **Off-chain**: Scalar multiplications using native libraries (curve25519-dalek)
- **On-chain**: DLEQ proofs verify discrete log equality in Solidity
- **In-circuit**: Poseidon commitment binds all witness values

**Constraint Optimization**:
- Original Circom circuit: 3.9M constraints
- Optimized DLEQ version: 1,167 constraints (3,350x reduction!)
- Proof generation: ~10-20 seconds (mobile-friendly)
- Memory: 500MB-1GB

### Security Features

1. **Proof Binding**: Public signals match Ed25519 proof coordinates
2. **Curve Validation**: All Ed25519 points validated on-curve
3. **Output Verification**: Oracle posts Monero outputs before minting
4. **Merkle Proofs**: TX and output Merkle roots verified

---


## 📄 License

MIT

---

## 🤝 Contributing

Contributions are welcome! Please open an issue or submit a pull request.

---

## ⚠️ Disclaimer

This is experimental software in beta. Use at your own risk. Not audited for production use.