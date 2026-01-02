# **Monero→Arbitrum Bridge Specification v5.4**

*Cryptographically Correct, Quadratic Oracle Consensus, TWAP-Protected Liquidations*

**Target: ~2.6M non-linear constraints, ~1.6M linear constraints, 150% initial collateral, 120% liquidation threshold, DAI-only yield**

**Platform: Arbitrum One (Solidity, Circom ZK Framework)**

**Collateral: Yield-Bearing DAI Only (sDAI, aDAI)**

**Status: ZK Circuit Functional - Core Security Features Working (Requires Audit)**

---

## **1. Architecture & Principles**

### **1.1 Core Design Tenets**

1. **Cryptographic Layer (Circuit)**: Proves Monero transaction authenticity using Circom. Witnesses generated 100% client-side from wallet data. **Current circuit proves: (1) Knowledge of transaction secret key (r·G = R), (2) Correct destination address derivation (P = H_s·G + B), (3) Amount decryption correctness (v matches ecdhAmount). ⚠️ NOT AUDITED **
2. **Economic Layer (Contracts)**: Enforces DAI-only collateralization, manages liquidity risk, **TWAP-protected liquidations** with 15-minute exponential moving average.
3. **Oracle Layer (On-Chain)**: **Quadratic-weighted N-of-M consensus** based on historical proof accuracy. Minimum 3.0 weighted votes required, weighted by oracle reputation score.
4. **Privacy Transparency**: Single-key verification model; destination address provided as explicit input.
5. **Minimal Governance**: No admin elections, no Snapshot. **Single guardian address** can pause mints only (30-day timelock to unpause). All other parameters immutable at deployment.

### **1.2 System Components**

```
┌─────────────────────────────────────────────────────────────┐
│              User Frontend (Browser/Wallet)                  │
│  - Paste tx secret key (r) from wallet                       │
│  - Paste tx hash                                             │
│  - Enter destination address used in transaction (P)         │
│  - Enter amount to prove                                     │
│  - Fetch transaction data from Monero node                   │
│  - Generate witnesses (r, v, P, H_s_scalar, S_extended)      │
│  - Prove locally (snarkjs + witness generation)              │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│         Bridge Circuit (Circom, ~4.2M R1CS constraints)     │
│  Proves:                                                     │
│    - Knowledge of transaction secret: r·G = R                │
│    - Correct destination: P = H_s(8·r·A)·G + B              │
│    - Amount decryption: v matches ecdhAmount XOR decrypt     │
│    - LP address binding: Uses A and B from public inputs     │
│                                                              │
│  ⚠️  REQUIRES SECURITY AUDIT BEFORE PRODUCTION               │
│             │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│              TLS Circuit (Circom, ~1.2M R1CS)               │
│  Proves: TLS 1.3 session with **registered node cert**      │
└──────────────────────────┬──────────────────────────────────┘
┌──────────────────────────▼──────────────────────────────────┐
│            Solidity Verifier Contract (Groth16)             │
│  - Verifies BN254 proofs on-chain                           │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│            Solidity Bridge Contract (~1,150 LOC)            │
│  - Manages LP collateral (DAI only)                         │
│  - **Quadratic-weighted N-of-M consensus** (min 3.0 votes)  │
│  - **TWAP oracle** (15-min EMA for liquidations)            │
│  - Enforces 150% collateralization (120% liquidation)       │
│  - Oracle rewards from yield + accuracy bonuses             │
│  - **On-chain node registry** (max 1 change/week)           │
│  - **Guardian pause** (mints only, 30-day unpause timelock) │
│  - **Oracle bonding** (slashable for provably false proofs) │
└─────────────────────────────────────────────────────────────┘
```

---

## **2. Zero-Knowledge Proof System**

### **2.1 Circuit Overview**

The MoneroBridge circuit (~4.2M constraints) cryptographically proves:

1. **Secret Key Knowledge**: Proves r·G = R without revealing r
2. **Destination Correctness**: Proves funds sent to LP address (A, B)
3. **Amount Verification**: Decrypts and verifies ecdhAmount matches claimed value

**Key Properties:**
- Client-side witness generation (browser-based)
- PLONK proof system with universal setup (no trusted ceremony needed)
- Replay protection via on-chain tx_hash tracking

### **2.2 Proof Generation Flow**

1. **Fetch Transaction Data**: Retrieve Monero tx from registered node
2. **Validate Confirmations**: Require 10+ block confirmations
3. **Compute Witnesses**: Generate circuit inputs (secret key, amount, addresses)
4. **Generate Proof**: Create Groth16 proof client-side using snarkjs
5. **Submit On-Chain**: Send proof + public inputs to bridge contract

### **2.3 Technical Summary**

- **Constraint Count**: ~4.2M (2.6M non-linear + 1.6M linear)
- **Proof System**: PLONK with universal setup
- **Key Operations**: Ed25519 scalar multiplications, point operations, Keccak256 hashing
- **Optimization**: H_s_scalar precomputed off-circuit (saves ~150k constraints)



---

## **3. Economic Model & Collateralization**

### **3.1 Collateral Requirements**

- **Initial Collateral**: 150% of minted wXMR value in DAI
- **Liquidation Threshold**: 120% collateralization ratio
- **Accepted Collateral**: Yield-bearing DAI only (sDAI, aDAI)
- **Collateral Custody**: Non-custodial - LPs maintain control

### **3.2 Liquidation Mechanics**

- **Price Oracle**: TWAP (15-minute exponential moving average) via Chainlink
- **Liquidation Trigger**: Collateral ratio falls below 120%
- **Liquidation Penalty**: 5% bonus to liquidator
- **Partial Liquidations**: Allowed to restore healthy ratio

### **3.3 Oracle Consensus Model**

**Quadratic-Weighted N-of-M Voting:**
- Minimum 3.0 weighted votes required for proof acceptance
- Oracle reputation score based on historical accuracy
- Vote weight = (reputation_score)²
- Slashing for provably false attestations

