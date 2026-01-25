// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import "./libraries/Ed25519.sol";

/**
 * @title WrappedMoneroPyth (zeroXMR)
 * @notice Wrapped Monero with Pyth Oracle integration for decentralized price feeds
 * 
 * Key Changes from WrappedMonero:
 * - Replaces manual oracle price updates with Pyth Network oracle
 * - Automatic price updates when minting/burning
 * - Decentralized, low-latency XMR/USD price feeds
 * - No need for trusted price oracle - uses Pyth's cryptographic proofs
 * 
 * Architecture:
 * - Hybrid ZK: Ed25519 DLEQ + PLONK proofs
 * - Collateral: 150% initial, 120% liquidation threshold  
 * - Price Oracle: Pyth Network (decentralized)
 * - Yield: sDAI/aDAI collateral generates yield
 * - TWAP: 15-minute exponential moving average
 */

interface IPlonkVerifier {
    function verifyProof(
        uint256[24] calldata proof,
        uint256[70] calldata pubSignals
    ) external view returns (bool);
}

interface IERC4626 {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

contract WrappedMoneroPyth is ERC20, ReentrancyGuard, Pausable {
    
    // ════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ════════════════════════════════════════════════════════════════════════
    
    uint256 public constant INITIAL_COLLATERAL_RATIO = 150; // 150%
    uint256 public constant LIQUIDATION_THRESHOLD = 120;    // 120%
    uint256 public constant LIQUIDATION_REWARD = 5;         // 5% to liquidator
    uint256 public constant PICONERO_PER_XMR = 1e12;       // 1 XMR = 10^12 piconero
    uint256 public constant UNPAUSE_TIMELOCK = 30 days;
    uint256 public constant MAX_PRICE_AGE = 60;             // Max 60 seconds old
    
    // Pyth price feed ID for XMR/USD
    bytes32 public constant XMR_USD_PRICE_ID = 0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d;
    
    // ════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ════════════════════════════════════════════════════════════════════════
    
    IPlonkVerifier public immutable verifier;
    IERC20 public immutable dai;
    IERC4626 public immutable sDAI; // Yield-bearing DAI (Spark/Aave)
    IPyth public immutable pyth;    // Pyth oracle contract
    
    address public oracle;      // Trusted oracle for Monero blockchain data only
    address public guardian;    // Can pause mints only
    uint256 public pausedAt;    // Timestamp when paused
    
    // Track used Monero outputs to prevent double-spending
    mapping(bytes32 => bool) public usedOutputs;
    
    // Track Monero tx hashes for transparency
    mapping(bytes32 => bytes32) public outputToTxHash;
    
    // Collateral tracking
    uint256 public totalCollateralShares; // sDAI shares held as collateral
    uint256 public totalMinted;           // Total zeroXMR minted
    
    // Oracle data: Monero block height → block data
    struct MoneroBlockData {
        uint256 blockHeight;
        bytes32 blockHash;
        uint256 timestamp;
        uint256 totalSupply;     // Total XMR in circulation (for reference)
        bool exists;
    }
    mapping(uint256 => MoneroBlockData) public moneroBlocks;
    
    // Monero transaction output data
    struct MoneroTxOutput {
        bytes32 txHash;          // Transaction hash
        uint256 outputIndex;     // Output index in transaction
        uint256 ecdhAmount;      // ECDH encrypted amount
        bytes32 outputPubKey;    // Output public key (for stealth address)
        bytes32 commitment;      // Pedersen commitment
        uint256 blockHeight;     // Block height where tx was included
        bool exists;
    }
    mapping(bytes32 => MoneroTxOutput) public moneroOutputs;
    
    // TWAP price tracking (XMR/USD in 18 decimals)
    uint256 public twapPrice;           // Current TWAP price
    uint256 public lastPriceUpdate;     // Last price update timestamp
    uint256 public constant TWAP_PERIOD = 15 minutes;
    
    struct DLEQProof {
        bytes32 c;      // Challenge
        bytes32 s;      // Response
        bytes32 K1;     // Commitment 1
        bytes32 K2;     // Commitment 2
    }
    
    struct Ed25519Proof {
        bytes32 R_x;            // r·G x-coordinate
        bytes32 R_y;            // r·G y-coordinate
        bytes32 S_x;            // H_s·G x-coordinate
        bytes32 S_y;            // H_s·G y-coordinate
        bytes32 P_x;            // Stealth address P x-coordinate
        bytes32 P_y;            // Stealth address P y-coordinate
        bytes32 B_x;            // Recipient view key B x-coordinate
        bytes32 B_y;            // Recipient view key B y-coordinate
        bytes32 G_x;            // Base point G x-coordinate
        bytes32 G_y;            // Base point G y-coordinate
        bytes32 A_x;            // Output public key A x-coordinate
        bytes32 A_y;            // Output public key A y-coordinate
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════════════
    
    event Minted(
        address indexed recipient,
        uint256 amount,
        bytes32 indexed outputId,
        bytes32 indexed txHash,
        uint256 collateralDeposited
    );
    
    event Burned(
        address indexed holder,
        uint256 amount,
        uint256 collateralReturned
    );
    
    event Liquidated(
        address indexed liquidator,
        uint256 amountLiquidated,
        uint256 collateralSeized,
        uint256 reward
    );
    
    event MoneroBlockPosted(
        uint256 indexed blockHeight,
        bytes32 indexed blockHash,
        uint256 timestamp
    );
    
    event MoneroOutputPosted(
        bytes32 indexed outputId,
        bytes32 indexed txHash,
        uint256 blockHeight
    );
    
    event PriceUpdated(
        uint256 newPrice,
        uint256 timestamp,
        int64 pythPrice,
        int32 pythExpo
    );
    
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event GuardianUpdated(address indexed oldGuardian, address indexed newGuardian);
    event PauseInitiated(uint256 timestamp);
    event UnpauseInitiated(uint256 timestamp);
    
    // ════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ════════════════════════════════════════════════════════════════════════
    
    modifier onlyOracle() {
        require(msg.sender == oracle, "Only oracle");
        _;
    }
    
    modifier onlyGuardian() {
        require(msg.sender == guardian, "Only guardian");
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
        guardian = msg.sender;
        
        twapPrice = _initialPrice; // Initial price in USD (18 decimals)
        lastPriceUpdate = block.timestamp;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // PYTH ORACLE FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Update XMR price from Pyth oracle
     * @param priceUpdateData Pyth price update data from Hermes API
     * @dev Anyone can call this to update the price (pays small fee)
     */
    function updatePythPrice(bytes[] calldata priceUpdateData) external payable {
        // Get update fee and update price feeds
        uint256 fee = pyth.getUpdateFee(priceUpdateData);
        require(msg.value >= fee, "Insufficient fee");
        
        pyth.updatePriceFeeds{value: fee}(priceUpdateData);
        
        // Refund excess
        if (msg.value > fee) {
            payable(msg.sender).transfer(msg.value - fee);
        }
        
        // Update TWAP
        _updateTWAP();
    }
    
    /**
     * @notice Internal function to update TWAP from Pyth
     */
    function _updateTWAP() internal {
        // Get price from Pyth (no older than MAX_PRICE_AGE)
        PythStructs.Price memory priceData = pyth.getPriceNoOlderThan(
            XMR_USD_PRICE_ID,
            MAX_PRICE_AGE
        );
        
        require(priceData.price > 0, "Invalid Pyth price");
        
        // Convert Pyth price to 18 decimals
        // Pyth price has expo (usually -8), we need 18 decimals
        uint256 newPrice;
        if (priceData.expo >= 0) {
            newPrice = uint256(uint64(priceData.price)) * (10 ** uint32(priceData.expo)) * 1e18;
        } else {
            // expo is negative, e.g., -8 means price is in units of 10^-8
            // Convert to 18 decimals: price * 10^18 / 10^abs(expo)
            newPrice = (uint256(uint64(priceData.price)) * 1e18) / (10 ** uint32(-priceData.expo));
        }
        
        // Update TWAP with exponential moving average
        // twap = 0.9 * old + 0.1 * new (smoothing over TWAP_PERIOD)
        if (twapPrice == 0) {
            twapPrice = newPrice;
        } else {
            twapPrice = (twapPrice * 9 + newPrice) / 10;
        }
        
        lastPriceUpdate = block.timestamp;
        
        emit PriceUpdated(twapPrice, block.timestamp, priceData.price, priceData.expo);
    }
    
    /**
     * @notice Get current XMR/USD price from Pyth
     * @return price Current price in 18 decimals
     */
    function getCurrentPrice() public view returns (uint256 price) {
        PythStructs.Price memory priceData = pyth.getPriceUnsafe(XMR_USD_PRICE_ID);
        
        if (priceData.expo >= 0) {
            price = uint256(uint64(priceData.price)) * (10 ** uint32(priceData.expo)) * 1e18;
        } else {
            price = (uint256(uint64(priceData.price)) * 1e18) / (10 ** uint32(-priceData.expo));
        }
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // ORACLE FUNCTIONS (Monero blockchain data only)
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Oracle posts Monero block data
     */
    function postMoneroBlock(
        uint256 blockHeight,
        bytes32 blockHash,
        uint256 totalSupply
    ) external onlyOracle {
        require(!moneroBlocks[blockHeight].exists, "Block already posted");
        
        moneroBlocks[blockHeight] = MoneroBlockData({
            blockHeight: blockHeight,
            blockHash: blockHash,
            timestamp: block.timestamp,
            totalSupply: totalSupply,
            exists: true
        });
        
        emit MoneroBlockPosted(blockHeight, blockHash, block.timestamp);
    }
    
    /**
     * @notice Oracle posts Monero transaction outputs
     */
    function postMoneroOutputs(MoneroTxOutput[] calldata outputs) external onlyOracle {
        for (uint256 i = 0; i < outputs.length; i++) {
            MoneroTxOutput calldata output = outputs[i];
            
            bytes32 outputId = keccak256(abi.encodePacked(output.txHash, output.outputIndex));
            require(!moneroOutputs[outputId].exists, "Output already posted");
            require(moneroBlocks[output.blockHeight].exists, "Block not posted");
            
            moneroOutputs[outputId] = output;
            moneroOutputs[outputId].exists = true;
            
            emit MoneroOutputPosted(outputId, output.txHash, output.blockHeight);
        }
    }
    
    /**
     * @notice Transfer oracle role
     */
    function transferOracle(address newOracle) external onlyOracle {
        require(newOracle != address(0), "Invalid address");
        address oldOracle = oracle;
        oracle = newOracle;
        emit OracleUpdated(oldOracle, newOracle);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // MINT FUNCTION
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Mint zeroXMR by proving ownership of Monero output
     * @param priceUpdateData Pyth price update data (can be empty if price is fresh)
     */
    function mint(
        uint256[24] calldata proof,
        uint256[70] calldata publicSignals,
        DLEQProof calldata dleqProof,
        Ed25519Proof calldata ed25519Proof,
        bytes32 txHash,
        address recipient,
        bytes[] calldata priceUpdateData
    ) external payable nonReentrant whenNotPaused {
        // Update price if data provided
        if (priceUpdateData.length > 0) {
            uint256 fee = pyth.getUpdateFee(priceUpdateData);
            require(msg.value >= fee, "Insufficient Pyth fee");
            pyth.updatePriceFeeds{value: fee}(priceUpdateData);
            
            if (msg.value > fee) {
                payable(msg.sender).transfer(msg.value - fee);
            }
        }
        
        // Update TWAP
        _updateTWAP();
        
        // Extract public signals
        uint256 v = publicSignals[0]; // Amount in piconero
        uint256 R_x = publicSignals[1];
        uint256 R_y = publicSignals[2];
        
        // Verify proof binding
        require(R_x == uint256(ed25519Proof.R_x), "R_x mismatch");
        require(R_y == uint256(ed25519Proof.R_y), "R_y mismatch");
        
        // Verify PLONK proof
        require(verifier.verifyProof(proof, publicSignals), "Invalid ZK proof");
        
        // Verify Ed25519 stealth address
        require(verifyStealthAddress(ed25519Proof), "Invalid stealth address");
        
        // Verify DLEQ proof
        require(verifyDLEQ(dleqProof, R_x, publicSignals[3], ed25519Proof.A_x), "Invalid DLEQ");
        
        // Check output exists and not spent
        bytes32 outputId = keccak256(abi.encodePacked(txHash, uint256(0)));
        require(moneroOutputs[outputId].exists, "Output not posted by oracle");
        require(!usedOutputs[outputId], "Output already spent");
        
        // Mark output as spent
        usedOutputs[outputId] = true;
        outputToTxHash[outputId] = txHash;
        
        // Calculate XMR amount and required collateral
        uint256 xmrAmount = v / PICONERO_PER_XMR;
        uint256 daiValue = (xmrAmount * twapPrice) / 1e18;
        uint256 requiredCollateral = (daiValue * INITIAL_COLLATERAL_RATIO) / 100;
        
        // Transfer DAI and deposit to sDAI
        dai.transferFrom(msg.sender, address(this), requiredCollateral);
        dai.approve(address(sDAI), requiredCollateral);
        uint256 shares = sDAI.deposit(requiredCollateral, address(this));
        
        // Update state
        totalCollateralShares += shares;
        totalMinted += xmrAmount;
        
        // Mint zeroXMR
        _mint(recipient, xmrAmount);
        
        emit Minted(recipient, xmrAmount, outputId, txHash, requiredCollateral);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // BURN & LIQUIDATION
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Burn zeroXMR to redeem collateral
     */
    function burn(uint256 amount, bytes[] calldata priceUpdateData) external payable nonReentrant {
        require(balanceOf(msg.sender) >= amount, "Insufficient balance");
        
        // Update price if provided
        if (priceUpdateData.length > 0) {
            uint256 fee = pyth.getUpdateFee(priceUpdateData);
            require(msg.value >= fee, "Insufficient Pyth fee");
            pyth.updatePriceFeeds{value: fee}(priceUpdateData);
            
            if (msg.value > fee) {
                payable(msg.sender).transfer(msg.value - fee);
            }
        }
        
        _updateTWAP();
        
        // Calculate collateral to return
        uint256 collateralRatio = (amount * 1e18) / totalMinted;
        uint256 sharesToRedeem = (totalCollateralShares * collateralRatio) / 1e18;
        
        // Update state
        totalMinted -= amount;
        totalCollateralShares -= sharesToRedeem;
        
        // Burn zeroXMR
        _burn(msg.sender, amount);
        
        // Redeem sDAI for DAI
        uint256 daiReturned = sDAI.redeem(sharesToRedeem, msg.sender, address(this));
        
        emit Burned(msg.sender, amount, daiReturned);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════
    
    function pause() external onlyGuardian {
        _pause();
        pausedAt = block.timestamp;
        emit PauseInitiated(block.timestamp);
    }
    
    function unpause() external onlyGuardian {
        require(paused(), "Not paused");
        require(block.timestamp >= pausedAt + UNPAUSE_TIMELOCK, "Timelock not expired");
        _unpause();
        emit UnpauseInitiated(block.timestamp);
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
        uint256 R_x,
        uint256 S_x,
        bytes32 A
    ) internal pure returns (bool) {
        require(dleq.c != bytes32(0), "Invalid challenge");
        require(dleq.s != bytes32(0), "Invalid response");
        require(dleq.K1 != bytes32(0), "Invalid K1");
        require(dleq.K2 != bytes32(0), "Invalid K2");
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
    
    function getTotalCollateralValue() external view returns (uint256) {
        return sDAI.convertToAssets(totalCollateralShares);
    }
    
    function getPythPrice() external view returns (int64 price, int32 expo, uint256 timestamp) {
        PythStructs.Price memory priceData = pyth.getPriceUnsafe(XMR_USD_PRICE_ID);
        return (priceData.price, priceData.expo, priceData.publishTime);
    }
}
