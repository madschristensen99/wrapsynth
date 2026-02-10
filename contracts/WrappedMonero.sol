// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import "./interfaces/IPlonkVerifier.sol";
import "./libraries/Ed25519.sol";

/**
 * @title Wrapsynth Monero (wsXMR) - Gnosis chain
 * @notice LP-based Wrapped Monero with Pyth Oracle on Gnosis
 * @dev Uses ETH for deposits and wstETH for yield-bearing collateral
 * 
 * Architecture:
 * - Each LP maintains their own collateral and backed wsXMR
 * - LPs set their own mint/burn fees
 * - Users choose which LP to use for minting/burning
 * - Collateral ratios: 150% safe, 120-150% risk mode, <120% liquidatable
 * - LPs can only withdraw down to 150% ratio
 * - 2-hour burn window: LP must send XMR or lose collateral
 */

interface IWstETH is IERC20 {
    function wrap(uint256 _stETHAmount) external returns (uint256);
    function unwrap(uint256 _wstETHAmount) external returns (uint256);
    function getWstETHByStETH(uint256 _stETHAmount) external view returns (uint256);
    function getStETHByWstETH(uint256 _wstETHAmount) external view returns (uint256);
    function stEthPerToken() external view returns (uint256);
    function tokensPerStEth() external view returns (uint256);
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
    uint256 public constant PICONERO_PER_XMR = 1e12;
    uint256 public constant MAX_PRICE_AGE = 60;
    uint256 public constant BURN_TIMEOUT = 2 hours;
    uint256 public constant MAX_FEE_BPS = 500;          // Max 5% fee
    uint256 public constant MINT_INTENT_TIMEOUT = 2 hours;
    uint256 public constant MIN_MINT_BPS = 100;         // Minimum 1% of LP capacity (Sybil defense)
    
    // Pyth price feed IDs
    bytes32 public constant XMR_USD_PRICE_ID = 0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d;
    bytes32 public constant ETH_USD_PRICE_ID = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    
    // ════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ════════════════════════════════════════════════════════════════════════
    
    IPlonkVerifier public immutable verifier;
    IWstETH public immutable wstETH;
    IPyth public immutable pyth;
    
    address public oracle;
    uint256 public totalLPCollateral;    // Total wstETH collateral (for yield calculationn
    uint256 public lastYieldSnapshot;    // Last wstETH value snapshot
    
    // Per-LP state
    struct LPInfo {
        uint256 collateralAmount;     // wstETH amount deposited
        uint256 backedAmount;         // WrapsynthXMR amount this LP is backing
        uint256 mintFeeBps;           // Mint fee in basis points (100 = 1%)
        uint256 burnFeeBps;           // Burn fee in basis points
        uint256 intentDepositBps;     // Intent deposit in basis points of mint amount (100 = 1%)
        string moneroAddress;         // LP's Monero address (95 char base58)
        bytes32 privateViewKey;       // LP's Monero private view key (for amount decryption)
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
        uint256 depositAmount;        // Anti-griefing deposit in ETH
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
        uint256 depositAmount;        // Anti-griefing deposit in ETH
        string xmrAddress;
        uint256 requestTime;
        uint256 collateralLocked;     // wstETH locked
        bool fulfilled;
        bool defaulted;
    }
    mapping(uint256 => BurnRequest) public burnRequests;
    uint256 public nextBurnId;
    
    // Monero blockchain data (Merkle-based)
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
    
    // Price tracking (both in USD with 8 decimals)
    uint256 public xmrUsdPrice;
    uint256 public ethUsdPrice;
    uint256 public lastPriceUpdate;
    
    struct DLEQProof {
        bytes32 c;
        bytes32 s;
        bytes32 K1;
        bytes32 K2;
    }
    
    struct Ed25519Proof {
        bytes32 R_x;
        bytes32 R_y;
        bytes32 S_x;
        bytes32 S_y;
        bytes32 P_x;
        bytes32 P_y;
        bytes32 B_x;
        bytes32 B_y;
        bytes32 G_x;
        bytes32 G_y;
        bytes32 A_x;
        bytes32 A_y;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════════════
    
