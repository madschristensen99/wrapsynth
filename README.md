# 🌉 WrapSynth

**A privacy-preserving bridge bringing Monero to Ethereum using zero-knowledge proofs.**

🌐 **[wrapsynth.com](https://wrapsynth.com)**

WrapSynth enables trustless, privacy-preserving bridging of Monero (XMR) to Ethereum and EVM chains. Users prove ownership of Monero transactions through PLONK zero-knowledge proofs without revealing sensitive transaction details on-chain.

---

## ✨ Key Features

### Core Technology
- **Zero-Knowledge Proofs**: PLONK proofs (~3.8M constraints) verify Monero stealth address ownership
- **Stealth Address Verification**: Full cryptographic verification of Monero transaction ownership
- **Server-Side Proof Generation**: High-performance proof generation (3-10 minutes, 32-64GB RAM)
- **Client-Side Witness Generation**: Fast witness calculation in browser (~1-4 seconds, <500MB RAM)
- **Merkle Proof Verification**: On-chain verification of transaction and output inclusion
- **Ed25519 & DLEQ Proofs**: Monero-compatible elliptic curve operations

### Privacy & Security
- **Transaction Public Key Verification**: Prevents unauthorized minting of others' Monero
- **Stealth Address Derivation**: Proves P = H_s·G + B without revealing private keys
- **Double-Spend Prevention**: On-chain tracking of used outputs
- **Collateralized Liquidity**: LPs provide wstETH collateral with 150% safe ratio
- **Privacy Relayer System**: Anonymous minting without revealing recipient address on-chain

### DeFi Integration
- **Uniswap V4 Hooks**: Privacy-preserving swap hooks for anonymous trading
- **Aave V3 Collateral**: Yield-bearing collateral backing for LPs
- **Multi-Chain Support**: Designed for Unichain, Gnosis Chain, and other EVM chains
- **ERC-20 Compatible**: Standard token interface for DeFi composability

---

## 🚀 Current Status

**Development Phase**: Active development, not yet deployed to mainnet

**Target Networks:**
- **Unichain Testnet** (ChainID: 1301) - Primary development target
- **Gnosis Chain** (ChainID: 100) - Future deployment for low gas costs

**Contracts Compiled**: ✅ All 60 Solidity files compile successfully

**Next Steps:**
1. Complete circuit testing and optimization
2. Set up proof generation server infrastructure
3. Deploy to Unichain testnet
4. Integrate Monero stagenet for testing
5. Security audit and mainnet deployment

---

## 🛠️ Development Setup

### Prerequisites

- **Node.js** v18+
- **npm** or **yarn**
- **Circom** 2.1.0+
- **snarkjs** (installed via npm)
- **Rust** (for oracle) - Install from [rustup.rs](https://rustup.rs/)
- **Hardhat** (installed via npm)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/wrapsynth.git
cd wrapsynth

# Install Node.js dependencies
npm install

# Install circuit dependencies
cd circuit
npm install
cd ..

# Copy environment variables
cp .env.example .env
# Edit .env and add your PRIVATE_KEY and RPC URLs
```

### Compile Circuit

```bash
cd circuit
./compile.sh
```

This will:
- Compile the Circom circuit
- Generate PLONK proving/verification keys
- Create Solidity verifier contract
- Copy verifier to `contracts/MoneroBridgeVerifier.sol`

### Compile Contracts

```bash
# From project root
npx hardhat compile
```

Should output: `Compiled 60 Solidity files successfully`

### Deploy to Unichain Testnet

1. **Get testnet ETH** from [Unichain Faucet](https://faucet.unichain.org/)

2. **Deploy contracts:**
```bash
# Deploy with real PLONK verifier
npm run deploy:unichain

# Or deploy with mock verifier for testing
npm run deploy:mock
```

3. **Verify contracts on Uniscan:**
```bash
npm run verify
```

### Run Oracle

```bash
# Build the Rust-based Monero oracle
cd monero-oracle
cargo build --release

# Configure oracle (edit config if needed)
../scripts/oracle/setup.sh

# Run oracle service
cargo run --release
```

### Setup Liquidity Provider

```bash
# Register as LP and set up pool
npm run lp:setup:mock
```

---

## 📁 Project Structure

```
wrapsynth/
├── circuit/                    # Circom ZK circuit
│   ├── monero_bridge.circom   # Main circuit (PLONK, ~3.8M constraints)
│   ├── compile.sh             # Circuit compilation script
│   ├── build/                 # Generated circuit artifacts (gitignored)
│   ├── package.json           # Circuit dependencies
│   └── README.md              # Circuit documentation
│
├── contracts/                  # Solidity smart contracts
│   ├── WrappedMonero.sol      # Main bridge contract (ERC-20 + LP system)
│   ├── MoneroBridgeVerifier.sol # PLONK verifier (auto-generated)
│   ├── PrivacySwapHook.sol    # Uniswap V4 hook for private swaps
│   ├── MintRelayer.sol        # Privacy-preserving mint relayer
│   ├── HookMiner.sol          # Uniswap V4 hook address miner
│   ├── interfaces/            # Contract interfaces
│   ├── libraries/             # Ed25519 & cryptographic utilities
│   ├── mocks/                 # Mock contracts for testing
│   └── README.md              # Contract documentation
│
├── scripts/                    # Deployment & management scripts
│   ├── deploy.js              # Main deployment script
│   ├── deploy-with-mock.js    # Deploy with mock verifier
│   ├── deploy-relayer.js      # Deploy privacy relayer
│   ├── deploy-privacy-hook.js # Deploy Uniswap V4 hook
│   ├── verify.js              # Contract verification
│   │
│   ├── proofGeneration/       # ZK proof generation
│   │   ├── generate_witness.js           # Witness generation
│   │   ├── generate_proof_and_mint.js    # Full proof + mint flow
│   │   ├── generate_proof_and_relay_mint.js # Private mint via relayer
│   │   ├── compute_monero_keys.js        # Monero key derivation
│   │   └── compute_merkle_proofs.js      # Merkle proof computation
│   │
│   ├── relayer/               # Privacy relayer system
│   │   ├── signMintIntent.js  # EIP-712 intent signing
│   │   ├── relayerService.js  # Background relayer service
│   │   ├── privateMint.js     # User-facing private mint
│   │   ├── registerRelayer.js # Register as relayer
│   │   └── startRelayer.js    # Start relayer daemon
│   │
│   ├── oracle/                # Oracle management
│   │   ├── setup.sh           # Configure oracle
│   │   └── run.sh             # Run oracle service
│   │
│   └── utils/                 # Utility functions
│       ├── compute_merkle_proof.js
│       └── ed25519_utils.js
│
├── monero-oracle/              # Rust-based Monero oracle
│   ├── src/main.rs            # Oracle service implementation
│   ├── Cargo.toml             # Rust dependencies
│   └── README.md              # Oracle documentation
│
├── frontend/                   # Web interface
│   └── app/                   # Frontend application
│       ├── app.html           # Main HTML
│       ├── app.js             # Frontend logic
│       ├── proof-gen.js       # Browser proof generation
│       └── circuit/           # Circuit artifacts for browser
│
├── deployments/                # Deployment records
│   ├── unichain_testnet_latest.json
│   └── unichain_testnet_mock_latest.json
│
├── hardhat.config.js          # Hardhat configuration
├── package.json               # Node.js dependencies
├── .env.example               # Environment variables template
├── RELAYER_README.md          # Relayer system documentation
└── README.md                  # This file
```

---

## 🏗️ Architecture

### High-Level Flow

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   Monero    │         │   Ethereum   │         │   Unichain  │
│  Mainnet    │         │   Mainnet    │         │   /Gnosis   │
└──────┬──────┘         └──────────────┘         └──────┬──────┘
       │                                                 │
       │  1. User sends XMR                             │
       │     to LP's address                            │
       │                                                 │
       │  2. Generate ZK proof                          │
       │     of ownership                               │
       │                                                 │
       └─────────────────────────────────────────────────┤
                                                         │
                                                         │  3. Submit proof
                                                         │     & mint wrapped XMR
                                                         │
                                                    ┌────▼─────┐
                                                    │ Wrapped  │
                                                    │  Monero  │
                                                    │ Contract │
                                                    └──────────┘
```

### Components

1. **Circom Circuit** (`circuit/`)
   - Proves knowledge of Monero transaction private key
   - Verifies stealth address derivation (P = H_s·G + B)
   - Validates ECDH amount decryption
   - Generates PLONK proofs (~3.8M constraints)
   - Server-side proof generation (3-10 minutes)

2. **Smart Contracts** (`contracts/`)
   - **WrappedMonero**: Main bridge logic, LP management, minting/burning
   - **MoneroBridgeVerifier**: On-chain PLONK proof verification
   - **PrivacySwapHook**: Uniswap V4 hook for anonymous swaps
   - **MintRelayer**: Privacy-preserving relayer for anonymous minting
   - **Ed25519 Library**: Monero cryptography verification

3. **Monero Oracle** (`monero-oracle/`)
   - Rust-based service for high performance
   - Posts Monero block data and Merkle roots on-chain
   - Enables trustless verification of transaction inclusion

4. **Privacy Relayer** (`scripts/relayer/`)
   - EIP-712 signed mint intents
   - Anonymous minting without revealing recipient
   - Relayer earns fees for privacy service

---

## 📖 How It Works

### Minting (Monero → Ethereum)

1. **Send Monero**: Transfer XMR to a liquidity provider's Monero address
2. **Generate Witness**: Client-side witness generation (~1-4 seconds, <500MB RAM)
3. **Generate Proof**: Server-side PLONK proof generation (3-10 minutes, 32-64GB RAM)
   - Proves knowledge of transaction secret key `r`
   - Verifies `R = r·G` matches transaction public key
   - Proves stealth address derivation `P = H_s·G + B`
   - Decrypts and verifies amount using LP's view key
   - Generates Merkle proofs for transaction and output inclusion
4. **Submit On-Chain**: Contract verifies all proofs and mints wrapped XMR
5. **Receive Tokens**: Get wrapped XMR (ERC-20) in your Ethereum wallet

### Private Minting (via Relayer)

1. **Create Intent**: Sign EIP-712 mint intent with recipient address
2. **Submit to Relayer**: Relayer submits proof on your behalf
3. **Anonymous Mint**: Recipient address never appears in your transactions
4. **Pay Fee**: Small fee paid to relayer for privacy service

### Burning (Ethereum → Monero)

1. **Request Burn**: Submit burn request with destination Monero address
2. **Tokens Locked**: Wrapped XMR locked in contract
3. **LP Fulfills**: Liquidity provider sends XMR to your Monero address
4. **Completion**: Burn finalized after oracle confirmation

### For Liquidity Providers

1. **Register**: Set fees and provide Monero address + private view key
2. **Deposit Collateral**: Lock wstETH (minimum 150% collateralization)
3. **Earn Fees**: Collect fees from mints and burns
4. **Earn Yield**: Automatic staking rewards on wstETH collateral

---

## 🔐 Security

### Cryptographic Guarantees

- **PLONK Zero-Knowledge Proofs**: ~3.8M constraints verify transaction ownership
- **Stealth Address Verification**: Proves P = H_s·G + B without revealing keys
- **Transaction Public Key Matching**: Prevents minting of others' Monero
- **Ed25519 Operations**: Native Monero elliptic curve cryptography
- **DLEQ Proofs**: Discrete logarithm equality verification
- **Poseidon Commitments**: ZK-friendly binding of private inputs
- **Merkle Proofs**: Cryptographic proof of transaction inclusion

### Economic Security

**Collateralization Tiers:**
- **Safe Zone** (≥150%): LPs can accept new mints
- **Warning Zone** (120-150%): No new mints allowed
- **Liquidation** (<120%): Collateral can be claimed

**Oracle System:**
- Rust-based oracle posts Monero block data on-chain
- Merkle roots enable trustless verification
- Future: Decentralized oracle network

### Security Considerations

⚠️ **This is experimental software for research purposes.**

- Not audited by professional security firms
- Not recommended for production use with real funds
- Testnet deployment only
- Use at your own risk

Before production deployment:
- Professional security audit required
- Formal verification of critical components
- Extensive testnet testing
- Legal and regulatory review

---

## 🧪 Testing

```bash
# Run contract tests
npm test

# Test circuit compilation
cd circuit && ./compile.sh

# Test proof generation
node scripts/proofGeneration/generate_proof_and_mint.js

# Test private minting via relayer
node scripts/relayer/privateMint.js
```

---

## 📚 Documentation

### Project Documentation
- [Circuit Documentation](circuit/README.md) - Circom circuit implementation
- [Contract Documentation](contracts/README.md) - Solidity smart contracts
- [Relayer Documentation](RELAYER_README.md) - Privacy relayer system
- [Oracle Documentation](monero-oracle/README.md) - Rust oracle service

### External Resources
- [PLONK Paper](https://eprint.iacr.org/2019/953) - Zero-knowledge proof system
- [Monero Documentation](https://www.getmonero.org/resources/developer-guides/) - Monero cryptography
- [Circom Documentation](https://docs.circom.io/) - Circuit development
- [snarkjs](https://github.com/iden3/snarkjs) - ZK proof generation library
- [Uniswap V4 Hooks](https://docs.uniswap.org/contracts/v4/overview) - Hook development

---

## 🔮 Roadmap

### Phase 1: Core Development (Current)
- ✅ Circuit design and implementation
- ✅ Smart contract development
- ✅ Privacy relayer system
- ✅ Uniswap V4 hooks integration
- 🔄 Proof generation server infrastructure
- 🔄 Frontend development

### Phase 2: Testnet Deployment
- ⏳ Deploy to Unichain testnet
- ⏳ Deploy to Gnosis Chain testnet
- ⏳ Integrate Monero stagenet
- ⏳ Public testing and feedback

### Phase 3: Security & Audit
- ⏳ Internal security review
- ⏳ External security audit
- ⏳ Bug bounty program
- ⏳ Formal verification of critical components

### Phase 4: Mainnet Launch
- ⏳ Gnosis Chain mainnet deployment (low gas costs)
- ⏳ Unichain mainnet deployment
- ⏳ Multi-chain expansion (Arbitrum, Optimism, Base)
- ⏳ Decentralized oracle network

---

## 🤝 Contributing

Contributions welcome! This is experimental research software.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Write/update tests
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

---

## ⚠️ Disclaimer

**EXPERIMENTAL RESEARCH SOFTWARE**

This software is provided "as is" for research and educational purposes only. It has not been audited and should not be used in production with real funds. The developers assume no liability for any losses incurred through the use of this software.

Before any production deployment, this system requires:
- Professional security audit by qualified firms
- Formal verification of critical components
- Extensive testing on testnets
- Legal and regulatory review
- Community review and feedback

---

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details

---

## 🔗 Links

- **Website**: [wrapsynth.com](https://wrapsynth.com)
- **GitHub**: [github.com/wrapsynth](https://github.com/wrapsynth)
- **Unichain Docs**: [docs.unichain.org](https://docs.unichain.org/)
- **Gnosis Chain**: [gnosis.io](https://www.gnosis.io/)
- **Monero**: [getmonero.org](https://www.getmonero.org/)
- **Circom**: [docs.circom.io](https://docs.circom.io/)

---

Built with ❤️ for privacy and decentralization