**Oracle Requirements:**
- Minimum 1,000 DAI bond (slashable)
- Run registered Monero node
- Verify ZK proofs on-chain
- Attest to transaction validity

### **3.4 Fee Structure**

- **Mint Fee**: 0.3% (paid to LPs)
- **Burn Fee**: 0.3% (paid to LPs)
- **Oracle Rewards**: From yield + accuracy bonuses
- **LP Yield**: From collateral (sDAI/aDAI) + bridge fees

### **3.5 Risk Parameters**

| Parameter | Value | Rationale |
|-----------|-------|----------|
| Initial Collateral | 150% | Buffer against volatility |
| Liquidation Threshold | 120% | Safety margin for liquidators |
| TWAP Window | 15 minutes | Balance responsiveness vs manipulation |
| Min Oracle Bond | 1,000 DAI | Skin in the game |
| Min Weighted Votes | 3.0 | Decentralization + security |
| Guardian Unpause Delay | 30 days | Time for community response |

---

## **4. Integration & Deployment**

### **4.1 Universal Setup (PLONK)**
1. Use existing universal setup parameters (no ceremony needed)
2. Compile circuit to PLONK format
3. Generate verification key from circuit

### **4.2 Solidity Verifier Contract**
1. Export verifier contract: `snarkjs zkey export solidityverifier`
2. Deploy to Arbitrum One
3. Integrate with bridge contract for proof verification

### **4.3 Frontend Integration**
1. Bundle circuit WASM and proving key
2. Implement witness generation in browser
3. Generate proofs client-side using snarkjs
4. Submit proofs to bridge contract



---

## **5. Solidity Contract Specification**

### **5.1 Contract Overview**

**Key Changes for v5.4:**

| Feature | v5.3 | v5.4 |
|---------|------|------|
| **Oracle Consensus** | Simple N-of-M (count-based) | Quadratic-weighted (reputation-based) |
| **Price Oracle** | Direct Chainlink spot | TWAP (15-min EMA) for liquidations |
| **Oracle Bonding** | None | 1,000 DAI minimum, slashable |
| **Pause Mechanism** | None | Guardian pause (mints only) |
| **Pedersen Commitment** | v·G + γ·H (incorrect) | v·H + γ·G (Monero-native) |
| **Binding Hash** | SHA256 | Keccak256 (Ethereum-native) |
| **Circuit Version** | 3 | 4 |
| **Contract LOC** | ~950 | ~1,150 |

### **3.2 Core Contract: `MoneroBridge.sol`**

