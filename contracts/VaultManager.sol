// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
contract VaultManager is Secp256k1, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ========== CONSTANTS ==========
    
    uint256 public constant COLLATERAL_RATIO = 150; // 150% overcollateralization
    uint256 public constant LIQUIDATION_RATIO = 120; // 120% liquidation threshold
    uint256 public constant LIQUIDATION_BONUS = 110; // 110% liquidator reward (must be < threshold)
    uint256 public constant RATIO_PRECISION = 100;
    uint256 public constant PRICE_PRECISION = 1e18;
    
    // MINT TIMEOUTS
    uint256 public constant MAX_MINT_TIMEOUT = 2 hours;
    uint256 public constant MINT_READY_EXTENSION = 2 hours; // Time user has to claim after LP is ready
    
    // BURN TIMEOUTS
    uint256 public constant BURN_REQUEST_TIMEOUT = 1 hours; // Time LP has to respond to a burn
    // NOTE: BURN_COMMIT_TIMEOUT must be GREATER than the Monero PTLC refund timelock
    uint256 public constant BURN_COMMIT_TIMEOUT = 2 hours; // Time LP has to reveal secret after committing
    
    // MARKET METRIC CONSTANTS
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_MARGIN_BPS = 1000; // 10% maximum fee/reward to prevent abuse
    
    // BUY-AND-BURN STRATEGY CONSTANTS
    uint256 public constant COOLDOWN_PERIOD = 24 hours; // Minimum time between buy-and-burn executions
    uint256 public constant BUY_CHUNK_PERCENT = 20; // 20% of war chest per execution
    uint256 public constant EMA_TRIGGER_THRESHOLD = 99; // 1% dip threshold (spot <= EMA * 0.99)
    uint256 public constant MEV_SLIPPAGE_BPS = 100; // 1% max slippage - prevents MEV extraction while allowing normal market variance
    uint256 public constant KEEPER_REWARD_BPS = 200; // 2% of the chunk paid to caller for gas
    uint256 public constant MAX_BURN_REQUESTS_PER_VAULT = 50; // Bounds liquidation loop gas cost
    uint256 public constant MAX_VAULT_COUNT = 10000;
    uint256 public constant MIN_BURN_AMOUNT = 1e6; // 0.01 wsXMR minimum (8 decimals)
    
    // Decimal and conversion constants
    uint256 public constant XMR_TO_WSXMR_DIVISOR = 1e4; // XMR 12 decimals -> wsXMR 8 decimals
    uint256 public constant WSXMR_DECIMALS = 1e8;
    uint256 public constant SDAI_DECIMALS = 1e18;
    uint256 public constant YIELD_DUST_THRESHOLD = 100; // Minimum shares to extract as yield
    uint256 public constant DEBT_DUST_THRESHOLD = 1e4; // Below this, reset debt tracking
    uint256 public constant MIN_DEBT_INDEX = 1e10; // Below this, reset to prevent precision loss
    
    // ========== STATE VARIABLES ==========
    
    wsXMR public immutable wsxmrToken;
    
    // Pyth oracle
    IPyth public immutable pyth;
    
    // Pyth price feed IDs
    bytes32 public constant XMR_USD_FEED_ID = 0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d;
   
    bytes32 public constant SDAI_USD_FEED_ID = 0xb0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd;

    // Oracle staleness configuration (in seconds)
    uint256 public constant PRICE_MAX_AGE = 5 minutes;
    
    // Buy-and-Burn Strategy State
    uint256 public lastBuyTimestamp; // Last execution timestamp for cooldown enforcement
    uint256 public globalTotalDebt; // Total wsXMR debt across all vaults
    uint256 public globalDebtIndex = 1e18; // Debt multiplier for O(1) proportional forgiveness
    uint256 public yieldWarChest; // Accumulated sDAI yield ready for buy-and-burn
    mapping(address => uint256) public lpPrincipalDeposits; // Track original DAI deposits per LP
    uint256 public globalLpPrincipal;
    mapping(address => uint256) public lpPrincipalShares; // Track sDAI shares as principal
    uint256 public globalLpPrincipalShares;
    uint256 public globalPendingSDAI;
    uint256 public globalPendingETH;
    uint256 public globalBadDebt; // Unbacked wsXMR supply from liquidation shortfalls
    uint256 private _requestNonce;
    mapping(uint24 => bool) public allowedPoolFeeTiers;
    
    // Frontend-friendly request tracking
    mapping(address => bytes32[]) public userMintRequests;
    mapping(address => bytes32[]) public userBurnRequests;
    mapping(address => bytes32[]) public vaultBurnRequests; // Track burn requests per vault
    
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
        uint256 collateralAmount; // sDAI SHARES (not DAI value)
        uint256 lockedCollateral; // Collateral reserved for pending burns (still liquidatable!)
        uint256 normalizedDebt; // Normalized debt for O(1) proportional forgiveness (actualDebt = normalizedDebt * globalDebtIndex / 1e18)
        uint256 pendingDebt; // Reserved capacity for pending mints (NOT Liquidatable)
        uint16 maxMintBps; // LP config limits single mint size (e.g. 1000 = 10%)
        uint256 mintGriefingDeposit; // ETH deposit required for mint requests (LP-configurable)
        uint16 mintFeeBps; // Fee LP charges for minting (paid in wsXMR)
        uint16 burnRewardBps; // Reward LP pays to incentivize burning (paid in Collateral)
        uint256 liquidationNonce;
        uint256 mintNonce; // Incremented on liquidation to invalidate pending mints
        uint256 minBurnAmount; // LP-configurable minimum burn (0 = use global default)
        bool active;
    }
    
    /**
     * @notice MintRequest tracks a pending mint operation
     */
    struct MintRequest {
        bytes32 requestId;
        address initiator; // msg.sender who pays the ETH deposit
        address recipient; // destination address for minted wsXMR
        address lpVault;
        uint256 xmrAmount; // Amount of XMR (in atomic units, 1e12 per XMR)
        uint256 wsxmrAmount; // Amount of wsXMR to mint (1e8 per wsXMR)
        uint256 feeAmount; // Portion of wsxmrAmount that goes to LP as fee
        bytes32 claimCommitment; // Hash of secret that LP will reveal
        uint256 timeout;
        uint256 griefingDeposit; // ETH deposit to prevent spam (refunded on finalize, awarded to LP on cancel)
        uint256 normalizedDebtAmount; // Store exact normalized amount for consistent accounting
        uint256 vaultMintNonce; // Snapshot of vault's mintNonce at creation
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
        uint256 vaultLiquidationNonce;
        uint256 normalizedDebtAmount; // Exact normalized amount deducted
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
    event BuyAndBurnExecuted(uint256 sDAISpent, uint256 wsxmrBurned, uint256 keeperReward, uint256 newGlobalDebtIndex);
    
    event MintInitiated(
        bytes32 indexed requestId,
        address indexed initiator,
        address indexed recipient,
        address lpVault,
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
    event BurnRewardShortfall(bytes32 indexed requestId, uint256 expectedReward, uint256 actualReward);
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
    event MaxMintBpsUpdated(address indexed lpVault, uint16 newMaxMintBps);
    event VaultDeactivated(address indexed lpVault);
    event GlobalDebtReconciled(uint256 oldDebt, uint256 newDebt);
    
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
    
    constructor(address _pythContract) {
        if (_pythContract == address(0)) revert ZeroAddress();
        
        pyth = IPyth(_pythContract);
        
        // Deploys the wsXMR token immutably on initialization
        wsxmrToken = new wsXMR();
        
        allowedPoolFeeTiers[500] = true;    // 0.05%
        allowedPoolFeeTiers[3000] = true;   // 0.3%
        allowedPoolFeeTiers[10000] = true;  // 1%
    }
    
    receive() external payable {
        // Accept ETH from Pyth refunds and griefing deposits
    }
    
    // ========== VAULT MANAGEMENT ==========
    
    /**
     * @notice Create a new LP vault (sDAI collateral only)
     */
    function createVault() external {
        if (vaults[msg.sender].active) revert VaultAlreadyExists();
        require(vaultList.length < MAX_VAULT_COUNT, "Max vaults reached");
        
        vaults[msg.sender] = Vault({
            lpAddress: msg.sender,
            collateralAmount: 0,
            lockedCollateral: 0,
            normalizedDebt: 0,
            pendingDebt: 0,
            maxMintBps: 0, // LP can set this later via setMaxMintBps (0 = no limit)
            mintGriefingDeposit: 0, // LP can set this later via setMintGriefingDeposit
            mintFeeBps: 0,
            burnRewardBps: 0,
            liquidationNonce: 0,
            mintNonce: 0,
            minBurnAmount: 0,
            active: true
        });
        
        vaultList.push(msg.sender);
        emit VaultCreated(msg.sender, GnosisAddresses.SDAI);
    }
    
    /**
     * @notice Deposit collateral into vault (xDAI)
     * @dev Auto-converts xDAI to sDAI for yield generation
     * @param _amount Amount of xDAI to deposit
     */
    function depositCollateral(uint256 _amount) external nonReentrant {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (_amount == 0) revert ZeroAmount();
        
        Vault storage vault = vaults[msg.sender];
        
        // 1. Transfer xDAI from user
        IERC20(GnosisAddresses.XDAI).safeTransferFrom(msg.sender, address(this), _amount);
        
        // 2. Approve and deposit to sDAI
        IERC20(GnosisAddresses.XDAI).forceApprove(GnosisAddresses.SDAI, _amount);
        uint256 sDAIShares = ISavingsDAI(GnosisAddresses.SDAI).deposit(_amount, address(this));
        
       
        _syncVaultYield(msg.sender);
        
        vault.collateralAmount += sDAIShares;
        lpPrincipalDeposits[msg.sender] += _amount;
        globalLpPrincipal += _amount;
        lpPrincipalShares[msg.sender] += sDAIShares;
        globalLpPrincipalShares += sDAIShares;
        
        emit CollateralDeposited(msg.sender, GnosisAddresses.SDAI, _amount);
    }
    
    /**
     * @notice Deposit sDAI shares directly into vault
     * @dev For LPs who already hold sDAI and want to skip the xDAI conversion step
     * @param _sDAIShares Amount of sDAI shares to deposit
     */
    function depositSDAI(uint256 _sDAIShares) external nonReentrant {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (_sDAIShares == 0) revert ZeroAmount();
        
        Vault storage vault = vaults[msg.sender];
        
        // Transfer sDAI shares directly from user
        IERC20(GnosisAddresses.SDAI).safeTransferFrom(msg.sender, address(this), _sDAIShares);
        
        // Convert shares to underlying DAI value for principal tracking
        uint256 daiValue = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(_sDAIShares);
        
       
        _syncVaultYield(msg.sender);
        
        vault.collateralAmount += _sDAIShares;
        lpPrincipalDeposits[msg.sender] += daiValue;
        globalLpPrincipal += daiValue;
        lpPrincipalShares[msg.sender] += _sDAIShares;
        globalLpPrincipalShares += _sDAIShares;
        
        emit CollateralDeposited(msg.sender, GnosisAddresses.SDAI, daiValue);
    }
    
    /**
     * @notice Withdraw collateral from vault (only if health ratio allows)
     * @param _amount Amount of collateral to withdraw
     */
    function withdrawCollateral(uint256 _amount) external nonReentrant {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (_amount == 0) revert ZeroAmount();
        
        Vault storage vault = vaults[msg.sender];
        
        // Sync yield FIRST before any state reads
        _syncVaultYield(msg.sender);
        
        // Now read the synced collateral amount
        uint256 collateralAfterSync = vault.collateralAmount;
        
        // Cannot withdraw collateral that's locked for pending burns
        uint256 availableCollateral = vault.collateralAmount - vault.lockedCollateral;
        if (availableCollateral < _amount) revert InsufficientCollateral();
        
        // Check if withdrawal would make vault unhealthy
        uint256 newCollateralAmount = vault.collateralAmount - _amount;
        
       
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        uint256 totalObligations = actualDebt + vault.pendingDebt;
        
        if (totalObligations > 0) {
           
            // Locked collateral backs burn requests, not active debt
            uint256 availableForDebt = newCollateralAmount > vault.lockedCollateral 
                ? newCollateralAmount - vault.lockedCollateral 
                : 0;
            uint256 ratio = calculateCollateralRatio(
                availableForDebt,
                totalObligations
            );
            if (ratio < COLLATERAL_RATIO) revert InsufficientCollateral();
        }
        
        // Subtract withdrawal amount
        vault.collateralAmount -= _amount;
        
       
        uint256 daiReceived = ISavingsDAI(GnosisAddresses.SDAI).redeem(_amount, msg.sender, address(this));
        
       
        // Calculate what portion of the LP's principal this withdrawal represents
        uint256 principalToDeduct = (lpPrincipalDeposits[msg.sender] * _amount) / collateralAfterSync;
        lpPrincipalDeposits[msg.sender] -= principalToDeduct;
        globalLpPrincipal -= principalToDeduct;
        uint256 sharesToDeduct = (lpPrincipalShares[msg.sender] * _amount) / collateralAfterSync;
        lpPrincipalShares[msg.sender] -= sharesToDeduct;
        globalLpPrincipalShares -= sharesToDeduct;
        
        emit CollateralWithdrawn(msg.sender, GnosisAddresses.SDAI, daiReceived);
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
        emit MaxMintBpsUpdated(msg.sender, _maxMintBps);
    }
    
    /**
     * @notice LP sets the minimum wsXMR amount for burn requests
     * @param _minAmount Minimum burn amount (0 to use global default)
     */
    function setMinBurnAmount(uint256 _minAmount) external {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        vaults[msg.sender].minBurnAmount = _minAmount;
    }
    
    /**
     * @notice Clean up completed/cancelled burn requests from vault tracking array
     * @param _lpVault Address of the vault to clean up
     */
    function cleanupVaultBurnRequests(address _lpVault) external {
        bytes32[] storage vaultBurns = vaultBurnRequests[_lpVault];
        uint256 writeIndex = 0;
        
        for (uint256 readIndex = 0; readIndex < vaultBurns.length; readIndex++) {
            BurnStatus status = burnRequests[vaultBurns[readIndex]].status;
            if (status == BurnStatus.REQUESTED || 
                status == BurnStatus.PROPOSED || 
                status == BurnStatus.COMMITTED) {
                if (writeIndex != readIndex) {
                    vaultBurns[writeIndex] = vaultBurns[readIndex];
                }
                writeIndex++;
            }
        }
        
        while (vaultBurns.length > writeIndex) {
            vaultBurns.pop();
        }
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
        
       
        if (_token == GnosisAddresses.SDAI) {
            globalPendingSDAI -= amount;
        }
        
        if (_token == address(0)) {
            globalPendingETH -= amount;
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
     * @notice Initiate a mint request with automatic Pyth price update (one-click UX)
     * @dev Combines updatePythPrices and initiateMint into a single transaction
     * @param _lpVault Address of the LP vault to handle this mint
     * @param _recipient Address to receive the minted wsXMR
     * @param _xmrAmount Amount of XMR (in atomic units, 12 decimals)
     * @param _claimCommitment secp256k1 commitment to user's secret
     * @param _timeoutDuration How long before request can be cancelled
     * @param _pythUpdateData Pyth price update data from Hermes API
     * @return requestId Unique identifier for this mint request
     */
    function initiateMintWithPriceUpdate(
        address _lpVault,
        address _recipient,
        uint256 _xmrAmount,
        bytes32 _claimCommitment,
        uint256 _timeoutDuration,
        bytes[] calldata _pythUpdateData
    ) external payable returns (bytes32 requestId) {
        // Calculate Pyth update fee
        uint256 pythFee = pyth.getUpdateFee(_pythUpdateData);
        
        // Update Pyth prices first
        pyth.updatePriceFeeds{value: pythFee}(_pythUpdateData);
        
        // Calculate griefing deposit (msg.value - pythFee)
        uint256 griefingDeposit = msg.value - pythFee;
        
        // Call internal mint function with adjusted value
        return _initiateMint(_lpVault, _recipient, _xmrAmount, _claimCommitment, _timeoutDuration, griefingDeposit);
    }
    
    /**
     * @notice Initiate a mint request
     * @dev User provides commitment, LP will lock XMR on Monero chain
     * @param _lpVault Address of the LP vault to handle this mint
     * @param _recipient Address to receive the minted wsXMR
     * @param _xmrAmount Amount of XMR (in atomic units, 12 decimals)
     * @param _claimCommitment secp256k1 commitment to user's secret
     * @param _timeoutDuration How long before request can be cancelled
     * @return requestId Unique identifier for this mint request
     */
    function initiateMint(
        address _lpVault,
        address _recipient,
        uint256 _xmrAmount,
        bytes32 _claimCommitment,
        uint256 _timeoutDuration
    ) external payable returns (bytes32 requestId) {
        return _initiateMint(_lpVault, _recipient, _xmrAmount, _claimCommitment, _timeoutDuration, msg.value);
    }
    
    /**
     * @notice Internal function to initiate mint
     */
    function _initiateMint(
        address _lpVault,
        address _recipient,
        uint256 _xmrAmount,
        bytes32 _claimCommitment,
        uint256 _timeoutDuration,
        uint256 _griefingDeposit
    ) internal returns (bytes32 requestId) {
        if (_lpVault == address(0)) revert ZeroAddress();
        if (_recipient == address(0)) revert ZeroAddress();
        if (_xmrAmount == 0) revert ZeroAmount();
        if (_claimCommitment == bytes32(0)) revert InvalidSecret();
        if (_timeoutDuration == 0 || _timeoutDuration > MAX_MINT_TIMEOUT) revert InvalidValue();
        if (!vaults[_lpVault].active) revert VaultDoesNotExist();
        
       
        // XMR has 12 decimals, wsXMR has 8, so amounts < 1e4 would floor to 0
        if (_xmrAmount < 1e4) revert ZeroAmount();
        
        // ANTI-SPAM: Require griefing deposit set by LP
        Vault storage vault = vaults[_lpVault];
        if (_griefingDeposit < vault.mintGriefingDeposit) revert InsufficientDeposit();
        
        // Convert XMR amount to wsXMR amount (XMR has 12 decimals, wsXMR has 8)
        uint256 wsxmrAmount = _xmrAmount / 1e4;
        
        // Calculate the LP's service fee in wsXMR
        uint256 feeAmount = (wsxmrAmount * vault.mintFeeBps) / BPS_DENOMINATOR;
        
        // Enforce LP's chunk size limit (prevents single large mint from draining capacity)
        if (vault.maxMintBps > 0) {
            uint256 collateralPrice = getCollateralPrice();
            uint256 collateralValueUsd = (vault.collateralAmount * collateralPrice) / 1e18; // sDAI has 18 decimals
            uint256 maxTotalDebtCapacity = (collateralValueUsd * RATIO_PRECISION) / COLLATERAL_RATIO;
            uint256 maxMintAllowed = (maxTotalDebtCapacity * vault.maxMintBps) / BPS_DENOMINATOR;
            
           
            // wsxmrAmount is in 8 decimals, maxMintAllowed is in USD with 18 decimals
            uint256 xmrPrice = getXmrPrice(); // Returns price in 18 decimals
            uint256 wsxmrValueUsd = (wsxmrAmount * xmrPrice) / 1e8; // Convert to USD (18 decimals)
            
            if (wsxmrValueUsd > maxMintAllowed) revert InvalidValue();
        }
        
        // Check capacity using Active + Pending Debt (prevents phantom debt DoS)
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        uint256 totalProjectedDebt = actualDebt + vault.pendingDebt + wsxmrAmount;
        
       
        // lockedCollateral is pledged to burn requests and cannot back new mints
        // Without this check, LP can double-count collateral to mint unbacked wsXMR
        uint256 availableCollateral = vault.collateralAmount > vault.lockedCollateral 
            ? vault.collateralAmount - vault.lockedCollateral 
            : 0;
        
        uint256 ratio = calculateCollateralRatio(
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
            ++_requestNonce
        ));
        
        // Check for collision BEFORE modifying state
        if (mintRequests[requestId].status != MintStatus.INVALID) revert MintAlreadyExists();
        
       
        // Pending debt reserves capacity but does NOT count towards liquidation calculations
        vault.pendingDebt += wsxmrAmount;
        
        mintRequests[requestId] = MintRequest({
            requestId: requestId,
            initiator: msg.sender, // Track who paid the deposit
            recipient: _recipient, // Track where tokens go
            lpVault: _lpVault,
            xmrAmount: _xmrAmount,
            wsxmrAmount: wsxmrAmount,
            feeAmount: feeAmount,
            claimCommitment: _claimCommitment,
            timeout: block.timestamp + _timeoutDuration,
            griefingDeposit: _griefingDeposit, // Store deposit for refund/award
            normalizedDebtAmount: 0,
            vaultMintNonce: vault.mintNonce,
            status: MintStatus.PENDING
        });
        
        // Track request for frontend discovery
        userMintRequests[msg.sender].push(requestId);
        
        emit MintInitiated(
            requestId,
            msg.sender,
            _recipient,
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
        if (block.timestamp >= request.timeout) revert DeadlineExpired();
        
        Vault storage vault = vaults[request.lpVault];
        if (request.vaultMintNonce != vault.mintNonce) revert InvalidStatus();
        
        // Verify vault is still healthy enough to support this mint
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        uint256 totalProjectedDebt = actualDebt + vault.pendingDebt;
        uint256 availableCollateral = vault.collateralAmount > vault.lockedCollateral
            ? vault.collateralAmount - vault.lockedCollateral
            : 0;
        uint256 currentRatio = calculateCollateralRatio(availableCollateral, totalProjectedDebt);
        if (currentRatio < COLLATERAL_RATIO) revert InsufficientCollateral();
        
        request.status = MintStatus.READY;
        // Reset timeout to give user time to finalize from the READY timestamp
        request.timeout = block.timestamp + MINT_READY_EXTENSION;
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
        
        // Check if vault was liquidated after this mint was initiated
        if (request.vaultMintNonce != vault.mintNonce) {
            // Vault was liquidated. Refund griefing deposit, cancel request.
            request.status = MintStatus.CANCELLED;
            if (request.griefingDeposit > 0) {
                pendingReturns[request.initiator][address(0)] += request.griefingDeposit;
                globalPendingETH += request.griefingDeposit;
                emit ReturnQueued(request.initiator, address(0), request.griefingDeposit);
            }
            emit MintCancelled(request.requestId);
            return; // Do not mint, do not add debt
        }
        
       
        vault.pendingDebt -= request.wsxmrAmount;
        // CRITICAL FIX: Convert to normalized debt using current index
        // This prevents wealth generation when index < 1e18
        uint256 normalizedAmount = (request.wsxmrAmount * 1e18 + globalDebtIndex - 1) / globalDebtIndex;
        vault.normalizedDebt += normalizedAmount;
        request.normalizedDebtAmount = normalizedAmount;
        globalTotalDebt += request.wsxmrAmount; // Track global debt for buy-and-burn
        
        // Mint wsXMR to the RECIPIENT (enables gasless meta-txs and DeFi composability)
        wsxmrToken.mint(request.recipient, request.wsxmrAmount - request.feeAmount);
        if (request.feeAmount > 0) {
            wsxmrToken.mint(vault.lpAddress, request.feeAmount);
        }
        
       
        // Status is READY (checked at function entry), so return deposit to initiator
        if (request.griefingDeposit > 0) {
            pendingReturns[request.initiator][address(0)] += request.griefingDeposit;
            globalPendingETH += request.griefingDeposit;
            emit ReturnQueued(request.initiator, address(0), request.griefingDeposit);
        }
        
        // Mark as completed
        request.status = MintStatus.COMPLETED;
        emit MintFinalized(_requestId, _secret);
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
        
        // Timeout is already set correctly in setMintReady
        uint256 requiredTimeout = request.timeout;
        
        if (block.timestamp < requiredTimeout) revert TimeoutNotReached();
        
        // PERMISSIONLESS: Once timeout expires, anyone can cleanup to free LP capacity
        // This prevents DoS where user locks LP's debt capacity forever
        
        // CHECKS-EFFECTS-INTERACTIONS: Update state BEFORE external calls
        // Release the reserved pending capacity (only if vault wasn't liquidated)
        Vault storage vault = vaults[request.lpVault];
        if (request.vaultMintNonce == vault.mintNonce) {
            vault.pendingDebt -= request.wsxmrAmount;
        }
        
       
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
                globalPendingETH += depositToTransfer;
                emit ReturnQueued(vault.lpAddress, address(0), depositToTransfer);
            } else {
                // LP confirmed but timeout expired - return to INITIATOR
                pendingReturns[request.initiator][address(0)] += depositToTransfer;
                globalPendingETH += depositToTransfer;
                emit ReturnQueued(request.initiator, address(0), depositToTransfer);
            }
        }
    }
    
    // ========== BURNING FLOW (3-STEP HANDSHAKE) ==========
    
    /**
     * @notice Step 1: User requests burn - LOCK WITHOUT ESCROW
     * @dev Burns user's wsXMR and LOCKS (not escrows) LP collateral
     * @dev CRITICAL: Collateral stays in vault and remains LIQUIDATABLE
     * @dev Supports gasless meta-txs: Relayers can call on behalf of users via ERC-20 allowance
     * @param _wsxmrAmount Amount of wsXMR to burn
     * @param _lpVault LP vault to handle the burn
     * @param _user Address whose wsXMR to burn (enables relayer composability)
     * @return requestId Unique identifier for this burn request
     */
    function requestBurn(
        uint256 _wsxmrAmount,
        address _lpVault,
        address _user
    ) external nonReentrant returns (bytes32 requestId) {
        if (_wsxmrAmount == 0) revert ZeroAmount();
        if (_lpVault == address(0)) revert ZeroAddress();
        if (_user == address(0)) revert ZeroAddress();
        if (!vaults[_lpVault].active) revert VaultDoesNotExist();
        
        _syncVaultYield(_lpVault);
        
        require(_wsxmrAmount >= MIN_BURN_AMOUNT, "Below minimum burn amount");
        
        Vault storage vault = vaults[_lpVault];
        
        if (vault.minBurnAmount > 0) {
            require(_wsxmrAmount >= vault.minBurnAmount, "Below vault minimum burn");
        }
        
        // Enforce burn request limit to bound liquidation gas cost
        bytes32[] storage vaultBurns = vaultBurnRequests[_lpVault];
        // Cleanup stale entries while counting active ones
        uint256 activeCount = 0;
        uint256 writeIndex = 0;
        for (uint256 i = 0; i < vaultBurns.length; i++) {
            BurnStatus status = burnRequests[vaultBurns[i]].status;
            if (status == BurnStatus.REQUESTED || 
                status == BurnStatus.PROPOSED || 
                status == BurnStatus.COMMITTED) {
                if (writeIndex != i) {
                    vaultBurns[writeIndex] = vaultBurns[i];
                }
                writeIndex++;
                activeCount++;
            }
        }
        while (vaultBurns.length > writeIndex) {
            vaultBurns.pop();
        }
        require(activeCount < MAX_BURN_REQUESTS_PER_VAULT, "Max burn requests reached");
        
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        if (actualDebt < _wsxmrAmount) revert InsufficientDebt();
        
        // Check that vault will remain healthy AFTER locking collateral for this burn
        // Calculate collateral needed first
        uint256 collateralValue = getCollateralValueForDebt(_wsxmrAmount);
        uint256 collateralToLock = usdToCollateral(
            (collateralValue * LIQUIDATION_RATIO) / RATIO_PRECISION
        );
        uint256 rewardUsd = (collateralValue * vault.burnRewardBps) / BPS_DENOMINATOR;
        uint256 rewardCollateral = usdToCollateral(rewardUsd);
        uint256 totalLock = collateralToLock + rewardCollateral;

        // Vault must have enough collateral for the lock
        if (vault.collateralAmount < totalLock) revert InsufficientCollateral();

        // After this lock, remaining collateral must support remaining debt at 150%
        uint256 remainingCollateral = vault.collateralAmount - totalLock;
        uint256 remainingDebt = actualDebt - _wsxmrAmount;
        if (remainingDebt > 0) {
            uint256 postBurnRatio = calculateCollateralRatio(
                remainingCollateral,
                remainingDebt + vault.pendingDebt
            );
            if (postBurnRatio < COLLATERAL_RATIO) revert InsufficientCollateral();
        }
        
        requestId = keccak256(abi.encodePacked(
            _user,
            _lpVault,
            _wsxmrAmount,
            ++_requestNonce
        ));
        if (burnRequests[requestId].status != BurnStatus.INVALID) revert BurnAlreadyExists();
        
        // Only user can initiate burn to prevent malicious relayer attacks
        require(msg.sender == _user, "Only user can initiate burn");
        wsxmrToken.burn(_user, _wsxmrAmount);
        
        // CRITICAL FIX: Physically segregate locked collateral from liquidatable balance
        // Deduct from collateralAmount so liquidators cannot touch user burn escrow
        vault.collateralAmount -= (collateralToLock + rewardCollateral);
        vault.lockedCollateral += (collateralToLock + rewardCollateral);
        
        // CRITICAL FIX: Reduce normalized debt when wsXMR is burned
        // Use ceiling division to match finalizeMint and prevent dust accumulation
        uint256 normalizedBurnAmount = (_wsxmrAmount * 1e18 + globalDebtIndex - 1) / globalDebtIndex;
        
        // Safety check to prevent underflow from rounding
        if (normalizedBurnAmount > vault.normalizedDebt) {
            normalizedBurnAmount = vault.normalizedDebt;
        }
        vault.normalizedDebt -= normalizedBurnAmount;
        globalTotalDebt -= _wsxmrAmount;
        
        // Step 1: wsXMR burned, collateral locked (but still liquidatable)
        // LP has BURN_REQUEST_TIMEOUT to lock XMR on Monero and provide secretHash
        burnRequests[requestId] = BurnRequest({
            requestId: requestId,
            user: _user,
            lpVault: _lpVault,
            wsxmrAmount: _wsxmrAmount,
            xmrAmount: _wsxmrAmount * 1e4,
            lockedCollateral: collateralToLock,
            rewardCollateral: rewardCollateral,
            secretHash: bytes32(0),
            deadline: block.timestamp + BURN_REQUEST_TIMEOUT,
            vaultLiquidationNonce: vault.liquidationNonce, // Snapshot current nonce
            normalizedDebtAmount: normalizedBurnAmount,
            status: BurnStatus.REQUESTED
        });
        
        // Track request for frontend discovery
        userBurnRequests[_user].push(requestId);
        vaultBurnRequests[_lpVault].push(requestId);
        
        emit BurnRequested(
            requestId,
            _user,
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
        
        _syncVaultYield(request.lpVault);
        
        Vault storage vault = vaults[request.lpVault];
        
        // Safely adjust vault locked collateral
        uint256 totalUnlock = request.lockedCollateral + request.rewardCollateral;
        if (vault.lockedCollateral >= totalUnlock) {
            vault.lockedCollateral -= totalUnlock;
        } else {
            vault.lockedCollateral = 0; // Protection against liquidation underflows
        }
        
        // Return the base locked collateral back to vault
        vault.collateralAmount += request.lockedCollateral;
        
        // Process reward
        if (request.rewardCollateral > 0) {
            uint256 safeReward = request.rewardCollateral > vault.collateralAmount 
                ? vault.collateralAmount 
                : request.rewardCollateral;
            
            vault.collateralAmount -= safeReward;

            // Ensure vault remains above liquidation ratio after reward payment
            uint256 remainingDebt = getActualDebt(vault.normalizedDebt);
            if (remainingDebt > 0) {
                uint256 availableForDebt = vault.collateralAmount > vault.lockedCollateral
                    ? vault.collateralAmount - vault.lockedCollateral
                    : 0;
                uint256 ratioAfterReward = calculateCollateralRatio(
                    availableForDebt,
                    remainingDebt + vault.pendingDebt
                );
                if (ratioAfterReward < LIQUIDATION_RATIO) {
                    // Reduce reward to maintain health
                    uint256 excessReward = safeReward;
                    vault.collateralAmount += excessReward; // Give back the reward
                    
                    // Recalculate max safe reward
                    uint256 collateralPrice = getCollateralPrice();
                    uint256 xmrPrice = getXmrPrice();
                    uint256 debtValueUSD = ((remainingDebt + vault.pendingDebt) * xmrPrice) / 1e8;
                    uint256 minCollateralUSD = (debtValueUSD * LIQUIDATION_RATIO) / RATIO_PRECISION;
                    uint256 minCollateralShares = (minCollateralUSD * 1e18) / collateralPrice + vault.lockedCollateral;
                    
                    if (vault.collateralAmount > minCollateralShares) {
                        safeReward = vault.collateralAmount - minCollateralShares;
                        vault.collateralAmount -= safeReward;
                    } else {
                        safeReward = 0;
                    }
                    
                    emit BurnRewardShortfall(_requestId, request.rewardCollateral, safeReward);
                }
            }
            
            if (safeReward < request.rewardCollateral && safeReward > 0) {
                emit BurnRewardShortfall(_requestId, request.rewardCollateral, safeReward);
            }
            
            // Principal reduction should be based on total vault assets
            // including locked collateral, not just the post-manipulation amount
            if (lpPrincipalDeposits[vault.lpAddress] > 0) {
                uint256 totalVaultAssets = vault.collateralAmount + vault.lockedCollateral + safeReward;
                uint256 principalReduction = (lpPrincipalDeposits[vault.lpAddress] * safeReward) / totalVaultAssets;
                if (principalReduction > lpPrincipalDeposits[vault.lpAddress]) {
                    principalReduction = lpPrincipalDeposits[vault.lpAddress];
                }
                lpPrincipalDeposits[vault.lpAddress] -= principalReduction;
                globalLpPrincipal -= principalReduction;
            }
            
            pendingReturns[request.user][GnosisAddresses.SDAI] += safeReward;
            globalPendingSDAI += safeReward;
            emit ReturnQueued(request.user, GnosisAddresses.SDAI, safeReward);
        }
        
        request.status = BurnStatus.COMPLETED;
        emit BurnFinalized(_requestId, _secret, request.rewardCollateral);
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
        
        _syncVaultYield(request.lpVault);
        
        Vault storage vault = vaults[request.lpVault];
        
        uint256 totalSeized = request.lockedCollateral + request.rewardCollateral;
        
       
        // Just unlock it from the tracker (no need to deduct from collateralAmount)
        uint256 actualSeized = totalSeized;
        vault.lockedCollateral -= actualSeized;
        
       
        if (lpPrincipalDeposits[vault.lpAddress] > 0) {
            uint256 totalVaultAssets = vault.collateralAmount + vault.lockedCollateral + actualSeized;
            uint256 principalReduction = totalVaultAssets > 0
                ? (lpPrincipalDeposits[vault.lpAddress] * actualSeized) / totalVaultAssets
                : 0;
            lpPrincipalDeposits[vault.lpAddress] -= principalReduction;
            globalLpPrincipal -= principalReduction;
        }
        
        // Queue collateral for user withdrawal (pull pattern prevents DoS)
        pendingReturns[request.user][GnosisAddresses.SDAI] += actualSeized;
        globalPendingSDAI += actualSeized;
        emit ReturnQueued(request.user, GnosisAddresses.SDAI, actualSeized);
        
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
        
        if (request.status != BurnStatus.REQUESTED && request.status != BurnStatus.PROPOSED) revert InvalidStatus();
        
        if (request.status == BurnStatus.PROPOSED) {
            if (block.timestamp < request.deadline) revert DeadlineNotExpired();
        }
        
        _syncVaultYield(request.lpVault);
        
        Vault storage vault = vaults[request.lpVault];
        require(request.vaultLiquidationNonce == vault.liquidationNonce, "Burn invalidated by liquidation");
        
        if (block.timestamp < request.deadline) revert DeadlineNotExpired();
        
        // Calculate what the vault looks like AFTER restoring debt and unlocking collateral
        uint256 restoredNormalizedDebt = vault.normalizedDebt + request.normalizedDebtAmount;
        uint256 restoredActualDebt = getActualDebt(restoredNormalizedDebt);
        uint256 totalUnlock = request.lockedCollateral + request.rewardCollateral;
        uint256 restoredCollateral = vault.collateralAmount + totalUnlock;
        
        // Check health at COLLATERAL_RATIO (150%), not LIQUIDATION_RATIO (120%)
        if (restoredActualDebt > 0) {
            uint256 newLockedCollateral = vault.lockedCollateral - totalUnlock;
            uint256 availableForDebt = restoredCollateral > newLockedCollateral
                ? restoredCollateral - newLockedCollateral
                : 0;
            
            uint256 ratioAfter = calculateCollateralRatio(
                availableForDebt,
                restoredActualDebt + vault.pendingDebt
            );
            
            if (ratioAfter < COLLATERAL_RATIO) {
                // Vault cannot safely absorb the restored debt
                // Give user their locked collateral as compensation, track bad debt
                
                // Release locked collateral
                vault.lockedCollateral -= totalUnlock;
                
                // Do NOT restore debt - track as bad debt
                globalBadDebt += request.wsxmrAmount;
                
                // Send locked collateral to user as compensation
                pendingReturns[request.user][GnosisAddresses.SDAI] += totalUnlock;
                globalPendingSDAI += totalUnlock;
                emit ReturnQueued(request.user, GnosisAddresses.SDAI, totalUnlock);
                
                request.status = BurnStatus.CANCELLED;
                emit BurnCancelled(_requestId);
                return;
            }
        }
        
        // Vault is healthy enough - restore debt and re-mint
        vault.normalizedDebt += request.normalizedDebtAmount;
        globalTotalDebt += request.wsxmrAmount;
        
        // Return locked collateral to vault's liquid balance
        vault.lockedCollateral -= totalUnlock;
        vault.collateralAmount += totalUnlock;
        
        // Re-mint wsXMR to user
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
        
        _syncVaultYield(_lpVault);
        
        Vault storage vault = vaults[_lpVault];
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        if (actualDebt == 0) revert InsufficientDebt();
        if (_debtToClear > actualDebt) {
            _debtToClear = actualDebt;
        }
        
        // Check if vault is underwater (use only unlocked collateral for health check)
        uint256 ratio = calculateCollateralRatio(
            vault.collateralAmount,
            actualDebt
        );
        if (ratio >= LIQUIDATION_RATIO) revert VaultHealthy();
        
        // CRITICAL: Resolve all active burn requests for this vault before seizing collateral
        // This prevents liquidators from seizing collateral that was earmarked for burns
        bytes32[] storage vaultBurns = vaultBurnRequests[_lpVault];
        for (uint256 i = 0; i < vaultBurns.length; i++) {
            BurnRequest storage request = burnRequests[vaultBurns[i]];
            
            if (request.status == BurnStatus.REQUESTED || request.status == BurnStatus.PROPOSED) {
                request.status = BurnStatus.CANCELLED;
                
                // Re-mint wsXMR to the user since their tokens were burned in requestBurn
                wsxmrToken.mint(request.user, request.wsxmrAmount);
                
                // CRITICAL: Restore debt tracking to match the re-minted wsXMR
                // requestBurn decremented both normalizedDebt and globalTotalDebt,
                // so we must restore them to keep accounting consistent
                vault.normalizedDebt += request.normalizedDebtAmount;
                globalTotalDebt += request.wsxmrAmount;
                
                // Release locked collateral back to vault for liquidator to seize
                uint256 unlockAmount = request.lockedCollateral + request.rewardCollateral;
                if (vault.lockedCollateral >= unlockAmount) {
                    vault.lockedCollateral -= unlockAmount;
                    vault.collateralAmount += unlockAmount;
                }
                
                request.lockedCollateral = 0;
                request.rewardCollateral = 0;
                emit BurnCancelled(request.requestId);
                
            } else if (request.status == BurnStatus.COMMITTED) {
                request.status = BurnStatus.SLASHED;
                
                // User confirmed Monero lock - they deserve full compensation
                // Re-mint wsXMR AND give them the locked collateral
                wsxmrToken.mint(request.user, request.wsxmrAmount);
                
                // Restore debt since wsXMR is being re-minted
                vault.normalizedDebt += request.normalizedDebtAmount;
                globalTotalDebt += request.wsxmrAmount;
                
                // Transfer locked collateral (including reward) to user as compensation
                uint256 collateralToTransfer = request.lockedCollateral + request.rewardCollateral;
                if (collateralToTransfer > 0) {
                    // Ensure we don't underflow - use min of tracked and actual
                    uint256 actualUnlock = collateralToTransfer > vault.lockedCollateral 
                        ? vault.lockedCollateral 
                        : collateralToTransfer;
                    vault.lockedCollateral -= actualUnlock;
                    
                    // Do NOT add back to collateralAmount - send directly to user
                    pendingReturns[request.user][GnosisAddresses.SDAI] += actualUnlock;
                    globalPendingSDAI += actualUnlock;
                    emit ReturnQueued(request.user, GnosisAddresses.SDAI, actualUnlock);
                }
                
                request.lockedCollateral = 0;
                request.rewardCollateral = 0;
                emit BurnSlashed(request.requestId, request.user, collateralToTransfer);
            }
        }
        
        // After resolving burn requests, add any remaining locked collateral to collateralAmount
        if (vault.lockedCollateral > 0) {
            vault.collateralAmount += vault.lockedCollateral;
            vault.lockedCollateral = 0;
        }
        
        // Re-read actual debt after burn resolution (debt may have increased from restored burns)
        actualDebt = getActualDebt(vault.normalizedDebt);
        if (actualDebt == 0) revert InsufficientDebt();
        if (_debtToClear > actualDebt) {
            _debtToClear = actualDebt;
        }

        // Re-verify vault is still liquidatable after burn resolution
        ratio = calculateCollateralRatio(vault.collateralAmount, actualDebt);
        if (ratio >= LIQUIDATION_RATIO) revert VaultHealthy();
        
        // Calculate collateral to seize (at liquidation bonus, which is < threshold to prevent death spiral)
        uint256 collateralValue = getCollateralValueForDebt(_debtToClear);
        uint256 collateralToSeize = (collateralValue * LIQUIDATION_BONUS) / RATIO_PRECISION;
        uint256 collateralAmount = usdToCollateral(collateralToSeize);
        
        // Can only seize from collateralAmount (lockedCollateral already resolved above)
        uint256 totalSeizable = vault.collateralAmount;
        if (collateralAmount > totalSeizable) {
            // Proportionally scale down the exacted debt to maintain the Liquidator's 10% bonus
            _debtToClear = (_debtToClear * totalSeizable) / collateralAmount;
            collateralAmount = totalSeizable;
        }
        
        // CHECKS-EFFECTS-INTERACTIONS: Update state before external calls
        // All collateral is now in collateralAmount (locked was consolidated above)
        vault.collateralAmount -= collateralAmount;
        
       
        // When collateral is seized, the principal tracking must be reduced proportionally
        if (lpPrincipalDeposits[_lpVault] > 0) {
            uint256 principalReduction = (lpPrincipalDeposits[_lpVault] * collateralAmount) / (vault.collateralAmount + collateralAmount);
            lpPrincipalDeposits[_lpVault] -= principalReduction;
            globalLpPrincipal -= principalReduction;
        }
        
       
        // Use ceiling division to match finalizeMint and prevent dust accumulation
        uint256 normalizedClear = (_debtToClear * 1e18 + globalDebtIndex - 1) / globalDebtIndex;
        
        // Safety check to prevent underflow from rounding
        if (normalizedClear > vault.normalizedDebt) {
            normalizedClear = vault.normalizedDebt;
        }
        vault.normalizedDebt -= normalizedClear;
        globalTotalDebt -= _debtToClear;
        
        // Burn wsXMR from liquidator (interaction after state changes)
        wsxmrToken.burn(msg.sender, _debtToClear);
        
        // Transfer seized collateral to liquidator
       
        IERC20(GnosisAddresses.SDAI).safeTransfer(msg.sender, collateralAmount);
        
       
        // When vault is liquidated, any active burns should not be cancellable
        // This prevents creating unbacked wsXMR via cancelBurn after liquidation
        // Note: Active burn requests are implicitly invalidated because:
        // 1. lockedCollateral was proportionally reduced above
        // 2. cancelBurn checks will fail due to insufficient locked amounts
        // 3. Vault debt was cleared, so restoring it would create unbacked tokens
        // In production, implement explicit burn request tracking per vault
        
       
        // If vault has zero collateral but still has debt, track as bad debt
        if (vault.collateralAmount == 0 && vault.normalizedDebt > 0) {
            uint256 remainingDebt = getActualDebt(vault.normalizedDebt);
            if (remainingDebt > 0) {
                // Track bad debt but do NOT remove from globalTotalDebt
                // Buy-and-burn will gradually pay this down via globalDebtIndex reduction
                globalBadDebt += remainingDebt;
                emit BadDebtWrittenOff(_lpVault, remainingDebt);
                // Note: vault.normalizedDebt is NOT zeroed - it remains in the system
                // so that globalDebtIndex reductions from buy-and-burn erode it over time
            }
        }
        
       
        vault.liquidationNonce++;
        vault.mintNonce++; // Invalidate all pending mints
        vault.pendingDebt = 0; // Zero pending debt since all mints are now invalid
        
        emit VaultLiquidated(_lpVault, msg.sender, _debtToClear, collateralAmount);
    }
    
    // ========== BUY-AND-BURN STRATEGY ==========
    
    /**
     * @notice Sync vault's yield and transfer accrued yield to war chest
     * @dev CRITICAL: Uses DAI value difference instead of share percentage to prevent principal depletion
     * @dev Lazy evaluation - only processes yield for vaults that interact
     * @dev Prevents DoS from unbounded loops over all vaults
     */
    function _syncVaultYield(address _lpAddress) internal {
        Vault storage vault = vaults[_lpAddress];
        if (vault.collateralAmount == 0) return;
        
        // Yield = current shares held - principal shares deposited
        // Any shares above principal are yield from sDAI appreciation
        uint256 principalShares = lpPrincipalShares[_lpAddress];
        
        if (vault.collateralAmount <= principalShares) return; // No yield
        
        uint256 yieldShares = vault.collateralAmount - principalShares;
        
        if (yieldShares <= YIELD_DUST_THRESHOLD) return;
        
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        uint256 totalObligations = actualDebt + vault.pendingDebt;
        
        if (totalObligations > 0) {
            uint256 cachedXmrPrice = getXmrPrice();
            uint256 cachedCollateralPrice = getCollateralPrice();
            
            uint256 debtValueUSD = (totalObligations * cachedXmrPrice) / 1e8;
            uint256 minCollateralUSD = (debtValueUSD * COLLATERAL_RATIO) / RATIO_PRECISION;
            uint256 minCollateralShares = (minCollateralUSD * 1e18) / cachedCollateralPrice;
            minCollateralShares += vault.lockedCollateral;
            
            if (vault.collateralAmount <= minCollateralShares) return;
            
            uint256 maxExtractable = vault.collateralAmount - minCollateralShares;
            if (yieldShares > maxExtractable) {
                yieldShares = maxExtractable;
            }
        }
        
        if (yieldShares > 0) {
            vault.collateralAmount -= yieldShares;
            yieldWarChest += yieldShares;
            
            uint256 yieldDai = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(yieldShares);
            emit YieldHarvested(yieldDai, yieldShares);
        }
    }
    
    /**
     * @notice Execute buy-and-burn when XMR dips 1% below EMA
     * @param poolFeeTier The exact Uniswap V3 fee tier to route through (e.g. 500, 3000)
     * @dev Permissionless keeper function with MEV protection and keeper bounty
     */
    function triggerBuyAndBurn(uint24 poolFeeTier) external nonReentrant {
        require(allowedPoolFeeTiers[poolFeeTier], "Invalid pool fee tier");
        
        // 1. Cooldown Check
        require(block.timestamp >= lastBuyTimestamp + COOLDOWN_PERIOD, "Cooldown active");
        
        // 2. EMA vs Spot Check (Pyth provides both)
        PythStructs.Price memory spotData = pyth.getPriceNoOlderThan(XMR_USD_FEED_ID, PRICE_MAX_AGE);
        PythStructs.Price memory emaData = pyth.getEmaPriceNoOlderThan(XMR_USD_FEED_ID, PRICE_MAX_AGE);
        
        // Validate 1% dip: Spot <= EMA * 0.99
        require(spotData.price > 0, "Invalid spot price");
        require(emaData.price > 0, "Invalid EMA price");
        require(spotData.expo == emaData.expo, "Price exponent mismatch");
        uint256 spotPrice = uint256(int256(spotData.price));
        uint256 emaPrice = uint256(int256(emaData.price));
        require(spotPrice <= (emaPrice * EMA_TRIGGER_THRESHOLD) / 100, "XMR has not dipped 1%");
        
        // 3. Calculate 20% chunk
        require(yieldWarChest > 0, "War chest is empty");
        uint256 totalChunk = (yieldWarChest * BUY_CHUNK_PERCENT) / 100;
        
        // Calculate Keeper Bounty and Actual Swap Amount
        uint256 keeperReward = (totalChunk * KEEPER_REWARD_BPS) / BPS_DENOMINATOR;
        uint256 spendAmount = totalChunk - keeperReward;
        
        // Update state (deduct the full chunk from the war chest)
        yieldWarChest -= totalChunk;
        lastBuyTimestamp = block.timestamp;
        
        // Transfer sDAI bounty to the caller to cover their gas
        if (keeperReward > 0) {
            IERC20(GnosisAddresses.SDAI).safeTransfer(msg.sender, keeperReward);
        }
        
        // 4. MEV Protection: Calculate minimum output using oracle
       
        // This prevents DoS during DAI depeg events
        uint256 sDAIPrice = getCollateralPrice(); // USD per sDAI share (18 decimals)
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
        IERC20(GnosisAddresses.SDAI).forceApprove(GnosisAddresses.UNISWAP_V3_ROUTER, spendAmount);
        uint256 wsxmrBought = ISwapRouter(GnosisAddresses.UNISWAP_V3_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: GnosisAddresses.SDAI,
                tokenOut: address(wsxmrToken),
                fee: poolFeeTier, // Dynamic input from the Keeper
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
       
        // New index = Old Index * (Remaining Debt / Existing Total Debt)
        if (globalTotalDebt > 0) {
            if (wsxmrBought >= globalTotalDebt) {
                globalDebtIndex = 1e18; // Reset to standard baseline
                globalTotalDebt = 0;
            } else {
                // Single-step calculation prevents cumulative rounding errors
                uint256 oldIndex = globalDebtIndex;
                uint256 remainingDebt = globalTotalDebt - wsxmrBought;
                globalDebtIndex = (oldIndex * remainingDebt) / globalTotalDebt;
                
                // Recalculate globalTotalDebt to stay consistent with index
                // This prevents drift from accumulating across multiple buy-and-burn cycles
                globalTotalDebt = remainingDebt;
                
                // If debt is negligible or index too low, reset to prevent precision issues
                if (globalTotalDebt < 1e4 || globalDebtIndex < 1e10) {
                    globalDebtIndex = 1e18;
                    globalTotalDebt = 0;
                }
            }
        }
        
        // Reduce tracked bad debt proportionally with buy-and-burn
        if (globalBadDebt > 0) {
            // Use pre-burn total debt as denominator (globalTotalDebt was already reduced above)
            uint256 preBurnTotalDebt = globalTotalDebt + wsxmrBought;
            if (preBurnTotalDebt > 0) {
                uint256 badDebtReduction = (globalBadDebt * wsxmrBought) / preBurnTotalDebt;
                if (badDebtReduction > globalBadDebt) badDebtReduction = globalBadDebt;
                globalBadDebt -= badDebtReduction;
            }
        }
        
        // Periodic reconciliation when feasible
        if (vaultList.length <= 200) {
            uint256 computedDebt = 0;
            for (uint256 i = 0; i < vaultList.length; i++) {
                computedDebt += getActualDebt(vaults[vaultList[i]].normalizedDebt);
            }
            globalTotalDebt = computedDebt;
        }
        
        emit BuyAndBurnExecuted(spendAmount, wsxmrBought, keeperReward, globalDebtIndex);
    }
    
    // ========== PRICE ORACLE FUNCTIONS ==========
    
    /**
     * @notice Get XMR price in USD (18 decimals)
     */
    function getXmrPrice() public view returns (uint256) {
        PythStructs.Price memory priceData = pyth.getPriceNoOlderThan(XMR_USD_FEED_ID, PRICE_MAX_AGE);
        if (priceData.price <= 0) revert StalePrice();
        
       
        // During high volatility or exchange outages, Pyth emits wide confidence intervals
        // Using such prices could enable manipulation or unfair liquidations
        uint256 price = uint256(int256(priceData.price));
        uint256 conf = uint256(priceData.conf);
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
     * @notice Get sDAI price in USD (18 decimals)
     */
    function getCollateralPrice() public view returns (uint256) {
        PythStructs.Price memory priceData = pyth.getPriceNoOlderThan(SDAI_USD_FEED_ID, PRICE_MAX_AGE);
        if (priceData.price <= 0) revert StalePrice();
        
       
        uint256 price = uint256(int256(priceData.price));
        uint256 conf = uint256(priceData.conf);
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
        
        // If Pyth prices sDAI directly (includes yield), just return normalized price
        // Remove the convertToAssets multiplier to avoid double-counting
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
     * @notice Reconcile globalTotalDebt to correct any drift from rounding
     * @dev WARNING: Only call when vault count is manageable (gas intensive)
     * @dev Anyone can call this to correct drift in globalTotalDebt tracking
     */
    function reconcileGlobalDebt() external {
        uint256 oldDebt = globalTotalDebt;
        uint256 computedDebt = 0;
        for (uint256 i = 0; i < vaultList.length; i++) {
            computedDebt += getActualDebt(vaults[vaultList[i]].normalizedDebt);
        }
        globalTotalDebt = computedDebt;
        emit GlobalDebtReconciled(oldDebt, computedDebt);
    }
    
    /**
     * @notice Compute actual total debt by summing all vaults (for off-chain monitoring)
     * @dev Used to verify globalTotalDebt accuracy and detect drift
     * @return total The sum of all vault debts
     */
    function computeActualGlobalDebt() external view returns (uint256 total) {
        for (uint256 i = 0; i < vaultList.length; i++) {
            if (vaults[vaultList[i]].active) {
                total += getActualDebt(vaults[vaultList[i]].normalizedDebt);
            }
        }
    }
    
    /**
     * @notice Deactivate an empty vault to clean up vaultList
     * @dev Can only be called by vault owner when vault has no assets or debt
     */
    function deactivateVault() external {
        Vault storage vault = vaults[msg.sender];
        require(vault.active, "Not active");
        require(vault.collateralAmount == 0, "Has collateral");
        require(vault.lockedCollateral == 0, "Has locked collateral");
        require(vault.normalizedDebt == 0, "Has debt");
        require(vault.pendingDebt == 0, "Has pending debt");
        vault.active = false;
        
        // Remove from vaultList to save gas in iterations
        for (uint256 i = 0; i < vaultList.length; i++) {
            if (vaultList[i] == msg.sender) {
                vaultList[i] = vaultList[vaultList.length - 1];
                vaultList.pop();
                break;
            }
        }
        
        emit VaultDeactivated(msg.sender);
    }
    
    /**
     * @notice Calculate collateral ratio for a vault
     * @return ratio Collateral ratio (e.g., 150 for 150%)
     */
    function calculateCollateralRatio(
        uint256 _collateralAmount,
        uint256 _debtAmount
    ) public view returns (uint256 ratio) {
        if (_debtAmount == 0) return type(uint256).max;
        
        uint256 collateralPrice = getCollateralPrice();
        uint256 xmrPrice = getXmrPrice();
        
        // Calculate collateral value in USD (18 decimals) - sDAI has 18 decimals
        uint256 collateralValue = (_collateralAmount * collateralPrice) / 1e18;
        
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
     * @notice Convert USD value to sDAI amount
     */
    function usdToCollateral(uint256 _usdValue) internal view returns (uint256) {
        uint256 collateralPrice = getCollateralPrice();
        return (_usdValue * 1e18) / collateralPrice; // sDAI has 18 decimals
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
    
    /**
     * @notice Paginated fetch for all vaults (useful for frontends and liquidators)
     * @param _cursor Starting index in the vaultList
     * @param _limit Maximum number of vaults to return
     * @return batch Array of vaults
     * @return nextCursor Next cursor position for pagination
     */
    function getVaultsPaginated(uint256 _cursor, uint256 _limit, bool _activeOnly) 
        external 
        view 
        returns (Vault[] memory batch, uint256 nextCursor) 
    {
        if (_cursor >= vaultList.length) {
            return (new Vault[](0), vaultList.length);
        }
        
        if (!_activeOnly) {
            // Original behavior when not filtering
            uint256 length = _limit;
            if (_cursor + length > vaultList.length) {
                length = vaultList.length - _cursor;
            }

            batch = new Vault[](length);
            for (uint256 i = 0; i < length; i++) {
                batch[i] = vaults[vaultList[_cursor + i]];
            }

            return (batch, _cursor + length);
        } else {
            // Filter for active vaults only
            uint256 count = 0;
            uint256 i = _cursor;
            
            // Count active vaults within limit
            while (i < vaultList.length && count < _limit) {
                if (vaults[vaultList[i]].active) {
                    count++;
                }
                i++;
            }
            
            // Allocate and populate
            batch = new Vault[](count);
            uint256 batchIndex = 0;
            i = _cursor;
            
            while (i < vaultList.length && batchIndex < count) {
                if (vaults[vaultList[i]].active) {
                    batch[batchIndex] = vaults[vaultList[i]];
                    batchIndex++;
                }
                i++;
            }
            
            return (batch, i);
        }
    }
    
    /**
     * @notice Get all active mint requests for a user
     * @param _user User address to query
     * @return activeMints Array of active mint requests
     */
    function getUserActiveMints(address _user) external view returns (MintRequest[] memory activeMints) {
        bytes32[] memory requestIds = userMintRequests[_user];
        
        // Count active requests
        uint256 count = 0;
        for (uint256 i = 0; i < requestIds.length; i++) {
            MintStatus status = mintRequests[requestIds[i]].status;
            if (status != MintStatus.COMPLETED && status != MintStatus.CANCELLED && status != MintStatus.INVALID) {
                count++;
            }
        }
        
        // Allocate and populate array
        activeMints = new MintRequest[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < requestIds.length; i++) {
            MintRequest memory req = mintRequests[requestIds[i]];
            if (req.status != MintStatus.COMPLETED && req.status != MintStatus.CANCELLED && req.status != MintStatus.INVALID) {
                activeMints[index] = req;
                index++;
            }
        }
        
        return activeMints;
    }
    
    /**
     * @notice Get all active burn requests for a user
     * @param _user User address to query
     * @return activeBurns Array of active burn requests
     */
    function getUserActiveBurns(address _user) external view returns (BurnRequest[] memory activeBurns) {
        bytes32[] memory requestIds = userBurnRequests[_user];
        
        // Count active requests
        uint256 count = 0;
        for (uint256 i = 0; i < requestIds.length; i++) {
            BurnStatus status = burnRequests[requestIds[i]].status;
            if (status != BurnStatus.COMPLETED && status != BurnStatus.CANCELLED && 
                status != BurnStatus.SLASHED && status != BurnStatus.INVALID) {
                count++;
            }
        }
        
        // Allocate and populate array
        activeBurns = new BurnRequest[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < requestIds.length; i++) {
            BurnRequest memory req = burnRequests[requestIds[i]];
            if (req.status != BurnStatus.COMPLETED && req.status != BurnStatus.CANCELLED && 
                req.status != BurnStatus.SLASHED && req.status != BurnStatus.INVALID) {
                activeBurns[index] = req;
                index++;
            }
        }
        
        return activeBurns;
    }
    
    /**
     * @notice Calculates exactly how much wsXMR a user can currently mint from a specific vault
     * @param _lpVault The LP vault to query
     * @return maxMintableWsxmr Exact amount in 8 decimals
     */
    function getVaultAvailableMintCapacity(address _lpVault) external view returns (uint256 maxMintableWsxmr) {
        Vault memory vault = vaults[_lpVault];
        if (!vault.active) return 0;

        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        uint256 totalObligations = actualDebt + vault.pendingDebt;
        uint256 availableCollateral = vault.collateralAmount > vault.lockedCollateral 
            ? vault.collateralAmount - vault.lockedCollateral 
            : 0;

        // Calculate maximum debt allowed for this available collateral
        uint256 collateralPrice = getCollateralPrice();
        uint256 xmrPrice = getXmrPrice();
        
        // Max Debt Value (USD) = (Collateral Value / 150) * 100
        uint256 collateralValueUsd = (availableCollateral * collateralPrice) / 1e18;
        uint256 maxDebtValueUsd = (collateralValueUsd * RATIO_PRECISION) / COLLATERAL_RATIO;
        uint256 maxTotalDebt = (maxDebtValueUsd * 1e8) / xmrPrice;

        if (maxTotalDebt <= totalObligations) return 0;
        
        uint256 capacity = maxTotalDebt - totalObligations;
        
        // Adjust for LP mint fee (user receives less than they request)
        // If fee is 1%, user gets 99% of minted amount, so capacity is reduced
        if (vault.mintFeeBps > 0) {
            capacity = (capacity * BPS_DENOMINATOR) / (BPS_DENOMINATOR + vault.mintFeeBps);
        }

        // Apply the LP's maxMintBps single-mint constraint if set
        if (vault.maxMintBps > 0) {
            uint256 maxPerMint = (maxTotalDebt * vault.maxMintBps) / BPS_DENOMINATOR;
            if (capacity > maxPerMint) capacity = maxPerMint;
        }

        return capacity;
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