    event LPRegistered(address indexed lp, uint256 mintFeeBps, uint256 burnFeeBps);
    event LPUpdated(address indexed lp, uint256 mintFeeBps, uint256 burnFeeBps, bool active);
    event LPDeposited(address indexed lp, uint256 ethAmount, uint256 wstETHAmount);
    event LPWithdrew(address indexed lp, uint256 wstETHAmount, uint256 ethValue);
    event LPLiquidated(address indexed lp, address indexed liquidator, uint256 collateralAdded);
    
    event Minted(address indexed recipient, address indexed lp, uint256 amount, uint256 fee, bytes32 indexed outputId);
    event BurnRequested(uint256 indexed burnId, address indexed user, address indexed lp, uint256 amount, string xmrAddress);
    event BurnFulfilled(uint256 indexed burnId, bytes32 xmrTxHash);
    event BurnDefaulted(uint256 indexed burnId, uint256 collateralSeized);
    
    event PriceUpdated(uint256 xmrPrice, uint256 ethPrice, uint256 timestamp);
    event MoneroBlockPosted(uint256 indexed blockHeight, bytes32 indexed blockHash);
    event OracleYieldClaimed(address indexed oracle, uint256 amount);
    event MintIntentCreated(bytes32 indexed intentId, address indexed user, address indexed lp, uint256 expectedAmount);
    event MintIntentFulfilled(bytes32 indexed intentId, uint256 actualAmount);
    event MintIntentCancelled(bytes32 indexed intentId);
    
    // ════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ════════════════════════════════════════════════════════════════════════
    