```solidity
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.19;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

// ════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ════════════════════════════════════════════════════════════════════════════

interface IBridgeVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[10] calldata _pubSignals
    ) external view returns (bool);
}

interface ITLSVerifier {
    function verifyProof(
        uint256[2] calldata _pA,
        uint256[2][2] calldata _pB,
        uint256[2] calldata _pC,
        uint256[3] calldata _pubSignals
    ) external view returns (bool);
}

interface ISavingsDAI {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20Mintable is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN CONTRACT
// ════════════════════════════════════════════════════════════════════════════

contract MoneroBridge is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ════════════════════════════════════════════════════════════════════════
    
    // Collateralization
    uint256 public constant INITIAL_COLLATERAL_BPS = 15000;     // 150%
    uint256 public constant LIQUIDATION_THRESHOLD_BPS = 12000;  // 120%
    uint256 public constant CRITICAL_THRESHOLD_BPS = 10500;     // 105%
    
    // Timing
    uint256 public constant BURN_COUNTDOWN = 2 hours;
    uint256 public constant MAX_PRICE_AGE = 60 seconds;
    uint256 public constant NODE_CHANGE_COOLDOWN = 7 days;
    uint256 public constant GUARDIAN_UNPAUSE_DELAY = 30 days;
    uint256 public constant MONERO_CONFIRMATIONS = 10;
    
    // Oracle
    uint256 public constant MIN_ORACLE_BOND = 1000e18;          // 1,000 DAI
    uint256 public constant ORACLE_REWARD_BPS = 200;            // 2% of yield
    uint256 public constant MIN_WEIGHTED_CONSENSUS = 3e18;      // 3.0 weighted votes
    uint256 public constant INITIAL_ACCURACY = 1e18;            // 100%
    uint256 public constant ACCURACY_DECAY = 0.25e18;           // -25% per slash
    
    // TWAP
    uint256 public constant TWAP_PERIOD = 15 minutes;
    uint256 public constant TWAP_OBSERVATIONS = 15;
    
    // Fees
    uint256 public constant MIN_FEE_BPS = 5;
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant MAX_SLIPPAGE_BPS = 50;              // 0.5%
    
    // Chain
    uint256 public constant CHAIN_ID = 42161;                   // Arbitrum One
    uint8 public constant CIRCUIT_VERSION = 4;
    
    // Addresses (Arbitrum One)
    address public constant DAI = 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1A;
    address public constant SDAI = 0xD8134205b0328F5676aaeFb3B2a0DC60036d9d7a;

    // ════════════════════════════════════════════════════════════════════════
    // IMMUTABLES
    // ════════════════════════════════════════════════════════════════════════
    
    IERC20Mintable public immutable wXMR;
    address public immutable treasury;
    address public immutable guardian;
    
    AggregatorV3Interface public immutable priceFeedXMR;
    AggregatorV3Interface public immutable priceFeedDAI;
    IBridgeVerifier public immutable bridgeVerifier;
    ITLSVerifier public immutable tlsVerifier;
    ISavingsDAI public immutable sDAI;
    IERC20 public immutable dai;

    // ════════════════════════════════════════════════════════════════════════
    // STATE
    // ════════════════════════════════════════════════════════════════════════
    
    // Pause state
    bool public mintsPaused;
    uint256 public pausedAt;
    uint256 public unpauseRequestedAt;
    
    // Node management
    uint256 public lastNodeChange;
    uint32 public nodeCount;
    
    // TWAP state
    uint256 public twapIndex;
    uint256 public lastTwapUpdate;

    // ════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ════════════════════════════════════════════════════════════════════════
    
    struct LP {
        bytes32 spendKey;           // ed25519 public key (compressed)
        uint256 collateral;         // DAI deposited
        uint256 obligation;         // wXMR obligation value in DAI
        uint256 sDAIShares;         // sDAI balance
        uint16 mintFeeBps;
        uint16 burnFeeBps;
        uint48 lastActive;
        uint48 timelock;
        bool active;
    }
    
    struct Oracle {
        uint256 bond;               // DAI bonded
        uint256 accuracy;           // 1e18 = 100%
        uint256 proofsSubmitted;
        uint256 proofsAccepted;
        uint256 rewards;
        uint48 lastActive;
        uint8 slashCount;
        bool active;
    }
    
    struct MoneroNode {
        bytes32 certFingerprint;
        string url;
        uint48 addedAt;
        bool active;
    }
    
    struct Burn {
        address user;
        address lp;
        uint256 amount;
        uint48 timestamp;
        bytes32 moneroTxHash;
        bool completed;
    }
    
    struct OracleVote {
        address oracle;
        uint256 weight;
        uint48 timestamp;
        bool valid;
    }
    
    struct PricePoint {
        uint48 timestamp;
        uint208 cumulativePrice;
    }

    // ════════════════════════════════════════════════════════════════════════
    // MAPPINGS
    // ════════════════════════════════════════════════════════════════════════
    
    mapping(address => LP) public lps;
    mapping(address => Oracle) public oracles;
    mapping(uint32 => MoneroNode) public nodes;
    mapping(bytes32 => Burn) public burns;
    mapping(bytes32 => bool) public usedTxHashes;
    
    // Consensus tracking
    mapping(bytes32 => mapping(address => OracleVote)) public votes;
    mapping(bytes32 => address[]) public voters;
    mapping(bytes32 => uint256) public totalWeight;
    
    // TWAP
    PricePoint[15] public pricePoints;

    // ════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════════════
    
    event LPRegistered(address indexed lp, bytes32 spendKey);
    event CollateralAdded(address indexed lp, uint256 amount, uint256 shares);
    event CollateralRemoved(address indexed lp, uint256 amount);
    
    event OracleRegistered(address indexed oracle, uint256 bond);
    event OracleSlashed(address indexed oracle, uint256 amount, string reason);
    event OracleVoteSubmitted(bytes32 indexed binding, address oracle, uint256 weight);
    
    event ConsensusReached(bytes32 indexed binding, uint256 weight, uint256 count);
    event Minted(bytes32 indexed txHash, bytes32 binding, address user, uint256 amount, address lp);
    event BurnStarted(bytes32 indexed burnId, address user, uint256 amount, address lp);
    event BurnCompleted(bytes32 indexed burnId, bytes32 moneroTxHash);
    event BurnClaimed(bytes32 indexed burnId, address user, uint256 payout);
    
    event Liquidated(address indexed lp, address liquidator, uint256 seized, uint256 twapPrice);
    
    event NodeAdded(uint32 indexed index, string url, bytes32 fingerprint);
    event NodeRemoved(uint32 indexed index);
    
    event MintsPaused(address guardian);
    event UnpauseRequested(address guardian, uint256 effectiveAt);
    event MintsUnpaused();
    
    event TWAPUpdated(uint256 index, uint256 price);

    // ════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ════════════════════════════════════════════════════════════════════════
    
    error Paused();
    error NotGuardian();
    error TimelockActive();
    error Cooldown();
    error InvalidBond();
    error AlreadyVoted();
    error NoConsensus();
    error InvalidProof();
    error TxUsed();
    error LPInactive();
    error Undercollateralized();
    error NotLiquidatable();
    error FlashLoanBlock();
    error InvalidFee();
    error StalePrice();
    error DepegCritical();
    error BurnExpired();
    error BurnActive();
    error AlreadyDone();
    error NotLP();
    error InvalidKey();

    // ════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ════════════════════════════════════════════════════════════════════════
    
    modifier whenNotPaused() {
        if (mintsPaused) revert Paused();
        _;
    }
    
    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }
    
    modifier noFlashLoan(address _lp) {
        if (lps[_lp].lastActive >= block.timestamp) revert FlashLoanBlock();
        _;
    }

    // ════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ════════════════════════════════════════════════════════════════════════
    
    constructor(
        address _wXMR,
        address _priceFeedXMR,
        address _priceFeedDAI,
        address _bridgeVerifier,
        address _tlsVerifier,
        address _treasury,
        address _guardian,
        MoneroNode[] memory _initialNodes
    ) {
        wXMR = IERC20Mintable(_wXMR);
        treasury = _treasury;
        guardian = _guardian;
        
        priceFeedXMR = AggregatorV3Interface(_priceFeedXMR);
        priceFeedDAI = AggregatorV3Interface(_priceFeedDAI);
        bridgeVerifier = IBridgeVerifier(_bridgeVerifier);
        tlsVerifier = ITLSVerifier(_tlsVerifier);
        sDAI = ISavingsDAI(SDAI);
        dai = IERC20(DAI);
        
        // Initialize nodes
        for (uint i = 0; i < _initialNodes.length; i++) {
            nodes[uint32(i)] = _initialNodes[i];
            emit NodeAdded(uint32(i), _initialNodes[i].url, _initialNodes[i].certFingerprint);
        }
        nodeCount = uint32(_initialNodes.length);
        lastNodeChange = block.timestamp;
        
        // Initialize TWAP
        _initTWAP();
    }

    // ════════════════════════════════════════════════════════════════════════
    // GUARDIAN FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Pause mints immediately (for emergencies)
    function pauseMints() external onlyGuardian {
        mintsPaused = true;
        pausedAt = block.timestamp;
        unpauseRequestedAt = 0;
        emit MintsPaused(guardian);
    }
    
    /// @notice Request unpause (30-day delay)
    function requestUnpause() external onlyGuardian {
        require(mintsPaused, "not paused");
        unpauseRequestedAt = block.timestamp;
        emit UnpauseRequested(guardian, block.timestamp + GUARDIAN_UNPAUSE_DELAY);
    }
    
    /// @notice Execute unpause after delay
    function executeUnpause() external {
        require(mintsPaused, "not paused");
        require(unpauseRequestedAt > 0, "not requested");
        if (block.timestamp < unpauseRequestedAt + GUARDIAN_UNPAUSE_DELAY) {
            revert TimelockActive();
        }
        mintsPaused = false;
        unpauseRequestedAt = 0;
        emit MintsUnpaused();
    }

    // ════════════════════════════════════════════════════════════════════════
    // TWAP ORACLE
    // ════════════════════════════════════════════════════════════════════════
    
    function _initTWAP() internal {
        (, int256 price,,,) = priceFeedXMR.latestRoundData();
        require(price > 0, "invalid price");
        
        uint256 p = uint256(price);
        for (uint i = 0; i < TWAP_OBSERVATIONS; i++) {
            pricePoints[i] = PricePoint({
                timestamp: uint48(block.timestamp),
                cumulativePrice: uint208(p * (i + 1))
            });
        }
        lastTwapUpdate = block.timestamp;
    }
    
    /// @notice Update TWAP with new observation
    function updateTWAP() public {
        (, int256 price,, uint256 updatedAt,) = priceFeedXMR.latestRoundData();
        if (block.timestamp - updatedAt > MAX_PRICE_AGE) revert StalePrice();
        require(price > 0, "invalid price");
        
        uint256 elapsed = block.timestamp - lastTwapUpdate;
        if (elapsed < 60) return; // Min 1 minute between updates
        
        uint256 newIndex = (twapIndex + 1) % TWAP_OBSERVATIONS;
        uint256 prevCumulative = pricePoints[twapIndex].cumulativePrice;
        
        pricePoints[newIndex] = PricePoint({
            timestamp: uint48(block.timestamp),
            cumulativePrice: uint208(prevCumulative + uint256(price) * elapsed)
        });
        
        twapIndex = newIndex;
        lastTwapUpdate = block.timestamp;
        
        emit TWAPUpdated(newIndex, uint256(price));
    }
    
    /// @notice Get 15-minute TWAP
    function getTWAP() public view returns (uint256) {
        uint256 newest = twapIndex;
        uint256 oldest = (newest + 1) % TWAP_OBSERVATIONS;
        
        PricePoint memory n = pricePoints[newest];
        PricePoint memory o = pricePoints[oldest];
        
        uint256 timeElapsed = n.timestamp - o.timestamp;
        if (timeElapsed < TWAP_PERIOD / 2) {
            // Not enough data, return spot
            (, int256 price,,,) = priceFeedXMR.latestRoundData();
            return uint256(price);
        }
        
        return (n.cumulativePrice - o.cumulativePrice) / timeElapsed;
    }
    
    /// @notice Get spot price
    function getSpotPrice() public view returns (uint256) {
        (, int256 price,, uint256 updatedAt,) = priceFeedXMR.latestRoundData();
        if (block.timestamp - updatedAt > MAX_PRICE_AGE) revert StalePrice();
        return uint256(price);
    }

    // ════════════════════════════════════════════════════════════════════════
    // ORACLE MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Register as oracle with bond
    function registerOracle(uint256 _bond) external nonReentrant {
        if (_bond < MIN_ORACLE_BOND) revert InvalidBond();
        require(!oracles[msg.sender].active, "exists");
        
        dai.safeTransferFrom(msg.sender, address(this), _bond);
        
        oracles[msg.sender] = Oracle({
            bond: _bond,
            accuracy: INITIAL_ACCURACY,
            proofsSubmitted: 0,
            proofsAccepted: 0,
            rewards: 0,
            lastActive: uint48(block.timestamp),
            slashCount: 0,
            active: true
        });
        
        emit OracleRegistered(msg.sender, _bond);
    }
    
    /// @notice Add bond
    function addBond(uint256 _amount) external nonReentrant {
        Oracle storage o = oracles[msg.sender];
        require(o.active, "inactive");
        
        dai.safeTransferFrom(msg.sender, address(this), _amount);
        o.bond += _amount;
    }
    
    /// @notice Get oracle quadratic weight
    /// weight = sqrt(accuracy * (1 + log2(proofs + 1)))
    function getOracleWeight(address _oracle) public view returns (uint256) {
        Oracle storage o = oracles[_oracle];
        if (!o.active || o.accuracy == 0) return 0;
        
        // Experience multiplier: 1 + min(proofs/10, 2) => max 3x
        uint256 expMul = 1e18 + Math.min(o.proofsSubmitted * 1e17 / 10, 2e18);
        
        // Combined: accuracy * experience
        uint256 combined = (o.accuracy * expMul) / 1e18;
        
        // Quadratic: sqrt
        return _sqrt(combined);
    }
    
    /// @notice Slash oracle
    function slashOracle(address _oracle, bytes32 _binding, string calldata _reason) external {
        require(msg.sender == treasury, "only treasury"); // TODO: Replace with fraud proof
        
        Oracle storage o = oracles[_oracle];
        require(o.active, "inactive");
        
        OracleVote storage v = votes[_binding][_oracle];
        require(v.oracle == _oracle && v.valid, "no valid vote");
        
        // Slash 25% of bond
        uint256 slash = o.bond / 4;
        o.bond -= slash;
        o.accuracy = o.accuracy > ACCURACY_DECAY ? o.accuracy - ACCURACY_DECAY : 0;
        o.slashCount++;
        v.valid = false;
        
        dai.safeTransfer(treasury, slash);
        
        emit OracleSlashed(_oracle, slash, _reason);
        
        // Deactivate if under minimum
        if (o.bond < MIN_ORACLE_BOND) {
            o.active = false;
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // LP MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Register as LP
    function registerLP(bytes32 _spendKey, uint16 _mintFee, uint16 _burnFee) external whenNotPaused {
        if (_mintFee < MIN_FEE_BPS || _mintFee > MAX_FEE_BPS) revert InvalidFee();
        if (_burnFee < MIN_FEE_BPS || _burnFee > MAX_FEE_BPS) revert InvalidFee();
        require(lps[msg.sender].spendKey == bytes32(0), "exists");
        if (!_validateEd25519Key(_spendKey)) revert InvalidKey();
        
        lps[msg.sender] = LP({
            spendKey: _spendKey,
            collateral: 0,
            obligation: 0,
            sDAIShares: 0,
            mintFeeBps: _mintFee,
            burnFeeBps: _burnFee,
            lastActive: uint48(block.timestamp),
            timelock: uint48(block.timestamp + 7 days),
            active: true
        });
        
        emit LPRegistered(msg.sender, _spendKey);
    }
    
    /// @notice Deposit DAI collateral
    function depositCollateral(uint256 _amount) external whenNotPaused nonReentrant {
        LP storage l = lps[msg.sender];
        if (!l.active) revert LPInactive();
        
        dai.safeTransferFrom(msg.sender, address(this), _amount);
        
        // Convert to sDAI
        dai.approve(address(sDAI), _amount);
        uint256 shares = sDAI.deposit(_amount, address(this));
        
        l.collateral += _amount;
        l.sDAIShares += shares;
        
        emit CollateralAdded(msg.sender, _amount, shares);
    }
    
    /// @notice Withdraw excess collateral
    function withdrawCollateral(uint256 _amount) external nonReentrant {
        LP storage l = lps[msg.sender];
        if (!l.active) revert LPInactive();
        require(block.timestamp > l.timelock, "timelocked");
        
        uint256 required = (l.obligation * INITIAL_COLLATERAL_BPS) / 10000;
        if (l.collateral - _amount < required) revert Undercollateralized();
        
        l.collateral -= _amount;
        
        // Redeem sDAI
        uint256 sharesToBurn = (_amount * 1e18) / _getSDAIPrice();
        sharesToBurn = Math.min(sharesToBurn, l.sDAIShares);
        l.sDAIShares -= sharesToBurn;
        
        uint256 received = sDAI.redeem(sharesToBurn, msg.sender, address(this));
        
        emit CollateralRemoved(msg.sender, received);
    }

    // ════════════════════════════════════════════════════════════════════════
    // ORACLE VOTING (QUADRATIC WEIGHTED)
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Submit TLS proof for transaction
    function submitVote(
        bytes32 _binding,
        bytes32[2] calldata _txData,
        uint64 _ecdhAmount,
        uint32 _nodeIndex,
        uint256[2] calldata _proofA,
        uint256[2][2] calldata _proofB,
        uint256[2] calldata _proofC,
        uint256[3] calldata _tlsSignals,
        uint256 _blockHeight
    ) external whenNotPaused {
        Oracle storage o = oracles[msg.sender];
        require(o.active, "inactive oracle");
        
        MoneroNode storage node = nodes[_nodeIndex];
        require(node.active, "inactive node");
        
        // Verify confirmations
        require(block.timestamp > _blockHeight * 120 + MONERO_CONFIRMATIONS * 120, "unconfirmed");
        
        // Verify TLS proof
        require(tlsVerifier.verifyProof(_proofA, _proofB, _proofC, _tlsSignals), "bad tls proof");
        require(_tlsSignals[2] == uint256(node.certFingerprint), "cert mismatch");
        
        // Prevent double voting
        if (votes[_binding][msg.sender].oracle != address(0)) revert AlreadyVoted();
        
        // Calculate weight
        uint256 weight = getOracleWeight(msg.sender);
        require(weight > 0, "zero weight");
        
        // Record vote
        votes[_binding][msg.sender] = OracleVote({
            oracle: msg.sender,
            weight: weight,
            timestamp: uint48(block.timestamp),
            valid: true
        });
        voters[_binding].push(msg.sender);
        totalWeight[_binding] += weight;
        
        o.proofsSubmitted++;
        o.lastActive = uint48(block.timestamp);
        
        emit OracleVoteSubmitted(_binding, msg.sender, weight);
        
        // Check consensus
        if (totalWeight[_binding] >= MIN_WEIGHTED_CONSENSUS) {
            emit ConsensusReached(_binding, totalWeight[_binding], voters[_binding].length);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // MINTING
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Mint wXMR with ZK proof
    function mint(
        bytes32 _moneroTxHash,
        bytes32 _binding,
        uint64 _amount,
        uint256[2] calldata _proofA,
        uint256[2][2] calldata _proofB,
        uint256[2] calldata _proofC,
        bytes32[3] calldata _publicData, // R, P, C
        uint64 _ecdhAmount,
        address _lp
    ) external whenNotPaused nonReentrant {
        if (usedTxHashes[_moneroTxHash]) revert TxUsed();
        
        LP storage l = lps[_lp];
        if (!l.active) revert LPInactive();
        
        // Update TWAP
        updateTWAP();
        
        // Check consensus
        if (totalWeight[_binding] < MIN_WEIGHTED_CONSENSUS) revert NoConsensus();
        
        // Verify recipient
        require(_publicData[1] == l.spendKey, "wrong recipient");
        
        // Price check
        uint256 price = getSpotPrice();
        if (_checkDepeg() == 2) revert DepegCritical();
        
        // Collateral check
        uint256 obligationInDAI = (_amount * price) / 1e8;
        uint256 required = (obligationInDAI * INITIAL_COLLATERAL_BPS) / 10000;
        if (l.collateral < required) revert Undercollateralized();
        
        // Verify ZK proof
        uint256[10] memory signals = [
            uint256(_publicData[0]),      // R
            uint256(_publicData[1]),      // P
            uint256(_publicData[2]),      // C
            uint256(_ecdhAmount),
            uint256(l.spendKey),          // B
            uint256(_moneroTxHash),
            uint256(_binding),
            CHAIN_ID,
            uint256(_amount),
            uint256(CIRCUIT_VERSION)
        ];
        
        if (!bridgeVerifier.verifyProof(_proofA, _proofB, _proofC, signals)) {
            revert InvalidProof();
        }
        
        // Update state
        usedTxHashes[_moneroTxHash] = true;
        l.obligation += obligationInDAI;
        l.lastActive = uint48(block.timestamp);
        
        // Reward oracles
        _rewardOracles(_binding);
        
        // Mint
        uint256 fee = (_amount * l.mintFeeBps) / 10000;
        uint256 toMint = _amount - fee;
        
        wXMR.mint(msg.sender, toMint);
        if (fee > 0) wXMR.mint(_lp, fee);
        
        emit Minted(_moneroTxHash, _binding, msg.sender, _amount, _lp);
    }
    
    function _rewardOracles(bytes32 _binding) internal {
        address[] storage v = voters[_binding];
        uint256 total = totalWeight[_binding];
        if (total == 0 || v.length == 0) return;
        
        uint256 pool = _calcRewardPool();
        
        for (uint i = 0; i < v.length; i++) {
            OracleVote storage vote = votes[_binding][v[i]];
            if (vote.valid) {
                Oracle storage o = oracles[vote.oracle];
                uint256 reward = (pool * vote.weight) / total;
                o.rewards += reward;
                o.proofsAccepted++;
                
                // Accuracy recovery (+1% per accepted proof)
                if (o.accuracy < INITIAL_ACCURACY) {
                    o.accuracy = Math.min(o.accuracy + 0.01e18, INITIAL_ACCURACY);
                }
                
                if (reward > 0) wXMR.mint(vote.oracle, reward);
            }
        }
    }
    
    function _calcRewardPool() internal view returns (uint256) {
        uint256 tvl = (sDAI.balanceOf(address(this)) * _getSDAIPrice()) / 1e18;
        uint256 annualYield = (tvl * 5) / 100; // 5% APY assumed
        uint256 oracleShare = (annualYield * ORACLE_REWARD_BPS) / 10000;
        return oracleShare / 1000; // Per-mint (assume 1000 mints/year)
    }

    // ════════════════════════════════════════════════════════════════════════
    // BURNING
    // ════════════════════════════════════════════════════════════════════════
    
    /// @notice Start burn process
    function startBurn(uint256 _amount, address _lp) external nonReentrant {
        if (!lps[_lp].active) revert LPInactive();
        
        wXMR.burn(msg.sender, _amount);
        
        bytes32 id = keccak256(abi.encodePacked(msg.sender, block.timestamp, _amount, _lp));
        burns[id] = Burn({
            user: msg.sender,
            lp: _lp,
            amount: _amount,
            timestamp: uint48(block.timestamp),
            moneroTxHash: bytes32(0),
            completed: false
        });
        
        emit BurnStarted(id, msg.sender, _amount, _lp);
    }
    
    /// @notice LP completes burn
    function completeBurn(bytes32 _id, bytes32 _moneroTxHash) external {
        Burn storage b = burns[_id];
        if (b.completed) revert AlreadyDone();
        if (b.lp != msg.sender) revert NotLP();
        if (block.timestamp > b.timestamp + 72 hours) revert BurnExpired();
        
        b.moneroTxHash = _moneroTxHash;
        b.completed = true;
        
        // Reduce obligation using TWAP
        uint256 twap = getTWAP();
        uint256 reduction = (b.amount * twap) / 1e8;
        
        LP storage l = lps[b.lp];
        l.obligation = l.obligation > reduction ? l.obligation - reduction : 0;
        l.lastActive = uint48(block.timestamp);
        
        emit BurnCompleted(_id, _moneroTxHash);
    }
    
    /// @notice Claim failed burn (after 2 hours)
    function claimBurn(bytes32 _id) external nonReentrant {
        Burn storage b = burns[_id];
        if (b.completed) revert AlreadyDone();
        if (block.timestamp <= b.timestamp + BURN_COUNTDOWN) revert BurnActive();
        
        // Calculate payout at 150% using TWAP
        uint256 twap = getTWAP();
        uint256 value = (b.amount * twap) / 1e8;
        uint256 payout = (value * INITIAL_COLLATERAL_BPS) / 10000;
        
        // Depeg handling
        LP storage l = lps[b.lp];
        if (_checkDepeg() == 2) {
            payout = Math.min(payout, l.collateral);
        }
        
        if (l.collateral < payout) revert Undercollateralized();
        l.collateral -= payout;
        
        // Redeem sDAI
        uint256 shares = (payout * 1e18) / _getSDAIPrice();
        shares = Math.min(shares, l.sDAIShares);
        l.sDAIShares -= shares;
        
        uint256 received = sDAI.redeem(shares, address(this), address(this));
        
        // Slippage check
        uint256 minReceive = (payout * (10000 - MAX_SLIPPAGE_BPS)) / 10000;
        require(received >= minReceive, "slippage");
        
        dai.safeTransfer(b.user, received);
        b.completed = true;
        
        emit BurnClaimed(_id, b.user, received);
    }
---

## **9. Changelog**

| Version | Date | Changes |
|---------|------|---------|
| **v5.4** | 2024-12 | Corrected Pedersen (v·H + γ·G), quadratic oracle weighting, TWAP liquidations, oracle bonding, guardian pause, Keccak binding hash |
| **v5.3** | 2024-11 | N-of-M consensus, removed admin/pause, on-chain node registry |
| **v5.2** | 2024-10 | Fixed ZK witness model |
| **v5.1** | 2024-09 | Instant liquidations |
| **v5.0** | 2024-08 | DAI-only collateral |

---
        
        updateTWAP();
        
        // Use TWAP for liquidation decision
        uint256 twap = getTWAP();
        uint256 xmrValue = (l.obligation * twap) / 1e8;
        
        if (xmrValue == 0) revert NotLiquidatable();
        
        uint256 ratio = (l.collateral * 10000) / xmrValue;
        if (ratio >= LIQUIDATION_THRESHOLD_BPS) revert NotLiquidatable();
        
        l.lastActive = uint48(block.timestamp);
        
        // Seize all sDAI---

## **9. Changelog**

| Version | Date | Changes |
|---------|------|---------|
| **v5.4** | 2024-12 | Corrected Pedersen (v·H + γ·G), quadratic oracle weighting, TWAP liquidations, oracle bonding, guardian pause, Keccak binding hash |
| **v5.3** | 2024-11 | N-of-M consensus, removed admin/pause, on-chain node registry |
| **v5.2** | 2024-10 | Fixed ZK witness model |
| **v5.1** | 2024-09 | Instant liquidations |
| **v5.0** | 2024-08 | DAI-only collateral |

---
        uint256 toTreasury = received - liquidatorCut;
        
        dai.safeTransfer(msg.sender, liquidatorCut);
        dai.safeTransfer(treasury, toTreasury);
        
        emit Liquidated(_lp, msg.sender, received, twap);
        
        // Deactivate
        l.collateral = 0;
        l.obligation = 0;
        l.active = false;
    }

    // ════════════════════════════════════════════════════════════════════════
    // NODE MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════
    
    function addNode(string calldata _url, bytes32 _fingerprint) external {
        if (block.timestamp < lastNodeChange + NODE_CHANGE_COOLDOWN) revert Cooldown();
        require(bytes(_url).length > 0 && _fingerprint != bytes32(0), "invalid");
        
        uint32 idx = nodeCount++;
        nodes[idx] = MoneroNode({
            certFingerprint: _fingerprint,
            url: _url,
            addedAt: uint48(block.timestamp),
            active: true
        });
        lastNodeChange = block.timestamp;
        
        emit NodeAdded(idx, _url, _fingerprint);
    }
    
    function removeNode(uint32 _idx) external {
        if (block.timestamp < lastNodeChange + NODE_CHANGE_COOLDOWN) revert Cooldown();
        require(nodes[_idx].active, "inactive");
        
        nodes[_idx].active = false;
        lastNodeChange = block.timestamp;
        
        emit NodeRemoved(_idx);
    }

    // ════════════════════════════════════════════════════════════════════════
    // INTERNAL HELPERS
    // ════════════════════════════════════════════════════════════════════════
    
    function _getSDAIPrice() internal view returns (uint256) {
        return sDAI.previewRedeem(1e18);
    }
    
    function _validateEd25519Key(bytes32 _key) internal pure returns (bool) {
        if (_key == bytes32(0)) return false;
        // Basic validation - production should use full curve check
        uint256 y = uint256(_key) & ((1 << 255) - 1);
        uint256 p = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed;
        return y < p;
    }
    
    function _checkDepeg() internal view returns (uint256) {
        (, int256 price,,,) = priceFeedDAI.latestRoundData();
        if (price < 0.95e8) return 2; // Critical
        if (price < 0.98e8) return 1; // Warning
        return 0;
    }
    
    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════
    
    function getLP(address _lp) external view returns (LP memory) {
        return lps[_lp];
    }
    
    function getOracle(address _oracle) external view returns (Oracle memory) {
        return oracles[_oracle];
    }
    
    function getConsensus(bytes32 _binding) external view returns (uint256 weight, uint256 count, bool reached) {
        weight = totalWeight[_binding];
        count = voters[_binding].length;
        reached = weight >= MIN_WEIGHTED_CONSENSUS;
    }
    
    function getHealthFactor(address _lp) external view returns (uint256) {
        LP storage l = lps[_lp];
        if (!l.active || l.obligation == 0) return type(uint256).max;
        
        uint256 twap = getTWAP();
        uint256 xmrValue = (l.obligation * twap) / 1e8;
        
        return (l.collateral * 1e18 * 10000) / (xmrValue * LIQUIDATION_THRESHOLD_BPS);
    }
}
```

