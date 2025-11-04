# Fun Gerbil - Privacy-Preserving Cross-Chain DeFi Infrastructure

A comprehensive privacy-focused DeFi protocol bridging Solana and Monero ecosystems, featuring atomic swaps, wrapped privacy tokens, and zero-knowledge computation.

[![Pitch:](https://img.youtube.com/vi/ZaeMy5X_Lc8/maxresdefault.jpg)](https://youtu.be/ZaeMy5X_Lc8)

## 🎯 Mission

Fun Gerbil is building the infrastructure to onboard Monero's privacy to Solana's DeFi ecosystem, creating private, trustless cross-chain financial primitives for the first time.

## 📊 Key Features

### 1. Solana ↔ Monero Atomic Swaps
- **SOL-to-XMR**: Lock SOL on Solana, receive XMR on Monero
- **XMR-to-SOL**: Lock XMR on Monero, receive SOL on Solana
- **Adaptor Signatures**: Deterministic secret revelation via Schnorr signatures
- **Dual-collateral system**: Both parties lock equal collateral to prevent fraud

### 2. Wrapped Monero (wXMR) 
- **Privacy Bridges**: Mint/burn privacy tokens using zero-knowledge proofs
- **Fully Homomorphic Encryption**: Private computation on encrypted balances
- **Arcium Integration**: MPC-based confidential computing infrastructure

### 3. Privacy DeFi Primitives
- **Private AMMs**: Confidential liquidity pools
- **ZK Borrowing**: Zero-knowledge lending markets
- **Private Perps**: Confidential perpetual swaps
- **Dark Pools**: Private order matching

### 4. User Experience
- **Self-custodial**: Users maintain full control of private keys
- **Non-custodial**: No centralized entities hold user funds
- **Approachable branding**: Fun, pun-based naming to reduce intimidation

## 🏗️ Architecture Overview

```
fungerbil/
├── atomic-swap/           # Core atomic swap infrastructure
├── arcium-mint/          # MPC-based privacy tokens
├── frontend/             # Web interfaces
├── pitchdeck/           # Investor materials
└── svm-fhe/            # (Future) Solana-native FHE
```

## 🔗 Cross-Chain Infrastructure

### Transaction Flows

#### SOL → XMR Swap
1. **Alice** locks SOL in Solana HTLC contract
2. **Bob** locks equivalent SOL collateral simultaneously
3. **Alice** reveals XMR secret via adaptor signature
4. **Bob** redeems SOL, **Alice** receives XMR

#### XMR → SOL Swap
1. **Bob** locks SOL in Solana HTLC contract
2. **Alice** sends XMR to Bob's Monero address
3. **Alice** claims SOL using revealed secret
4. **Bob** receives XMR, **Alice** receives SOL

### Security Properties
- **Atomic**: All-or-nothing swaps preventing partial execution
- **Deterministic**: Secrets revealed through cryptographic proofs
- **Time-locked**: Automatic refund after expiry
- **Collaterized**: Dual-asset backing eliminates counterparty risk

## 💻 Technical Implementation

### Smart Contracts
- **Anchor Framework**: Rust-based Solana program development
- **Adaptor Signatures**: Schnorr signature revelation mechanism
- **Token Program**: SPL token integration for SOL transfers
- **Cross-program invocation**: Atomic multi-token transfers

### Backend Services
- **Node.js/TypeScript**: RESTful API server
- **Solana Client**: Transaction management and account monitoring
- **Monero Client**: RPC integration for Monero operations
- **WebSocket**: Real-time swap status updates

### Frontend Applications
- **Atomic Swap Terminal**: Live trading interface
- **Wallet Connection**: Multi-wallet support (Phantom, Brave, Solflare)
- **Real-time Pricing**: Live SOL/XMR price feeds
- **Transaction Status**: Real-time swap monitoring

## 🖥️ Quick Start

### Prerequisites
- Node.js 18+
- Rust 1.70+
- Solana CLI tools
- Monero wallet RPC (optional)

### 1. Clone and Setup
```bash
git clone https://github.com/madschristensen99/fungerbil.git
cd fungerbil
```

### 2. Start Atomic Swap Server
```bash
cd atomic-swap/server
npm install
npm run dev
```
Server runs on `http://localhost:3000`

### 3. Setup Monero Wallet (Optional)
```bash
# Start monero-wallet-rpc for stagenet testing
monero-wallet-rpc \
  --stagenet \
  --rpc-bind-port 18082 \
  --wallet-file ~/monero/stagenet.wallet \
  --password your_password \
  --daemon-host stagenet.community.xmr.to \
  --daemon-port 38081 \
  --disable-rpc-login
```

### 4. Launch Frontend
Open `/frontend/atomicSwap/index.html` in any modern web browser.

## 📁 Project Structure Deep Dive

### `atomic-swap/` - Core Protocol
Contain the complete atomic swap infrastructure:

**Smart Contract** (`solana-program/src/lib.rs`):
- `create_SOL_to_xmr_swap`: Alice initiates SOL→XMR swap
- `create_xmr_to_SOL_swap`: Bob initiates XMR→SOL swap
- `redeem_SOL`: Secret revelation and asset redemption
- `refund`: Automatic expiry refunds with collateral return

**Backend Server** (`server/src/`):
- `solana-client.ts`: Solana transaction management
- `monero-client.ts`: Monero RPC client integration
- `handlers.ts`: REST API endpoints for swap creation/execution

**API Endpoints**:
```bash
# Create SOL → XMR swap
POST /api/swap/create-SOL-to-xmr

# Create XMR → SOL swap  
POST /api/swap/create-xmr-to-SOL

# Redeem completed swap
POST /api/swap/:swapId/redeem

# Get swap details
GET /api/swap/:swapId
```

### `arcium-mint/` - Privacy Token Infrastructure
FHE-enabled privacy token system based on Arcium network:

**Computation Definition**:
- Encrypted state transitions via Arcium coprocessor
- Zero-knowledge balance updates
- Private transfer verification

**Privacy Features**:
- Fully homomorphic encryption for computations
- MPC-based consensus on encrypted states
- Cross-chain cryptographic proof systems

### `frontend/` - User Interfaces
Modern web applications for different user personas:

**Atomic Swap Terminal** (`atomicSwap/`):
- Live trading interface with price feeds
- Wallet connection and swap creation
- Real-time transaction monitoring

**Wrapped XMR (wXMR) System** (`wxmr/`):
- LP collateral staking (SOL/hyUSD) with overcollateralization
- Monero atomic mint/burn with ZK proofs
- Automatic slashing for failed XMR redemptions
- Real-time Pyth pricing integration

**Wallet Interface** (`wxmr/`):
- Basic Solana wallet functionality
- wXMR token management
- Token minting and burning

### `pitchdeck/` - Investor Materials
Comprehensive pitch presentation covering:
- Market opportunity for privacy DeFi
- Technical architecture and security model
- Revenue streams and tokenomics
- Team backgrounds and roadmap

## 🔐 Security Model

### Cryptographic Primitives
- **Adaptor Signatures**: Schnorr-based secret revelation 
- **Hash Time-Lock Contracts**: HTLC implementation with automatic expiry
- **Zero-Knowledge Proofs**: Confidential transaction verification
- **Threshold Cryptography**: Distributed key generation and sharing

### Risk Mitigation
- **Dual Collateral**: Both parties lock equal value, preventing fraud
- **Time-locked Refunds**: Automatic return of funds after expiry
- **Monatomic Execution**: All-or-nothing swap completion
- **Cryptographic Auditing**: Mathematical verification of outcomes

## 🌐 Live Applications

### Production Services
- **Main Website**: [fungerbil.com](https://fungerbil.com)
- **Telegram**: [t.me/fungerbilswap](https://t.me/fungerbilswap)
- **GitHub**: [github.com/madschristensen99/fungerbil](https://github.com/madschristensen99/fungerbil)

### Network Status
- **Current Version**: 2.0.0 (devnet)
- **Solana Program ID**: `G1BVSiFojnXFaPG1WUgJAcYaB7aGKLKWtSqhMreKgA82`
- **Deploy Network**: Solana Devnet (mainnet support planned Q1 2026)

## 📈 Development Roadmap

### Q4 2025 (Current)
- ✅ Devnet testnet launch
- ✅ Atomic swap protocol completion
- ✅ Frontend trading terminal
- ✅ Monero integration testing

### Q1 2026
- Mainnet deployment preparation
- Security audit completion
- Audited program verification
- Mainnet SOL support integration

### Q2 2026
- wXMR privacy token launch
- Private AMM development
- API/SDK release for third-party integration
- Dark pool infrastructure setup

### Q3 2026
- DAO governance implementation
- Cross-chain expansion (Ethereum, Bitcoin)
- Mobile application release
- Institutional liquidity partnerships

## 👥 Team

### Founders
- **Mads Christensen** - CEO & Founder
  - Monero maximalist and full-stack engineer
  - Former senior developer roles in DeFi protocols

- **Kyle Koshiyama** - Protocol Engineer  
  - Former Fhenix engineer
  - Current DarkLake protocol contributor

- **Tiago Alves** - Research Lead
  - PhD Cryptography (University of Lisbon)
  - Zero-knowledge proof systems researcher

## 🤝 Contributing

We welcome contributions from the privacy and DeFi communities:

1. **Issue reporting**: Use GitHub issues for bug reports
2. **Code contributions**: Opening PRs following existing patterns
3. **Security audits**: Contact team for protocol audits
4. **Community help**: Discord server for technical discussions

## 📞 Contact

- **Email**: mads@fungerbil.com
- **Telegram**: [t.me/fungerbilswap](https://t.me/fungerbilswap)
- **Twitter**: [@fungerbilXMR](https://x.com/fungerbilXMR)
- **GitHub**: [madschristensen99/fungerbil](https://github.com/madschristensen99/fungerbil)

## 🪪 License

This project is licensed under the MIT License - see individual subdirectories for specific component licenses.

## ⚠️ Disclaimer

This software is experimental and should be used with testnet funds only until security audits are completed. Always verify smart contract addresses and conduct thorough testing before mainnet deployment.

---

**Fun Gerbil**: *Privacy shouldn't be complicated.*
