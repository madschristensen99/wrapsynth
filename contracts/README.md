# Hooked Monero Contracts

Smart contracts for the Monero-to-Ethereum bridge on EVM.

## 📁 Contract Overview

### Core Contracts

#### `WrappedMonero.sol`
The main bridge contract that manages:
- **LP System**: Liquidity providers deposit wstETH collateral to back wrapped XMR tokens
- **Minting**: Users prove Monero ownership via ZK proofs to mint wrapped XMR
- **Burning**: Users burn wrapped XMR to receive XMR from LPs
- **Collateralization**: 150% safe ratio, 120% liquidation threshold
- **Price Oracle**: Integrates with Pyth for XMR/USD and ETH/USD prices

**Key Features:**
- Per-LP collateral management
- LP-specific mint/burn fees
- 2-hour burn window with collateral slashing
- Yield-bearing collateral (wstETH)
- ZK proof verification for privacy

#### `MoneroBridgeVerifier.sol`
PLONK verifier contract (auto-generated from circuit compilation).

**Purpose:**
- Verifies zero-knowledge proofs of Monero transaction ownership
- Validates amount decryption without revealing transaction details
- ~1,167 constraints, optimized for gas efficiency

**Generated from:** `../circuit/monero_bridge.circom`

#### `MintRelayer.sol`
ERC-4337 style relayer for gasless private minting.

**Purpose:**
- Enables privacy-preserving mints to fresh addresses
- Users sign EIP-712 mint intents off-chain
- Relayers execute mints and pay gas
- No on-chain link between user and recipient

**Key Features:**
- EIP-712 structured data signing
- Relayer registration with stake
- Intent replay protection
- Deadline enforcement

**Deployed:** `0xbF9Aff472b81D36971b3328f79fA661610fE8675`

#### `PrivacySwapHook.sol`
Uniswap v4 hook for private token acquisition.

**Purpose:**
- Atomic wXMR → any token swaps
- Complete privacy preservation
- Works with any token with wXMR liquidity

**Key Features:**
- Extends Uniswap v4 BaseHook
- Implements beforeSwap and afterSwap hooks
- Automatic swap execution after mint
- Sends tokens to fresh address
- MEV protection via slippage limits


### Interfaces

#### `interfaces/IPlonkVerifier.sol`
Interface for the PLONK verifier contract.

### Libraries

#### `libraries/Ed25519.sol`
Ed25519 signature and point verification library for Monero cryptography.

**Functions:**
- Point validation
- Scalar multiplication verification
- DLEQ proof verification

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      WrappedMonero                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  LP System                                            │  │
│  │  • Register LP with fees                             │  │
│  │  • Deposit wstETH collateral                         │  │
│  │  • Withdraw (down to 150% ratio)                     │  │
│  │  • Liquidation if < 120%                             │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Minting Flow                                         │  │
│  │  1. User creates mint intent (anti-griefing deposit) │  │
│  │  2. User sends XMR to LP's Monero address            │  │
│  │  3. Oracle confirms transaction                       │  │
│  │  4. User submits ZK proof                            │  │
│  │  5. Contract verifies proof & mints wrapped XMR      │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Burning Flow                                         │  │
│  │  1. User requests burn with XMR address              │  │
│  │  2. Wrapped XMR tokens locked                        │  │
│  │  3. LP has 2 hours to send XMR                       │  │
│  │  4. Oracle confirms XMR sent → burn complete         │  │
│  │  5. If timeout → user claims LP collateral           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ├─────► MoneroBridgeVerifier
                           │       (ZK Proof Verification)
                           │
                           ├─────► Pyth Oracle
                           │       (XMR/USD, ETH/USD prices)
                           │
                           └─────► wstETH
                                   (Yield-bearing collateral)
```

## 🔐 Security Model

### Collateralization Ratios

- **150%+ (Safe Zone)**: LP can accept new mints, withdraw excess
- **120-150% (Risk Zone)**: LP cannot accept new mints, cannot withdraw
- **<120% (Liquidation)**: Anyone can liquidate LP, add collateral

### ZK Proof Requirements

The circuit proves:
1. Knowledge of transaction private key `r`
2. Correct ECDH decryption: `v = ecdhAmount ⊕ Keccak(H_s)`
3. Valid Poseidon commitment binding all values
4. Range checks on scalars (< Ed25519 curve order)

### Trust Assumptions

- **Oracle**: Trusted to confirm Monero transactions (can be decentralized)
- **LPs**: Economically incentivized via collateral and fees
- **Pyth**: Trusted for price feeds (decentralized oracle network)
- **ZK Proofs**: Trustless cryptographic verification

## 📊 Contract Specifications

### WrappedMonero

**Solidity Version:** `^0.8.20`

**Dependencies:**
- OpenZeppelin: ERC20, ERC20Permit, ReentrancyGuard
- Pyth: IPyth, PythStructs
- Custom: IPlonkVerifier, Ed25519

**Key Constants:**
```solidity
SAFE_RATIO = 150                    // 150% collateralization
LIQUIDATION_THRESHOLD = 120         // 120% liquidation threshold
PICONERO_PER_XMR = 1e12            // Monero atomic units
MAX_PRICE_AGE = 60                 // 60 seconds max price staleness
BURN_TIMEOUT = 2 hours             // LP must send XMR within 2 hours
MAX_FEE_BPS = 500                  // Max 5% fee
MINT_INTENT_TIMEOUT = 2 hours      // Intent expires after 2 hours
MIN_INTENT_DEPOSIT = 0.001 ether   // Minimum anti-griefing deposit
MIN_MINT_BPS = 100                 // Minimum 1% of LP capacity
```

### MoneroBridgeVerifier

**Type:** PLONK Verifier (auto-generated)

**Statistics:**
- Constraints: 1,167
- Public Inputs: 69
- Private Inputs: 511
- Gas Cost: ~300-400k per verification (estimate)

## 🚀 Deployment

### Prerequisites

1. Compile the circuit (generates verifier):
```bash
cd ../circuit
./compile.sh
```

2. Install dependencies:
```bash
cd ..
npm install
```

3. Configure environment:
```bash
cp .env.example .env
# Edit .env with your private key
```

### Deploy to EVM

```bash
npm run deploy:unichain
```

This will:
1. Deploy `MoneroBridgeVerifier`
2. Deploy `WrappedMonero` with verifier address
3. Save deployment info to `deployments/`

### Manual Deployment

```javascript
// 1. Deploy Verifier
const PlonkVerifier = await ethers.getContractFactory("PlonkVerifier");
const verifier = await PlonkVerifier.deploy();