---

## **4. Economic Model**

### **4.1 LP Position Example**

```
User deposits: 10 XMR @ $150 = $1,500 value
LP required collateral: $1,500 × 1.50 = $2,250 DAI

LP posts: 2,250 DAI → ~2,180 sDAI (at 1.032 price)
Yield: 5% APY on sDAI = $112.50/year
├─ Oracle reward pool: $2.25/year (2% of yield)
└─ LP net yield: $110.25/year (~4.9% APY)
```

### **4.2 Collateralization Tiers**

| Tier | Ratio | Status | Actions |
|------|-------|--------|---------|
| **Healthy** | ≥150% | ✅ Normal | All operations |
| **Warning** | 120-150% | ⚠️ At risk | Cannot mint more |
| **Liquidatable** | <120% | 🔴 TWAP-verified | Open to liquidation |
| **Critical** | <105% | 🚨 Emergency | Priority liquidation |

### **4.3 Oracle Quadratic Weighting**

**Formula:** `weight = sqrt(accuracy × experienceMultiplier)`

Where `experienceMultiplier = 1 + min(proofsSubmitted / 10, 2)`

| Oracle State | Accuracy | Proofs | Experience | Combined | Weight |
|--------------|----------|--------|------------|----------|--------|
| **New** | 100% | 0 | 1.0× | 1.00 | 1.00 |
| **Active** | 100% | 20 | 1.2× | 1.20 | 1.10 |
| **Experienced** | 100% | 50 | 1.5× | 1.50 | 1.22 |
| **Veteran** | 100% | 100+ | 2.0× | 2.00 | 1.41 |
| **Slashed 1×** | 75% | 100+ | 2.0× | 1.50 | 1.22 |
| **Slashed 2×** | 50% | 100+ | 2.0× | 1.00 | 1.00 |
| **Slashed 3×** | 25% | 100+ | 2.0× | 0.50 | 0.71 |
| **Slashed 4×** | 0% | 100+ | 2.0× | 0.00 | 0.00 |

