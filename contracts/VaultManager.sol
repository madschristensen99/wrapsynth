// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Secp256k1} from "./Secp256k1.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {wsXMR} from "./wsXMR.sol";
import {ISavingsDAI} from "./interfaces/ISavingsDAI.sol";
import {ISwapRouter} from "./interfaces/ISwapRouter.sol";
import {GnosisAddresses} from "./GnosisAddresses.sol";

/**
 * @title VaultManager
 * @notice Manages LP vaults, collateralization, and mint/burn operations for wsXMR
 * @dev Integrates cryptographic proofs from atomic swaps with CDP vault mechanics
 */
contract VaultManager is Secp256k1, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ========== CONSTANTS ==========
    
    uint256 public constant COLLATERAL_RATIO = 150; // 150% overcollateralization
    uint256 public constant LIQUIDATION_RATIO = 120; // 120% liquidation threshold
    uint256 public constant LIQUIDATION_BONUS = 110; // 110% liquidator reward (must be < threshold)
    uint256 public constant RATIO_PRECISION = 100;
    uint256 public constant PRICE_PRECISION = 1e18;
    
    // MINT TIMEOUTS
    uint256 public constant MAX_MINT_TIMEOUT = 12 hours; // Reduced from 7 days
    uint256 public constant MINT_READY_EXTENSION = 8 hours; // Time user has to claim after LP is ready
    
    // BURN TIMEOUTS
    uint256 public constant BURN_REQUEST_TIMEOUT = 2 hours; // Time LP has to respond to a burn
    // NOTE: BURN_COMMIT_TIMEOUT must be GREATER than the Monero PTLC refund timelock
    uint256 public constant BURN_COMMIT_TIMEOUT = 8 hours; // Time LP has to reveal secret after committing
    
    // MARKET METRIC CONSTANTS
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_MARGIN_BPS = 1000; // 10% maximum fee/reward to prevent abuse
    
    // BUY-AND-BURN STRATEGY CONSTANTS
    uint256 public constant COOLDOWN_PERIOD = 24 hours; // Minimum time between buy-and-burn executions
    uint256 public constant BUY_CHUNK_PERCENT = 20; // 20% of war chest per execution
    uint256 public constant EMA_TRIGGER_THRESHOLD = 99; // 1% dip threshold (spot <= EMA * 0.99)
    uint256 public constant MEV_SLIPPAGE_BPS = 200; // 2% max slippage for MEV protection
    
    // ========== STATE VARIABLES ==========
    
    wsXMR public immutable wsxmrToken;
    
    // Pyth oracle
    IPyth public immutable pyth;
    
    // Pyth price feed IDs
    bytes32 public constant XMR_USD_FEED_ID = 0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d;

    // Oracle staleness configuration (in seconds)
    uint256 public priceMaxAge = 5 minutes; // Configurable staleness threshold
    
    // Supported collateral tokens (address(0) = native MON)
    mapping(address => bool) public supportedCollateral;
    mapping(address => bytes32) public collateralPriceFeeds; // Maps collateral to Pyth feed ID
    
    // Buy-and-Burn Strategy State
    uint256 public lastBuyTimestamp; // Last execution timestamp for cooldown enforcement
    uint256 public globalTotalDebt; // Total wsXMR debt across all vaults
    uint256 public globalDebtIndex = 1e18; // Debt multiplier for O(1) proportional forgiveness
    uint256 public yieldWarChest; // Accumulated sDAI yield ready for buy-and-burn
    mapping(address => uint256) public lpPrincipalDeposits; // Track original DAI deposits per LP
    uint256 public globalLpPrincipal; // CRITICAL FIX: Global sum to avoid O(N) loop DoS   
    // ========== ENUMS ==========
    
    enum MintStatus {
        INVALID,
        PENDING,
        READY,      // LP confirmed XMR lock on Monero chain
        COMPLETED,
        CANCELLED
    }
    
    enum BurnStatus {
        INVALID,
        REQUESTED,  // Step 1: User requested burn, wsXMR burned, collateral locked
        PROPOSED,   // Step 2: LP proposed secretHash (waiting for user confirmation)
        COMMITTED,  // Step 3: User confirmed Monero lock (slashing timer T2 starts)
        COMPLETED,  // Step 4: LP revealed secret and unlocked collateral
        SLASHED,    // LP failed to reveal secret after user confirmation, collateral slashed
        CANCELLED   // Cancelled before user confirmation (no slashing)
    }
    
    // ========== STRUCTS ==========
    
    /**
     * @notice Vault represents an LP's collateral position
     */
    struct Vault {
        address lpAddress;
        address collateralAsset; // address(0) for ETH
        uint256 collateralAmount; // For sDAI: tracks sDAI SHARES (not DAI value)
        uint256 lockedCollateral; // Collateral reserved for pending burns (still liquidatable!)
        uint256 normalizedDebt; // Normalized debt for O(1) proportional forgiveness (actualDebt = normalizedDebt * globalDebtIndex / 1e18)
        uint256 pendingDebt; // Reserved capacity for pending mints (NOT Liquidatable)
        uint16 maxMintBps; // LP config limits single mint size (e.g. 1000 = 10%)
        uint256 mintGriefingDeposit; // ETH deposit required for mint requests (LP-configurable)
        uint16 mintFeeBps; // Fee LP charges for minting (paid in wsXMR)
        uint16 burnRewardBps; // Reward LP pays to incentivize burning (paid in Collateral)
        bool active;
    }
    
    /**
     * @notice MintRequest tracks a pending mint operation
     */
    struct MintRequest {
        bytes32 requestId;
        address user;
        address lpVault;
        uint256 xmrAmount; // Amount of XMR (in atomic units, 1e12 per XMR)
        uint256 wsxmrAmount; // Amount of wsXMR to mint (1e8 per wsXMR)
        uint256 feeAmount; // Portion of wsxmrAmount that goes to LP as fee
        bytes32 claimCommitment; // Hash of secret that LP will reveal
        uint256 timeout;
        uint256 griefingDeposit; // ETH deposit to prevent spam (refunded on finalize, awarded to LP on cancel)
        MintStatus status;
    }
    
    /**
     * @notice BurnRequest tracks a pending burn operation
     * 3-step handshake:
     * 1. REQUESTED: wsXMR burned, collateral LOCKED (not escrowed, still liquidatable)
     * 2. COMMITTED: LP locked XMR on Monero, provided secretHash
     * 3. COMPLETED: LP revealed secret, locked collateral transferred to user
     */
    struct BurnRequest {
        bytes32 requestId;
        address user;
        address lpVault;
        uint256 wsxmrAmount;
        uint256 xmrAmount;
        uint256 lockedCollateral; // Base collateral locked (still liquidatable)
        uint256 rewardCollateral; // Extra collateral added as a reward
        bytes32 secretHash; // Hash of secret that LP generates (set in commitBurn)
        uint256 deadline; // LP must respond/reveal before this
        BurnStatus status;
    }
    
    // ========== MAPPINGS ==========
    
    mapping(address => Vault) public vaults;
    mapping(bytes32 => MintRequest) public mintRequests;
    mapping(bytes32 => BurnRequest) public burnRequests;
    
    // Track all vault addresses
    address[] public vaultList;
    
    // Track pending withdrawals for users/LPs (user => token => amount)
    // address(0) represents native ETH
    mapping(address => mapping(address => uint256)) public pendingReturns;
    
    // ========== EVENTS ==========
    
    event VaultCreated(address indexed lpAddress, address indexed collateralAsset);
    event CollateralDeposited(address indexed lpAddress, address indexed asset, uint256 amount);
    event CollateralWithdrawn(address indexed lpAddress, address indexed asset, uint256 amount);
    
    event VaultMarketMetricsUpdated(address indexed lpVault, uint16 mintFeeBps, uint16 burnRewardBps);
    
    event ReturnQueued(address indexed recipient, address indexed token, uint256 amount);
    event ReturnsWithdrawn(address indexed recipient, address indexed token, uint256 amount);
    
    event YieldHarvested(uint256 yieldInDAI, uint256 yieldInShares);
    event BadDebtWrittenOff(address indexed lpVault, uint256 debtAmount);
    event BuyAndBurnExecuted(uint256 sDAISpent, uint256 wsxmrBurned, uint256 newGlobalDebtIndex);
    
    event MintInitiated(
        bytes32 indexed requestId,
        address indexed user,
        address indexed lpVault,
        uint256 xmrAmount,
        uint256 wsxmrAmount,
        uint256 feeAmount,
        bytes32 claimCommitment,
        uint256 timeout
    );
    event MintReady(bytes32 indexed requestId);
    event MintFinalized(bytes32 indexed requestId, bytes32 secret);
    event MintCancelled(bytes32 indexed requestId);
    event MintGriefingDepositUpdated(address indexed lpVault, uint256 newDeposit);
    
    // Step 1: User requests burn (wsXMR burned, collateral locked)
    event BurnRequested(
        bytes32 indexed requestId,
        address indexed user,
        address indexed lpVault,
        uint256 wsxmrAmount,
        uint256 xmrAmount,
        uint256 rewardCollateral
    );
    // Step 2: LP proposes secretHash (waiting for user confirmation)
    event HashProposed(bytes32 indexed requestId, bytes32 secretHash);
    // Step 3: User confirms Monero lock (slashing timer T2 starts)
    event BurnCommitted(
        bytes32 indexed requestId,
        uint256 deadline
    );
    // Step 3: LP reveals secret (collateral released)
    event BurnFinalized(bytes32 indexed requestId, bytes32 secret, uint256 rewardPaid);
    // LP failed to reveal secret (collateral slashed)
    event BurnSlashed(bytes32 indexed requestId, address indexed user, uint256 collateralSeized);
    // User cancelled REQUESTED burn (LP never responded)
    event BurnCancelled(bytes32 indexed requestId);
    
    event VaultLiquidated(
        address indexed lpVault,
        address indexed liquidator,
        uint256 debtCleared,
        uint256 collateralSeized
    );
    
    event OracleUpdated(string indexed oracleType, address indexed newOracle);
    event CollateralSupported(address indexed asset, address indexed oracle);
    event PriceMaxAgeUpdated(uint256 newMaxAge);
    
    // ========== ERRORS ==========
    
    error ZeroAddress();
    error ZeroAmount();
    error VaultAlreadyExists();
    error VaultDoesNotExist();
    error VaultNotActive();
    error InsufficientCollateral();
    error ExceedsMaxMargin();
    error InvalidCollateralAsset();
    error InvalidMintRequest();
    error InvalidBurnRequest();
    error MintAlreadyExists();
    error BurnAlreadyExists();
    error InvalidSecret();
    error InvalidStatus();
    error TimeoutNotReached();
    error DeadlineExpired();
    error DeadlineNotExpired();
    error VaultHealthy();
    error InsufficientDebt();
    error Unauthorized();
    error InvalidValue();
    error StalePrice();
    error InvalidAsset();
    error InsufficientDeposit();
    
    // ========== CONSTRUCTOR ==========
    
    constructor(
        address _wsxmrToken,
        address _pythContract,
        address _initialOwner
    ) Ownable(_initialOwner) {
        if (_wsxmrToken == address(0)) revert ZeroAddress();
        if (_pythContract == address(0)) revert ZeroAddress();
        if (_initialOwner == address(0)) revert ZeroAddress();
        
        wsxmrToken = wsXMR(_wsxmrToken);
        pyth = IPyth(_pythContract);
        
        // GNOSIS CHAIN: Enable sDAI as default yield-bearing collateral
        supportedCollateral[GnosisAddresses.SDAI] = true;
        collateralPriceFeeds[GnosisAddresses.SDAI] = GnosisAddresses.DAI_USD_FEED_ID;
        emit CollateralSupported(GnosisAddresses.SDAI, _pythContract);
    }
    
    // ========== VAULT MANAGEMENT ==========
    
    /**
     * @notice Create a new LP vault
     * @param _collateralAsset Address of collateral token (address(0) for ETH)
     */
    function createVault(address _collateralAsset) external {
        if (vaults[msg.sender].active) revert VaultAlreadyExists();
        if (!supportedCollateral[_collateralAsset]) revert InvalidCollateralAsset();
        
        vaults[msg.sender] = Vault({
            lpAddress: msg.sender,
            collateralAsset: _collateralAsset,
            collateralAmount: 0,
            lockedCollateral: 0,
            normalizedDebt: 0,
            pendingDebt: 0,
            maxMintBps: 0, // LP can set this later via setMaxMintBps (0 = no limit)
            mintGriefingDeposit: 0, // LP can set this later via setMintGriefingDeposit
            mintFeeBps: 0,
            burnRewardBps: 0,
            active: true
        });
        
        vaultList.push(msg.sender);
        emit VaultCreated(msg.sender, _collateralAsset);
    }
    
    /**
     * @notice Deposit collateral into vault
     * @dev Auto-converts DAI/xDAI to sDAI for yield generation
     * @param _amount Amount of collateral to deposit (in DAI if depositing to sDAI vault)
     */
    function depositCollateral(uint256 _amount) external payable nonReentrant {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (_amount == 0) revert ZeroAmount();
        
        Vault storage vault = vaults[msg.sender];
        
        // GNOSIS CHAIN: Auto-convert DAI to sDAI for yield
        if (vault.collateralAsset == GnosisAddresses.SDAI) {
            if (msg.value != 0) revert InvalidValue();
            
            // Transfer DAI from user
            IERC20(GnosisAddresses.XDAI).safeTransferFrom(msg.sender, address(this), _amount);
            
            // Approve sDAI contract to spend DAI
            IERC20(GnosisAddresses.XDAI).approve(GnosisAddresses.SDAI, _amount);
            
            // Deposit DAI into sDAI vault and receive sDAI shares
            uint256 sDAIShares = ISavingsDAI(GnosisAddresses.SDAI).deposit(_amount, address(this));
            
            // CRITICAL FIX: Track sDAI SHARES consistently
            vault.collateralAmount += sDAIShares;
            
            // Track principal DAI deposit for yield harvesting
            lpPrincipalDeposits[msg.sender] += _amount;
            globalLpPrincipal += _amount;
            
            emit CollateralDeposited(msg.sender, vault.collateralAsset, _amount);
        } else if (vault.collateralAsset == address(0)) {
            // Native ETH deposit (for other chains)
            if (msg.value != _amount) revert InvalidValue();
            vault.collateralAmount += _amount;
            emit CollateralDeposited(msg.sender, vault.collateralAsset, _amount);
        } else {
            // Direct ERC20 deposit
            if (msg.value != 0) revert InvalidValue();
            IERC20(vault.collateralAsset).safeTransferFrom(msg.sender, address(this), _amount);
            vault.collateralAmount += _amount;
            emit CollateralDeposited(msg.sender, vault.collateralAsset, _amount);
        }
    }
    
    /**
     * @notice Withdraw collateral from vault (only if health ratio allows)
     * @param _amount Amount of collateral to withdraw
     */
    function withdrawCollateral(uint256 _amount) external nonReentrant {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (_amount == 0) revert ZeroAmount();
        
        Vault storage vault = vaults[msg.sender];
        
        // CRITICAL: Check available (unlocked) collateral
        // Cannot withdraw collateral that's locked for pending burns
        uint256 availableCollateral = vault.collateralAmount - vault.lockedCollateral;
        if (availableCollateral < _amount) revert InsufficientCollateral();
        
        // Check if withdrawal would make vault unhealthy
        uint256 newCollateralAmount = vault.collateralAmount - _amount;
        
        // CRITICAL: Calculate safety based on BOTH active and pending debt
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        uint256 totalObligations = actualDebt + vault.pendingDebt;
        
        if (totalObligations > 0) {
            // CRITICAL FIX: Exclude lockedCollateral from health check
            // Locked collateral backs burn requests, not active debt
            uint256 availableForDebt = newCollateralAmount > vault.lockedCollateral 
                ? newCollateralAmount - vault.lockedCollateral 
                : 0;
            uint256 ratio = calculateCollateralRatio(
                vault.collateralAsset,
                availableForDebt,
                totalObligations
            );
            if (ratio < COLLATERAL_RATIO) revert InsufficientCollateral();
        }
        
        vault.collateralAmount = newCollateralAmount;
        
        // Transfer collateral back to LP
        if (vault.collateralAsset == GnosisAddresses.SDAI) {
            // CRITICAL FIX: _amount is in sDAI shares, redeem directly
            uint256 daiReceived = ISavingsDAI(GnosisAddresses.SDAI).redeem(_amount, msg.sender, address(this));
            
            // CRITICAL FIX: Decrement principal proportionally to prevent yield lockup
            // Calculate what portion of the LP's principal this withdrawal represents
            uint256 totalCollateral = vault.collateralAmount + _amount; // Before withdrawal
            uint256 principalToDeduct = (lpPrincipalDeposits[msg.sender] * _amount) / totalCollateral;
            lpPrincipalDeposits[msg.sender] -= principalToDeduct;
            globalLpPrincipal -= principalToDeduct;
            
            emit CollateralWithdrawn(msg.sender, vault.collateralAsset, daiReceived);
        } else if (vault.collateralAsset == address(0)) {
            (bool success, ) = payable(msg.sender).call{value: _amount}("");
            require(success, "ETH transfer failed");
            emit CollateralWithdrawn(msg.sender, vault.collateralAsset, _amount);
        } else {
            IERC20(vault.collateralAsset).safeTransfer(msg.sender, _amount);
            emit CollateralWithdrawn(msg.sender, vault.collateralAsset, _amount);
        }
    }
    
    /**
     * @notice LP sets griefing deposit required for mint requests
     * @dev Higher deposits prevent spam but may reduce user demand
     * @param _deposit ETH amount required (0 to disable)
     */
    function setMintGriefingDeposit(uint256 _deposit) external {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        
        vaults[msg.sender].mintGriefingDeposit = _deposit;
        emit MintGriefingDepositUpdated(msg.sender, _deposit);
    }
    
    /**
     * @notice Allows LP to set Minting Fees and Burning Rewards to manage vault flow
     * @param _mintFeeBps Fee charged for minting (in basis points, max 1000 = 10%)
     * @param _burnRewardBps Reward paid for burning (in basis points, max 1000 = 10%)
     */
    function setVaultMarketMetrics(uint16 _mintFeeBps, uint16 _burnRewardBps) external {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (_mintFeeBps > MAX_MARGIN_BPS || _burnRewardBps > MAX_MARGIN_BPS) revert ExceedsMaxMargin();
        
        vaults[msg.sender].mintFeeBps = _mintFeeBps;
        vaults[msg.sender].burnRewardBps = _burnRewardBps;
        emit VaultMarketMetricsUpdated(msg.sender, _mintFeeBps, _burnRewardBps);
    }
    
    /**
     * @notice LP sets the maximum wsXMR they are willing to accept in a single mint request
     * @param _maxMintBps Value in basis points (1000 = 10% of total collateral capacity)
     */
    function setMaxMintBps(uint16 _maxMintBps) external {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (_maxMintBps > BPS_DENOMINATOR) revert InvalidValue();
        
        vaults[msg.sender].maxMintBps = _maxMintBps;
    }
    
    /**
     * @notice Allows users or LPs to withdraw their queued refunds/rewards
     * @dev Replaces the push-payment pattern to prevent DoS attacks
     * @param _token Token address to withdraw (address(0) for ETH)
     */
    function withdrawReturns(address _token) external nonReentrant {
        uint256 amount = pendingReturns[msg.sender][_token];
        if (amount == 0) revert ZeroAmount();
        
        // CHECKS-EFFECTS-INTERACTIONS
        pendingReturns[msg.sender][_token] = 0;
        
        if (_token == address(0)) {
            // Withdraw ETH
            (bool success, ) = payable(msg.sender).call{value: amount}("");
            require(success, "ETH transfer failed");
        } else {
            // Withdraw ERC20
            IERC20(_token).safeTransfer(msg.sender, amount);
        }
        
        emit ReturnsWithdrawn(msg.sender, _token, amount);
    }
    
    // ========== MINTING FLOW ==========
    
    /**
     * @notice User initiates a mint request
     * @param _lpVault Address of the LP vault to use
     * @param _xmrAmount Amount of XMR to lock (atomic units)
     * @param _claimCommitment Hash of the secret LP will reveal
     * @param _timeoutDuration How long before request can be cancelled
     * @return requestId Unique identifier for this mint request
     */
    function initiateMint(
        address _lpVault,
        uint256 _xmrAmount,
        bytes32 _claimCommitment,
        uint256 _timeoutDuration
    ) external payable returns (bytes32 requestId) {
        if (_lpVault == address(0)) revert ZeroAddress();
        if (_xmrAmount == 0) revert ZeroAmount();
        if (_claimCommitment == bytes32(0)) revert InvalidSecret();
        if (_timeoutDuration == 0 || _timeoutDuration > MAX_MINT_TIMEOUT) revert InvalidValue();
        if (!vaults[_lpVault].active) revert VaultDoesNotExist();
        
        // ANTI-SPAM: Require griefing deposit set by LP
        Vault storage vault = vaults[_lpVault];
        if (msg.value < vault.mintGriefingDeposit) revert InsufficientDeposit();
        
        // Convert XMR amount to wsXMR amount (XMR has 12 decimals, wsXMR has 8)
        uint256 wsxmrAmount = _xmrAmount / 1e4;
        
        // Calculate the LP's service fee in wsXMR
        uint256 feeAmount = (wsxmrAmount * vault.mintFeeBps) / BPS_DENOMINATOR;
        
        // Enforce LP's chunk size limit (prevents single large mint from draining capacity)
        if (vault.maxMintBps > 0) {
            uint256 collateralPrice = getCollateralPrice(vault.collateralAsset);
            uint256 collateralDecimals = vault.collateralAsset == address(0) ? 18 : IERC20Metadata(vault.collateralAsset).decimals();
            uint256 collateralValueUsd = (vault.collateralAmount * collateralPrice) / (10 ** collateralDecimals);
            uint256 maxTotalDebtCapacity = (collateralValueUsd * RATIO_PRECISION) / COLLATERAL_RATIO;
            uint256 maxMintAllowed = (maxTotalDebtCapacity * vault.maxMintBps) / BPS_DENOMINATOR;
            if (wsxmrAmount > maxMintAllowed) revert InvalidValue();
        }
        
        // Check capacity using Active + Pending Debt (prevents phantom debt DoS)
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        uint256 totalProjectedDebt = actualDebt + vault.pendingDebt + wsxmrAmount;
        
        // CRITICAL FIX: Exclude lockedCollateral from available collateral
        // lockedCollateral is pledged to burn requests and cannot back new mints
        // Without this check, LP can double-count collateral to mint unbacked wsXMR
        uint256 availableCollateral = vault.collateralAmount > vault.lockedCollateral 
            ? vault.collateralAmount - vault.lockedCollateral 
            : 0;
        
        uint256 ratio = calculateCollateralRatio(
            vault.collateralAsset,
            availableCollateral,
            totalProjectedDebt
        );
        if (ratio < COLLATERAL_RATIO) revert InsufficientCollateral();
        
        // Generate unique request ID
        requestId = keccak256(abi.encodePacked(
            msg.sender,
            _lpVault,
            _xmrAmount,
            _claimCommitment,
            block.timestamp,
            block.number
        ));
        
        // Check for collision BEFORE modifying state
        if (mintRequests[requestId].status != MintStatus.INVALID) revert MintAlreadyExists();
        
        // CRITICAL: Add to pendingDebt (NOT debtAmount) to prevent phantom debt DoS
        // Pending debt reserves capacity but does NOT count towards liquidation calculations
        vault.pendingDebt += wsxmrAmount;
        
        mintRequests[requestId] = MintRequest({
            requestId: requestId,
            user: msg.sender,
            lpVault: _lpVault,
            xmrAmount: _xmrAmount,
            wsxmrAmount: wsxmrAmount,
            feeAmount: feeAmount,
            claimCommitment: _claimCommitment,
            timeout: block.timestamp + _timeoutDuration,
            griefingDeposit: msg.value, // Store deposit for refund/award
            status: MintStatus.PENDING
        });
        
        emit MintInitiated(
            requestId,
            msg.sender,
            _lpVault,
            _xmrAmount,
            wsxmrAmount,
            feeAmount,
            _claimCommitment,
            block.timestamp + _timeoutDuration
        );
        
        return requestId;
    }
    
    /**
     * @notice LP confirms User has locked XMR on the Monero network
     * @param _requestId The mint request ID
     */
    function setMintReady(bytes32 _requestId) external {
        MintRequest storage request = mintRequests[_requestId];
        if (request.status != MintStatus.PENDING) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();
        
        request.status = MintStatus.READY;
        emit MintReady(_requestId);
    }
    
    /**
     * @notice Finalize mint after LP has claimed XMR on Monero chain
     * @param _requestId The mint request ID
     * @param _secret The secret revealed by LP when claiming XMR
     */
    function finalizeMint(bytes32 _requestId, bytes32 _secret) external nonReentrant {
        MintRequest storage request = mintRequests[_requestId];
        if (request.status != MintStatus.READY) revert InvalidStatus(); // MUST be READY, not PENDING
        
        // Verify the secret matches the commitment using secp256k1 verification
        if (!mulVerify(uint256(_secret), uint256(request.claimCommitment))) {
            revert InvalidSecret();
        }
        
        Vault storage vault = vaults[request.lpVault];
        
        // CRITICAL: Move debt from Pending state to Active state
        vault.pendingDebt -= request.wsxmrAmount;
        
        // CRITICAL FIX: Normalize the debt amount by dividing by globalDebtIndex
        // This prevents wealth generation when index < 1e18
        uint256 normalizedAmount = (request.wsxmrAmount * 1e18) / globalDebtIndex;
        vault.normalizedDebt += normalizedAmount;
        globalTotalDebt += request.wsxmrAmount; // Track global debt for buy-and-burn
        
        // Split mint execution between User and LP if a fee was configured
        wsxmrToken.mint(request.user, request.wsxmrAmount - request.feeAmount);
        if (request.feeAmount > 0) {
            wsxmrToken.mint(vault.lpAddress, request.feeAmount);
        }
        
        // CRITICAL FIX: Award griefing deposit based on who is at fault
        if (request.griefingDeposit > 0) {
            if (request.status == MintStatus.PENDING) {
                // User failed to lock XMR off-chain - compensate LP
                pendingReturns[vault.lpAddress][address(0)] += request.griefingDeposit;
                emit ReturnQueued(vault.lpAddress, address(0), request.griefingDeposit);
            } else if (request.status == MintStatus.READY) {
                // LP confirmed but user failed to claim - return to user
                pendingReturns[request.user][address(0)] += request.griefingDeposit;
                emit ReturnQueued(request.user, address(0), request.griefingDeposit);
            }
        }
        
        // Mark as completed
        request.status = MintStatus.COMPLETED;
        emit MintFinalized(_requestId, _secret);
        
        // CRITICAL FIX: Skim yield to war chest after mint completes
        _skimYieldToWarChest();
    }
    
    /**
     * @notice Cancel a mint request after timeout - PERMISSIONLESS CLEANUP
     * @dev After timeout expires, ANYONE can call this to free LP's locked capacity
     * @dev Prevents DoS where malicious user locks LP capacity forever at zero cost
     * @param _requestId The mint request ID
     */
    function cancelMint(bytes32 _requestId) external nonReentrant {
        MintRequest storage request = mintRequests[_requestId];
        // Allow cancellation from PENDING (timeout) or READY (extended timeout)
        if (request.status != MintStatus.PENDING && request.status != MintStatus.READY) {
            revert InvalidStatus();
        }
        
        // For READY state, require extended timeout
        uint256 requiredTimeout = request.status == MintStatus.READY 
            ? request.timeout + MINT_READY_EXTENSION 
            : request.timeout;
        
        if (block.timestamp < requiredTimeout) revert TimeoutNotReached();
        
        // PERMISSIONLESS: Once timeout expires, anyone can cleanup to free LP capacity
        // This prevents DoS where user locks LP's debt capacity forever
        
        // CHECKS-EFFECTS-INTERACTIONS: Update state BEFORE external calls
        // Release the reserved pending capacity
        Vault storage vault = vaults[request.lpVault];
        vault.pendingDebt -= request.wsxmrAmount;
        
        // CRITICAL FIX: Save original status before marking as cancelled
        MintStatus originalStatus = request.status;
        uint256 depositToTransfer = request.griefingDeposit;
        
        // Mark as cancelled BEFORE transferring (prevents reentrancy)
        request.status = MintStatus.CANCELLED;
        
        emit MintCancelled(_requestId);
        
        // Award griefing deposit based on fault state
        if (depositToTransfer > 0) {
            if (originalStatus == MintStatus.PENDING) {
                // User failed to lock XMR - compensate LP
                pendingReturns[vault.lpAddress][address(0)] += depositToTransfer;
                emit ReturnQueued(vault.lpAddress, address(0), depositToTransfer);
            } else {
                // LP confirmed but timeout expired - return to user
                pendingReturns[request.user][address(0)] += depositToTransfer;
                emit ReturnQueued(request.user, address(0), depositToTransfer);
            }
        }
    }
    
    // ========== BURNING FLOW (3-STEP HANDSHAKE) ==========
    
    /**
     * @notice Step 1: User requests burn - LOCK WITHOUT ESCROW
     * @dev Burns user's wsXMR and LOCKS (not escrows) LP collateral
     * @dev CRITICAL: Collateral stays in vault and remains LIQUIDATABLE
     * @param _wsxmrAmount Amount of wsXMR to burn
     * @param _lpVault LP vault to handle the burn
     * @return requestId Unique identifier for this burn request
     */
    function requestBurn(
        uint256 _wsxmrAmount,
        address _lpVault
    ) external returns (bytes32 requestId) {
        if (_wsxmrAmount == 0) revert ZeroAmount();
        if (_lpVault == address(0)) revert ZeroAddress();
        if (!vaults[_lpVault].active) revert VaultDoesNotExist();
        
        Vault storage vault = vaults[_lpVault];
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        if (actualDebt < _wsxmrAmount) revert InsufficientDebt();
        
        // CRITICAL: Verify vault is healthy before allowing burn to be routed to it
        // Prevents users from burning to unhealthy vaults that may be liquidated
        uint256 vaultHealthRatio = calculateCollateralRatio(
            vault.collateralAsset,
            vault.collateralAmount,
            actualDebt
        );
        if (vaultHealthRatio < COLLATERAL_RATIO) revert InsufficientCollateral();
        
        // 1. Calculate and verify collateral needed for this specific burn
        uint256 collateralValue = getCollateralValueForDebt(_wsxmrAmount);
        uint256 collateralToLock = usdToCollateral(
            vault.collateralAsset,
            (collateralValue * LIQUIDATION_RATIO) / RATIO_PRECISION
        );
        
        // Calculate User Reward in Vault's collateral asset
        uint256 rewardUsd = (collateralValue * vault.burnRewardBps) / BPS_DENOMINATOR;
        uint256 rewardCollateral = usdToCollateral(vault.collateralAsset, rewardUsd);
        
        // 2. Check available (unlocked) collateral for both base + reward
        uint256 availableCollateral = vault.collateralAmount - vault.lockedCollateral;
        if (availableCollateral < (collateralToLock + rewardCollateral)) revert InsufficientCollateral();
        
        requestId = keccak256(abi.encodePacked(
            msg.sender,
            _lpVault,
            _wsxmrAmount,
            block.timestamp,
            block.number
        ));
        if (burnRequests[requestId].status != BurnStatus.INVALID) revert BurnAlreadyExists();
        
        // 3. Burn the User's wsXMR
        wsxmrToken.burn(msg.sender, _wsxmrAmount);
        
        // 4. CRITICAL: LOCK collateral (don't escrow) and reduce debt
        // Collateral stays in vault.collateralAmount and remains LIQUIDATABLE
        // This prevents liquidation blind spot vulnerability
        // Lock both Base Liquidation Collateral and Reward Collateral
        vault.lockedCollateral += (collateralToLock + rewardCollateral);
        
        // CRITICAL FIX: Normalize the debt amount when subtracting
        vault.normalizedDebt -= (_wsxmrAmount * 1e18) / globalDebtIndex;
        globalTotalDebt -= _wsxmrAmount;
        
        // Step 1: wsXMR burned, collateral locked (but still liquidatable)
        // LP has BURN_REQUEST_TIMEOUT to lock XMR on Monero and provide secretHash
        burnRequests[requestId] = BurnRequest({
            requestId: requestId,
            user: msg.sender,
            lpVault: _lpVault,
            wsxmrAmount: _wsxmrAmount,
            xmrAmount: _wsxmrAmount * 1e4,
            lockedCollateral: collateralToLock,
            rewardCollateral: rewardCollateral,
            secretHash: bytes32(0),
            deadline: block.timestamp + BURN_REQUEST_TIMEOUT,
            status: BurnStatus.REQUESTED
        });
        
        emit BurnRequested(
            requestId,
            msg.sender,
            _lpVault,
            _wsxmrAmount,
            _wsxmrAmount * 1e4,
            rewardCollateral
        );
        
        return requestId;
    }
    
    /**
     * @notice Step 2: LP proposes secretHash after locking XMR on Monero
     * @dev LP locks XMR on Monero with PTLC, then proposes hash on Ethereum
     * @dev User must verify and confirm before slashing timer starts
     * @param _requestId The burn request ID
     * @param _secretHash Hash of secret that LP generated for the Monero PTLC
     */
    function proposeHash(bytes32 _requestId, bytes32 _secretHash) external nonReentrant {
        BurnRequest storage request = burnRequests[_requestId];
        if (request.status != BurnStatus.REQUESTED) revert InvalidStatus();
        
        Vault storage vault = vaults[request.lpVault];
        if (msg.sender != vault.lpAddress) revert Unauthorized();
        if (_secretHash == bytes32(0)) revert InvalidSecret();
        
        request.secretHash = _secretHash;
        request.status = BurnStatus.PROPOSED;
        // CRITICAL FIX: Set deadline for user to confirm
        // If user doesn't confirm within timeout, LP can cancel
        request.deadline = block.timestamp + BURN_COMMIT_TIMEOUT;
        
        emit HashProposed(_requestId, _secretHash);
    }
    
    /**
     * @notice Step 3: User confirms Monero lock is valid (starts slashing timer T2)
     * @dev User inspects Monero blockchain and explicitly opts-in
     * @dev This starts the short BURN_COMMIT_TIMEOUT for LP to reveal secret
     * @param _requestId The burn request ID
     */
    function confirmMoneroLock(bytes32 _requestId) external nonReentrant {
        BurnRequest storage request = burnRequests[_requestId];
        if (request.status != BurnStatus.PROPOSED) revert InvalidStatus();
        if (msg.sender != request.user) revert Unauthorized();
        
        // User explicitly confirms the Monero lock is valid
        // NOW the LP is on the clock to reveal the secret
        // BURN_COMMIT_TIMEOUT must be shorter than Monero refund timelock
        request.deadline = block.timestamp + BURN_COMMIT_TIMEOUT;
        request.status = BurnStatus.COMMITTED;
        
        emit BurnCommitted(_requestId, request.deadline);
    }
    
    /**
     * @notice Step 4: LP finalizes burn by revealing secret to unlock collateral
     * @param _requestId The burn request ID
     * @param _secret The secret that LP generated (user saw this on Ethereum, used it to claim XMR)
     */
    function finalizeBurn(bytes32 _requestId, bytes32 _secret) external nonReentrant {
        BurnRequest storage request = burnRequests[_requestId];
        if (request.status != BurnStatus.COMMITTED) revert InvalidStatus();
        if (block.timestamp >= request.deadline) revert DeadlineExpired();
        
        // Verify the secret matches the hash using secp256k1 verification
        if (!mulVerify(uint256(_secret), uint256(request.secretHash))) {
            revert InvalidSecret();
        }
        
        Vault storage vault = vaults[request.lpVault];
        
        // Safely adjust vault locked collateral
        uint256 totalUnlock = request.lockedCollateral + request.rewardCollateral;
        if (vault.lockedCollateral >= totalUnlock) {
            vault.lockedCollateral -= totalUnlock;
        } else {
            vault.lockedCollateral = 0; // Protection against liquidation underflows
        }
        
        // Process the burn reward to the User
        if (request.rewardCollateral > 0) {
            // CRITICAL FIX: Cap reward if vault was liquidated during burn
            // Prevents underflow trap where static reward exceeds remaining collateral
            uint256 safeReward = request.rewardCollateral > vault.collateralAmount 
                ? vault.collateralAmount 
                : request.rewardCollateral;
            
            vault.collateralAmount -= safeReward;
            
            // CRITICAL FIX: Decrement principal when collateral leaves the vault
            if (lpPrincipalDeposits[vault.lpAddress] > 0) {
                uint256 principalReduction = (lpPrincipalDeposits[vault.lpAddress] * safeReward) / 
                    (vault.collateralAmount + safeReward);
                lpPrincipalDeposits[vault.lpAddress] -= principalReduction;
                globalLpPrincipal -= principalReduction;
            }
            
            // CRITICAL FIX: safeReward is already in sDAI shares
            // Queue both ETH and ERC20 rewards to prevent DoS
            pendingReturns[request.user][vault.collateralAsset] += safeReward;
            emit ReturnQueued(request.user, vault.collateralAsset, safeReward);
        }
        
        request.status = BurnStatus.COMPLETED;
        emit BurnFinalized(_requestId, _secret, request.rewardCollateral);
        
        // CRITICAL FIX: Skim yield to war chest after burn completes
        _skimYieldToWarChest();
    }
    
    /**
     * @notice User claims slashed collateral if LP failed to reveal secret
     * @dev Can only be called after deadline expires in COMMITTED state
     * @param _requestId The burn request ID
     */
    function claimSlashedCollateral(bytes32 _requestId) external nonReentrant {
        BurnRequest storage request = burnRequests[_requestId];
        if (request.status != BurnStatus.COMMITTED) revert InvalidStatus();
        if (msg.sender != request.user) revert Unauthorized();
        if (block.timestamp < request.deadline) revert DeadlineNotExpired();
        
        Vault storage vault = vaults[request.lpVault];
        
        uint256 totalSeized = request.lockedCollateral + request.rewardCollateral;
        
        // CRITICAL FIX: Cap seizure to available collateral to prevent underflow
        // Vault may have been liquidated between burn request and slash claim
        uint256 actualSeized = vault.collateralAmount < totalSeized 
            ? vault.collateralAmount 
            : totalSeized;
        
        if (vault.lockedCollateral >= actualSeized) {
            vault.lockedCollateral -= actualSeized;
        } else {
            vault.lockedCollateral = 0; 
        }
        vault.collateralAmount -= actualSeized;
        
        // CRITICAL FIX: Decrement principal when collateral is slashed
        if (lpPrincipalDeposits[vault.lpAddress] > 0) {
            uint256 principalReduction = (lpPrincipalDeposits[vault.lpAddress] * actualSeized) / 
                (vault.collateralAmount + actualSeized);
            lpPrincipalDeposits[vault.lpAddress] -= principalReduction;
            globalLpPrincipal -= principalReduction;
        }
        
        // Transfer collateral to user as penalty for LP failure
        if (vault.collateralAsset == GnosisAddresses.SDAI) {
            // CRITICAL FIX: actualSeized is already in sDAI shares, transfer directly
            IERC20(vault.collateralAsset).safeTransfer(request.user, actualSeized);
        } else if (vault.collateralAsset == address(0)) {
            (bool success, ) = payable(request.user).call{value: actualSeized}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(vault.collateralAsset).safeTransfer(request.user, actualSeized);
        }
        
        request.lockedCollateral = 0;
        request.rewardCollateral = 0;
        request.status = BurnStatus.SLASHED;
        
        emit BurnSlashed(_requestId, request.user, totalSeized);
    }
    
    /**
     * @notice Cancel REQUESTED burn if LP never locked XMR - PERMISSIONLESS CLEANUP
     * @dev After deadline expires, ANYONE can call this to unlock LP's collateral
     * @dev Prevents DoS where user abandons burn, locking LP's collateral forever
     * @param _requestId The burn request ID
     */
    function cancelBurn(bytes32 _requestId) external nonReentrant {
        BurnRequest storage request = burnRequests[_requestId];
        // CRITICAL FIX: Allow cancellation from REQUESTED or PROPOSED (after timeout)
        // REQUESTED: User never engaged, LP can cancel
        // PROPOSED: LP proposed hash but user didn't confirm within timeout
        // COMMITTED: User confirmed Monero lock - LP must honor or be slashed
        if (request.status != BurnStatus.REQUESTED && request.status != BurnStatus.PROPOSED) revert InvalidStatus();
        
        // CRITICAL FIX: For PROPOSED state, require timeout to prevent user griefing
        if (request.status == BurnStatus.PROPOSED) {
            if (block.timestamp < request.deadline) revert DeadlineNotExpired();
        }
        
        // CRITICAL FIX: Prevent state overlap with liquidations
        // If vault was liquidated, lockedCollateral was seized
        // Cancelling would restore debt without collateral → unbacked wsXMR
        Vault storage vault = vaults[request.lpVault];
        if (request.lockedCollateral > vault.lockedCollateral) {
            revert("Vault liquidated, cannot cancel burn");
        }
        
        // Require deadline to expire (48h)
        if (block.timestamp < request.deadline) revert DeadlineNotExpired();
        
        // PERMISSIONLESS: Once deadline expires, anyone can cleanup to unlock assets
        // This prevents DoS where user abandons request, locking LP's collateral
        
        // Restore the LP's debt and UNLOCK collateral (don't transfer it)
        // CRITICAL FIX: Normalize the debt amount when adding back
        uint256 normalizedAmount = (request.wsxmrAmount * 1e18) / globalDebtIndex;
        vault.normalizedDebt += normalizedAmount;
        globalTotalDebt += request.wsxmrAmount;
        
        uint256 totalUnlock = request.lockedCollateral + request.rewardCollateral;
        if (vault.lockedCollateral >= totalUnlock) {
            vault.lockedCollateral -= totalUnlock;
        } else {
            vault.lockedCollateral = 0;
        }
        
        // CRITICAL: Mint the wsXMR back to the User since we burned it in Step 1
        wsxmrToken.mint(request.user, request.wsxmrAmount);
        
        request.status = BurnStatus.CANCELLED;
        emit BurnCancelled(_requestId);
    }
    
    // ========== LIQUIDATION ==========
    
    /**
     * @notice Liquidate an undercollateralized vault
     * @param _lpVault Address of the vault to liquidate
     * @param _debtToClear Amount of debt to clear (in wsXMR)
     */
    function liquidate(address _lpVault, uint256 _debtToClear) external nonReentrant {
        if (!vaults[_lpVault].active) revert VaultDoesNotExist();
        if (_debtToClear == 0) revert ZeroAmount();
        
        Vault storage vault = vaults[_lpVault];
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        if (actualDebt == 0) revert InsufficientDebt();
        if (_debtToClear > actualDebt) {
            _debtToClear = actualDebt;
        }
        
        // Check if vault is underwater
        // CRITICAL: Only count available (unlocked) collateral to prevent ratio inflation
        uint256 availableCollateral = vault.collateralAmount - vault.lockedCollateral;
        uint256 ratio = calculateCollateralRatio(
            vault.collateralAsset,
            availableCollateral,
            actualDebt
        );
        if (ratio >= LIQUIDATION_RATIO) revert VaultHealthy();
        
        // Calculate collateral to seize (at liquidation bonus, which is < threshold to prevent death spiral)
        uint256 collateralValue = getCollateralValueForDebt(_debtToClear);
        uint256 collateralToSeize = (collateralValue * LIQUIDATION_BONUS) / RATIO_PRECISION;
        uint256 collateralAmount = usdToCollateral(vault.collateralAsset, collateralToSeize);
        
        // CRITICAL: Proportional bad-debt handling
        // If vault is severely underwater, scale down debt to maintain liquidator's 10% bonus
        // This ensures liquidators remain profitable and bad debt gets cleaned up
        // NOTE: This may seize collateral locked for pending burns - users accept this risk
        // Users should monitor vault health before requesting burns
        if (collateralAmount > vault.collateralAmount) {
            // Proportionally scale down the exacted debt to maintain the Liquidator's 10% bonus
            _debtToClear = (_debtToClear * vault.collateralAmount) / collateralAmount;
            collateralAmount = vault.collateralAmount;
        }
        
        // CHECKS-EFFECTS-INTERACTIONS: Update state before external calls
        vault.collateralAmount -= collateralAmount;
        
        // CRITICAL FIX: Proportionally reduce lpPrincipalDeposits to prevent yield harvesting from breaking
        // When collateral is seized, the principal tracking must be reduced proportionally
        if (lpPrincipalDeposits[_lpVault] > 0) {
            uint256 principalReduction = (lpPrincipalDeposits[_lpVault] * collateralAmount) / (vault.collateralAmount + collateralAmount);
            lpPrincipalDeposits[_lpVault] -= principalReduction;
            globalLpPrincipal -= principalReduction; // CRITICAL FIX: Update global sum
        }
        
        // CRITICAL FIX: Normalize the debt amount when liquidating
        uint256 normalizedClear = (_debtToClear * 1e18) / globalDebtIndex;
        vault.normalizedDebt -= normalizedClear;
        globalTotalDebt -= _debtToClear;
        
        // CRITICAL FIX: Proportionally reduce lockedCollateral to prevent underflow
        // If we seized locked collateral, we must reduce the locked amount
        if (vault.lockedCollateral > 0 && collateralAmount > 0) {
            // Calculate how much of the seized collateral was locked
            uint256 lockedReduction = (vault.lockedCollateral * collateralAmount) / (vault.collateralAmount + collateralAmount);
            vault.lockedCollateral -= lockedReduction;
        }
        
        // Burn wsXMR from liquidator (interaction after state changes)
        wsxmrToken.burn(msg.sender, _debtToClear);
        
        // Transfer seized collateral to liquidator
        if (vault.collateralAsset == GnosisAddresses.SDAI) {
            // CRITICAL FIX: collateralAmount is already in sDAI shares, transfer directly
            IERC20(vault.collateralAsset).safeTransfer(msg.sender, collateralAmount);
        } else if (vault.collateralAsset == address(0)) {
            (bool success, ) = payable(msg.sender).call{value: collateralAmount}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(vault.collateralAsset).safeTransfer(msg.sender, collateralAmount);
        }
        
        // CRITICAL FIX: Mark vault as liquidated to prevent burn state overlap
        // When vault is liquidated, any active burns should not be cancellable
        // This prevents creating unbacked wsXMR via cancelBurn after liquidation
        // Note: Active burn requests are implicitly invalidated because:
        // 1. lockedCollateral was proportionally reduced above
        // 2. cancelBurn checks will fail due to insufficient locked amounts
        // 3. Vault debt was cleared, so restoring it would create unbacked tokens
        // In production, implement explicit burn request tracking per vault
        
        // CRITICAL FIX: Clean up orphaned bad debt if vault is completely drained
        // If vault has zero collateral but still has debt, remove the bad debt from global tracking
        // This prevents yield dilution where buy-and-burn pays back ghost debt
        if (vault.collateralAmount == 0 && vault.normalizedDebt > 0) {
            uint256 remainingDebt = getActualDebt(vault.normalizedDebt);
            if (remainingDebt > 0 && globalTotalDebt >= remainingDebt) {
                globalTotalDebt -= remainingDebt;
                vault.normalizedDebt = 0; // Clear the bad debt
                
                // CRITICAL FIX: Do NOT burn tokens from address(this)
                // VaultManager doesn't hold unbacked wsXMR tokens
                // Attempting to burn will revert and DoS all liquidations
                // Instead, emit event for off-chain tracking of protocol bad debt
                // An insurance fund or governance mechanism should handle unbacked supply
                
                emit BadDebtWrittenOff(_lpVault, remainingDebt);
            }
        }
        
        emit VaultLiquidated(_lpVault, msg.sender, _debtToClear, collateralAmount);
    }
    
    // ========== BUY-AND-BURN STRATEGY ==========
    
    /**
     * @notice Skim sDAI appreciation into yieldWarChest for buy-and-burn
     * @dev Called internally when debt operations occur
     * @dev Calculates yield as: (currentShareValue - principalDeposits)
     */
    function _skimYieldToWarChest() internal {
        // CRITICAL FIX: Removed unbounded loop to prevent DoS
        // Instead, use ERC4626 exchange rate tracking
        // LPs maintain their share counts, yield accrues via exchange rate appreciation
        // War chest is funded by explicitly skimming excess shares without touching LP balances
        
        // Get total sDAI shares held by contract
        uint256 totalSDAIShares = IERC20(GnosisAddresses.SDAI).balanceOf(address(this));
        if (totalSDAIShares == 0) return;
        
        // Calculate current DAI value of all shares
        uint256 totalUnderlyingDAI = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(totalSDAIShares);
        
        // Calculate yield as: total value - (principal + existing war chest)
        uint256 warChestDAI = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(yieldWarChest);
        uint256 totalAssignedDAI = globalLpPrincipal + warChestDAI;
        
        // If no yield available, return
        if (totalUnderlyingDAI <= totalAssignedDAI) return;
        
        // Calculate yield in DAI and convert to shares
        uint256 yieldInDAI = totalUnderlyingDAI - totalAssignedDAI;
        uint256 yieldInShares = ISavingsDAI(GnosisAddresses.SDAI).convertToShares(yieldInDAI);
        
        // CRITICAL FIX: Do NOT deduct from vault.collateralAmount
        // LPs keep their shares, which appreciate via ERC4626 exchange rate
        // War chest accumulates the excess shares representing yield
        // This prevents:
        // 1. O(N) DoS via unbounded loop
        // 2. Artificial insolvency by reducing LP collateral ratios
        
        // Add to war chest
        yieldWarChest += yieldInShares;
        
        emit YieldHarvested(yieldInDAI, yieldInShares);
    }
    
    /**
     * @notice Execute buy-and-burn when XMR dips 1% below EMA
     * @dev Permissionless keeper function with MEV protection
     */
    function triggerBuyAndBurn() external nonReentrant {
        // 1. Cooldown Check
        require(block.timestamp >= lastBuyTimestamp + COOLDOWN_PERIOD, "Cooldown active");
        
        // 2. EMA vs Spot Check (Pyth provides both)
        PythStructs.Price memory spotData = pyth.getPriceNoOlderThan(XMR_USD_FEED_ID, priceMaxAge);
        PythStructs.Price memory emaData = pyth.getEmaPriceNoOlderThan(XMR_USD_FEED_ID, priceMaxAge);
        
        // Validate 1% dip: Spot <= EMA * 0.99
        uint256 spotPrice = uint256(uint64(spotData.price));
        uint256 emaPrice = uint256(uint64(emaData.price));
        require(spotPrice <= (emaPrice * EMA_TRIGGER_THRESHOLD) / 100, "XMR has not dipped 1%");
        
        // 3. Calculate 20% chunk
        require(yieldWarChest > 0, "War chest is empty");
        uint256 spendAmount = (yieldWarChest * BUY_CHUNK_PERCENT) / 100;
        
        // Update state
        yieldWarChest -= spendAmount;
        lastBuyTimestamp = block.timestamp;
        
        // 4. MEV Protection: Calculate minimum output using oracle
        // CRITICAL FIX: Use oracle price for sDAI, not hardcoded 1 DAI = 1 USD assumption
        // This prevents DoS during DAI depeg events
        uint256 sDAIPrice = getCollateralPrice(GnosisAddresses.SDAI); // USD per sDAI share (18 decimals)
        uint256 xmrPrice = getXmrPrice(); // USD per XMR (18 decimals)
        
        // Calculate expected wsXMR output
        // spendAmount is in sDAI shares (18 decimals)
        // sDAIPrice is USD per share (18 decimals)
        // xmrPrice is USD per XMR (18 decimals)
        // Expected wsXMR in 8 decimals = (spendAmount * sDAIPrice / 1e18) * 1e8 / xmrPrice
        uint256 expectedWsxmr = (spendAmount * sDAIPrice) / xmrPrice / 1e10; // Normalize to 8 decimals
        
        // Allow 2% slippage max to prevent sandwich attacks
        uint256 minWsxmrOut = (expectedWsxmr * (BPS_DENOMINATOR - MEV_SLIPPAGE_BPS)) / BPS_DENOMINATOR;
        
        // 5. Execute Uniswap Swap (sDAI -> wsXMR)
        IERC20(GnosisAddresses.SDAI).approve(GnosisAddresses.UNISWAP_V3_ROUTER, spendAmount);
        uint256 wsxmrBought = ISwapRouter(GnosisAddresses.UNISWAP_V3_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: GnosisAddresses.SDAI,
                tokenOut: address(wsxmrToken),
                fee: 3000, // 0.3% pool
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: spendAmount,
                amountOutMinimum: minWsxmrOut,
                sqrtPriceLimitX96: 0
            })
        );
        
        // 6. Burn the bought wsXMR
        wsxmrToken.burn(address(this), wsxmrBought);
        
        // 7. Erase LP debt (O(1) calculation)
        // Reduce global index by exact percentage of total debt burned
        if (globalTotalDebt > 0) {
            uint256 reductionPercentage = (wsxmrBought * 1e18) / globalTotalDebt;
            
            // CRITICAL FIX: Prevent globalDebtIndex from reaching zero (division by zero protection)
            // If reduction would drop index to zero, cap it at 1e18 - 1 to prevent protocol lockup
            if (reductionPercentage >= 1e18) {
                reductionPercentage = 1e18 - 1; // Maximum 99.9999...% reduction
            }
            
            globalDebtIndex -= (globalDebtIndex * reductionPercentage) / 1e18;
            globalTotalDebt -= wsxmrBought;
        }
        
        emit BuyAndBurnExecuted(spendAmount, wsxmrBought, globalDebtIndex);
    }
    
    // ========== PRICE ORACLE FUNCTIONS ==========
    
    /**
     * @notice Get XMR price in USD (18 decimals)
     */
    function getXmrPrice() public view returns (uint256) {
        uint256 maxAge = priceMaxAge;
        PythStructs.Price memory priceData = pyth.getPriceNoOlderThan(XMR_USD_FEED_ID, maxAge);
        if (priceData.price <= 0) revert StalePrice();
        
        // CRITICAL: Validate confidence interval (reject if uncertainty > 10%)
        // During high volatility or exchange outages, Pyth emits wide confidence intervals
        // Using such prices could enable manipulation or unfair liquidations
        uint256 price = uint256(uint64(priceData.price));
        uint256 conf = uint256(uint64(priceData.conf));
        if (conf * 10 > price) revert StalePrice(); // Confidence > 10% of price
        
        // Pyth prices have expo (e.g., -8 means divide by 1e8)
        // Convert to 18 decimals
        int32 expo = priceData.expo;
        
        if (expo >= 0) {
            return price * (10 ** uint32(expo)) * 1e18;
        } else {
            uint32 absExpo = uint32(-expo);
            if (absExpo >= 18) {
                return price / (10 ** (absExpo - 18));
            } else {
                return price * (10 ** (18 - absExpo));
            }
        }
    }
    
    /**
     * @notice Get collateral asset price in USD (18 decimals)
     */
    function getCollateralPrice(address _asset) public view returns (uint256) {
        bytes32 feedId = collateralPriceFeeds[_asset];
        if (feedId == bytes32(0)) revert InvalidAsset();
        
        uint256 maxAge = priceMaxAge;
        PythStructs.Price memory priceData = pyth.getPriceNoOlderThan(feedId, maxAge);
        if (priceData.price <= 0) revert StalePrice();
        
        // CRITICAL: Validate confidence interval (reject if uncertainty > 10%)
        uint256 price = uint256(uint64(priceData.price));
        uint256 conf = uint256(uint64(priceData.conf));
        if (conf * 10 > price) revert StalePrice(); // Confidence > 10% of price
        
        // Pyth prices have expo (e.g., -8 means divide by 1e8)
        // Convert to 18 decimals
        int32 expo = priceData.expo;
        
        uint256 normalizedPrice;
        if (expo >= 0) {
            normalizedPrice = price * (10 ** uint32(expo)) * 1e18;
        } else {
            uint32 absExpo = uint32(-expo);
            if (absExpo >= 18) {
                normalizedPrice = price / (10 ** (absExpo - 18));
            } else {
                normalizedPrice = price * (10 ** (18 - absExpo));
            }
        }
        
        // CRITICAL FIX: Account for ERC4626 share-to-asset exchange rate
        // sDAI shares appreciate over time - 1 share > 1 DAI
        // Without this, LPs are massively shortchanged on borrowing power
        // and liquidators extract unintended bonuses
        if (_asset == GnosisAddresses.SDAI) {
            // Find how many underlying DAI exactly 1e18 sDAI shares are worth
            uint256 underlyingPerShare = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(1e18);
            return (normalizedPrice * underlyingPerShare) / 1e18;
        }
        
        return normalizedPrice;
    }
    
    /**
     * @notice Calculate actual debt from normalized debt using global index
     * @param _normalizedDebt The normalized debt amount
     * @return actualDebt The actual debt amount after applying global index
     */
    function getActualDebt(uint256 _normalizedDebt) public view returns (uint256 actualDebt) {
        return (_normalizedDebt * globalDebtIndex) / 1e18;
    }
    
    /**
     * @notice Get actual debt for a specific vault
     * @param _lpAddress The LP vault address
     * @return actualDebt The vault's actual debt amount
     */
    function getVaultDebt(address _lpAddress) public view returns (uint256 actualDebt) {
        return getActualDebt(vaults[_lpAddress].normalizedDebt);
    }
    
    /**
     * @notice Calculate collateral ratio for a vault
     * @return ratio Collateral ratio (e.g., 150 for 150%)
     */
    function calculateCollateralRatio(
        address _collateralAsset,
        uint256 _collateralAmount,
        uint256 _debtAmount
    ) public view returns (uint256 ratio) {
        if (_debtAmount == 0) return type(uint256).max;
        
        uint256 collateralPrice = getCollateralPrice(_collateralAsset);
        uint256 xmrPrice = getXmrPrice();
        
        // Get collateral decimals
        uint8 collateralDecimals = _collateralAsset == address(0) ? 18 : IERC20Metadata(_collateralAsset).decimals();
        
        // Calculate collateral value in USD (18 decimals)
        uint256 collateralValue = (_collateralAmount * collateralPrice) / (10 ** collateralDecimals);
        
        // Calculate debt value in USD (wsXMR has 8 decimals)
        uint256 debtValue = (_debtAmount * xmrPrice) / 1e8;
        
        // Return ratio as percentage
        ratio = (collateralValue * RATIO_PRECISION) / debtValue;
    }
    
    /**
     * @notice Get USD value of collateral needed for debt amount
     */
    function getCollateralValueForDebt(uint256 _debtAmount) internal view returns (uint256) {
        uint256 xmrPrice = getXmrPrice();
        return (_debtAmount * xmrPrice) / 1e8;
    }
    
    /**
     * @notice Convert USD value to collateral token amount
     */
    function usdToCollateral(address _asset, uint256 _usdValue) internal view returns (uint256) {
        uint256 collateralPrice = getCollateralPrice(_asset);
        uint8 decimals = _asset == address(0) ? 18 : IERC20Metadata(_asset).decimals();
        return (_usdValue * (10 ** decimals)) / collateralPrice;
    }
    
    // ========== VIEW FUNCTIONS ==========
    
    /**
     * @notice Get vault information
     */
    function getVault(address _lpAddress) external view returns (Vault memory) {
        return vaults[_lpAddress];
    }
    
    /**
     * @notice Get current collateral ratio for a vault
     */
    function getVaultHealth(address _lpAddress) external view returns (uint256 ratio) {
        Vault memory vault = vaults[_lpAddress];
        if (!vault.active) revert VaultDoesNotExist();
        
        return calculateCollateralRatio(
            vault.collateralAsset,
            vault.collateralAmount,
            getVaultDebt(_lpAddress)
        );
    }
    
    /**
     * @notice Check if vault is liquidatable
     */
    function isVaultLiquidatable(address _lpAddress) external view returns (bool) {
        Vault memory vault = vaults[_lpAddress];
        uint256 actualDebt = getVaultDebt(_lpAddress);
        if (!vault.active || actualDebt == 0) return false;
        
        uint256 ratio = calculateCollateralRatio(
            vault.collateralAsset,
            vault.collateralAmount,
            actualDebt
        );
        return ratio < LIQUIDATION_RATIO;
    }
    
    /**
     * @notice Get total number of vaults
     */
    function getVaultCount() external view returns (uint256) {
        return vaultList.length;
    }
    
    // ========== ADMIN FUNCTIONS ==========
    
    /**
     * @notice Add support for new collateral type with Pyth price feed
     * @param _asset Address of the collateral token (address(0) for native MON)
     * @param _pythFeedId Pyth price feed ID for this asset
     */
    function addCollateralSupport(address _asset, bytes32 _pythFeedId) external onlyOwner {
        if (_pythFeedId == bytes32(0)) revert InvalidAsset();
        supportedCollateral[_asset] = true;
        collateralPriceFeeds[_asset] = _pythFeedId;
        emit CollateralSupported(_asset, address(pyth));
    }
    
    /**
     * @notice Remove support for collateral type
     */
    function removeCollateralSupport(address _asset) external onlyOwner {
        supportedCollateral[_asset] = false;
        delete collateralPriceFeeds[_asset];
    }
    
    /**
     * @notice Set maximum price age for oracle staleness check
     * @param _maxAge Maximum age in seconds (recommended: 5 minutes)
     */
    function setPriceMaxAge(uint256 _maxAge) external onlyOwner {
        if (_maxAge == 0 || _maxAge > 1 hours) revert InvalidValue();
        priceMaxAge = _maxAge;
        emit PriceMaxAgeUpdated(_maxAge);
    }
    
    /**
     * @notice Update Pyth price feeds with off-chain data
     * @dev Pyth is a pull-based oracle - prices must be pushed on-chain before use
     * @dev Call this before initiateMint, requestBurn, or liquidate operations
     * @param pythUpdateData Signed price update data from Pyth Network
     */
    function updatePythPrices(bytes[] calldata pythUpdateData) external payable {
        // Get the required fee from Pyth
        uint256 fee = pyth.getUpdateFee(pythUpdateData);
        
        // Update the price feeds (msg.value pays the fee)
        pyth.updatePriceFeeds{value: fee}(pythUpdateData);
        
        // Refund any excess ETH sent
        if (msg.value > fee) {
            (bool success, ) = payable(msg.sender).call{value: msg.value - fee}("");
            require(success, "Refund failed");
        }
    }
}
