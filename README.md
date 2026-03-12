![WrapSynth](./images/wrapsynth-hero.png)

# 🌉 WrapSynth

**A trustless bridge bringing Monero to EVM chains using atomic swaps and collateralized vaults.**

🌐 **[wrapsynth.com](https://wrapsynth.com)**

WrapSynth enables trustless bridging of Monero (XMR) to Ethereum and EVM chains through atomic swap mechanics and overcollateralized LP vaults. Users exchange XMR for wsXMR tokens backed by 150% collateral, with cryptographic commitments ensuring trustless execution.

---

## ✨ Key Features

### Core Technology
- **Atomic Swap Protocol**: HTLC-style secret commitments for trustless XMR ↔ wsXMR exchange
- **Secp256k1 Verification**: Cryptographic verification of secret reveals using elliptic curve operations
- **Vault-Based System**: Individual LP vaults with isolated collateral and debt tracking
- **Multi-Collateral Support**: Accept ETH, wstETH, or any ERC20 token as collateral
- **Real-Time Pricing**: Pyth Network oracle integration for accurate asset valuation

### Vault-Based Architecture
- **Individual LP Vaults**: Each liquidity provider manages their own collateralized vault
- **Multi-Collateral Support**: Accept ETH, wstETH, or other ERC20 tokens as collateral
- **Overcollateralization**: 150% collateral ratio ensures wsXMR is always backed
- **Liquidation Protection**: 120% liquidation threshold with 110% liquidator bonus
- **Pyth Oracle Integration**: Real-time price feeds for XMR and collateral assets

### Security & Trust Model
- **Overcollateralization**: 150% collateral ratio ensures wsXMR is always backed
- **Atomic Swap Guarantees**: Cryptographic commitments prevent fund loss for both parties
- **Liquidation System**: 120% threshold with 10% liquidator bonus protects solvency
- **Timeout Protection**: 24-hour windows with slashing for non-compliance
- **Griefing Protection**: Configurable deposits prevent spam attacks on LP vaults

### DeFi Integration
- **ERC-20 Compatible**: Standard token interface (8 decimals matching XMR)
- **Multi-Chain Support**: Designed for Gnosis Chain, Unichain, and other EVM chains
- **Composable Design**: Ready for DEX integration and DeFi protocols
- **Price Oracle Ready**: Pyth Network integration for accurate pricing

---

## 🚀 Current Status

**Development Phase**: ✅ **Deployed to Gnosis Chain Mainnet**

### 🌐 Live Deployments

#### Gnosis Chain (ChainID: 100)
**Deployed Contracts:**
- **wsXMR Token**: [`0xf0114924F8e3d1D4dca68DEf1F3Ea402EF5B32a2`](https://gnosisscan.io/address/0xf0114924F8e3d1D4dca68DEf1F3Ea402EF5B32a2#code)
- **VaultManager**: [`0x839257DE37b22B377e545514e2eD0b4f92266F88`](https://gnosisscan.io/address/0x839257DE37b22B377e545514e2eD0b4f92266F88#code)
- **wsXMRLiquidityRouter**: [`0x7Ed870F86ae9c7ecE955185792FFF1Ac57dc743a`](https://gnosisscan.io/address/0x7Ed870F86ae9c7ecE955185792FFF1Ac57dc743a#code)

**Configuration:**
- Collateral: sDAI (Savings DAI) - auto-converts from xDAI deposits
- Oracle: Pyth Network (`0x2880aB155794e7179c9eE2e38200202908C17B43`)
- Status: ✅ Verified on Gnosisscan

**Target Networks:**
- **Gnosis Chain** (ChainID: 100) - ✅ **LIVE** (low gas costs)
- **Unichain Testnet** (ChainID: 1301) - Development and testing

**Deployment Status:**
- ✅ VaultManager and wsXMR contracts implemented
- ✅ Atomic swap mechanics with HTLC-style commitments
- ✅ Pyth oracle integration for price feeds
- ✅ **Deployed to Gnosis Chain mainnet**
- ✅ **Contracts verified on Gnosisscan**
- ✅ Multi-collateral support (sDAI with auto-conversion from xDAI)

**Next Steps:**
1. ✅ ~~Deploy VaultManager and wsXMR to Gnosis mainnet~~ **COMPLETE**
2. Set up LP server infrastructure for vault management
3. Integrate with frontend for testing
4. Complete end-to-end testing with Monero stagenet
5. Security audit before public launch

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

# Copy environment variables
cp .env.example .env
# Edit .env and add your PRIVATE_KEY and RPC URLs
```

### Compile Contracts

```bash
# From project root
npx hardhat compile
```

This will compile:
- `VaultManager.sol` - Core vault and atomic swap logic
- `wsXMR.sol` - ERC-20 token contract
- `Secp256k1.sol` - Elliptic curve verification library
- Supporting interfaces and libraries

### Deploy Contracts

#### Deploy to Gnosis Mainnet

1. **Get xDAI** for gas fees (very low cost ~$0.01 per tx)
   - Bridge DAI to xDAI: [Gnosis Bridge](https://bridge.gnosischain.com/)
   - Or use [Jumper Exchange](https://jumper.exchange/)

2. **Configure environment:**
```bash
cp .env.example .env
# Edit .env and add your PRIVATE_KEY and GNOSIS_RPC_URL
```

3. **Deploy contracts:**
```bash
# Deploy VaultManager and wsXMR to Gnosis mainnet
npm run deploy:gnosis
```

4. **Verify contracts on Gnosisscan:**
```bash
npm run verify:gnosis
```

#### Deploy to Unichain Testnet

1. **Get testnet ETH** from [Unichain Faucet](https://faucet.unichain.org/)

2. **Deploy contracts:**
```bash
# Deploy VaultManager and wsXMR to Unichain testnet
npm run deploy:unichain
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
├── contracts/                  # Solidity smart contracts
│   ├── VaultManager.sol       # Core vault system with atomic swap logic
│   ├── wsXMR.sol              # ERC-20 token (8 decimals)
│   ├── Secp256k1.sol          # Elliptic curve verification library
│   ├── IPyth.sol              # Pyth oracle interface
│   ├── IERC20Metadata.sol     # ERC20 metadata interface
│   ├── interfaces/            # Contract interfaces
│   ├── mocks/                 # Mock contracts for testing
│   └── README.md              # Contract documentation
│
├── scripts/                    # Deployment & management scripts
│   ├── deploy/                # Deployment scripts
│   │   ├── deploy.js          # Unichain testnet deployment
│   │   ├── deploy-gnosis.js   # Gnosis mainnet deployment
│   │   └── verify.js          # Contract verification
│   │
│   ├── lpServer/              # LP vault management
│   │   ├── createVault.js     # Create new LP vault
│   │   ├── depositCollateral.js # Deposit collateral to vault
│   │   ├── confirmMint.js     # LP confirms XMR receipt
│   │   ├── finalizeBurn.js    # LP reveals secret for burn
│   │   ├── testMint.js        # Test mint flow
│   │   ├── testBurn.js        # Test burn flow
│   │   └── testVault.js       # Test vault operations
│   │
│   └── utils/                 # Utility functions
│       └── pyth_utils.js      # Pyth oracle helpers
│
├── frontend/                   # Web interface
│   ├── index.html             # Landing page
│   ├── config.js              # Network configuration
│   ├── styles.css             # Styling
│   └── app/                   # Frontend application
│       ├── app.html           # Main app interface
│       └── app.js             # Frontend logic
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
┌──────────────┐                                  ┌─────────────┐
│   Monero     │                                  │   Gnosis    │
│   Mainnet    │                                  │   Chain     │
└──────┬───────┘                                  └──────┬──────┘
       │                                                 │
       │  1. User sends XMR to LP's Monero address      │
       │  ──────────────────────────────────────────►   │
       │                                                 │
       │  2. User generates ZK proof of ownership        │
       │     (Proves P = H_s·G + B without revealing r)  │
       │                                                 │
       │  3. LP verifies proof & mints wsXMR        ┌────┴────┐
       │  ◄──────────────────────────────────────  │VaultMgr │
       │                                           │  Vault  │
       │  4. User receives wsXMR tokens            │Collateral│
       │  ◄──────────────────────────────────────  │  wsXMR  │
       │                                           └────┬────┘
       │                                                 │
       │  5. To burn: User commits to XMR address        │
       │  ──────────────────────────────────────────────►│
       │                                                 │
       │  6. LP sends XMR, reveals secret                │
       │  ◄──────────────────────────────────────────────│
       │                                                 │
       │  7. User verifies & finalizes burn              │
       │  ──────────────────────────────────────────────►│
```

### Components

1. **Atomic Swap Protocol**
   - HTLC-style secret commitments for trustless exchange
   - Secp256k1 elliptic curve verification
   - Timeout-based slashing for non-compliance
   - No zero-knowledge proofs required

2. **Smart Contracts** (`contracts/`)
   - **VaultManager.sol**: Core vault system managing LP collateral and mint/burn operations
   - **wsXMR.sol**: ERC-20 token (8 decimals) representing wrapped Monero
   - **Secp256k1.sol**: Elliptic curve verification for secret reveals
   - **IPyth.sol**: Oracle integration for XMR and collateral price feeds

3. **Vault System**
   - Individual LP vaults with customizable collateral types (ETH, wstETH, etc.)
   - 150% collateralization ratio ensures wsXMR is always backed
   - 120% liquidation threshold with 110% liquidator bonus
   - Atomic swap-based mint/burn with HTLC commitments
   - Pyth oracle integration for real-time price feeds

---

## 📖 How It Works

### Minting (Monero → wsXMR)

1. **Create Vault** (LP): Liquidity provider creates a vault with collateral (ETH, wstETH, etc.)
2. **Deposit Collateral** (LP): LP deposits collateral to back wsXMR (minimum 150% ratio)
3. **Initiate Mint** (User): User initiates mint request on-chain
   - Provides claim commitment (hash of secret for atomic swap)
   - Pays griefing deposit (refunded on completion)
   - LP's vault debt is reserved
4. **Send XMR** (User): User sends XMR to LP's Monero address off-chain
5. **Confirm Receipt** (LP): LP verifies XMR receipt and marks mint as READY
6. **Finalize Mint** (User): User reveals secret to claim wsXMR
   - Secret is verified against commitment using secp256k1
   - wsXMR is minted to user
   - Griefing deposit is refunded

### Burning (wsXMR → Monero)

1. **Request Burn** (User): User requests burn with Monero address and secret hash
   - wsXMR tokens are reserved (not yet burned)
   - LP's collateral is reserved for this burn
   - 24-hour deadline is set
2. **Send XMR** (LP): LP sends XMR to user's Monero address off-chain
3. **Commit Burn** (User): User verifies XMR receipt and commits burn
   - wsXMR is burned
   - Collateral is escrowed
4. **Finalize Burn** (LP): LP reveals secret to unlock escrowed collateral
   - Secret is verified against hash
   - Collateral is released back to LP
5. **Timeout Protection**: If LP doesn't reveal secret within 24h, user can slash and seize collateral

### For Liquidity Providers

1. **Create Vault**: Call `createVault()` with chosen collateral type
2. **Deposit Collateral**: Lock ETH or ERC20 tokens (minimum 150% of debt value)
3. **Set Parameters**: Configure griefing deposit amount for mint requests
4. **Accept Mints**: Users can initiate mints against your vault
5. **Manage Health**: Monitor collateral ratio to avoid liquidation (<120%)
6. **Earn Fees**: Collect fees from mint/burn operations

---

## 🔐 Security

### Cryptographic Guarantees

- **Secp256k1 Verification**: Elliptic curve operations verify secret reveals match commitments
- **Hash-Time-Locked Contracts**: HTLC-style atomic swaps prevent fund loss
- **Timeout Enforcement**: 24-hour windows with on-chain slashing for non-compliance
- **Commitment Binding**: Secrets are cryptographically bound to commitments
- **Collateral Escrow**: Smart contract holds collateral during burn process

### Economic Security

**Collateralization System:**
- **Collateral Ratio**: 150% - Minimum collateral required to back wsXMR debt
- **Liquidation Threshold**: 120% - Below this, vault can be liquidated
- **Liquidation Bonus**: 110% - Liquidators receive 10% bonus from vault collateral
- **Health Monitoring**: Real-time collateral ratio tracking per vault
- **Multi-Asset Support**: Each collateral type has its own Pyth price feed

**Oracle System:**
- **Pyth Network Integration**: Real-time price feeds for XMR/USD and collateral assets
- **Price Staleness Check**: Maximum 5-minute age for price data
- **Pull-Based Updates**: Prices pushed on-chain before critical operations
- **Multi-Feed Support**: Separate feeds for XMR and each collateral type

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

# Test mint/burn flows
node scripts/lpServer/testMint.js
node scripts/lpServer/testBurn.js

# Test vault operations
node scripts/lpServer/testVault.js
```

---

## 📚 Documentation

### Project Documentation
- [Technical Specification](SYNTHWRAP.md) - Complete protocol specification
- [Contract Documentation](contracts/README.md) - Solidity smart contracts
- [Deployment Guide](scripts/deploy/README.md) - Deployment instructions

### External Resources
- [Monero Documentation](https://www.getmonero.org/resources/developer-guides/) - Monero protocol
- [Pyth Network](https://pyth.network/) - Price oracle documentation
- [Atomic Swaps](https://en.bitcoin.it/wiki/Atomic_swap) - Cross-chain atomic swap protocol
- [HTLC](https://en.bitcoin.it/wiki/Hash_Time_Locked_Contracts) - Hash time-locked contracts
- [Uniswap V4 Hooks](https://docs.uniswap.org/contracts/v4/overview) - Hook development

---

## 🔮 Roadmap

### Phase 1: Core Development (Current)
- ✅ VaultManager contract with atomic swap mechanics
- ✅ wsXMR ERC-20 token implementation
- ✅ Secp256k1 verification library
- ✅ Pyth oracle integration
- 🔄 LP server infrastructure for managing vaults
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