// 2. Deploy WrappedMonero
const WrappedMonero = await ethers.getContractFactory("WrappedMonero");
const wrappedMonero = await WrappedMonero.deploy(
  verifierAddress,
  wstETHAddress,
  pythAddress,
  oracleAddress,
  xmrPriceData,
  ethPriceData
);
```

## 🧪 Testing

### Unit Tests

```bash
npm test
```

### Integration Tests

Test the full flow:
1. LP registration and deposit
2. Mint intent creation
3. ZK proof generation and verification
4. Burn request and completion

### Local Testing

```bash
# Start local Hardhat node
npm run node

# Deploy to local network
npm run deploy
```

## 📝 Contract Interactions

### For Liquidity Providers

#### 1. Register as LP
```solidity
wrappedMonero.registerLP(
  uint16 mintFeeBps,  // e.g., 50 = 0.5%
  uint16 burnFeeBps,  // e.g., 50 = 0.5%
  bool active         // true to accept mints
);
```

#### 2. Deposit Collateral
```solidity
wrappedMonero.lpDeposit{value: ethAmount}();
```

#### 3. Withdraw Collateral
```solidity
wrappedMonero.lpWithdraw(uint256 wstETHAmount);
```

### For Users

#### 1. Create Mint Intent
```solidity
wrappedMonero.createMintIntent{value: depositAmount}(
  address lp,
  uint256 expectedAmount  // in piconero
);
```

#### 2. Complete Mint (after sending XMR)
```solidity
wrappedMonero.completeMint(
  uint256 intentId,
  MoneroTxOutput memory txOutput,
  Ed25519Proof memory ed25519Proof,
  DLEQProof memory dleqProof,
  uint256[24] memory zkProof,
  uint256[69] memory publicSignals
);
```

#### 3. Request Burn
```solidity
wrappedMonero.requestBurn(
  address lp,
  uint256 amount,      // in piconero
  string memory xmrAddress
);
```

#### 4. Claim Collateral (if LP doesn't send XMR)
```solidity
wrappedMonero.claimBurnCollateral(uint256 burnId);
```

### For Oracle

#### 1. Confirm Mint
```solidity
wrappedMonero.confirmMint(uint256 intentId);
```

#### 2. Confirm Burn
```solidity
wrappedMonero.confirmBurn(uint256 burnId);
```

## 🔍 Events

```solidity
event LPRegistered(address indexed lp, uint16 mintFeeBps, uint16 burnFeeBps);
event LPDeposited(address indexed lp, uint256 ethAmount, uint256 wstETHAmount);
event LPWithdrew(address indexed lp, uint256 wstETHAmount, uint256 ethValue);
event LPLiquidated(address indexed lp, address indexed liquidator, uint256 collateralAdded);

event MintIntentCreated(uint256 indexed intentId, address indexed user, address indexed lp, uint256 expectedAmount);
event MintIntentCancelled(uint256 indexed intentId, address indexed user);
event Minted(address indexed recipient, address indexed lp, uint256 amount, uint256 fee, bytes32 indexed outputId);

event BurnRequested(uint256 indexed burnId, address indexed user, address indexed lp, uint256 amount, string xmrAddress);
event BurnCompleted(uint256 indexed burnId, address indexed user, uint256 amount);
event BurnCollateralClaimed(uint256 indexed burnId, address indexed user, uint256 collateralAmount);

event PriceUpdated(uint256 xmrUsdPrice, uint256 ethUsdPrice, uint256 timestamp);
```

## ⚠️ Security Considerations

### Known Limitations

1. **Oracle Trust**: Currently relies on single oracle for Monero tx confirmation
2. **Price Oracle**: Depends on Pyth for accurate XMR/ETH prices
3. **Amount Verification**: Disabled in circuit for subaddress support
4. **Gas Costs**: ZK verification is expensive (~300-400k gas)

### Audit Status

⚠️ **NOT AUDITED - EXPERIMENTAL SOFTWARE**

Do not use with real funds without:
- Professional security audit
- Formal verification
- Extensive testing
- Bug bounty program

### Best Practices

1. **LPs**: Maintain >150% collateralization ratio
2. **Users**: Verify LP reputation and fees before minting
3. **Oracle**: Use multiple confirmation sources
4. **Prices**: Update Pyth prices before large operations

## 📚 Resources

- [Monero Cryptography](https://www.getmonero.org/resources/moneropedia/)
- [PLONK Paper](https://eprint.iacr.org/2019/953)
- [Pyth Network](https://pyth.network/)
- [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts/)

## 🤝 Contributing

Contributions welcome! Please:
1. Review the architecture
2. Write tests for new features
3. Follow Solidity best practices
4. Document security considerations

## 📄 License

MIT
