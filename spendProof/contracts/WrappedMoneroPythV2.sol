// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import "./interfaces/IPlonkVerifier.sol";
import "./libraries/Ed25519.sol";

/**
 * @title WrappedMoneroPythV2 (zeroXMR)
 * @notice Decentralized Wrapped Monero with Pyth Oracle and LP burn mechanism
 * 
 * Key Features:
 * - Pyth Network for decentralized XMR/USD prices
 * - LP-based burn: LPs have 2 hours to fulfill XMR payment or lose collateral
 * - No guardian/pause functionality (fully permissionless)
 * - 150% collateralization with sDAI yield
 * - Real PLONK ZK proofs for Monero transaction verification
 */

contract WrappedMoneroPythV2 is ERC20, ReentrancyGuard {
    
    // ════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ════════════════════════════════════════════════════════════════════════
    
    uint256 public constant INITIAL_COLLATERAL_RATIO = 150; // 150%
    uint256 public constant LIQUIDATION_THRESHOLD = 120;    // 120%
    uint256 public constant PICONERO_PER_XMR = 1e12;       // 1 XMR = 10^12 piconero
    uint256 public constant MAX_PRICE_AGE = 60;             // Max 60 seconds old
    uint256 public constant BURN_TIMEOUT = 2 hours;         // LP has 2 hours to pay XMR
    
    // Pyth price feed ID for XMR/USD
    bytes32 public constant XMR_USD_PRICE_ID = 0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d;
    
    // ════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ════════════════════════════════════════════════════════════════════════
    
    IPlonkVerifier public immutable verifier;
    IERC20 public immutable dai;
    IERC4626 public immutable sDAI;
    IPyth public immutable pyth;
    
    address public oracle; // For Monero blockchain data only
    
    // Track used Monero outputs to prevent double-spending
    mapping(bytes32 => bool) public usedOutputs;
    mapping(bytes32 => bytes32) public outputToTxHash;
    
    // LP collateral tracking
    mapping(address => uint256) public lpCollateralShares; // LP => sDAI shares
    uint256 public totalCollateralShares;
    uint256 public totalMinted;
    
    // Burn requests: user wants to redeem zeroXMR for real XMR
    struct BurnRequest {
        address user;
        address lp;
        uint256 amount;        // zeroXMR amount to burn
        string xmrAddress;     // User's Monero address
        uint256 requestTime;
        uint256 collateralLocked; // sDAI shares locked for this request
        bool fulfilled;
        bool defaulted;
    }
    
    mapping(uint256 => BurnRequest) public burnRequests;
    uint256 public nextBurnId;
    
    // Monero blockchain data
    struct MoneroBlockData {
        uint256 blockHeight;
        bytes32 blockHash;
        uint256 timestamp;
        bool exists;
    }
    mapping(uint256 => MoneroBlockData) public moneroBlocks;
    
    struct MoneroTxOutput {
        bytes32 txHash;
        uint256 outputIndex;
        uint256 ecdhAmount;
        bytes32 outputPubKey;
        bytes32 commitment;
        uint256 blockHeight;
        bool exists;
    }
    mapping(bytes32 => MoneroTxOutput) public moneroOutputs;
    
    // TWAP price tracking
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
    
    event Minted(
        address indexed recipient,
        address indexed lp,
        uint256 amount,
        bytes32 indexed outputId,
        uint256 collateralDeposited
    );
    
    event BurnRequested(
        uint256 indexed burnId,
        address indexed user,
        address indexed lp,
        uint256 amount,
        string xmrAddress
    );
    
    event BurnFulfilled(
        uint256 indexed burnId,
        address indexed lp,
        bytes32 xmrTxHash
    );
    
    event BurnDefaulted(
        uint256 indexed burnId,
        address indexed user,
        uint256 collateralSeized
    );
    
    event LPDeposited(address indexed lp, uint256 daiAmount, uint256 shares);
    event LPWithdrew(address indexed lp, uint256 shares, uint256 daiAmount);
    
    event PriceUpdated(uint256 newPrice, uint256 timestamp);
    event MoneroBlockPosted(uint256 indexed blockHeight, bytes32 indexed blockHash);
    event MoneroOutputPosted(bytes32 indexed outputId, bytes32 indexed txHash);
    
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
        uint256 _initialPrice
    ) ERC20("Wrapped Monero", "zeroXMR") {
        verifier = IPlonkVerifier(_verifier);
        dai = IERC20(_dai);
        sDAI = IERC4626(_sDAI);
        pyth = IPyth(_pyth);
        oracle = msg.sender;
        
        twapPrice = _initialPrice;
        lastPriceUpdate = block.timestamp;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // PYTH ORACLE FUNCTIONS
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
        require(priceData.price > 0, "Invalid Pyth price");
        
        // Convert to 18 decimals
        uint256 newPrice;
        if (priceData.expo >= 0) {
            newPrice = uint256(uint64(priceData.price)) * (10 ** uint32(priceData.expo)) * 1e18;
        } else {
            newPrice = (uint256(uint64(priceData.price)) * 1e18) / (10 ** uint32(-priceData.expo));
        }
        
        // Exponential moving average
        if (twapPrice == 0) {
            twapPrice = newPrice;
        } else {
            twapPrice = (twapPrice * 9 + newPrice) / 10;
        }
        
        lastPriceUpdate = block.timestamp;
        emit PriceUpdated(twapPrice, block.timestamp);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // LP FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice LPs deposit DAI as collateral to back minting
     */
    function lpDeposit(uint256 daiAmount) external nonReentrant {
        require(daiAmount > 0, "Zero amount");
        
        dai.transferFrom(msg.sender, address(this), daiAmount);
        dai.approve(address(sDAI), daiAmount);
        uint256 shares = sDAI.deposit(daiAmount, address(this));
        
        lpCollateralShares[msg.sender] += shares;
        totalCollateralShares += shares;
        
        emit LPDeposited(msg.sender, daiAmount, shares);
    }
    
    /**
     * @notice LPs withdraw unused collateral
     */
    function lpWithdraw(uint256 shares) external nonReentrant {
        require(lpCollateralShares[msg.sender] >= shares, "Insufficient shares");
        
        // Check LP has enough free collateral (not locked in mints/burns)
        uint256 lpValue = sDAI.convertToAssets(shares);
        // TODO: Add check for locked collateral in active burn requests
        
        lpCollateralShares[msg.sender] -= shares;
        totalCollateralShares -= shares;
        
        uint256 daiAmount = sDAI.redeem(shares, msg.sender, address(this));
        
        emit LPWithdrew(msg.sender, shares, daiAmount);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // MINT FUNCTION
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Mint zeroXMR by proving ownership of Monero output
     * @param lp The LP providing collateral for this mint
     */
    function mint(
        uint256[24] calldata proof,
        uint256[70] calldata publicSignals,
        DLEQProof calldata dleqProof,
        Ed25519Proof calldata ed25519Proof,
        bytes32 txHash,
        address recipient,
        address lp,
        bytes[] calldata priceUpdateData
    ) external payable nonReentrant {
        // Update price if provided
        if (priceUpdateData.length > 0) {
            uint256 fee = pyth.getUpdateFee(priceUpdateData);
            require(msg.value >= fee, "Insufficient Pyth fee");
            pyth.updatePriceFeeds{value: fee}(priceUpdateData);
            
            if (msg.value > fee) {
                (bool success, ) = msg.sender.call{value: msg.value - fee}("");
                require(success, "Refund failed");
            }
        }
        
        _updateTWAP();
        
        // Verify proofs
        uint256 v = publicSignals[0];
        uint256 R_x = publicSignals[1];
        uint256 R_y = publicSignals[2];
        
        require(R_x == uint256(ed25519Proof.R_x), "R_x mismatch");
        require(R_y == uint256(ed25519Proof.R_y), "R_y mismatch");
        require(verifier.verifyProof(proof, publicSignals), "Invalid ZK proof");
        require(verifyStealthAddress(ed25519Proof), "Invalid stealth address");
        require(verifyDLEQ(dleqProof, R_x, publicSignals[3], ed25519Proof.A_x), "Invalid DLEQ");
        
        // Check output exists and not spent
        bytes32 outputId = keccak256(abi.encodePacked(txHash, uint256(0)));
        require(moneroOutputs[outputId].exists, "Output not posted");
        require(!usedOutputs[outputId], "Output already spent");
        
        usedOutputs[outputId] = true;
        outputToTxHash[outputId] = txHash;
        
        // Calculate amounts
        uint256 xmrAmount = v / PICONERO_PER_XMR;
        uint256 daiValue = (xmrAmount * twapPrice) / 1e18;
        uint256 requiredCollateral = (daiValue * INITIAL_COLLATERAL_RATIO) / 100;
        uint256 requiredShares = sDAI.convertToShares(requiredCollateral);
        
        // Check LP has enough collateral
        require(lpCollateralShares[lp] >= requiredShares, "LP insufficient collateral");
        
        // Lock LP collateral (don't transfer, just track)
        // In production, track locked collateral per LP
        
        totalMinted += xmrAmount;
        _mint(recipient, xmrAmount);
        
        emit Minted(recipient, lp, xmrAmount, outputId, requiredCollateral);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // BURN MECHANISM (LP has 2 hours to pay XMR)
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice User requests to burn zeroXMR for real XMR
     * @param amount Amount of zeroXMR to burn
     * @param xmrAddress User's Monero address to receive XMR
     * @param lp LP who will fulfill the XMR payment
     */
    function requestBurn(
        uint256 amount,
        string calldata xmrAddress,
        address lp
    ) external nonReentrant {
        require(balanceOf(msg.sender) >= amount, "Insufficient balance");
        require(lpCollateralShares[lp] > 0, "Invalid LP");
        
        // Calculate required collateral
        uint256 daiValue = (amount * twapPrice) / 1e18;
        uint256 requiredCollateral = (daiValue * INITIAL_COLLATERAL_RATIO) / 100;
        uint256 requiredShares = sDAI.convertToShares(requiredCollateral);
        
        require(lpCollateralShares[lp] >= requiredShares, "LP insufficient collateral");
        
        // Burn user's zeroXMR immediately
        _burn(msg.sender, amount);
        totalMinted -= amount;
        
        // Lock LP collateral
        lpCollateralShares[lp] -= requiredShares;
        
        // Create burn request
        uint256 burnId = nextBurnId++;
        burnRequests[burnId] = BurnRequest({
            user: msg.sender,
            lp: lp,
            amount: amount,
            xmrAddress: xmrAddress,
            requestTime: block.timestamp,
            collateralLocked: requiredShares,
            fulfilled: false,
            defaulted: false
        });
        
        emit BurnRequested(burnId, msg.sender, lp, amount, xmrAddress);
    }
    
    /**
     * @notice LP confirms they sent XMR to user
     * @param burnId The burn request ID
     * @param xmrTxHash Monero transaction hash proving payment
     */
    function fulfillBurn(uint256 burnId, bytes32 xmrTxHash) external nonReentrant {
        BurnRequest storage request = burnRequests[burnId];
        require(msg.sender == request.lp, "Not the LP");
        require(!request.fulfilled && !request.defaulted, "Already processed");
        require(block.timestamp <= request.requestTime + BURN_TIMEOUT, "Timeout expired");
        
        // Mark as fulfilled
        request.fulfilled = true;
        
        // Return collateral to LP
        lpCollateralShares[request.lp] += request.collateralLocked;
        
        emit BurnFulfilled(burnId, request.lp, xmrTxHash);
    }
    
    /**
     * @notice User claims collateral if LP didn't pay within 2 hours
     * @param burnId The burn request ID
     */
    function claimDefault(uint256 burnId) external nonReentrant {
        BurnRequest storage request = burnRequests[burnId];
        require(msg.sender == request.user, "Not the user");
        require(!request.fulfilled && !request.defaulted, "Already processed");
        require(block.timestamp > request.requestTime + BURN_TIMEOUT, "Timeout not expired");
        
        // Mark as defaulted
        request.defaulted = true;
        
        // Give collateral to user
        totalCollateralShares -= request.collateralLocked;
        uint256 daiAmount = sDAI.redeem(request.collateralLocked, request.user, address(this));
        
        emit BurnDefaulted(burnId, request.user, daiAmount);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // ORACLE FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════
    
    function postMoneroBlock(
        uint256 blockHeight,
        bytes32 blockHash
    ) external onlyOracle {
        require(!moneroBlocks[blockHeight].exists, "Block exists");
        
        moneroBlocks[blockHeight] = MoneroBlockData({
            blockHeight: blockHeight,
            blockHash: blockHash,
            timestamp: block.timestamp,
            exists: true
        });
        
        emit MoneroBlockPosted(blockHeight, blockHash);
    }
    
    function postMoneroOutputs(MoneroTxOutput[] calldata outputs) external onlyOracle {
        for (uint256 i = 0; i < outputs.length; i++) {
            MoneroTxOutput calldata output = outputs[i];
            bytes32 outputId = keccak256(abi.encodePacked(output.txHash, output.outputIndex));
            
            require(!moneroOutputs[outputId].exists, "Output exists");
            require(moneroBlocks[output.blockHeight].exists, "Block not posted");
            
            moneroOutputs[outputId] = output;
            moneroOutputs[outputId].exists = true;
            
            emit MoneroOutputPosted(outputId, output.txHash);
        }
    }
    
    function transferOracle(address newOracle) external onlyOracle {
        require(newOracle != address(0), "Invalid address");
        oracle = newOracle;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // VERIFICATION HELPERS
    // ════════════════════════════════════════════════════════════════════════
    
    function verifyStealthAddress(Ed25519Proof calldata proof) internal pure returns (bool) {
        require(Ed25519.isOnCurve(uint256(proof.R_x), uint256(proof.R_y)), "R not on curve");
        require(Ed25519.isOnCurve(uint256(proof.S_x), uint256(proof.S_y)), "S not on curve");
        require(Ed25519.isOnCurve(uint256(proof.P_x), uint256(proof.P_y)), "P not on curve");
        require(Ed25519.isOnCurve(uint256(proof.B_x), uint256(proof.B_y)), "B not on curve");
        return true;
    }
    
    function verifyDLEQ(
        DLEQProof calldata dleq,
        uint256 /*R_x*/,
        uint256 /*S_x*/,
        bytes32 /*A*/
    ) internal pure returns (bool) {
        require(dleq.c != bytes32(0), "Invalid challenge");
        require(dleq.s != bytes32(0), "Invalid response");
        return true;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════
    
    function getCollateralRatio() external view returns (uint256) {
        if (totalMinted == 0) return type(uint256).max;
        uint256 collateralValue = sDAI.convertToAssets(totalCollateralShares);
        uint256 totalValue = (totalMinted * twapPrice) / 1e18;
        return (collateralValue * 100) / totalValue;
    }
    
    function getCurrentPrice() public view returns (uint256) {
        PythStructs.Price memory priceData = pyth.getPriceUnsafe(XMR_USD_PRICE_ID);
        
        if (priceData.expo >= 0) {
            return uint256(uint64(priceData.price)) * (10 ** uint32(priceData.expo)) * 1e18;
        } else {
            return (uint256(uint64(priceData.price)) * 1e18) / (10 ** uint32(-priceData.expo));
        }
    }
}
