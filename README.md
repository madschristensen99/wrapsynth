# ⛴️ WrapSynth

**A trustless cross-chain ferry bringing Monero to EVM chains using atomic swaps and collateralized vaults.**

🌐 **[wrapsynth.com](https://wrapsynth.com)**

WrapSynth enables trustless cross-chain transfers of Monero (XMR) to Ethereum and EVM chains through atomic swap mechanics and overcollateralized LP vaults. Users exchange XMR for wsXMR tokens backed by 150% collateral, with cryptographic commitments ensuring trustless execution.

---

## ✨ Key Features

### Core Technology
- **Atomic Swap Protocol**: HTLC-style secret commitments for trustless XMR ↔ wsXMR exchange
- **Ed25519 Verification**: Cryptographic verification of secret reveals using elliptic curve operations (matching Monero's curve)
- **Diamond/Facet Architecture**: Modular EIP-2535 Diamond pattern for upgradeable logic with immutable storage
- **Vault-Based System**: Individual LP vaults with isolated collateral and debt tracking
- **sDAI Collateral**: Savings DAI (auto-converting from xDAI) with yield harvesting
- **Real-Time Pricing**: Pyth Network oracle integration for accurate asset valuation

### Vault-Based Architecture
- **Individual LP Vaults**: Each liquidity provider manages their own collateralized vault
- **sDAI Collateral**: Savings DAI with automatic yield harvesting to protocol war chest
- **Overcollateralization**: 150% collateral ratio ensures wsXMR is always backed
- **Liquidation Protection**: 120% liquidation threshold with 110% liquidator bonus
- **Pyth Oracle Integration**: Real-time price feeds for XMR and sDAI/USD

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

## 🏗️ Monorepo Structure

WrapSynth is organized as a **multi-chain monorepo** with clear separation between implementations:

- **`ethereum/`** - Complete EVM implementation (Gnosis, Unichain, etc.)
  - Solidity contracts, Hardhat tests, deployment scripts
  - Rust-based LP node for managing vaults and Monero interactions
  
- **`solana/anchor-program/`** - Solana Anchor program implementation
  - Anchor-based vault manager program
  - Native Solana integration with similar atomic swap mechanics
  
- **`frontend/`** - Unified web interface supporting both chains
  
- **`docs/`** - Technical documentation and design specs

This structure allows independent development and deployment of each chain while sharing common documentation and frontend code.

---

## 🚀 Current Status

**Development Phase**: ✅ **Deployed to Gnosis Chain Mainnet**

### 🌐 Live Deployments

#### Gnosis Chain (ChainID: 100)

**Latest Deployment (v1.2 - Burn Reward Fix):**
- **wsXMR Token**: [`0x910bfbfe34cfa4ea45b6ec8070872e2f89b5e6ad`](https://gnosisscan.io/address/0x910bfbfe34cfa4ea45b6ec8070872e2f89b5e6ad) (0x910...)
- **wsXmrHub (Diamond)**: [`0x9b03355624acd1265508b981b046f4293b1ffed8`](https://gnosisscan.io/address/0x9b03355624acd1265508b981b046f4293b1ffed8) (0x9b0...)
- **CREATE2 Factory**: [`0x5bCaA55651c71ec49b29feCAFA8a3D654F9f87e7`](https://gnosisscan.io/address/0x5bCaA55651c71ec49b29feCAFA8a3D654F9f87e7)
- Deployed: May 25, 2026
- Status: ✅ Deployed with Diamond/facet architecture + burn reward fixes

**Previous Deployment (Monolithic):**
- **wsXMR Token**: [`0xf0114924F8e3d1D4dca68DEf1F3Ea402EF5B32a2`](https://gnosisscan.io/address/0xf0114924F8e3d1D4dca68DEf1F3Ea402EF5B32a2#code)
- **VaultManager (deprecated)**: [`0x839257DE37b22B377e545514e2eD0b4f92266F88`](https://gnosisscan.io/address/0x839257DE37b22B377e545514e2eD0b4f92266F88#code)
- **wsXMRLiquidityRouter**: [`0x7Ed870F86ae9c7ecE955185792FFF1Ac57dc743a`](https://gnosisscan.io/address/0x7Ed870F86ae9c7ecE955185792FFF1Ac57dc743a#code)

**Configuration:**
- Collateral: sDAI (Savings DAI) - auto-converts from xDAI deposits
- Oracle: Pyth Network (`0x2880aB155794e7179c9eE2e38200202908C17B43`)
- Architecture: EIP-2535 Diamond pattern with 6 facets (Vault, Mint, Burn, Liquidation, Yield, Oracle)
- Cryptography: Ed25519 elliptic curve (matching Monero) for atomic swap secret verification
- Libraries: CollateralLogic, YieldLogic, BurnLogic for shared functionality

**Target Networks:**
- **Gnosis Chain** (ChainID: 100) - ✅ **LIVE** (low gas costs)
- **Unichain Testnet** (ChainID: 1301) - Development and testing

**Deployment Status:**
- ✅ Diamond/facet architecture (wsXmrHub + 6 facets) implemented
- ✅ Atomic swap mechanics with HTLC-style commitments and Ed25519 verification
- ✅ Pyth oracle integration for price feeds
- ✅ **Deployed to Gnosis Chain mainnet**
- ✅ **Contracts verified on Gnosisscan**
- ✅ sDAI collateral with automatic yield harvesting

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

# Install Ethereum dependencies
cd ethereum
npm install

# Copy environment variables
cp .env.example .env
# Edit .env and add your PRIVATE_KEY and RPC URLs
```

### Compile Contracts

```bash
# From ethereum directory
cd ethereum
npx hardhat compile
```

This will compile:
- `wsXmrHub.sol` - Diamond proxy with state storage and facet routing
- `wsXMR.sol` - ERC-20 token contract (8 decimals)
- Facets: `VaultFacet`, `MintFacet`, `BurnFacet`, `LiquidationFacet`, `YieldFacet`
- **Oracle**: `RedStoneOracleFacet` (live deployment) or `SimpleOracleFacet` (testing)
  - `ChainlinkOracleFacet` exists for reference but is not currently used
- `Ed25519.sol` - Elliptic curve verification library (matching Monero's curve)
- Supporting interfaces and libraries (CollateralLogic, YieldLogic, BurnLogic)

### Deploy Contracts

#### Deploy to Gnosis Mainnet

1. **Get xDAI** for gas fees (very low cost ~$0.01 per tx)
   - Transfer DAI to xDAI: [Gnosis Chain](https://www.gnosischain.com/)
   - Or use [Jumper Exchange](https://jumper.exchange/)

2. **Configure environment:**
```bash
cp .env.example .env
# Edit .env and add your PRIVATE_KEY and GNOSIS_RPC_URL
```

3. **Deploy contracts:**
```bash
# From ethereum directory
cd ethereum

# Deploy wsXmrHub (Diamond) and wsXMR to Gnosis mainnet
npm run deploy:gnosis

# Or deploy with vanity addresses (0xB00F for hub, 0x420 for token)
npx hardhat run scripts/deploy/deploy-vanity-fixed.js --network gnosis
```

4. **Verify contracts on Gnosisscan:**
```bash
npm run verify:gnosis
```

**Diamond Architecture Deployment:**
The latest deployment uses EIP-2535 Diamond pattern with CREATE2 vanity addresses:
- wsXmrHub (Diamond proxy) starts with `0xB00F`
- wsXMR token starts with `0x420`
- Modular facet design eliminates 24KB contract size limit
- Shared libraries (CollateralLogic, YieldLogic, BurnLogic) reduce code duplication

**⚠️ EVM Requirements:**
- Requires Cancun or later EVM (for transient storage EIP-1153)
- Gnosis Chain: ✅ Supported (Pectra upgrade April 2025)
- Most L2s: ✅ Supported (verify deployment target has Cancun)
- Solidity 0.8.28+ required for `transient` keyword

#### Deploy to Unichain Testnet

1. **Get testnet ETH** from [Unichain Faucet](https://faucet.unichain.org/)

2. **Deploy contracts:**
```bash
# From ethereum directory
cd ethereum

# Deploy wsXmrHub (Diamond) and wsXMR to Unichain testnet
npm run deploy:unichain
```

3. **Verify contracts on Uniscan:**
```bash
npm run verify
```

### Run LP Node

```bash
# Build the Rust-based LP node
cd ethereum/lp-node
cargo build --release

# Configure LP node (edit config.toml if needed)
./setup.sh

# Run LP node service
cargo run --release
```

### Solana Program

```bash
# Build the Solana program
cd solana/anchor-program
anchor build

# Run tests
anchor test
```

---

## 📁 Project Structure

```
wrapsynth/
├── ethereum/                   # Ethereum/EVM implementation
│   ├── contracts/             # Solidity smart contracts
│   │   ├── core/              # Diamond core contracts
│   │   │   ├── wsXmrHub.sol   # Diamond proxy with facet routing
│   │   │   └── wsXmrStorage.sol # Shared storage layout
│   │   ├── facets/            # Diamond facets (logic contracts)
│   │   │   ├── VaultFacet.sol # Vault management
│   │   │   ├── MintFacet.sol  # Mint operations
│   │   │   ├── BurnFacet.sol  # Burn operations
│   │   │   ├── LiquidationFacet.sol # Liquidation logic
│   │   │   ├── YieldFacet.sol # Yield harvesting and buy-and-burn
│   │   │   └── OracleFacet.sol # Price feed management
│   │   ├── wsXMR.sol          # ERC-20 token (8 decimals)
│   │   ├── Ed25519.sol        # Elliptic curve verification (Monero curve)
│   │   ├── Create2Deployer.sol # CREATE2 factory for vanity addresses
│   │   ├── libraries/         # Shared logic libraries
│   │   │   ├── CollateralLogic.sol # Collateral ratio calculations
│   │   │   ├── YieldLogic.sol # Yield harvesting logic
│   │   │   └── BurnLogic.sol  # Burn request logic
│   │   ├── interfaces/        # Contract interfaces
│   │   └── mocks/             # Mock contracts for testing
│   │
│   ├── scripts/               # Deployment & management scripts
│   │   ├── deploy/            # Deployment scripts
│   │   │   ├── deploy-gnosis.js # Gnosis mainnet deployment
│   │   │   └── verify-gnosis.js # Contract verification
│   │   └── vanity-address.js  # Vanity address generator
│   │
│   ├── lp-node/               # Rust-based LP node
│   │   ├── src/               # LP node source code
│   │   │   ├── main.rs        # Main entry point
│   │   │   ├── engine.rs      # Core LP logic
│   │   │   ├── evm.rs         # EVM interaction
│   │   │   ├── monero.rs      # Monero RPC client
│   │   │   ├── db.rs          # Database layer
│   │   │   ├── api.rs         # REST API
│   │   │   └── events.rs      # Event monitoring
│   │   ├── Cargo.toml         # Rust dependencies
│   │   ├── config.toml        # LP node configuration
│   │   └── README.md          # LP node documentation
│   │
│   ├── test/                  # Contract tests
│   ├── hardhat.config.js      # Hardhat configuration
│   ├── package.json           # Node.js dependencies
│   └── .env.example           # Environment variables template
│
├── solana/                     # Solana implementation
│   └── anchor-program/        # Anchor program
│       ├── programs/          # Solana programs
│       │   └── wrapsynth-vault-manager/ # Main vault manager program
│       ├── tests/             # Anchor tests
│       ├── Anchor.toml        # Anchor configuration
│       └── README.md          # Solana program documentation
│
├── frontend/                   # Web interface
│   ├── index.html             # Landing page
│   ├── config.js              # Network configuration
│   ├── styles.css             # Styling
│   └── app/                   # Frontend application
│       ├── app.html           # Main app interface
│       └── app.js             # Frontend logic
│
├── docs/                       # Technical documentation
│   └── SEED_STORAGE_IMPLEMENTATION.md # Seed storage design
│
├── .env.example               # Root environment variables
├── .gitignore                 # Git ignore rules
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
   - Ed25519 elliptic curve verification (matching Monero's curve)
   - Timeout-based slashing for non-compliance
   - Commitment binding to prevent secret replay attacks

2. **Smart Contracts** (`contracts/`)
   - **wsXmrHub.sol**: EIP-2535 Diamond proxy with facet routing and shared storage
   - **Facets**: VaultFacet, MintFacet, BurnFacet, LiquidationFacet, YieldFacet, OracleFacet
   - **wsXMR.sol**: ERC-20 token (8 decimals) representing wrapped Monero
   - **Ed25519.sol**: Elliptic curve verification for secret reveals (Monero's curve)
   - **Libraries**: CollateralLogic, YieldLogic, BurnLogic for shared functionality

3. **Vault System**
   - Individual LP vaults with sDAI (Savings DAI) collateral
   - 150% collateralization ratio ensures wsXMR is always backed
   - 120% liquidation threshold with 110% liquidator bonus
   - Atomic swap-based mint/burn with HTLC commitments
   - Automatic yield harvesting to protocol war chest
   - Pyth oracle integration for real-time XMR/USD and sDAI/USD price feeds

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
   - Secret is verified against commitment using Ed25519 scalar multiplication
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

1. **Create Vault**: Call `createVault()` to initialize your LP vault
2. **Deposit Collateral**: Deposit xDAI (auto-converts to sDAI) - minimum 150% of debt value
3. **Set Parameters**: Configure griefing deposit amount for mint requests
4. **Accept Mints**: Users can initiate mints against your vault
5. **Manage Health**: Monitor collateral ratio to avoid liquidation (<120%)
6. **Earn Fees**: Collect fees from mint/burn operations
7. **Yield Harvesting**: Excess sDAI yield is automatically extracted to protocol war chest

---

## 🔐 Security

### Cryptographic Guarantees

- **Ed25519 Verification**: Elliptic curve operations verify secret reveals match commitments (using Monero's curve)
- **Hash-Time-Locked Contracts**: HTLC-style atomic swaps prevent fund loss
- **Timeout Enforcement**: 24-hour windows with on-chain slashing for non-compliance
- **Commitment Binding**: Secrets are cryptographically bound to requestId to prevent replay attacks
- **Collateral Escrow**: Smart contract holds collateral during burn process
- **Delegate Context Protection**: Privileged functions only callable via Diamond delegatecall

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

### Ethereum Tests
```bash
# From ethereum directory
cd ethereum

# Run all contract tests
npm test

# Run specific test suites
npx hardhat test test/01-TokenAuthority.test.js
npx hardhat test test/03-MintingLifecycle.test.js
```

### Solana Tests
```bash
# From solana program directory
cd solana/anchor-program

# Run Anchor tests
anchor test
```

### LP Node Testing
```bash
# From LP node directory
cd ethereum/lp-node

# Run LP node in test mode
cargo run --release -- --config config.toml
```

---

## 📚 Documentation

### Project Documentation
- [Ethereum Contracts](ethereum/contracts/) - Solidity smart contracts
- [LP Node Documentation](ethereum/lp-node/README.md) - LP node setup and operation
- [Solana Program](solana/anchor-program/README.md) - Anchor program documentation
- [Seed Storage Design](docs/SEED_STORAGE_IMPLEMENTATION.md) - Technical design docs

### External Resources
- [Monero Documentation](https://www.getmonero.org/resources/developer-guides/) - Monero protocol
- [Pyth Network](https://pyth.network/) - Price oracle documentation
- [Atomic Swaps](https://en.bitcoin.it/wiki/Atomic_swap) - Cross-chain atomic swap protocol
- [HTLC](https://en.bitcoin.it/wiki/Hash_Time_Locked_Contracts) - Hash time-locked contracts
- [Uniswap V4 Hooks](https://docs.uniswap.org/contracts/v4/overview) - Hook development

---

## 🔮 Roadmap

### Phase 1: Core Development (Current)
- ✅ Diamond/facet architecture (wsXmrHub + 6 facets)
- ✅ wsXMR ERC-20 token implementation
- ✅ Ed25519 verification library (Monero curve)
- ✅ Pyth oracle integration
- ✅ Security fixes: access control, commitment binding, reentrancy optimization
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