**Minimum consensus:** 3.0 weighted votes

**Example consensus scenarios:**
- 3 new oracles: 1.0 + 1.0 + 1.0 = 3.0 ✅
- 2 veterans + 1 new: 1.41 + 1.41 + 1.0 = 3.82 ✅
- 2 new oracles: 1.0 + 1.0 = 2.0 ❌
- 1 veteran + 1 slashed-2×: 1.41 + 1.0 = 2.41 ❌

### **4.4 TWAP Configuration**

| Parameter | Value | Purpose |
|-----------|-------|---------|
| **Period** | 15 minutes | Manipulation resistance |
| **Observations** | 15 | ~1 min granularity |
| **Min Update Interval** | 60 seconds | Prevent spam |
| **Fallback** | Spot price | If insufficient data |

---

## **5. Performance Targets**

### **5.1 Proving Times**

| Environment | Time | Memory | Notes |
|-------------|------|--------|-------|
| **Browser (WASM)** | 2.0-2.8s | ~1.0 GB | snarkjs optimized |
| **Browser (WebGPU)** | 1.4-2.0s | ~600 MB | Chrome 120+ |
| **Native (rapidsnark)** | 0.5-0.8s | ~500 MB | 8-core CPU |
| **Mobile (iOS)** | 3.5-4.5s | ~1.2 GB | iPhone 15 Pro |

