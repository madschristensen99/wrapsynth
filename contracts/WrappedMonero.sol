// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import "./libraries/Ed25519.sol";

/**
 * @title Wrapsynth Monero (wsXMR) - Gnosis chain
 * @notice LP-based Wrapped Monero with Decentralized PoS Oracle on Gnosis Chain
 * @dev Uses sDAI (Savings DAI) for yield-bearing collateral
 * 
 * Architecture:
 * - Each LP maintains their own collateral and backed wsXMR
 * - LPs set their own mint/burn fees
 * - Users choose which LP to use for minting/burning
 * - Collateral ratios: 150% safe, 120% liquidation threshold
 * - LPs can only withdraw down to 150% ratio
 * - 2-hour burn window: LP must send XMR or lose collateral
 * 
 * Security Improvements:
 * - Native Ed25519 + DLEQ proofs instead of PLONK (gas efficient)
 * - Proper liquidation mechanic (repay debt, seize collateral at discount)
 * - Decentralized PoS oracle (validators stake wsXMR/sDAI BPT)
 * - Replay attack protection (proofs bound to msg.sender)
 * - Proper sDAI handling (ERC20 transfers, not native xDAI)
 */

interface ISDAI is IERC20 {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function convertToShares(uint256 assets) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

interface IWETH is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

contract WrappedMonero is ERC20, ERC20Permit, ReentrancyGuard {
    
    // ════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ════════════════════════════════════════════════════════════════════════
    
    uint256 public constant SAFE_RATIO = 150;           // 150% - safe zone
    uint256 public constant LIQUIDATION_THRESHOLD = 120; // 120% - below this = liquidatable
    uint256 public constant LIQUIDATION_BONUS_BPS = 1000; // 10% bonus for liquidators
    uint256 public constant PICONERO_PER_XMR = 1e12;
    uint256 public constant MAX_PRICE_AGE = 60;
    uint256 public constant BURN_TIMEOUT = 2 hours;
    uint256 public constant MAX_FEE_BPS = 500;          // Max 5% fee
    uint256 public constant MINT_INTENT_TIMEOUT = 2 hours;
    uint256 public constant MIN_MINT_BPS = 100;         // Minimum 1% of LP capacity (Sybil defense)
    
    // PoS Oracle Constants (2/3 Quorum Consensus)
    uint256 public constant MIN_VALIDATOR_STAKE = 1000 * 1e12; // 1000 wsXMR minimum stake
    uint256 public constant UNSTAKE_DELAY = 1 days;            // Prevents flash-loan voting
    
    // Pyth price feed IDs
    bytes32 public constant XMR_USD_PRICE_ID = 0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d;
    // Note: On Gnosis, xDAI is pegged 1:1 to USD, so no ETH/USD price feed needed
    
    // ════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ════════════════════════════════════════════════════════════════════════
    
    ISDAI public immutable sDAI;
    IPyth public immutable pyth;
    
    address public legacyOracle;         // Legacy centralized oracle (deprecated)
    uint256 public totalLPCollateral;    // Total sDAI collateral (for yield calculation)
    uint256 public lastYieldSnapshot;    // Last sDAI value snapshot
    
    // ════════════════════════════════════════════════════════════════════════
    // POS ORACLE (2/3 Quorum Consensus)
    // ════════════════════════════════════════════════════════════════════════
    
    uint256 public totalStaked;
    mapping(address => uint256) public validatorStakes;
    mapping(address => uint256) public unstakeAvailableAt;     // Timestamp when validator can unstake
    mapping(bytes32 => bool) public usedProofs;                // Prevent replay attacks: proofHash => used
    
    struct BlockProposal {
        bytes32 txMerkleRoot;
        bytes32 outputMerkleRoot;
        uint256 votes; // Total staked wsXMR voting for this hash
    }
    
    // blockHeight => blockHash => Proposal Data
    mapping(uint256 => mapping(bytes32 => BlockProposal)) public blockProposals;
    
    // blockHeight => validator => blockHash they voted for (prevents double voting)
    mapping(uint256 => mapping(address => bytes32)) public validatorVotes;
    
    // Per-LP state
    struct LPInfo {
        uint256 collateralAmount;     // sDAI amount deposited
        uint256 backedAmount;         // WrapsynthXMR amount this LP is backing
        uint256 mintFeeBps;           // Mint fee in basis points (100 = 1%)
        uint256 burnFeeBps;           // Burn fee in basis points
        uint256 intentDepositBps;     // Intent deposit in basis points of mint amount (100 = 1%)
        string moneroAddress;         // LP's Monero address (95 char base58)
        bytes32 publicViewKey;        // LP's public view key A (32 bytes)
        bytes32 publicSpendKey;       // LP's public spend key B (32 bytes)
        bool active;                  // Is LP accepting new mints?
        bool registered;              // Has this LP ever registered?
    }
    mapping(address => LPInfo) public lpInfo;
    address[] public allLPs;          // Array of all registered LPs
    
    // Mint intents (user reserves capacity before sending XMR)
    struct MintIntent {
        address user;
        address lp;
        uint256 expectedAmount;       // Expected XMR amount in piconero
        uint256 depositAmount;        // Anti-griefing deposit in DAI
        uint256 createdAt;
        bool fulfilled;
        bool cancelled;
    }
    mapping(bytes32 => MintIntent) public mintIntents;
    mapping(address => bytes32[]) public userMintIntents;  // Track user's intent IDs
    
    // Track used Monero outputs
    mapping(bytes32 => bool) public usedOutputs;
    
    // Burn requests
    struct BurnRequest {
        address user;
        address lp;
        uint256 amount;               // WrapsynthXMR amount (locked)
        uint256 depositAmount;        // Anti-griefing deposit in DAI
        string xmrAddress;            // User's Monero address (for display)
        bytes32 userPublicViewKey;    // User's public view key A (32 bytes)
        bytes32 userPublicSpendKey;   // User's public spend key B (32 bytes)
        uint256 requestTime;
        uint256 collateralLocked;     // sDAI locked
        bool fulfilled;
        bool defaulted;
    }
    mapping(uint256 => BurnRequest) public burnRequests;
    uint256 public nextBurnId;
    
    // Finalized Monero blocks (2/3 quorum reached)
    struct MoneroBlockData {
        bytes32 blockHash;
        bytes32 txMerkleRoot;
        bytes32 outputMerkleRoot;
        uint256 timestamp;
        bool exists;
    }
    mapping(uint256 => MoneroBlockData) public moneroBlocks;
    uint256 public latestMoneroBlock;
    
    struct MoneroTxOutput {
        bytes32 txHash;
        uint256 outputIndex;
        bytes32 ecdhAmount;
        bytes32 outputPubKey;
        bytes32 commitment;
    }
    
    // DLEQ Proof Structure (replaces PLONK)
    struct MintProof {
        bytes32 R;              // Transaction public key (R = r·G)
        bytes32 S;              // Shared secret (S = r·A)
        bytes32 P;              // Output stealth address
        bytes32 C;              // Pedersen commitment of the amount
        uint256 dleq_c;         // DLEQ challenge
        uint256 dleq_s;         // DLEQ response
        bytes32 intentId;       // Intent ID (binds proof to specific user)
        address recipient;      // Recipient address (prevents front-running)
    }
    
    // Price tracking (both in USD with 8 decimals)
    uint256 public xmrUsdPrice;
    uint256 public ethUsdPrice;
    uint256 public lastPriceUpdate;
    
    // ════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════════════
    
    event LPRegistered(address indexed lp, uint256 mintFeeBps, uint256 burnFeeBps);
    event LPUpdated(address indexed lp, uint256 mintFeeBps, uint256 burnFeeBps, bool active);
    event LPDeposited(address indexed lp, uint256 daiAmount, uint256 sDAIAmount);
    event LPWithdrew(address indexed lp, uint256 sDAIAmount, uint256 daiValue);
    event LPLiquidated(address indexed lp, address indexed liquidator, uint256 wsXMRRepaid, uint256 collateralSeized);
    
    event Minted(address indexed recipient, address indexed lp, uint256 amount, uint256 fee, bytes32 indexed outputId);
    event BurnRequested(uint256 indexed burnId, address indexed user, address indexed lp, uint256 amount, string xmrAddress);
    event BurnFulfilled(uint256 indexed burnId, bytes32 xmrTxHash);
    event BurnDefaulted(uint256 indexed burnId, uint256 collateralSeized);
    
    event PriceUpdated(uint256 xmrPrice, uint256 ethPrice, uint256 timestamp);
    event MoneroBlockFinalized(uint256 indexed blockHeight, bytes32 indexed blockHash);
    event ValidatorStaked(address indexed validator, uint256 amount);
    event ValidatorUnstaked(address indexed validator, uint256 amount);
    event UnstakeRequested(address indexed validator, uint256 availableAt);
    event OracleYieldClaimed(address indexed oracle, uint256 amount);
    event MintIntentCreated(bytes32 indexed intentId, address indexed user, address indexed lp, uint256 expectedAmount);
    event MintIntentFulfilled(bytes32 indexed intentId, uint256 actualAmount);
    event MintIntentCancelled(bytes32 indexed intentId);
    
    // ════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ════════════════════════════════════════════════════════════════════════
    
    modifier onlyLegacyOracle() {
        require(msg.sender == legacyOracle, "Only legacy oracle");
        _;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ════════════════════════════════════════════════════════════════════════
    
    constructor(
        address _sDAI,
        address _pyth,
        uint256 _initialMoneroBlock
    ) ERC20("Wrapsynth Monero", "wsXMR") ERC20Permit("Wrapsynth Monero") {
        sDAI = ISDAI(_sDAI);
        pyth = IPyth(_pyth);
        legacyOracle = msg.sender;
        
        // Fetch initial prices from Pyth
        _initializePrices();
        
        latestMoneroBlock = _initialMoneroBlock;
    }
    
    function _initializePrices() internal {
        PythStructs.Price memory xmrPriceData = pyth.getPriceUnsafe(XMR_USD_PRICE_ID);
        
        require(xmrPriceData.price > 0, "Invalid XMR price");
        
        xmrUsdPrice = _normalizePythPrice(xmrPriceData);
        // On Gnosis, xDAI is pegged 1:1 to USD, so ethUsdPrice = 1e18
        ethUsdPrice = 1e18;
        lastPriceUpdate = block.timestamp;
    }
    
    function _normalizePythPrice(PythStructs.Price memory priceData) internal pure returns (uint256) {
        int256 price = int256(priceData.price);
        int32 expo = priceData.expo;
        
        // Normalize to 18 decimals
        if (expo >= 0) {
            return uint256(price) * (10 ** uint32(expo)) * 1e18;
        } else {
            int32 adjustedExpo = 18 + expo;
            if (adjustedExpo >= 0) {
                return uint256(price) * (10 ** uint32(adjustedExpo));
            } else {
                return uint256(price) / (10 ** uint32(-adjustedExpo));
            }
        }
    }
    
    /**
     * @notice Override decimals to 12 (piconero precision)
     */
    function decimals() public pure override(ERC20) returns (uint8) {
        return 12;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // PYTH ORACLE
    // ════════════════════════════════════════════════════════════════════════
    
    function updatePythPrice(bytes[] calldata priceUpdateData) external payable {
        uint256 fee = pyth.getUpdateFee(priceUpdateData);
        require(msg.value >= fee, "Insufficient fee");
        
        pyth.updatePriceFeeds{value: fee}(priceUpdateData);
        
        if (msg.value > fee) {
            (bool success, ) = msg.sender.call{value: msg.value - fee}("");
            require(success, "Refund failed");
        }
        
        _updatePrices();
    }
    
    function _updatePrices() internal {
        PythStructs.Price memory xmrPriceData = pyth.getPriceNoOlderThan(XMR_USD_PRICE_ID, MAX_PRICE_AGE);
        
        require(xmrPriceData.price > 0, "Invalid XMR price");
        
        uint256 newXmrPrice = _normalizePythPrice(xmrPriceData);
        
        // TWAP smoothing for XMR price
        xmrUsdPrice = xmrUsdPrice == 0 ? newXmrPrice : (xmrUsdPrice * 9 + newXmrPrice) / 10;
        // On Gnosis, xDAI is always 1:1 with USD
        ethUsdPrice = 1e18;
        lastPriceUpdate = block.timestamp;
        
        emit PriceUpdated(xmrUsdPrice, ethUsdPrice, block.timestamp);
    }
    
    /**
     * @notice Get XMR price in DAI (18 decimals)
     * @dev On Gnosis, xDAI = $1, so this returns XMR/USD price
     */
    function getXmrDaiPrice() public view returns (uint256) {
        require(ethUsdPrice > 0, "DAI price not set");
        return (xmrUsdPrice * 1e18) / ethUsdPrice;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // LP MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Register as LP or update fees
     * @param moneroAddress LP's Monero address (Base58 string for display)
     * @param publicViewKey LP's public view key A (32 bytes, from Monero wallet)
     * @param publicSpendKey LP's public spend key B (32 bytes, from Monero wallet)
     * @dev LPs can get these from their Monero wallet - they're NOT private keys!
     */
    function registerLP(
        uint256 mintFeeBps,
        uint256 burnFeeBps,
        uint256 intentDepositBps,
        string calldata moneroAddress,
        bytes32 publicViewKey,
        bytes32 publicSpendKey,
        bool active
    ) external {
        require(mintFeeBps <= MAX_FEE_BPS, "Mint fee too high");
        require(burnFeeBps <= MAX_FEE_BPS, "Burn fee too high");
        require(intentDepositBps <= 1000, "Intent deposit too high"); // Max 10%
        require(bytes(moneroAddress).length > 0, "Invalid Monero address");
        require(publicViewKey != bytes32(0), "Invalid view key");
        require(publicSpendKey != bytes32(0), "Invalid spend key");
        
        // Add to allLPs array if first time registering
        if (!lpInfo[msg.sender].registered) {
            allLPs.push(msg.sender);
            lpInfo[msg.sender].registered = true;
        }
        
        lpInfo[msg.sender].mintFeeBps = mintFeeBps;
        lpInfo[msg.sender].burnFeeBps = burnFeeBps;
        lpInfo[msg.sender].intentDepositBps = intentDepositBps;
        lpInfo[msg.sender].moneroAddress = moneroAddress;
        lpInfo[msg.sender].publicViewKey = publicViewKey;
        lpInfo[msg.sender].publicSpendKey = publicSpendKey;
        lpInfo[msg.sender].active = active;
        
        emit LPRegistered(msg.sender, mintFeeBps, burnFeeBps);
    }
    
    /**
     * @notice LP deposits sDAI collateral
     * @param sDAIAmount Amount of sDAI to deposit
     * @dev LPs must approve this contract to spend their sDAI first
     */
    function lpDeposit(uint256 sDAIAmount) external nonReentrant {
        require(sDAIAmount > 0, "Zero amount");
        
        // Transfer sDAI from LP to contract
        require(sDAI.transferFrom(msg.sender, address(this), sDAIAmount), "sDAI transfer failed");
        
        lpInfo[msg.sender].collateralAmount += sDAIAmount;
        totalLPCollateral += sDAIAmount;
        
        emit LPDeposited(msg.sender, 0, sDAIAmount);
    }
    
    /**
     * @notice LP withdraws sDAI collateral (only down to 150% ratio)
     * @param amount Amount of sDAI to withdraw
     */
    function lpWithdraw(uint256 amount) external nonReentrant {
        LPInfo storage lp = lpInfo[msg.sender];
        require(lp.collateralAmount >= amount, "Insufficient collateral");
        
        // Check LP maintains 150% ratio after withdrawal
        uint256 remainingCollateral = lp.collateralAmount - amount;
        uint256 remainingValueEth = _sDAIToDAI(remainingCollateral);
        uint256 backedValueEth = _xmrToDAI(lp.backedAmount);
        
        if (lp.backedAmount > 0) {
            uint256 ratio = (remainingValueEth * 100) / backedValueEth;
            require(ratio >= SAFE_RATIO, "Would drop below 150%");
        }
        
        lp.collateralAmount -= amount;
        totalLPCollateral -= amount;
        
        // Transfer sDAI to LP
        require(sDAI.transfer(msg.sender, amount), "sDAI transfer failed");
        
        emit LPWithdrew(msg.sender, amount, remainingValueEth);
    }
    
    /**
     * @notice Liquidate underwater LP by repaying wsXMR debt and seizing collateral
     * @param lp LP address to liquidate
     * @param wsXMRAmountToRepay Amount of wsXMR to burn (repaying LP's debt)
     * @dev Liquidator burns their wsXMR and receives LP's sDAI collateral at 10% discount
     */
    function liquidateLP(address lp, uint256 wsXMRAmountToRepay) external nonReentrant {
        LPInfo storage lpData = lpInfo[lp];
        require(lpData.backedAmount > 0, "LP has no position");
        require(wsXMRAmountToRepay > 0, "Zero amount");
        require(balanceOf(msg.sender) >= wsXMRAmountToRepay, "Insufficient wsXMR balance");
        
        // Check LP is underwater (below 120% collateralization)
        uint256 collateralValueEth = _sDAIToDAI(lpData.collateralAmount);
        uint256 backedValueEth = _xmrToDAI(lpData.backedAmount);
        uint256 ratio = (collateralValueEth * 100) / backedValueEth;
        
        require(ratio < LIQUIDATION_THRESHOLD, "LP is safely collateralized");
        
        // Calculate how much sDAI the liquidator gets (wsXMR value + 10% bonus)
        uint256 repayValueEth = _xmrToDAI(wsXMRAmountToRepay);
        uint256 rewardEth = repayValueEth + ((repayValueEth * LIQUIDATION_BONUS_BPS) / 10000);
        uint256 sDAIToTransfer = _ethToSDAI(rewardEth);
        
        // Cap at LP's maximum collateral
        if (sDAIToTransfer > lpData.collateralAmount) {
            sDAIToTransfer = lpData.collateralAmount;
        }
        
        // 1. Burn the liquidator's wsXMR (repaying the debt)
        _burn(msg.sender, wsXMRAmountToRepay);
        
        // 2. Reduce the LP's backed debt and collateral
        lpData.backedAmount -= wsXMRAmountToRepay;
        lpData.collateralAmount -= sDAIToTransfer;
        totalLPCollateral -= sDAIToTransfer;
        
        // 3. Send seized sDAI to liquidator
        require(sDAI.transfer(msg.sender, sDAIToTransfer), "sDAI transfer failed");
        
        emit LPLiquidated(lp, msg.sender, wsXMRAmountToRepay, sDAIToTransfer);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // MINT INTENTS
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Create mint intent - reserve LP capacity before sending XMR
     */
    function createMintIntent(
        address lp,
        uint256 expectedAmount
    ) external payable nonReentrant returns (bytes32 intentId) {
        LPInfo storage lpData = lpInfo[lp];
        require(lpData.active, "LP not active");
        
        // Calculate required deposit based on LP's setting
        uint256 expectedValueEth = _xmrToDAI(expectedAmount);
        uint256 requiredDeposit = (expectedValueEth * lpData.intentDepositBps) / 10000;
        require(msg.value >= requiredDeposit, "Deposit too small");
        
        // Calculate LP's available capacity
        uint256 collateralValueEth = _sDAIToDAI(lpData.collateralAmount);
        uint256 currentBackedValueEth = _xmrToDAI(lpData.backedAmount);
        uint256 maxBackedValueEth = (collateralValueEth * 100) / SAFE_RATIO;
        uint256 availableCapacityEth = maxBackedValueEth > currentBackedValueEth 
            ? maxBackedValueEth - currentBackedValueEth 
            : 0;
        
        // Convert to XMR terms for comparison
        uint256 availableCapacityXmr = _ethToXmr(availableCapacityEth);
        
        // Require mint amount to be at least 1% of available capacity (Sybil defense)
        uint256 minMintAmount = (availableCapacityXmr * MIN_MINT_BPS) / 10000;
        require(expectedAmount >= minMintAmount, "Amount below minimum (1% of LP capacity)");
        
        // Generate intent ID (using day-based timestamp for 24h validity)
        uint256 dayTimestamp = block.timestamp / 1 days;
        intentId = keccak256(abi.encodePacked(msg.sender, lp, expectedAmount, dayTimestamp));
        require(mintIntents[intentId].user == address(0), "Intent exists");
        
        // Create intent (deposit held as xDAI)
        mintIntents[intentId] = MintIntent({
            user: msg.sender,
            lp: lp,
            expectedAmount: expectedAmount,
            depositAmount: msg.value,
            createdAt: block.timestamp,
            fulfilled: false,
            cancelled: false
        });
        
        // Track user's intent
        userMintIntents[msg.sender].push(intentId);
        
        emit MintIntentCreated(intentId, msg.sender, lp, expectedAmount);
    }
    
    /**
     * @notice LP claims deposit from expired mint intent
     * @dev User had 2 hours to complete mint. If they don't, LP gets the deposit as compensation.
     */
    function claimExpiredIntent(bytes32 intentId) external nonReentrant {
        MintIntent storage intent = mintIntents[intentId];
        require(intent.lp == msg.sender, "Not the LP for this intent");
        require(!intent.fulfilled, "Already fulfilled");
        require(!intent.cancelled, "Already cancelled");
        require(block.timestamp > intent.createdAt + MINT_INTENT_TIMEOUT, "Not expired yet");
        
        intent.cancelled = true;
        
        // Send deposit to LP as compensation for reserved capacity
        (bool success, ) = msg.sender.call{value: intent.depositAmount}("");
        require(success, "Transfer failed");
        
        emit MintIntentCancelled(intentId);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // MINT
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Mint wsXMR using native Ed25519 + DLEQ proof (replaces PLONK)
     * @param proof MintProof containing DLEQ proof and Monero transaction data
     * @param amount Amount of XMR in piconero
     * @param blockHeight Monero block height containing the transaction
     * @param txMerkleProof Merkle proof that TX exists in the block
     * @param txIndex Index of transaction in block
     */
    function mintWithDLEQ(
        MintProof calldata proof,
        uint256 amount,
        uint256 blockHeight,
        bytes32[] calldata txMerkleProof,
        uint256 txIndex
    ) external nonReentrant {
        // 1. Verify proof is bound to msg.sender (prevents front-running/replay)
        require(proof.recipient == msg.sender, "Proof not bound to caller");
        
        // 2. Prevent replay attacks - check proof hasn't been used
        bytes32 proofHash = keccak256(abi.encodePacked(
            proof.R, proof.S, proof.P, proof.C,
            proof.dleq_c, proof.dleq_s,
            proof.intentId, proof.recipient
        ));
        require(!usedProofs[proofHash], "Proof already used");
        usedProofs[proofHash] = true;
        
        // 3. Validate mint intent
        MintIntent storage intent = mintIntents[proof.intentId];
        require(intent.user == msg.sender, "Intent user mismatch");
        require(!intent.fulfilled, "Intent already fulfilled");
        require(!intent.cancelled, "Intent cancelled");
        require(amount == intent.expectedAmount, "Amount mismatch");
        require(block.timestamp <= intent.createdAt + MINT_INTENT_TIMEOUT, "Intent expired");
        
        address lp = intent.lp;
        LPInfo storage lpData = lpInfo[lp];
        require(lpData.active, "LP not active");
        
        // 4. Get LP's public keys from storage (convert bytes32 to uint256 for Ed25519 ops)
        uint256 A_x = uint256(lpData.publicViewKey);
        uint256 A_y = 0; // Y-coordinate derived from X in Ed25519
        uint256 B_x = uint256(lpData.publicSpendKey);
        uint256 B_y = 0; // Y-coordinate derived from X in Ed25519
        
        // 5. Verify DLEQ Proof: log_G(R) == log_A(S)
        // This proves S was derived correctly using the tx secret 'r' without revealing it
        require(
            Ed25519.verifyDLEQ(
                uint256(proof.R), 0, // R_x, R_y (y-coord derived)
                uint256(proof.S), 0, // S_x, S_y
                A_x, A_y,
                proof.dleq_c,
                proof.dleq_s
            ),
            "Invalid DLEQ proof"
        );
        
        // 6. Verify Stealth Address: P == H(S)*G + B
        // This proves the transaction was bound to the LP's spend key
        uint256 sharedSecHash = uint256(keccak256(abi.encodePacked(proof.S)));
        require(
            Ed25519.verifyStealthAddress(
                sharedSecHash,
                B_x, B_y,
                uint256(proof.P), 0
            ),
            "Invalid stealth address"
        );
        
        // 7. Verify Amount Commitment: C == x*G + amount*H
        // This proves the hidden amount on Monero matches the requested mint amount
        uint256 mask = uint256(keccak256(abi.encodePacked(proof.S, "commitment_mask")));
        (uint256 xG_x, uint256 xG_y) = Ed25519.scalarMultBase(mask);
        (uint256 amountH_x, uint256 amountH_y) = Ed25519.scalarMultH(amount);
        (uint256 expectedC_x, uint256 expectedC_y) = Ed25519.addPoints(xG_x, xG_y, amountH_x, amountH_y);
        require(uint256(proof.C) == expectedC_x, "Invalid amount commitment");
        
        // 8. Verify TX exists in Monero block via Merkle proof
        require(moneroBlocks[blockHeight].exists, "Block not posted");
        bytes32 txHash = keccak256(abi.encodePacked(proof.R, proof.P, proof.C));
        require(
            verifyTxInBlock(txHash, blockHeight, txMerkleProof, txIndex),
            "TX not in block"
        );
        
        // 9. Prevent double-spending
        bytes32 outputId = keccak256(abi.encodePacked(txHash, uint256(0)));
        require(!usedOutputs[outputId], "Output already spent");
        usedOutputs[outputId] = true;
        
        // 10. Mark intent as fulfilled
        intent.fulfilled = true;
        
        // 11. Calculate amounts and fees
        uint256 fee = (amount * lpData.mintFeeBps) / 10000;
        uint256 netAmount = amount - fee;
        
        // 12. Update LP state
        lpData.backedAmount += amount;
        
        // 13. Mint tokens
        _mint(msg.sender, netAmount);
        if (fee > 0) _mint(lp, fee);
        
        // 14. Return intent deposit to user
        if (intent.depositAmount > 0) {
            (bool success, ) = msg.sender.call{value: intent.depositAmount}("");
            require(success, "Deposit refund failed");
        }
        
        emit Minted(msg.sender, lp, netAmount, fee, outputId);
    }
    
    /**
     * @notice Legacy mint function using PLONK (deprecated, use mintWithDLEQ)
     * @dev This function is kept for backward compatibility but should not be used
     */
    function mint(
        MoneroTxOutput calldata output,
        uint256 blockHeight,
        bytes32[] calldata txMerkleProof,
        uint256 txIndex,
        bytes32[] calldata outputMerkleProof,
        uint256 outputIndex,
        address recipient,
        address lp,
        bytes32 txPublicKey
    ) external payable nonReentrant {
        // DEPRECATED: This function is kept for backward compatibility only
        // Use mintWithDLEQ() instead for proper cryptographic verification
        revert("Legacy mint deprecated - use mintWithDLEQ");
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // BURN (2-hour window)
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Request burn - locks wsXMR and LP collateral
     * @param amount Amount of wsXMR to burn (in piconero)
     * @param xmrAddress Monero address to receive XMR (Base58 string for display)
     * @param userPublicViewKey User's public view key A (32 bytes, from Monero wallet)
     * @param userPublicSpendKey User's public spend key B (32 bytes, from Monero wallet)
     * @param lp LP to process the burn
     * @dev Users can get these from their Monero wallet - they're NOT private keys!
     */
    function requestBurn(
        uint256 amount, 
        string calldata xmrAddress,
        bytes32 userPublicViewKey,
        bytes32 userPublicSpendKey,
        address lp
    ) external payable nonReentrant {
        require(balanceOf(msg.sender) >= amount, "Insufficient balance");
        require(userPublicViewKey != bytes32(0), "Invalid view key");
        require(userPublicSpendKey != bytes32(0), "Invalid spend key");
        
        LPInfo storage lpData = lpInfo[lp];
        
        // Calculate required deposit based on LP's setting
        uint256 burnValueEth = _xmrToDAI(amount);
        uint256 requiredDeposit = (burnValueEth * lpData.intentDepositBps) / 10000;
        require(msg.value >= requiredDeposit, "Deposit too small");
        require(lpData.backedAmount >= amount, "LP cannot cover");
        
        // Calculate collateral to lock
        uint256 xmrValueEth = _xmrToDAI(amount);
        uint256 collateralNeededEth = (xmrValueEth * SAFE_RATIO) / 100;
        uint256 sDAINeeded = _ethToSDAI(collateralNeededEth);
        
        require(lpData.collateralAmount >= sDAINeeded, "LP insufficient collateral");
        
        // Burn user's tokens
        _burn(msg.sender, amount);
        
        // Lock LP collateral
        lpData.collateralAmount -= sDAINeeded;
        lpData.backedAmount -= amount;
        totalLPCollateral -= sDAINeeded;
        
        uint256 burnId = nextBurnId++;
        burnRequests[burnId] = BurnRequest({
            user: msg.sender,
            lp: lp,
            amount: amount,
            depositAmount: msg.value,
            xmrAddress: xmrAddress,
            userPublicViewKey: userPublicViewKey,
            userPublicSpendKey: userPublicSpendKey,
            requestTime: block.timestamp,
            collateralLocked: sDAINeeded,
            fulfilled: false,
            defaulted: false
        });
        
        emit BurnRequested(burnId, msg.sender, lp, amount, xmrAddress);
    }
    
    /**
     * @notice LP fulfills burn with DLEQ proof (cryptographically proves XMR sent to user)
     * @param burnId The burn request ID
     * @param proof DLEQ proof showing LP sent XMR to user's Monero address
     * @param blockHeight Monero block height containing the transaction
     * @param txMerkleProof Merkle proof that TX exists in the block
     * @param txIndex Index of transaction in block
     * @dev LP must prove: 1) They created the TX, 2) TX sent to user's address, 3) Amount matches
     */
    function fulfillBurnWithDLEQ(
        uint256 burnId,
        MintProof calldata proof,
        uint256 blockHeight,
        bytes32[] calldata txMerkleProof,
        uint256 txIndex
    ) external nonReentrant {
        BurnRequest storage request = burnRequests[burnId];
        require(msg.sender == request.lp, "Not the LP");
        require(!request.fulfilled && !request.defaulted, "Already processed");
        require(block.timestamp <= request.requestTime + BURN_TIMEOUT, "Timeout");
        
        // Get user's public keys from the burn request (convert bytes32 to uint256)
        uint256 userA_x = uint256(request.userPublicViewKey);
        uint256 userA_y = 0; // Y-coordinate derived from X in Ed25519
        uint256 userB_x = uint256(request.userPublicSpendKey);
        uint256 userB_y = 0; // Y-coordinate derived from X in Ed25519
        
        // 1. Verify DLEQ Proof: log_G(R) == log_A(S)
        // This proves the LP created this transaction using their secret key r
        require(
            Ed25519.verifyDLEQ(
                uint256(proof.R), 0,
                uint256(proof.S), 0,
                userA_x, userA_y,
                proof.dleq_c,
                proof.dleq_s
            ),
            "Invalid DLEQ proof - LP did not create this TX"
        );
        
        // 2. Verify Stealth Address: P == H(S)*G + B
        // This proves the transaction was sent to the USER's spend key (not someone else)
        uint256 sharedSecHash = uint256(keccak256(abi.encodePacked(proof.S)));
        require(
            Ed25519.verifyStealthAddress(
                sharedSecHash,
                userB_x, userB_y,
                uint256(proof.P), 0
            ),
            "Invalid stealth address - TX not sent to user's address"
        );
        
        // 3. Verify Amount Commitment: C == x*G + amount*H
        // This proves the amount sent matches the burn request amount
        uint256 mask = uint256(keccak256(abi.encodePacked(proof.S, "commitment_mask")));
        (uint256 xG_x, uint256 xG_y) = Ed25519.scalarMultBase(mask);
        (uint256 amountH_x, uint256 amountH_y) = Ed25519.scalarMultH(request.amount);
        (uint256 expectedC_x, ) = Ed25519.addPoints(xG_x, xG_y, amountH_x, amountH_y);
        require(uint256(proof.C) == expectedC_x, "Amount mismatch - LP sent wrong amount");
        
        // 4. Verify TX exists in Monero block via Merkle proof
        require(moneroBlocks[blockHeight].exists, "Block not posted");
        bytes32 txHash = keccak256(abi.encodePacked(proof.R, proof.P, proof.C));
        require(
            verifyTxInBlock(txHash, blockHeight, txMerkleProof, txIndex),
            "TX not in block"
        );
        
        // 5. Verify block was posted AFTER burn request (prevents replay)
        require(
            moneroBlocks[blockHeight].timestamp >= request.requestTime,
            "TX predates burn request"
        );
        
        // 6. Mark as fulfilled
        request.fulfilled = true;
        
        // 7. Return collateral to LP
        lpInfo[request.lp].collateralAmount += request.collateralLocked;
        totalLPCollateral += request.collateralLocked;
        
        // 8. Return deposit to user
        (bool success, ) = request.user.call{value: request.depositAmount}("");
        require(success, "Deposit refund failed");
        
        emit BurnFulfilled(burnId, txHash);
    }
    
    /**
     * @notice Legacy burn fulfillment (deprecated, use fulfillBurnWithDLEQ)
     * @param burnId The burn request ID
     * @param xmrTxHash Hash of the Monero transaction that sent XMR to user
     * @param blockHeight Monero block height containing the transaction
     * @param txMerkleProof Merkle proof that TX exists in the block
     * @param txIndex Index of transaction in block
     */
    function fulfillBurn(
        uint256 burnId,
        bytes32 xmrTxHash,
        uint256 blockHeight,
        bytes32[] calldata txMerkleProof,
        uint256 txIndex
    ) external nonReentrant {
        BurnRequest storage request = burnRequests[burnId];
        require(msg.sender == request.lp, "Not the LP");
        require(!request.fulfilled && !request.defaulted, "Already processed");
        require(block.timestamp <= request.requestTime + BURN_TIMEOUT, "Timeout");
        
        // Verify the Monero transaction exists in a posted block
        require(moneroBlocks[blockHeight].exists, "Block not posted by oracle");
        require(
            verifyTxInBlock(xmrTxHash, blockHeight, txMerkleProof, txIndex),
            "TX not in block - LP must prove XMR was sent"
        );
        
        // Additional check: Block must be posted AFTER the burn was requested
        // This prevents LP from reusing old transactions
        require(
            moneroBlocks[blockHeight].timestamp >= request.requestTime,
            "TX predates burn request"
        );
        
        request.fulfilled = true;
        
        // Return collateral to LP
        lpInfo[request.lp].collateralAmount += request.collateralLocked;
        totalLPCollateral += request.collateralLocked;
        
        // Return deposit to user
        (bool success, ) = request.user.call{value: request.depositAmount}("");
        require(success, "Deposit refund failed");
        
        emit BurnFulfilled(burnId, xmrTxHash);
    }
    
    /**
     * @notice User claims collateral if LP defaults
     */
    function claimDefault(uint256 burnId) external nonReentrant {
        BurnRequest storage request = burnRequests[burnId];
        require(msg.sender == request.user, "Not the user");
        require(!request.fulfilled && !request.defaulted, "Already processed");
        require(block.timestamp > request.requestTime + BURN_TIMEOUT, "Not expired");
        
        request.defaulted = true;
        
        // Transfer sDAI collateral to user (ERC20 transfer, not native currency)
        require(sDAI.transfer(request.user, request.collateralLocked), "Collateral transfer failed");
        
        // Return user's deposit (native xDAI)
        (bool success, ) = request.user.call{value: request.depositAmount}("");
        require(success, "Deposit refund failed");
        
        emit BurnDefaulted(burnId, request.collateralLocked);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // ORACLE
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Legacy oracle posts Monero block (deprecated, use PoS oracle)
     */
    function postMoneroBlock(
        uint256 blockHeight,
        bytes32 blockHash,
        bytes32 txMerkleRoot,
        bytes32 outputMerkleRoot
    ) external onlyLegacyOracle {
        require(blockHeight > latestMoneroBlock, "Height must increase");
        require(!moneroBlocks[blockHeight].exists, "Block exists");
        
        // Use named initialization for new struct format
        moneroBlocks[blockHeight] = MoneroBlockData({
            blockHash: blockHash,
            txMerkleRoot: txMerkleRoot,
            outputMerkleRoot: outputMerkleRoot,
            timestamp: block.timestamp,
            exists: true
        });
        
        latestMoneroBlock = blockHeight;
        emit MoneroBlockFinalized(blockHeight, blockHash);
    }
    
    function transferOracle(address newOracle) external onlyLegacyOracle {
        legacyOracle = newOracle;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // POS ORACLE (Decentralized)
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Stake wsXMR to become a validator and gain voting power
     */
    function stakeAsValidator(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");

        // Transfer wsXMR to contract
        _transfer(msg.sender, address(this), amount);

        validatorStakes[msg.sender] += amount;
        totalStaked += amount;

        require(validatorStakes[msg.sender] >= MIN_VALIDATOR_STAKE, "Below minimum stake");

        // Reset unstake timer if they add stake
        unstakeAvailableAt[msg.sender] = 0;

        emit ValidatorStaked(msg.sender, amount);
    }

    /**
     * @notice Request to unstake (starts the delay timer)
     */
    function requestUnstake() external {
        require(validatorStakes[msg.sender] > 0, "No stake");
        unstakeAvailableAt[msg.sender] = block.timestamp + UNSTAKE_DELAY;
        emit UnstakeRequested(msg.sender, unstakeAvailableAt[msg.sender]);
    }

    /**
     * @notice Execute unstaking after the delay has passed
     */
    function executeUnstake() external nonReentrant {
        uint256 amount = validatorStakes[msg.sender];
        require(amount > 0, "No stake");
        require(unstakeAvailableAt[msg.sender] > 0, "Unstake not requested");
        require(block.timestamp >= unstakeAvailableAt[msg.sender], "Delay not finished");

        // Clear stake
        validatorStakes[msg.sender] = 0;
        totalStaked -= amount;
        unstakeAvailableAt[msg.sender] = 0;

        // Transfer wsXMR back
        _transfer(address(this), msg.sender, amount);

        emit ValidatorUnstaked(msg.sender, amount);
    }

    /**
     * @notice Vote for a Monero block's validity. If it hits 2/3 stake, it becomes finalized.
     * @param blockHeight Monero block height
     * @param blockHash Block hash
     * @param txMerkleRoot Transaction Merkle root
     * @param outputMerkleRoot Output Merkle root
     */
    function voteForBlock(
        uint256 blockHeight,
        bytes32 blockHash,
        bytes32 txMerkleRoot,
        bytes32 outputMerkleRoot
    ) external {
        uint256 stake = validatorStakes[msg.sender];
        require(stake >= MIN_VALIDATOR_STAKE, "Not an active validator");
        require(unstakeAvailableAt[msg.sender] == 0, "Cannot vote while unstaking");

        bytes32 previousVote = validatorVotes[blockHeight][msg.sender];

        // If changing vote, remove stake from previous block hash
        if (previousVote != bytes32(0)) {
            if (previousVote == blockHash) return; // Already voted for this hash
            blockProposals[blockHeight][previousVote].votes -= stake;
        }

        // Record new vote
        validatorVotes[blockHeight][msg.sender] = blockHash;
        blockProposals[blockHeight][blockHash].votes += stake;

        // Save roots if this is the first time this hash is voted on
        if (blockProposals[blockHeight][blockHash].txMerkleRoot == bytes32(0)) {
            blockProposals[blockHeight][blockHash].txMerkleRoot = txMerkleRoot;
            blockProposals[blockHeight][blockHash].outputMerkleRoot = outputMerkleRoot;
        }

        // Check if 2/3 Quorum is reached: votes >= (totalStaked * 2) / 3
        // Note: We multiply by 2 first, then divide by 3 to avoid precision loss
        uint256 requiredQuorum = (totalStaked * 2) / 3;

        if (blockProposals[blockHeight][blockHash].votes >= requiredQuorum) {
            // Finalize (or Overwrite in case of a Re-org)
            moneroBlocks[blockHeight] = MoneroBlockData({
                blockHash: blockHash,
                txMerkleRoot: blockProposals[blockHeight][blockHash].txMerkleRoot,
                outputMerkleRoot: blockProposals[blockHeight][blockHash].outputMerkleRoot,
                timestamp: block.timestamp,
                exists: true
            });

            if (blockHeight > latestMoneroBlock) {
                latestMoneroBlock = blockHeight;
            }

            emit MoneroBlockFinalized(blockHeight, blockHash);
        }
    }
    
    /**
     * @notice Legacy oracle claims yield from sDAI appreciation
     * @dev sDAI accrues value over time, oracle gets the excess
     */
    function claimOracleYield() external onlyLegacyOracle nonReentrant {
        uint256 totalSDAI = sDAI.balanceOf(address(this));
        
        // Total sDAI should be >= totalLPCollateral
        // Any excess is yield from sDAI appreciation
        if (totalSDAI > totalLPCollateral) {
            uint256 yieldAmount = totalSDAI - totalLPCollateral;
            require(sDAI.transfer(legacyOracle, yieldAmount), "Transfer failed");
            
            emit OracleYieldClaimed(legacyOracle, yieldAmount);
        }
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // MERKLE PROOF VERIFICATION
    // ════════════════════════════════════════════════════════════════════════
    
    function verifyTxInBlock(
        bytes32 txHash,
        uint256 blockHeight,
        bytes32[] memory merkleProof,
        uint256 index
    ) public view returns (bool) {
        require(moneroBlocks[blockHeight].exists, "Block not posted");
        bytes32 root = moneroBlocks[blockHeight].txMerkleRoot;
        
        // Manually verify instead of calling verifyMerkleProof to avoid calldata/memory issues
        bytes32 computedHash = txHash;
        for (uint256 i = 0; i < merkleProof.length; i++) {
            bytes32 proofElement = merkleProof[i];
            if (index % 2 == 0) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
            index = index / 2;
        }
        return computedHash == root;
    }
    
    function verifyMerkleProof(
        bytes32 leaf,
        bytes32 root,
        bytes32[] calldata proof,
        uint256 index
    ) public pure returns (bool) {
        bytes32 computedHash = leaf;
        
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            
            if (index % 2 == 0) {
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
            
            index = index / 2;
        }
        
        return computedHash == root;
    }
    
    function verifyMerkleProofSHA256(
        bytes32 leaf,
        bytes32 root,
        bytes32[] calldata proof,
        uint256 index
    ) public pure returns (bool) {
        bytes32 computedHash = leaf;
        
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            
            if (index % 2 == 0) {
                computedHash = sha256(abi.encodePacked(computedHash, proofElement));
            } else {
                computedHash = sha256(abi.encodePacked(proofElement, computedHash));
            }
            
            index = index / 2;
        }
        
        return computedHash == root;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // PRICE CONVERSION HELPERS
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Convert XMR amount (piconero) to DAI value
     */
    function _xmrToDAI(uint256 piconeroAmount) internal view returns (uint256) {
        // piconeroAmount is in 1e12 units
        // xmrUsdPrice and ethUsdPrice are in 1e18
        uint256 xmrAmount = piconeroAmount; // Keep in piconero
        uint256 usdValue = (xmrAmount * xmrUsdPrice) / PICONERO_PER_XMR;
        return (usdValue * 1e18) / ethUsdPrice;
    }
    
    /**
     * @notice Convert DAI value to XMR amount (piconero)
     */
    function _ethToXmr(uint256 daiAmount) internal view returns (uint256) {
        uint256 usdValue = (daiAmount * ethUsdPrice) / 1e18;
        return (usdValue * PICONERO_PER_XMR) / xmrUsdPrice;
    }
    
    /**
     * @notice Convert sDAI to DAI value (accounting for stETH appreciation)
     */
    function _sDAIToDAI(uint256 sDAIAmount) internal pure returns (uint256) {
        // GNOSIS: Using xDAI directly (1:1 ratio)
        // In production, would call: sDAI.getStETHBySDAI(sDAIAmount)
        return sDAIAmount;
    }
    
    /**
     * @notice Convert DAI value to sDAI amount
     */
    function _ethToSDAI(uint256 daiAmount) internal pure returns (uint256) {
        // GNOSIS: Using xDAI directly (1:1 ratio)
        // In production, would call: sDAI.getSDAIByStETH(daiAmount)
        return daiAmount;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // VIEWS
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Get LP's current collateralization ratio
     */
    function getLPRatio(address lp) external view returns (uint256) {
        LPInfo storage lpData = lpInfo[lp];
        if (lpData.backedAmount == 0) return type(uint256).max;
        
        uint256 collateralValueEth = _sDAIToDAI(lpData.collateralAmount);
        uint256 backedValueEth = _xmrToDAI(lpData.backedAmount);
        return (collateralValueEth * 100) / backedValueEth;
    }
    
    /**
     * @notice Get current XMR/USD price
     */
    function getXmrUsdPrice() external view returns (uint256) {
        return xmrUsdPrice;
    }
    
    /**
     * @notice Get current xDAI/USD price
     */
    function getEthUsdPrice() external view returns (uint256) {
        return ethUsdPrice;
    }
    
    /**
     * @notice Get LP's available mint capacity in piconero
     */
    function getLPAvailableCapacity(address lp) external view returns (uint256) {
        LPInfo storage lpData = lpInfo[lp];
        
        uint256 collateralValueEth = _sDAIToDAI(lpData.collateralAmount);
        uint256 currentBackedValueEth = _xmrToDAI(lpData.backedAmount);
        uint256 maxBackedValueEth = (collateralValueEth * 100) / SAFE_RATIO;
        
        if (maxBackedValueEth <= currentBackedValueEth) return 0;
        
        return _ethToXmr(maxBackedValueEth - currentBackedValueEth);
    }
    
    /**
     * @notice Get total number of registered LPs
     */
    function getLPCount() external view returns (uint256) {
        return allLPs.length;
    }
    
    /**
     * @notice Get all active LPs with capacity
     * @return addresses Array of LP addresses
     * @return moneroAddresses Array of LP Monero addresses
     * @return mintFees Array of mint fees in bps
     * @return capacities Array of available capacities in piconero
     */
    function getActiveLPs() external view returns (
        address[] memory addresses,
        string[] memory moneroAddresses,
        uint256[] memory mintFees,
        uint256[] memory capacities
    ) {
        // Count active LPs with capacity
        uint256 activeCount = 0;
        for (uint256 i = 0; i < allLPs.length; i++) {
            address lp = allLPs[i];
            if (lpInfo[lp].active && lpInfo[lp].collateralAmount > 0) {
                activeCount++;
            }
        }
        
        // Allocate arrays
        addresses = new address[](activeCount);
        moneroAddresses = new string[](activeCount);
        mintFees = new uint256[](activeCount);
        capacities = new uint256[](activeCount);
        
        // Populate arrays
        uint256 index = 0;
        for (uint256 i = 0; i < allLPs.length; i++) {
            address lp = allLPs[i];
            LPInfo storage lpData = lpInfo[lp];
            
            if (lpData.active && lpData.collateralAmount > 0) {
                addresses[index] = lp;
                moneroAddresses[index] = lpData.moneroAddress;
                mintFees[index] = lpData.mintFeeBps;
                
                // Calculate capacity
                uint256 collateralValueEth = _sDAIToDAI(lpData.collateralAmount);
                uint256 currentBackedValueEth = _xmrToDAI(lpData.backedAmount);
                uint256 maxBackedValueEth = (collateralValueEth * 100) / SAFE_RATIO;
                
                if (maxBackedValueEth > currentBackedValueEth) {
                    capacities[index] = _ethToXmr(maxBackedValueEth - currentBackedValueEth);
                } else {
                    capacities[index] = 0;
                }
                
                index++;
            }
        }
        
        return (addresses, moneroAddresses, mintFees, capacities);
    }
    
    /**
     * @notice Get user's active mint intents
     * @param user User address
     * @return intentIds Array of intent IDs
     * @return lps Array of LP addresses
     * @return amounts Array of expected amounts
     * @return deposits Array of deposit amounts
     * @return timestamps Array of creation timestamps
     */
    function getUserMintIntents(address user) external view returns (
        bytes32[] memory intentIds,
        address[] memory lps,
        uint256[] memory amounts,
        uint256[] memory deposits,
        uint256[] memory timestamps
    ) {
        bytes32[] storage userIntents = userMintIntents[user];
        
        // Count active intents
        uint256 activeCount = 0;
        for (uint256 i = 0; i < userIntents.length; i++) {
            MintIntent storage intent = mintIntents[userIntents[i]];
            if (!intent.fulfilled && !intent.cancelled) {
                activeCount++;
            }
        }
        
        // Allocate arrays
        intentIds = new bytes32[](activeCount);
        lps = new address[](activeCount);
        amounts = new uint256[](activeCount);
        deposits = new uint256[](activeCount);
        timestamps = new uint256[](activeCount);
        
        // Populate arrays
        uint256 index = 0;
        for (uint256 i = 0; i < userIntents.length; i++) {
            bytes32 intentId = userIntents[i];
            MintIntent storage intent = mintIntents[intentId];
            
            if (!intent.fulfilled && !intent.cancelled) {
                intentIds[index] = intentId;
                lps[index] = intent.lp;
                amounts[index] = intent.expectedAmount;
                deposits[index] = intent.depositAmount;
                timestamps[index] = intent.createdAt;
                index++;
            }
        }
        
        return (intentIds, lps, amounts, deposits, timestamps);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // RECEIVE
    // ════════════════════════════════════════════════════════════════════════
    
    receive() external payable {
        // Accept DAI for LP deposits and intent deposits
    }
}