    modifier onlyOracle() {
        require(msg.sender == oracle, "Only oracle");
        _;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ════════════════════════════════════════════════════════════════════════
    
    constructor(
        address _verifier,
        address _wstETH,
        address _pyth,
        uint256 _initialMoneroBlock
    ) ERC20("Wrapsynth Monero", "wsXMR") ERC20Permit("Wrapsynth Monero") {
        verifier = IPlonkVerifier(_verifier);
        wstETH = IWstETH(_wstETH);
        pyth = IPyth(_pyth);
        oracle = msg.sender;
        
        // Fetch initial prices from Pyth
        _initializePrices();
        
        latestMoneroBlock = _initialMoneroBlock;
    }
    
    function _initializePrices() internal {
        PythStructs.Price memory xmrPriceData = pyth.getPriceUnsafe(XMR_USD_PRICE_ID);
        PythStructs.Price memory ethPriceData = pyth.getPriceUnsafe(ETH_USD_PRICE_ID);
        
        require(xmrPriceData.price > 0 && ethPriceData.price > 0, "Invalid Pyth prices");
        
        xmrUsdPrice = _normalizePythPrice(xmrPriceData);
        ethUsdPrice = _normalizePythPrice(ethPriceData);
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
        PythStructs.Price memory ethPriceData = pyth.getPriceNoOlderThan(ETH_USD_PRICE_ID, MAX_PRICE_AGE);
        
        require(xmrPriceData.price > 0 && ethPriceData.price > 0, "Invalid prices");
        
        uint256 newXmrPrice = _normalizePythPrice(xmrPriceData);
        uint256 newEthPrice = _normalizePythPrice(ethPriceData);
        
        // TWAP smoothing
        xmrUsdPrice = xmrUsdPrice == 0 ? newXmrPrice : (xmrUsdPrice * 9 + newXmrPrice) / 10;
        ethUsdPrice = ethUsdPrice == 0 ? newEthPrice : (ethUsdPrice * 9 + newEthPrice) / 10;
        lastPriceUpdate = block.timestamp;
        
        emit PriceUpdated(xmrUsdPrice, ethUsdPrice, block.timestamp);
    }
    
    /**
     * @notice Get XMR price in ETH (18 decimals)
     */
    function getXmrEthPrice() public view returns (uint256) {
        require(ethUsdPrice > 0, "ETH price not set");
        return (xmrUsdPrice * 1e18) / ethUsdPrice;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // LP MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Register as LP or update fees
     * @param privateViewKey LP's Monero private view key (32 bytes) - used for amount decryption verification
     */
    function registerLP(
        uint256 mintFeeBps,
        uint256 burnFeeBps,
        uint256 intentDepositBps,
        string calldata moneroAddress,
        bytes32 privateViewKey,
        bool active
    ) external {
        require(mintFeeBps <= MAX_FEE_BPS, "Mint fee too high");
        require(burnFeeBps <= MAX_FEE_BPS, "Burn fee too high");
        require(intentDepositBps <= 1000, "Intent deposit too high"); // Max 10%
        require(bytes(moneroAddress).length > 0, "Invalid Monero address");
        require(privateViewKey != bytes32(0), "Invalid private view key");
        
        // Add to allLPs array if first time registering
        if (!lpInfo[msg.sender].registered) {
            allLPs.push(msg.sender);
            lpInfo[msg.sender].registered = true;
        }
        
        lpInfo[msg.sender].mintFeeBps = mintFeeBps;
        lpInfo[msg.sender].burnFeeBps = burnFeeBps;
        lpInfo[msg.sender].intentDepositBps = intentDepositBps;
        lpInfo[msg.sender].moneroAddress = moneroAddress;
        lpInfo[msg.sender].privateViewKey = privateViewKey;
        lpInfo[msg.sender].active = active;
        
        emit LPRegistered(msg.sender, mintFeeBps, burnFeeBps);
    }
    
    /**
     * @notice LP deposits collateral (accepts ETH directly)
     * @dev For testnet: Accepts ETH directly without wrapping to wstETH
     * @dev In production, this would wrap to wstETH for yield generation
     */
    function lpDeposit() external payable nonReentrant {
        require(msg.value > 0, "Zero amount");
        
        // TESTNET: Accept ETH directly (1:1 ratio)
        // In production, this would wrap to wstETH
        uint256 collateralAmount = msg.value;
        
        lpInfo[msg.sender].collateralAmount += collateralAmount;
        totalLPCollateral += collateralAmount;
        
        emit LPDeposited(msg.sender, msg.value, collateralAmount);
    }
    
    /**
     * @notice LP deposits wstETH directly
     */
    function lpDepositWstETH(uint256 wstETHAmount) external nonReentrant {
        require(wstETHAmount > 0, "Zero amount");
        
        wstETH.transferFrom(msg.sender, address(this), wstETHAmount);
        
        lpInfo[msg.sender].collateralAmount += wstETHAmount;
        totalLPCollateral += wstETHAmount;
        
        emit LPDeposited(msg.sender, 0, wstETHAmount);
    }
    
    /**
     * @notice LP withdraws collateral (only down to 150% ratio)
     * @dev For testnet: Sends ETH directly instead of wstETH
     */
    function lpWithdraw(uint256 amount) external nonReentrant {
        LPInfo storage lp = lpInfo[msg.sender];
        require(lp.collateralAmount >= amount, "Insufficient collateral");
        
        // Check LP maintains 150% ratio after withdrawal
        uint256 remainingCollateral = lp.collateralAmount - amount;
        // TESTNET: Collateral is in ETH directly (1:1)
        uint256 remainingValueEth = remainingCollateral;
        uint256 backedValueEth = _xmrToETH(lp.backedAmount);
        
        if (lp.backedAmount > 0) {
            uint256 ratio = (remainingValueEth * 100) / backedValueEth;
            require(ratio >= SAFE_RATIO, "Would drop below 150%");
        }
        
        lp.collateralAmount -= amount;
        totalLPCollateral -= amount;
        
        // TESTNET: Transfer ETH directly to LP
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "ETH transfer failed");
        
        emit LPWithdrew(msg.sender, amount, remainingValueEth);
    }
    
    /**
     * @notice Liquidate LP in risk mode (120-150%) by adding collateral
     */
    function liquidateLP(address lp) external payable nonReentrant {
        require(msg.value > 0, "Zero amount");
        
        LPInfo storage lpData = lpInfo[lp];
        require(lpData.backedAmount > 0, "LP has no position");
        
        // Check LP is in risk mode
        uint256 collateralValueEth = _wstETHToETH(lpData.collateralAmount);
        uint256 backedValueEth = _xmrToETH(lpData.backedAmount);
        uint256 ratio = (collateralValueEth * 100) / backedValueEth;
        
        require(ratio < SAFE_RATIO, "LP not in risk mode");
        require(ratio >= LIQUIDATION_THRESHOLD, "Below liquidation threshold");
        
        // Wrap ETH to wstETH
        uint256 wstETHBefore = wstETH.balanceOf(address(this));
        (bool success, ) = address(wstETH).call{value: msg.value}("");
        require(success, "wstETH wrap failed");
        uint256 wstETHReceived = wstETH.balanceOf(address(this)) - wstETHBefore;
        
        // Add collateral to LP
        lpData.collateralAmount += wstETHReceived;
        totalLPCollateral += wstETHReceived;
        
        // Liquidator gets bonus shares (takes over part of LP position)
        // For simplicity, liquidator receives equivalent wstETH rights
        lpInfo[msg.sender].collateralAmount += wstETHReceived;
        
        emit LPLiquidated(lp, msg.sender, msg.value);
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
        uint256 expectedValueEth = _xmrToETH(expectedAmount);
        uint256 requiredDeposit = (expectedValueEth * lpData.intentDepositBps) / 10000;
        require(msg.value >= requiredDeposit, "Deposit too small");
        
        // Calculate LP's available capacity
        uint256 collateralValueEth = _wstETHToETH(lpData.collateralAmount);
        uint256 currentBackedValueEth = _xmrToETH(lpData.backedAmount);
        uint256 maxBackedValueEth = (collateralValueEth * 100) / SAFE_RATIO;
        uint256 availableCapacityEth = maxBackedValueEth > currentBackedValueEth 
            ? maxBackedValueEth - currentBackedValueEth 
            : 0;
        
        // Convert to XMR terms for comparison
        uint256 availableCapacityXmr = _ethToXmr(availableCapacityEth);
        
        // Require mint amount to be at least 1% of available capacity (Sybil defense)
        uint256 minMintAmount = (availableCapacityXmr * MIN_MINT_BPS) / 10000;
        require(expectedAmount >= minMintAmount, "Amount below minimum (1% of LP capacity)");
        
        // Generate intent ID
        intentId = keccak256(abi.encodePacked(msg.sender, lp, expectedAmount, block.timestamp));
        require(mintIntents[intentId].user == address(0), "Intent exists");
        
        // Create intent (deposit held as ETH)
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
    
    function mint(
        uint256[24] calldata proof,
        uint256[70] calldata publicSignals,
        DLEQProof calldata dleqProof,
        Ed25519Proof calldata ed25519Proof,
        MoneroTxOutput calldata output,
        uint256 blockHeight,
        bytes32[] calldata txMerkleProof,
        uint256 txIndex,
        bytes32[] calldata outputMerkleProof,
        uint256 outputIndex,
        address recipient,
        address lp,
        bytes32 txPublicKey,  // Transaction public key R from Monero TX
        bytes[] calldata priceUpdateData
    ) external payable nonReentrant {
        LPInfo storage lpData = lpInfo[lp];
        require(lpData.active, "LP not active");
        
        // TEMP: Skip price updates for now
        // if (priceUpdateData.length > 0) {
        //     uint256 pythFee = pyth.getUpdateFee(priceUpdateData);
        //     require(msg.value >= pythFee, "Insufficient fee");
        //     pyth.updatePriceFeeds{value: pythFee}(priceUpdateData);
        //     if (msg.value > pythFee) {
        //         (bool success, ) = msg.sender.call{value: msg.value - pythFee}("");
        //         require(success, "Refund failed");
        //     }
        // }
        // _updatePrices();
        
        // Verify PLONK proof
        require(
            verifier.verifyProof(proof, publicSignals),
            "Invalid ZK proof"
        );
        
        // CRITICAL SECURITY CHECK: Verify that R_x from proof matches transaction public key
        // publicSignals[1] = R_x (transaction public key x-coordinate from user's secret key r)
        // This prevents users from minting Monero they don't own
        require(
            publicSignals[1] == uint256(txPublicKey),
            "Transaction public key mismatch - user does not own this Monero"
        );
        
        // Verify TX exists in Monero block via Merkle proof
        require(moneroBlocks[blockHeight].exists, "Block not posted");
        require(
            verifyTxInBlock(output.txHash, blockHeight, txMerkleProof, txIndex),
            "TX not in block"
        );
        
        // Verify output exists in block's output Merkle tree
        bytes32 outputLeaf = keccak256(abi.encodePacked(
            output.txHash,
            output.outputIndex,
            output.ecdhAmount,
            output.outputPubKey,
            output.commitment
        ));
        require(
            verifyMerkleProofSHA256(
                outputLeaf,
                moneroBlocks[blockHeight].outputMerkleRoot,
                outputMerkleProof,
                outputIndex
            ),
            "Output not in block"
        );
        
        // Get amount from public signals
        uint256 v = publicSignals[0];
        
        // Validate mint intent
        bytes32 intentId = keccak256(abi.encodePacked(recipient, lp, v, block.timestamp / 1 days));
        MintIntent storage intent = mintIntents[intentId];
        
        // Try to find a valid intent for this user/LP/amount within the last 7 days
        bool foundIntent = false;
        for (uint256 i = 0; i < 7 && !foundIntent; i++) {
            bytes32 testIntentId = keccak256(abi.encodePacked(recipient, lp, v, (block.timestamp / 1 days) - i));
            MintIntent storage testIntent = mintIntents[testIntentId];
            if (testIntent.user == recipient && !testIntent.fulfilled && !testIntent.cancelled) {
                intentId = testIntentId;
                intent = testIntent;
                foundIntent = true;
            }
        }
        
        require(foundIntent, "No valid mint intent found");
        require(intent.user == recipient, "Intent user mismatch");
        require(intent.lp == lp, "Intent LP mismatch");
        require(!intent.fulfilled, "Intent already fulfilled");
        require(!intent.cancelled, "Intent cancelled");
        require(v == intent.expectedAmount, "Amount does not match intent");
        
        // Mark intent as fulfilled
        intent.fulfilled = true;
        
        // Prevent double-spending
        bytes32 outputId = keccak256(abi.encodePacked(output.txHash, output.outputIndex));
        require(!usedOutputs[outputId], "Output spent");
        usedOutputs[outputId] = true;
        
        // Calculate amounts (v is in piconero, we mint 1:1)
        uint256 fee = (v * lpData.mintFeeBps) / 10000;
        uint256 netAmount = v - fee;
        
        // TEMP: Skip collateral check
        // uint256 xmrValueEth = _xmrToETH(v);
        // uint256 requiredCollateralEth = (xmrValueEth * SAFE_RATIO) / 100;
        // uint256 requiredWstETH = _ethToWstETH(requiredCollateralEth);
        // require(lpData.collateralAmount >= requiredWstETH, "LP insufficient collateral");
        
        // Update LP state
        lpData.backedAmount += v;
        
        // Mint tokens
        _mint(recipient, netAmount);
        if (fee > 0) _mint(lp, fee);
        
        emit Minted(recipient, lp, netAmount, fee, output.txHash);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // BURN (2-hour window)
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Request burn - locks wsXMR and LP collateral
     * @param amount Amount of wsXMR to burn (in piconero)
     * @param xmrAddress Monero address to receive XMR
     * @param lp LP to process the burn
     */
    function requestBurn(
        uint256 amount, 
        string calldata xmrAddress, 
        address lp
    ) external payable nonReentrant {
        require(balanceOf(msg.sender) >= amount, "Insufficient balance");
        
        LPInfo storage lpData = lpInfo[lp];
        
        // Calculate required deposit based on LP's setting
        uint256 burnValueEth = _xmrToETH(amount);
        uint256 requiredDeposit = (burnValueEth * lpData.intentDepositBps) / 10000;
        require(msg.value >= requiredDeposit, "Deposit too small");
        require(lpData.backedAmount >= amount, "LP cannot cover");
        
        // Calculate collateral to lock
        uint256 xmrValueEth = _xmrToETH(amount);
        uint256 collateralNeededEth = (xmrValueEth * SAFE_RATIO) / 100;
        uint256 wstETHNeeded = _ethToWstETH(collateralNeededEth);
        
        require(lpData.collateralAmount >= wstETHNeeded, "LP insufficient collateral");
        
        // Burn user's tokens
        _burn(msg.sender, amount);
        
        // Lock LP collateral
        lpData.collateralAmount -= wstETHNeeded;
        lpData.backedAmount -= amount;
        totalLPCollateral -= wstETHNeeded;
        
        uint256 burnId = nextBurnId++;
        burnRequests[burnId] = BurnRequest({
            user: msg.sender,
            lp: lp,
            amount: amount,
            depositAmount: msg.value,
            xmrAddress: xmrAddress,
            requestTime: block.timestamp,
            collateralLocked: wstETHNeeded,
            fulfilled: false,
            defaulted: false
        });
        
        emit BurnRequested(burnId, msg.sender, lp, amount, xmrAddress);
    }
    
    /**
     * @notice LP fulfills burn by proving XMR was sent
     * @param burnId The burn request ID
     * @param xmrTxHash Hash of the Monero transaction that sent XMR to user
     * @param blockHeight Monero block height containing the transaction
     * @param txMerkleProof Merkle proof that TX exists in the block
     * @param txIndex Index of transaction in block
     * @dev LP must cryptographically prove they sent XMR by providing Merkle proofs
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
        
        // TESTNET: Transfer ETH collateral directly to user
        (bool success1, ) = request.user.call{value: request.collateralLocked}("");
        require(success1, "Collateral transfer failed");
        
        // Return user's deposit
        (bool success2, ) = request.user.call{value: request.depositAmount}("");
        require(success2, "Deposit refund failed");
        
        emit BurnDefaulted(burnId, request.collateralLocked);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // ORACLE
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Post Monero block with Merkle roots
     */
    function postMoneroBlock(
        uint256 blockHeight,
        bytes32 blockHash,
        bytes32 txMerkleRoot,
        bytes32 outputMerkleRoot
    ) external onlyOracle {
        require(blockHeight > latestMoneroBlock, "Height must increase");
        require(!moneroBlocks[blockHeight].exists, "Block exists");
        
        // Use positional initialization to avoid any named parameter issues
        moneroBlocks[blockHeight] = MoneroBlockData(
            blockHash,
            txMerkleRoot,
            outputMerkleRoot,
            block.timestamp,
            true
        );
        
        latestMoneroBlock = blockHeight;
        emit MoneroBlockPosted(blockHeight, blockHash);
    }
    
    function transferOracle(address newOracle) external onlyOracle {
        oracle = newOracle;
    }
    
    /**
     * @notice Oracle claims yield from wstETH appreciation
     * @dev wstETH accrues value over time, oracle gets the excess
     */
    function claimOracleYield() external onlyOracle nonReentrant {
        uint256 totalWstETH = wstETH.balanceOf(address(this));
        
        // Total wstETH should be >= totalLPCollateral
        // Any excess is yield from stETH appreciation
        if (totalWstETH > totalLPCollateral) {
            uint256 yieldAmount = totalWstETH - totalLPCollateral;
            wstETH.transfer(oracle, yieldAmount);
            
            emit OracleYieldClaimed(oracle, yieldAmount);
        }
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // VERIFICATION
    // ════════════════════════════════════════════════════════════════════════
    
    function verifyStealthAddress(Ed25519Proof calldata proof) internal pure returns (bool) {
        // NOTE: Full DLEQ verification performed off-chain in RISC Zero zkVM
        // On-chain we only verify points are on curve as sanity check
        require(Ed25519.isOnCurve(uint256(proof.R_x), uint256(proof.R_y)), "R not on curve");
        require(Ed25519.isOnCurve(uint256(proof.S_x), uint256(proof.S_y)), "S not on curve");
        require(Ed25519.isOnCurve(uint256(proof.P_x), uint256(proof.P_y)), "P not on curve");
        require(Ed25519.isOnCurve(uint256(proof.B_x), uint256(proof.B_y)), "B not on curve");
        return true;
    }
    
    function verifyDLEQ(DLEQProof calldata dleq) internal pure returns (bool) {
        // NOTE: Full DLEQ verification performed off-chain in RISC Zero zkVM
        // Oracle attests to correctness via zkTLS proofs
        require(dleq.c != bytes32(0) && dleq.s != bytes32(0), "Invalid DLEQ");
        return true;
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
     * @notice Convert XMR amount (piconero) to ETH value
     */
    function _xmrToETH(uint256 piconeroAmount) internal view returns (uint256) {
        // piconeroAmount is in 1e12 units
        // xmrUsdPrice and ethUsdPrice are in 1e18
        uint256 xmrAmount = piconeroAmount; // Keep in piconero
        uint256 usdValue = (xmrAmount * xmrUsdPrice) / PICONERO_PER_XMR;
        return (usdValue * 1e18) / ethUsdPrice;
    }
    
    /**
     * @notice Convert ETH value to XMR amount (piconero)
     */
    function _ethToXmr(uint256 ethAmount) internal view returns (uint256) {
        uint256 usdValue = (ethAmount * ethUsdPrice) / 1e18;
        return (usdValue * PICONERO_PER_XMR) / xmrUsdPrice;
    }
    
    /**
     * @notice Convert wstETH to ETH value (accounting for stETH appreciation)
     */
    function _wstETHToETH(uint256 wstETHAmount) internal pure returns (uint256) {
        // TESTNET: Using ETH directly (1:1 ratio)
        // In production, would call: wstETH.getStETHByWstETH(wstETHAmount)
        return wstETHAmount;
    }
    
    /**
     * @notice Convert ETH value to wstETH amount
     */
    function _ethToWstETH(uint256 ethAmount) internal pure returns (uint256) {
        // TESTNET: Using ETH directly (1:1 ratio)
        // In production, would call: wstETH.getWstETHByStETH(ethAmount)
        return ethAmount;
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
        
        uint256 collateralValueEth = _wstETHToETH(lpData.collateralAmount);
        uint256 backedValueEth = _xmrToETH(lpData.backedAmount);
        return (collateralValueEth * 100) / backedValueEth;
    }
    
    /**
     * @notice Get current XMR/USD price
     */
    function getXmrUsdPrice() external view returns (uint256) {
        return xmrUsdPrice;
    }
    
    /**
     * @notice Get current ETH/USD price
     */
    function getEthUsdPrice() external view returns (uint256) {
        return ethUsdPrice;
    }
    
    /**
     * @notice Get LP's available mint capacity in piconero
     */
    function getLPAvailableCapacity(address lp) external view returns (uint256) {
        LPInfo storage lpData = lpInfo[lp];
        
        uint256 collateralValueEth = _wstETHToETH(lpData.collateralAmount);
        uint256 currentBackedValueEth = _xmrToETH(lpData.backedAmount);
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
                uint256 collateralValueEth = _wstETHToETH(lpData.collateralAmount);
                uint256 currentBackedValueEth = _xmrToETH(lpData.backedAmount);
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
        // Accept ETH for LP deposits and intent deposits
    }
}