### **5.2 Gas Costs (Arbitrum)**

| Function | Gas | L1 Data | Cost @ 30 gwei |
|----------|-----|---------|----------------|
| `registerOracle` | 180k | 2.5kb | ~$0.35 |
| `submitVote` | 680k | 4.5kb | ~$1.18 |
| `mint` | **920k** | 10.2kb | ~$1.45 |
| `startBurn` | 98k | 1.5kb | ~$0.20 |
| `completeBurn` | 145k | 2.8kb | ~$0.28 |
| `claimBurn` | 580k | 3.2kb | ~$0.85 |
| `liquidate` | **520k** | 2.6kb | ~$0.78 |
| `updateTWAP` | 65k | 0.8kb | ~$0.12 |

---

## **6. Security Analysis**

### **6.1 Attack Cost Matrix**

| Attack | Requirements | Cost | Outcome |
|--------|--------------|------|---------|
| **3 Sybil Oracles** | 3× 1,000 DAI bonds | 3,000 DAI | Slashed if detected |
| **TWAP Manipulation** | 15-min sustained | Arbitrage losses | Economically infeasible |
| **Flash Loan Liquidation** | Flash loan + oracle | — | Blocked by TWAP |
| **Oracle Majority** | >50% weighted votes | Variable | Degraded influence via slashing |
| **Circuit Bug Exploit** | Zero-day | — | Guardian pause available |

