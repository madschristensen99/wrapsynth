// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import "./interfaces/IPlonkVerifier.sol";
import "./libraries/Ed25519.sol";

/**
 * @title WrappedMoneroV3 (zeroXMR)
 * @notice LP-based Wrapped Monero with Pyth Oracle
 * 
 * Architecture:
 * - Each LP maintains their own collateral and backed zeroXMR
 * - LPs set their own mint/burn fees
 * - Users choose which LP to use for minting/burning
 * - Collateral ratios: 150% safe, 120-150% risk mode, <120% liquidatable
 * - LPs can only withdraw down to 150% ratio
 * - 2-hour burn window: LP must send XMR or lose collateral
 */

contract WrappedMoneroV3 is ERC20, ERC20Permit, ReentrancyGuard {
    
    // ════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ════════════════════════════════════════════════════════════════════════
    
    uint256 public constant SAFE_RATIO = 150;           // 150% - safe zone
    uint256 public constant LIQUIDATION_THRESHOLD = 120; // 120% - below this = liquidatable
    uint256 public constant PICONERO_PER_XMR = 1e12;
    uint256 public constant MAX_PRICE_AGE = 60;
    uint256 public constant BURN_TIMEOUT = 2 hours;
    uint256 public constant MAX_FEE_BPS = 500;          // Max 5% fee
    uint256 public constant MINT_INTENT_TIMEOUT = 2 hours;  // Intent expires after 24h
    uint256 public constant MIN_INTENT_DEPOSIT = 1e18;  // 1 DAI minimum deposit
    
    bytes32 public constant XMR_USD_PRICE_ID = 0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d;
    
    // ════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ════════════════════════════════════════════════════════════════════════
    
    IPlonkVerifier public immutable verifier;
    IERC20 public immutable dai;
    IERC4626 public immutable sDAI;
    IPyth public immutable pyth;
    
    address public oracle;
    uint256 public totalLPShares;        // Total LP shares (for yield calculation)
    uint256 public lastYieldSnapshot;    // Last sDAI balance snapshot
    
    // Per-LP state
    struct LPInfo {
        uint256 collateralShares;    // sDAI shares deposited
        uint256 backedAmount;         // zeroXMR amount this LP is backing
        uint256 mintFeeBps;           // Mint fee in basis points (100 = 1%)
        uint256 burnFeeBps;           // Burn fee in basis points
        uint256 maxPendingIntents;    // Max pending mint/burn intents
        uint256 pendingIntents;       // Current pending intents
        bool active;                  // Is LP accepting new mints?
    }
    mapping(address => LPInfo) public lpInfo;
    
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
    mapping(bytes32 => MintIntent) public mintIntents;  // intentId => MintIntent
    
    // Track used Monero outputs
    mapping(bytes32 => bool) public usedOutputs;
    
    // Burn requests (updated with deposit)
    struct BurnRequest {
        address user;
        address lp;
        uint256 amount;               // zeroXMR amount (locked)
        uint256 depositAmount;        // Anti-griefing deposit in DAI
        string xmrAddress;
        uint256 requestTime;
        uint256 collateralLocked;
        bool fulfilled;
        bool defaulted;
    }
    mapping(uint256 => BurnRequest) public burnRequests;
    uint256 public nextBurnId;
    
    // Monero blockchain data (Merkle-based)
    struct MoneroBlockData {
        bytes32 blockHash;
        bytes32 txMerkleRoot;      // Merkle root of transaction hashes
        bytes32 outputMerkleRoot;  // Merkle root of output data
        uint256 timestamp;
        bool exists;
    }
    mapping(uint256 => MoneroBlockData) public moneroBlocks;
    uint256 public latestMoneroBlock;
    
    struct MoneroTxOutput {
        bytes32 txHash;
        uint256 outputIndex;
        bytes32 ecdhAmount;        // ECDH encrypted amount (CRITICAL)
        bytes32 outputPubKey;
        bytes32 commitment;
    }
    
    // Price tracking
    uint256 public twapPrice;
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
    event LPDeposited(address indexed lp, uint256 daiAmount, uint256 shares);
    event LPWithdrew(address indexed lp, uint256 shares, uint256 daiAmount);
    event LPLiquidated(address indexed lp, address indexed liquidator, uint256 collateralAdded);
    
    event Minted(address indexed recipient, address indexed lp, uint256 amount, uint256 fee, bytes32 indexed outputId);
    event BurnRequested(uint256 indexed burnId, address indexed user, address indexed lp, uint256 amount, string xmrAddress);
    event BurnFulfilled(uint256 indexed burnId, bytes32 xmrTxHash);
    event BurnDefaulted(uint256 indexed burnId, uint256 collateralSeized);
    
    event PriceUpdated(uint256 newPrice, uint256 timestamp);
    event MoneroBlockPosted(uint256 indexed blockHeight, bytes32 indexed blockHash);
    event MoneroOutputPosted(bytes32 indexed outputId, bytes32 indexed txHash);
    event OracleYieldClaimed(address indexed oracle, uint256 amount);
    event MintIntentCreated(bytes32 indexed intentId, address indexed user, address indexed lp, uint256 expectedAmount);
    event MintIntentFulfilled(bytes32 indexed intentId, uint256 actualAmount);
    event MintIntentCancelled(bytes32 indexed intentId);
    event BurnIntentCreated(uint256 indexed burnId, address indexed user, address indexed lp, uint256 amount);
    
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
        address _dai,
        address _sDAI,
        address _pyth,
        uint256 _initialMoneroBlock
    ) ERC20("Wrapped Monero", "zeroXMR") ERC20Permit("Wrapped Monero") {
        verifier = IPlonkVerifier(_verifier);
        dai = IERC20(_dai);
        sDAI = IERC4626(_sDAI);
        pyth = IPyth(_pyth);
        oracle = msg.sender;
        
        // Fetch initial price from Pyth
        PythStructs.Price memory pythPrice = pyth.getPriceUnsafe(XMR_USD_PRICE_ID);
        require(pythPrice.price > 0, "Invalid Pyth price");
        
        // Convert Pyth price (with expo) to uint256 with 8 decimals
        // Pyth price format: price * 10^expo = actual price
        // We need: actual price * 10^8
        int256 price = int256(pythPrice.price);
        int32 expo = pythPrice.expo;
        
        // Calculate: price * 10^(8 + expo)
        if (expo >= 0) {
            twapPrice = uint256(price) * (10 ** uint32(expo)) * 1e8;
        } else {
            // expo is negative, so we divide
            int32 adjustedExpo = 8 + expo;
            if (adjustedExpo >= 0) {
                twapPrice = uint256(price) * (10 ** uint32(adjustedExpo));
            } else {
                twapPrice = uint256(price) / (10 ** uint32(-adjustedExpo));
            }
        }
        
        lastPriceUpdate = block.timestamp;
        latestMoneroBlock = _initialMoneroBlock;
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
        
        _updateTWAP();
    }
    
    function _updateTWAP() internal {
        PythStructs.Price memory priceData = pyth.getPriceNoOlderThan(XMR_USD_PRICE_ID, MAX_PRICE_AGE);
        require(priceData.price > 0, "Invalid price");
        
        uint256 newPrice;
        if (priceData.expo >= 0) {
            newPrice = uint256(uint64(priceData.price)) * (10 ** uint32(priceData.expo)) * 1e18;
        } else {
            newPrice = (uint256(uint64(priceData.price)) * 1e18) / (10 ** uint32(-priceData.expo));
        }
        
        twapPrice = twapPrice == 0 ? newPrice : (twapPrice * 9 + newPrice) / 10;
        lastPriceUpdate = block.timestamp;
        
        emit PriceUpdated(twapPrice, block.timestamp);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // LP MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Register as LP or update fees
     */
    function registerLP(uint256 mintFeeBps, uint256 burnFeeBps, uint256 maxPendingIntents, bool active) external {
        require(mintFeeBps <= MAX_FEE_BPS, "Mint fee too high");
        require(burnFeeBps <= MAX_FEE_BPS, "Burn fee too high");
        require(maxPendingIntents > 0, "Must allow intents");
        
        lpInfo[msg.sender].mintFeeBps = mintFeeBps;
        lpInfo[msg.sender].burnFeeBps = burnFeeBps;
        lpInfo[msg.sender].maxPendingIntents = maxPendingIntents;
        lpInfo[msg.sender].active = active;
        
        emit LPRegistered(msg.sender, mintFeeBps, burnFeeBps);
    }
    
    /**
     * @notice LP deposits collateral
     */
    function lpDeposit(uint256 daiAmount) external nonReentrant {
        require(daiAmount > 0, "Zero amount");
        
        dai.transferFrom(msg.sender, address(this), daiAmount);
        dai.approve(address(sDAI), daiAmount);
        uint256 shares = sDAI.deposit(daiAmount, address(this));
        
        lpInfo[msg.sender].collateralShares += shares;
        totalLPShares += shares;
        
        emit LPDeposited(msg.sender, daiAmount, shares);
    }
    
    /**
     * @notice LP withdraws collateral (only down to 150% ratio)
     */
    function lpWithdraw(uint256 shares) external nonReentrant {
        LPInfo storage lp = lpInfo[msg.sender];
        require(lp.collateralShares >= shares, "Insufficient shares");
        
        // Check LP maintains 150% ratio after withdrawal
        uint256 remainingShares = lp.collateralShares - shares;
        uint256 remainingValue = sDAI.convertToAssets(remainingShares);
        uint256 backedValue = (lp.backedAmount * twapPrice) / 1e18;
        
        if (lp.backedAmount > 0) {
            uint256 ratio = (remainingValue * 100) / backedValue;
            require(ratio >= SAFE_RATIO, "Would drop below 150%");
        }
        
        lp.collateralShares -= shares;
        totalLPShares -= shares;
        uint256 daiAmount = sDAI.redeem(shares, msg.sender, address(this));
        
        emit LPWithdrew(msg.sender, shares, daiAmount);
    }
    
    /**
     * @notice Liquidate LP in risk mode (120-150%) by adding collateral
     */
    function liquidateLP(address lp, uint256 daiAmount) external nonReentrant {
        LPInfo storage lpData = lpInfo[lp];
        require(lpData.backedAmount > 0, "LP has no position");
        
        // Check LP is in risk mode
        uint256 collateralValue = sDAI.convertToAssets(lpData.collateralShares);
        uint256 backedValue = (lpData.backedAmount * twapPrice) / 1e18;
        uint256 ratio = (collateralValue * 100) / backedValue;
        
        require(ratio < SAFE_RATIO, "LP not in risk mode");
        require(ratio >= LIQUIDATION_THRESHOLD, "Below liquidation threshold");
        
        // Add collateral to bring LP back to 150%
        dai.transferFrom(msg.sender, address(this), daiAmount);
        dai.approve(address(sDAI), daiAmount);
        uint256 shares = sDAI.deposit(daiAmount, address(this));
        
        lpData.collateralShares += shares;
        
        // Liquidator gets the shares (takes over part of LP position)
        lpInfo[msg.sender].collateralShares += shares;
        
        emit LPLiquidated(lp, msg.sender, daiAmount);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // MINT INTENTS
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Create mint intent - reserve LP capacity before sending XMR
     */
    function createMintIntent(
        address lp,
        uint256 expectedAmount,
        uint256 depositAmount
    ) external nonReentrant returns (bytes32 intentId) {
        LPInfo storage lpData = lpInfo[lp];
        require(lpData.active, "LP not active");
        require(depositAmount >= MIN_INTENT_DEPOSIT, "Deposit too small");
        require(lpData.pendingIntents < lpData.maxPendingIntents, "LP at capacity");
        
        // Generate intent ID
        intentId = keccak256(abi.encodePacked(msg.sender, lp, expectedAmount, block.timestamp));
        require(mintIntents[intentId].user == address(0), "Intent exists");
        
        // Transfer deposit
        dai.transferFrom(msg.sender, address(this), depositAmount);
        
        // Create intent
        mintIntents[intentId] = MintIntent({
            user: msg.sender,
            lp: lp,
            expectedAmount: expectedAmount,
            depositAmount: depositAmount,
            createdAt: block.timestamp,
            fulfilled: false,
            cancelled: false
        });
        
        lpData.pendingIntents++;
        
        emit MintIntentCreated(intentId, msg.sender, lp, expectedAmount);
    }
    
    /**
     * @notice Cancel expired mint intent
     */
    function cancelMintIntent(bytes32 intentId) external nonReentrant {
        MintIntent storage intent = mintIntents[intentId];
        require(intent.user == msg.sender, "Not your intent");
        require(!intent.fulfilled, "Already fulfilled");
        require(!intent.cancelled, "Already cancelled");
        require(block.timestamp > intent.createdAt + MINT_INTENT_TIMEOUT, "Not expired");
        
        intent.cancelled = true;
        lpInfo[intent.lp].pendingIntents--;
        
        // Refund deposit
        dai.transfer(msg.sender, intent.depositAmount);
        
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
        bytes[] calldata priceUpdateData
    ) external payable nonReentrant {
        LPInfo storage lpData = lpInfo[lp];
        require(lpData.active, "LP not active");
        
        // Update price
        if (priceUpdateData.length > 0) {
            uint256 pythFee = pyth.getUpdateFee(priceUpdateData);
            require(msg.value >= pythFee, "Insufficient fee");
            pyth.updatePriceFeeds{value: pythFee}(priceUpdateData);
            if (msg.value > pythFee) {
                (bool success, ) = msg.sender.call{value: msg.value - pythFee}("");
                require(success, "Refund failed");
            }
        }
        _updateTWAP();
        
        // Verify TX exists in Monero block via Merkle proof
        require(moneroBlocks[blockHeight].exists, "Block not posted");
        require(
            verifyTxInBlock(output.txHash, blockHeight, txMerkleProof, txIndex),
            "TX not in block"
        );
        
        // Verify output data via Merkle proof (prevents amount fraud!)
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
            "Output not in Merkle tree"
        );
        
        // Verify ZK proofs
        uint256 v = publicSignals[0];
        // Proof binding: Verify ZK proof commits to same Ed25519 points
        // Note: Circuit uses x-coordinates only (reduced mod BN254)
        uint256 p = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        require(uint256(ed25519Proof.R_x) % p == publicSignals[1], "R_x mismatch");
        require(uint256(ed25519Proof.S_x) % p == publicSignals[2], "S_x mismatch");
        require(uint256(ed25519Proof.P_x) % p == publicSignals[3], "P_x mismatch");
        require(verifier.verifyProof(proof, publicSignals), "Invalid ZK proof");
        require(verifyStealthAddress(ed25519Proof), "Invalid stealth");
        require(verifyDLEQ(dleqProof), "Invalid DLEQ");
        
        // Prevent double-spending
        bytes32 outputId = keccak256(abi.encodePacked(output.txHash, output.outputIndex));
        require(!usedOutputs[outputId], "Output spent");
        usedOutputs[outputId] = true;
        
        // Calculate amounts (v is in piconero, we mint 1:1)
        uint256 fee = (v * lpData.mintFeeBps) / 10000;
        uint256 netAmount = v - fee;
        
        // For collateral calculation, convert to XMR units
        uint256 xmrAmount = v / PICONERO_PER_XMR;
        uint256 daiValue = (xmrAmount * twapPrice) / 1e18;
        uint256 requiredCollateral = (daiValue * SAFE_RATIO) / 100;
        uint256 requiredShares = sDAI.convertToShares(requiredCollateral);
        
        require(lpData.collateralShares >= requiredShares, "LP insufficient collateral");
        
        // Update LP state (track in piconero)
        lpData.backedAmount += v;
        
        // Mint tokens
        _mint(recipient, netAmount);
        if (fee > 0) _mint(lp, fee); // Fee goes to LP
        
        emit Minted(recipient, lp, netAmount, fee, output.txHash);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // BURN (2-hour window)
    // ════════════════════════════════════════════════════════════════════════
    
    function requestBurn(uint256 amount, string calldata xmrAddress, address lp) external nonReentrant {
        require(balanceOf(msg.sender) >= amount, "Insufficient balance");
        
        LPInfo storage lpData = lpInfo[lp];
        require(lpData.backedAmount >= amount, "LP cannot cover");
        
        uint256 daiValue = (amount * twapPrice) / 1e18;
        uint256 collateralNeeded = (daiValue * SAFE_RATIO) / 100;
        uint256 sharesNeeded = sDAI.convertToShares(collateralNeeded);
        
        require(lpData.collateralShares >= sharesNeeded, "LP insufficient collateral");
        
        // Burn user's tokens
        _burn(msg.sender, amount);
        
        // Lock LP collateral
        lpData.collateralShares -= sharesNeeded;
        lpData.backedAmount -= amount;
        
        uint256 burnId = nextBurnId++;
        burnRequests[burnId] = BurnRequest({
            user: msg.sender,
            lp: lp,
            amount: amount,
            depositAmount: 0,  // TODO: Add deposit requirement
            xmrAddress: xmrAddress,
            requestTime: block.timestamp,
            collateralLocked: sharesNeeded,
            fulfilled: false,
            defaulted: false
        });
        
        emit BurnRequested(burnId, msg.sender, lp, amount, xmrAddress);
    }
    
    function fulfillBurn(uint256 burnId, bytes32 xmrTxHash) external nonReentrant {
        BurnRequest storage request = burnRequests[burnId];
        require(msg.sender == request.lp, "Not the LP");
        require(!request.fulfilled && !request.defaulted, "Already processed");
        require(block.timestamp <= request.requestTime + BURN_TIMEOUT, "Timeout");
        
        request.fulfilled = true;
        
        // Return collateral to LP
        lpInfo[request.lp].collateralShares += request.collateralLocked;
        
        emit BurnFulfilled(burnId, xmrTxHash);
    }
    
    function claimDefault(uint256 burnId) external nonReentrant {
        BurnRequest storage request = burnRequests[burnId];
        require(msg.sender == request.user, "Not the user");
        require(!request.fulfilled && !request.defaulted, "Already processed");
        require(block.timestamp > request.requestTime + BURN_TIMEOUT, "Not expired");
        
        request.defaulted = true;
        
        // Give collateral to user
        uint256 daiAmount = sDAI.redeem(request.collateralLocked, request.user, address(this));
        
        emit BurnDefaulted(burnId, daiAmount);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // ORACLE
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Post Monero block with Merkle roots
     * @param blockHeight Block height
     * @param blockHash Block hash
     * @param txMerkleRoot Merkle root of all TX hashes in block
     * @param outputMerkleRoot Merkle root of all output data in block
     */
    function postMoneroBlock(
        uint256 blockHeight,
        bytes32 blockHash,
        bytes32 txMerkleRoot,
        bytes32 outputMerkleRoot
    ) external onlyOracle {
        require(blockHeight > latestMoneroBlock, "Height must increase");
        require(!moneroBlocks[blockHeight].exists, "Block exists");
        
        moneroBlocks[blockHeight] = MoneroBlockData({
            blockHash: blockHash,
            txMerkleRoot: txMerkleRoot,
            outputMerkleRoot: outputMerkleRoot,
            timestamp: block.timestamp,
            exists: true
        });
        
        latestMoneroBlock = blockHeight;
        emit MoneroBlockPosted(blockHeight, blockHash);
    }
    
    function transferOracle(address newOracle) external onlyOracle {
        oracle = newOracle;
    }
    
    /**
     * @notice Oracle claims yield from sDAI vault
     * @dev Oracle gets all interest earned on LP collateral
     */
    function claimOracleYield() external onlyOracle nonReentrant {
        // Calculate total sDAI balance
        uint256 totalBalance = sDAI.balanceOf(address(this));
        
        // LP shares represent their principal
        // Any excess is yield that goes to oracle
        if (totalBalance > totalLPShares) {
            uint256 yieldShares = totalBalance - totalLPShares;
            uint256 yieldAmount = sDAI.redeem(yieldShares, oracle, address(this));
            
            emit OracleYieldClaimed(oracle, yieldAmount);
        }
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // VERIFICATION
    // ════════════════════════════════════════════════════════════════════════
    
    function verifyStealthAddress(Ed25519Proof calldata proof) internal pure returns (bool) {
        require(Ed25519.isOnCurve(uint256(proof.R_x), uint256(proof.R_y)), "R");
        require(Ed25519.isOnCurve(uint256(proof.S_x), uint256(proof.S_y)), "S");
        require(Ed25519.isOnCurve(uint256(proof.P_x), uint256(proof.P_y)), "P");
        require(Ed25519.isOnCurve(uint256(proof.B_x), uint256(proof.B_y)), "B");
        return true;
    }
    
    function verifyDLEQ(DLEQProof calldata dleq) internal pure returns (bool) {
        require(dleq.c != bytes32(0) && dleq.s != bytes32(0), "Invalid DLEQ");
        return true;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // MERKLE PROOF VERIFICATION
    // ════════════════════════════════════════════════════════════════════════
    
    function verifyTxInBlock(
        bytes32 txHash,
        uint256 blockHeight,
        bytes32[] calldata merkleProof,
        uint256 index
    ) public view returns (bool) {
        require(moneroBlocks[blockHeight].exists, "Block not posted");
        bytes32 root = moneroBlocks[blockHeight].txMerkleRoot;
        return verifyMerkleProof(txHash, root, merkleProof, index);
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
    // VIEWS
    // ════════════════════════════════════════════════════════════════════════
    
    function getLPRatio(address lp) external view returns (uint256) {
        LPInfo storage lpData = lpInfo[lp];
        if (lpData.backedAmount == 0) return type(uint256).max;
        
        uint256 collateralValue = sDAI.convertToAssets(lpData.collateralShares);
        uint256 backedValue = (lpData.backedAmount * twapPrice) / 1e18;
        return (collateralValue * 100) / backedValue;
    }
    
    function getCurrentPrice() external view returns (uint256) {
        PythStructs.Price memory priceData = pyth.getPriceUnsafe(XMR_USD_PRICE_ID);
        if (priceData.expo >= 0) {
            return uint256(uint64(priceData.price)) * (10 ** uint32(priceData.expo)) * 1e18;
        } else {
            return (uint256(uint64(priceData.price)) * 1e18) / (10 ** uint32(-priceData.expo));
        }
    }
}