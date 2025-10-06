# 🐹 Fun Gerbil - The Privacy Bridge

[![Status](https://img.shields.io/badge/status-devnet_preview-green.svg)](https://fungerbil.com) [![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Solana](https://img.shields.io/badge/powered-Solana-9945FF.svg)](https://solana.com)

**Private atomic swaps between USDC on Solana and XMR on Monero**

Got USDC but want XMR? Got XMR but want USDC? **One click. No seed phrases. No custody. Pure privacy.**

## 🎯 In 30 Seconds

- **What**: Cross-chain atomic swaps between Solana USDC ↔ Monero XMR
- **How**: Single user action → cryptographically provable → without custody
- **Why**: Monero's disappearing from exchanges, but privacy shouldn't disappear from crypto

## 🚀 Try It Now

```bash
# Quick demo (devnet only)
git clone https://github.com/madschristensen99/fungerbil.git
cd fungerbil/frontend
# Open index.html in your browser
# OR visit: https://fungerbil.com
```

## 📋 For Newcomers

### What This Actually Does

**Problem**: You have USDC in your Solana wallet but need XMR for privacy. Traditional solutions:
- **Centralized exchanges**: KYC, tracking, delisting risks
- **Bridge protocols**: Still expose transaction history
- **Manual atomic swaps**: Complex, risky, requires technical expertise

**Solution**: Fun Gerbil creates a trustless bridge where:
1. You lock USDC in a Solana smart contract
2. A liquidity provider automatically sends XMR to your Monero address
3. The trade completes atomically - either both parties get what they want, or everyone gets their money back

### Live Components

| Component | Purpose | Status | Doc |
|-----------|---------|---------|-----|
| `svm-xmr/` | Backend server (TypeScript) | ✅ Working on Devnet | [README](svm-xmr/README.md) |
| `frontend/` | Web UI (HTML/JS) | ✅ Ready to use | [index.html](frontend/index.html) |
| Solana Program | Smart contract | ✅ Deployed to Devnet | [Protocol](svm-xmr/protocol.md) |
| Monero Integration | XMR wallet automation | ✅ Stagenet compatible | [Guide](svm-xmr/README.md) |

## 🛠️ Quick Start (5-Minute Demo)

### Prerequisites
- Node.js 18+
- Solana CLI (`npm install -g @solana/cli`)
- Monero wallet RPC (optional for testing)

### 1. Backend Setup
```bash
cd fungerbil/svm-xmr/server
npm install

# Copy and edit config
cp .env.example .env
nano .env  # Add your Solana keypair path

# Start server
npm run dev
```

### 2. Frontend Without Backend
```bash
cd fungerbil/frontend
# Simply open in browser - connects to live demo backend
open index.html
# OR python -m http.server 8080
# Visit: http://localhost:8080
```

### 3. Create a Test Swap
1. **USDC → XMR**: Enter your **Monero address** → Connect Solana wallet → Sign one transaction
2. **XMR → USDC**: Enter your **Solana address** → Send XMR to provided address → Receive USDC

## 🔍 Project Architecture

```
fungerbil/
├── 📂 frontend/              # Web interface
│   ├── index.html           # Main swap UI
│   ├── swap.js              # Business logic
│   ├── style.css            # Epic gerbil-themed design
│   └── assets/              # Gerbil mascot & crypto logos
├── 📂 svm-xmr/              # Solana-Monero bridge
│   ├── server/              # TypeScript backend
│   ├── solana-program/      # Rust smart contract
│   ├── protocol.md          # Technical specification
│   └── README.md           # Detailed setup
├── 📂 fungerbilPitchdeck/   # Investor materials
│   └── deck.tex            # LaTeX presentation
└── README.md               # This file
```

## 🔐 Security Model

### Core Principles
- **Trustless**: No central authority holds funds
- **Atomic**: Either completes fully or reverts completely
- **Private**: No transaction visibility between chains
- **On-chain auditable**: All enforcement in smart contracts

### Risk Mitigation
- **Timeout refunds**: 24-hour window with automatic refunds
- **Malleability fixes**: Canonical signature forms to prevent attacks
- **Fraud proofs**: Slashing mechanism for bad actors
- **No custody**: Users maintain control of private keys

## 🌐 Network Support

| Environment | Solana Network | Monero Network | Status |
|-------------|----------------|----------------|---------|
| Development | Solana Devnet | Monero Stagenet | ✅ Active |
| Production | Solana Mainnet | Monero Mainnet | 🔒 Q1 2026 |
| Testnet | Solana Testnet | Monero Stagenet | ✅ Ready |

## 📊 Development Roadmap

### ✅ Q4 2025 - Testnet Launch
- [x] Smart contract deployment
- [x] Basic atomic swap functionality
- [x] Web interface
- [ ] Stress testing
- [ ] Security audit

### 🔄 Q1 2026 - Mainnet Preparation
- [ ] Mainnet program deployment
- [ ] USD Coin integration
- [ ] Multi-asset support
- [ ] API/SDK release

### 🚀 Q2 2026 - Full Protocol
- [ ] TWAP orders
- [ ] Liquidity pools
- [ ] API/SDK expansion
- [ ] DAO governance

## 🤝 Contributing

We welcome contributors! Here's what we need help with:

### 🐛 Bug Bounties
Found a vulnerability? Contact us privately: team@fungerbil.com

### 💡 Feature Requests
- **Frontend**: React/Next.js migration
- **Backend**: Additional chains (Ethereum, BNB)
- **Testing**: More comprehensive test suites
- **DevOps**: Deployment automation

### 🏗️ Getting Involved
1. **Pick your area**: Backend/Frontend/Smart Contracts/Security
2. **Read design docs**: [Protocol Specification](svm-xmr/protocol.md)
3. **Create PR**: Small focused changes preferred
4. **Join discussions**: [Telegram](https://t.me/fungerbilswap)

## 💰 Liquidity Program

Running a liquidity fleet? We provide:
- **0.08% swap fees**
- **24/7 uptime monitoring**
- **Automated XMR management**
- **Risk-free operation with collateral**

Contact: liquidity@fungerbil.com

## 🎯 Use Cases

### 🏪 Merchants
Accept USDC → Settle XMR automatically
Privacy without complexity

### 🕵️‍♂️ Privacy Users
Exit centralized exchanges → Maintain anonymity
No technical complexity

### 💱 Arbitrage Traders
Cross-exchange arbitrage with privacy
Minimal fees and fast settlement

## 📚 For Developers

### API Endpoints (Production)
```javascript
// Create swap
POST /api/swap/create-usdc-to-xmr
POST /api/swap/create-xmr-to-usdc

// Monitor progress
GET /api/swap/:swapId
POST /api/swap/:swapId/redeem

// Status updates
POST /api/web3/status/:swapId
```

### Smart Contract Details
- **Program ID**: `G1BVSiFojnXFaPG1WUgJAcYaB7aGKLKWtSqhMreKgA82`
- **Language**: Rust (Anchor Framework)
- **Features**: HTLC with adaptor signatures
- **Audits**: Currently in progress (Q4 2025)

### Monero Integration
- **Network**: Auto-detects between mainnet/stagenet
- **Fee Handling**: Dynamic based on network conditions
- **Resilience**: Automatic retry on network issues

## 📱 Mobile Integration

Coming soon:
- React Native wrapper
- WalletConnect integration
- Push notifications for swap completion

## 🔗 Links

| Resource | Link |
|----------|------|
| **Live Demo** | [https://fungerbil.com](https://fungerbil.com) |
| **GitHub Issues** | [Report bugs](https://github.com/madschristensen99/fungerbil/issues) |
| **Telegram Community** | [t.me/fungerbilswap](https://t.me/fungerbilswap) |
| **Security Disclosures** | team@fungerbil.com |
| **Business Inquiries** | business@fungerbil.com |

## 🏆 Team & Partners

**Founding Team:**
- **Mads Christensen** - CEO (DeFi Infrastructure Engineer)
- **Kyle Koshiyama** - FHE Engineer (formerly Fhenix, current DarkLake)
- **Eric Nans** - Head of Marketing (Growth expert)

**Strategic Partners:**
- **DarkLake** - FHE infrastructure
- **Arcium** - Privacy computation
- **Solana Foundation** - Grant recipient

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

*Built with ❤️ by gerbils, for humans who care about privacy.*

**Warning**: This is experimental software currently in devnet/beta. Mainnet launch scheduled for Q1 2026. Use only with small amounts for testing purposes.