### **6.2 Trust Assumptions**

1. **Chainlink**: Trusted for spot prices; TWAP provides resistance
2. **3+ Honest Oracles**: Required for consensus
3. **Guardian Key**: Can only pause mints; 30-day unpause delay
4. **Circuit Correctness**: Pre-mainnet audits required
5. **Monero Nodes**: N-of-M with TLS pinning

---

## **7. Sequence Diagrams**

### **7.1 Mint Flow**

```
User                Frontend            Oracles (3)         Contract
 │                     │                    │                  │
 ├─ Export r, tx_hash ─►                    │                  │
 │                     │                    │                  │
 │◄─── Fetch tx data ──┤                    │                  │
 │                     │                    │                  │
 │                     ├─ Generate binding ─►                  │
 │                     │   hash (Keccak)    │                  │
 │                     │                    │                  │
 │                     ├─ Generate ZK proof─►                  │
 │                     │   (2.0s)           │                  │
 │                     │                    │                  │
 │                     │                    ├── submitVote ───►│
 │                     │                    │   (weight: 1.0)  │
 │                     │                    ├── submitVote ───►│
 │                     │                    │   (weight: 1.22) │
 │                     │                    ├── submitVote ───►│
 │                     │                    │   (weight: 1.41) │
 │                     │                    │                  │
 │                     │                    │◄── Consensus ────┤
 │                     │                    │    (3.63 ≥ 3.0)  │
 │                     │                    │                  │
 │                     ├────── mint() ─────────────────────────►
 │                     │                                       │
 │◄─────────────────── wXMR ──────────────────────────────────┤
```

### **7.2 Liquidation Flow**

```
Liquidator            Contract              TWAP
    │                    │                   │
    ├─── liquidate() ───►│                   │
    │                    ├── updateTWAP() ──►│
    │                    │◄── 15-min avg ───┤
    │                    │                   │
    │                    ├── Check ratio     │
    │                    │   (< 120%)        │
    │                    │                   │
    │                    ├── Seize sDAI      │
    │                    ├── Redeem DAI      │
    │                    │                   │
    │◄── 5% reward ──────┤                   │
    │    (DAI)           │                   │
    │                    ├── 95% to treasury │
```

---

## **8. Deployment Checklist**

### **8.1 Pre-Mainnet Requirements**

- [ ] Circuit formal verification (Ecne/Picus)
- [ ] Groth16 trusted setup ceremony (100+ participants)
- [ ] Trail of Bits audit (contracts + circuits)
- [ ] Ed25519 Solidity library audit
- [ ] Monero wallet integration (`get_tx_key` PR merged)
- [ ] Chainlink wXMR/USD feed approved
- [ ] Guardian multisig setup (3-of-5)
- [ ] Initial node set deployment (5 nodes minimum)


## **10. License & Disclaimer**

**License:** MIT (Circom), GPL-3.0 (Solidity)

This is experimental cryptographic software. Trusted setup ceremony and security audits pending before mainnet deployment.

---

*Document Version: 5.4.0*
*Last Updated: December 2024*
*Authors: FUNGERBIL Team*
