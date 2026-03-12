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
    uint256 public constant MAX_BURN_REQUESTS_PER_VAULT = 50; // Bounds liquidation loop gas cost
    // Inlined: KEEPER_REWARD_BPS = 200 (2% of chunk paid to caller)
    uint256 public constant MAX_VAULT_COUNT = 10000;
    uint256 public constant MIN_BURN_AMOUNT = 1e6; // 0.01 wsXMR minimum (8 decimals)
    uint256 public constant BURN_LOCK_RATIO = 130; // 130% lock for price movement buffer
    
    // Decimal and conversion constants
    uint256 public constant XMR_TO_WSXMR_DIVISOR = 1e4; // XMR 12 decimals -> wsXMR 8 decimals
    uint256 public constant WSXMR_DECIMALS = 1e8;
    uint256 public constant SDAI_DECIMALS = 1e18;
    // Inlined constants: YIELD_DUST_THRESHOLD=100, DEBT_DUST_THRESHOLD=1e4, MIN_DEBT_INDEX=1e10
    
    // ========== STATE VARIABLES ==========
    
    wsXMR public immutable wsxmrToken;
    
    // FIX C-1: Track deployer for one-time router setup
    address public immutable deployer;
    
    // FIX C-3: Track authorized router for internal balance burns
    address public liquidityRouter;
    
    // Pyth oracle
    IPyth public immutable pyth;
    
    // Pyth price feed IDs
    bytes32 public constant XMR_USD_FEED_ID = 0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d;
   
    bytes32 public constant SDAI_USD_FEED_ID = 0xb0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd;

    // Oracle staleness configuration (in seconds)
    uint256 public constant PRICE_MAX_AGE = 2 minutes;
    // FIX H-2: Tighter staleness for liquidity operations to prevent manipulation
    uint256 public constant LIQUIDITY_PRICE_MAX_AGE = 30 seconds;
    
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
    uint256 public globalBadDebt; // Unbacked wsXMR supply from liquidation shortfalls
    uint256 public globalPendingBurnDebt; // FIX H-4: Track debt in pending burns separately
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
    
    // Farcaster atomic swap: LP's public key for each mint request
    mapping(bytes32 => bytes32) public lpPublicKeys; // requestId => P_b (LP's public spend key)
    
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
    event LPKeyProvided(bytes32 indexed requestId, bytes32 lpPublicKey);
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
    event MinBurnAmountUpdated(address indexed lpVault, uint256 newMinBurnAmount);
    event VaultDeactivated(address indexed lpVault);
    event GlobalDebtReconciled(uint256 oldDebt, uint256 newDebt);
    
    // FIX L-5: Add missing events for cleanup operations
    event UserMintRequestsCleanedUp(address indexed user, uint256 removedCount);
    event UserBurnRequestsCleanedUp(address indexed user, uint256 removedCount);
    event VaultBurnRequestsCleanedUp(address indexed vault, uint256 removedCount);
    
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
    error MaxVaultsReached();
    error ETHTransferFailed();
    error OnlyRouter();
    error OnlyDeployer();
    error RouterAlreadySet();
    error BelowMinimumBurn();
    error MaxBurnRequestsReached();
    error OnlyUserCanInitiate();
    error GracePeriodOnlyUser();
    error BurnInvalidatedByLiquidation();
    error InvalidPoolFeeTier();
    error CooldownActive();
    error InvalidSpotPrice();
    error InvalidEMAPrice();
    error PriceExponentMismatch();
    error XMRNotDipped();
    error WarChestEmpty();
    error PriceNormalizedToZero();
    error RefundFailed();
    error CancelBurnsFirst();
    
    // ========== CONSTRUCTOR ==========
    
    constructor(address _pythContract) {
        if (_pythContract == address(0)) revert ZeroAddress();
        
        deployer = msg.sender; // FIX C-1: Store deployer for router setup
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
        if (vaultList.length >= MAX_VAULT_COUNT) revert MaxVaultsReached();
        
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
        
       
        // Calculate what proportion of the vault this withdrawal represents
        // Use shares-to-shares ratio for consistency (both are in sDAI share units)
        uint256 withdrawalProportion = (_amount * 1e18) / collateralAfterSync; // 18 decimal proportion

        // Deduct principal deposits proportionally
        uint256 principalToDeduct = (lpPrincipalDeposits[msg.sender] * withdrawalProportion) / 1e18;
        if (principalToDeduct > lpPrincipalDeposits[msg.sender]) {
            principalToDeduct = lpPrincipalDeposits[msg.sender];
        }
        lpPrincipalDeposits[msg.sender] -= principalToDeduct;
        if (principalToDeduct > globalLpPrincipal) {
            principalToDeduct = globalLpPrincipal;
        }
        globalLpPrincipal -= principalToDeduct;

        // Deduct principal shares proportionally
        uint256 sharesToDeduct = (lpPrincipalShares[msg.sender] * withdrawalProportion) / 1e18;
        if (sharesToDeduct > lpPrincipalShares[msg.sender]) {
            sharesToDeduct = lpPrincipalShares[msg.sender];
        }
        lpPrincipalShares[msg.sender] -= sharesToDeduct;
        if (sharesToDeduct > globalLpPrincipalShares) {
            sharesToDeduct = globalLpPrincipalShares;
        }
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
        emit MinBurnAmountUpdated(msg.sender, _minAmount);
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
            (bool success, ) = payable(msg.sender).call{value: amount}("");
            if (!success) revert ETHTransferFailed();
        } else {
            // Withdraw ERC20
            IERC20(_token).safeTransfer(msg.sender, amount);
        }
        
        emit ReturnsWithdrawn(msg.sender, _token, amount);
    }
    
    // ========== MINTING FLOW ==========
    
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
        
        // FIX M-2: Sync yield before reading collateral amounts
        _syncVaultYield(_lpVault);
        
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
     * @notice LP provides their public key for Farcaster atomic swap
     * @param _requestId The mint request ID
     * @param _lpPublicKey LP's public spend key (P_b) for this swap
     */
    function provideLPKey(bytes32 _requestId, bytes32 _lpPublicKey) external {
        MintRequest storage request = mintRequests[_requestId];
        if (request.status != MintStatus.PENDING) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();
        if (_lpPublicKey == bytes32(0)) revert InvalidValue();
        
        lpPublicKeys[_requestId] = _lpPublicKey;
        emit LPKeyProvided(_requestId, _lpPublicKey);
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
        
        // FIX M-2: Sync yield for accurate collateral check
        _syncVaultYield(request.lpVault);
        
        // FIX M-6: Verify vault can support THIS mint, not all pending debt
        // Checking against all pending debt creates deadlock when other mints are abandoned
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        uint256 projectedDebtWithThisMint = actualDebt + request.wsxmrAmount;
        uint256 availableCollateral = vault.collateralAmount > vault.lockedCollateral
            ? vault.collateralAmount - vault.lockedCollateral
            : 0;
        uint256 currentRatio = calculateCollateralRatio(availableCollateral, projectedDebtWithThisMint);
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
        
        // FIX M-2: Sync yield before modifying debt
        _syncVaultYield(request.lpVault);
        
        // Check if vault was liquidated after this mint was initiated
        if (request.vaultMintNonce != vault.mintNonce) {
            // Vault was liquidated. Refund griefing deposit, cancel request.
            request.status = MintStatus.CANCELLED;
            if (request.griefingDeposit > 0) {
                pendingReturns[request.initiator][address(0)] += request.griefingDeposit;
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
                // FIX H-3: LP failed to respond (never called setMintReady) - return to initiator
                // The LP should not be rewarded for non-cooperation
                pendingReturns[request.initiator][address(0)] += depositToTransfer;
                emit ReturnQueued(request.initiator, address(0), depositToTransfer);
            } else {
                // LP confirmed but user failed to finalize - compensate LP for locking XMR
                pendingReturns[vault.lpAddress][address(0)] += depositToTransfer;
                emit ReturnQueued(vault.lpAddress, address(0), depositToTransfer);
            }
        }
    }
    
    // ========== BURNING FLOW (3-STEP HANDSHAKE) ==========
    
    /**
     * @notice Step 1: User requests burn - LOCK WITHOUT ESCROW
     * @dev Burns user's wsXMR and LOCKS (not escrows) LP collateral
     * @dev CRITICAL: Collateral stays in vault and remains LIQUIDATABLE
     * @dev Only callable by the user directly. No relayer/meta-tx support.
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
        return _requestBurn(_wsxmrAmount, _lpVault, _user, false);
    }
    
    /**
     * @notice FIX C-3: Allow router to burn wsXMR from internal deposits
     * @dev Only callable by the wsXMRLiquidityRouter contract
     * @param _wsxmrAmount Amount of wsXMR to burn from router internal balance
     * @param _lpVault LP vault to handle the burn
     * @param _user Address whose internal wsXMR deposit to burn
     * @return requestId Unique identifier for this burn request
     */
    function requestBurnFromRouter(
        uint256 _wsxmrAmount,
        address _lpVault,
        address _user
    ) external nonReentrant returns (bytes32 requestId) {
        // Only the authorized router can call this function
        if (msg.sender != liquidityRouter) revert OnlyRouter();
        return _requestBurn(_wsxmrAmount, _lpVault, _user, true);
    }
    
    /**
     * @notice Set the authorized liquidity router address (one-time setup)
     * @dev FIX C-1: Only deployer can call this to prevent front-running
     * @dev Should be called immediately after router deployment
     * @param _router Address of the wsXMRLiquidityRouter contract
     */
    function setLiquidityRouter(address _router) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (liquidityRouter != address(0)) revert RouterAlreadySet();
        if (_router == address(0)) revert ZeroAddress();
        liquidityRouter = _router;
    }
    
    /**
     * @notice Internal burn request logic
     * @param _fromRouter If true, caller must be router and burn is from internal balance
     */
    function _requestBurn(
        uint256 _wsxmrAmount,
        address _lpVault,
        address _user,
        bool _fromRouter
    ) internal returns (bytes32 requestId) {
        if (_wsxmrAmount == 0) revert ZeroAmount();
        if (_lpVault == address(0)) revert ZeroAddress();
        if (_user == address(0)) revert ZeroAddress();
        if (!vaults[_lpVault].active) revert VaultDoesNotExist();
        
        _syncVaultYield(_lpVault);
        
        if (_wsxmrAmount < MIN_BURN_AMOUNT) revert BelowMinimumBurn();
        
        Vault storage vault = vaults[_lpVault];
        
        if (vault.minBurnAmount > 0) {
            if (_wsxmrAmount < vault.minBurnAmount) revert BelowMinimumBurn();
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
        if (activeCount >= MAX_BURN_REQUESTS_PER_VAULT) revert MaxBurnRequestsReached();
        
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        if (actualDebt < _wsxmrAmount) revert InsufficientDebt();
        
        // Check that vault will remain healthy AFTER locking collateral for this burn
        // Calculate collateral needed first
        uint256 collateralValue = getCollateralValueForDebt(_wsxmrAmount);
        // Lock at 130% of debt value (higher than LIQUIDATION_RATIO of 120%)
        // to provide a buffer against price movements during the burn handshake.
        // The extra 10% buffer protects users if XMR price rises before settlement.
        uint256 collateralToLock = usdToCollateral(
            (collateralValue * BURN_LOCK_RATIO) / RATIO_PRECISION
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
        
        // FIX C-3: Handle both wallet burns and router internal balance burns
        if (!_fromRouter) {
            // Standard burn: only user can initiate to prevent malicious relayer attacks
            if (msg.sender != _user) revert OnlyUserCanInitiate();
            wsxmrToken.burn(_user, _wsxmrAmount);
        } else {
            // Router burn: tokens already held by router, will be burned by router
            // Caller validation already done in requestBurnFromRouter
        }
        
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
        // FIX H-4: Track this debt as pending to exclude from buy-and-burn
        globalPendingBurnDebt += _wsxmrAmount;
        
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
        
        // Safely adjust vault locked collateral (already done above, keep as is)

        // Process reward from the locked collateral before returning base to vault
        uint256 safeReward = 0;
        if (request.rewardCollateral > 0) {
            safeReward = request.rewardCollateral;
            
            // After giving the reward, check if remaining vault would be healthy
            // Return base locked collateral to vault first for calculation
            uint256 projectedCollateral = vault.collateralAmount + request.lockedCollateral;
            uint256 remainingDebt = getActualDebt(vault.normalizedDebt);
            
            if (remainingDebt > 0) {
            // FIX M-5: Subtract OTHER locked collateral (not this request's lock)
            uint256 otherLockedCollateral = vault.lockedCollateral - 
                (request.lockedCollateral + request.rewardCollateral);
            
            uint256 availableForDebt = projectedCollateral > otherLockedCollateral
                ? projectedCollateral - otherLockedCollateral
                : 0;
            uint256 ratioAfterReward = calculateCollateralRatio(
                availableForDebt - safeReward,
                remainingDebt + vault.pendingDebt
            );
                if (ratioAfterReward < LIQUIDATION_RATIO) {
                    // Reduce reward to maintain health
                    uint256 collateralPrice = getCollateralPrice();
                    uint256 xmrPrice = getXmrPrice();
                    uint256 debtValueUSD = ((remainingDebt + vault.pendingDebt) * xmrPrice) / 1e8;
                    uint256 minCollateralUSD = (debtValueUSD * LIQUIDATION_RATIO) / RATIO_PRECISION;
                    uint256 minCollateralShares = (minCollateralUSD * 1e18) / collateralPrice + vault.lockedCollateral;
                    
                    if (projectedCollateral > minCollateralShares) {
                        safeReward = projectedCollateral - minCollateralShares;
                    } else {
                        safeReward = 0;
                    }
                    
                    if (safeReward < request.rewardCollateral) {
                        emit BurnRewardShortfall(_requestId, request.rewardCollateral, safeReward);
                    }
                }
            }
        }

        // Unlock from lockedCollateral tracker
        uint256 totalUnlock = request.lockedCollateral + request.rewardCollateral;
        if (vault.lockedCollateral >= totalUnlock) {
            vault.lockedCollateral -= totalUnlock;
        } else {
            vault.lockedCollateral = 0; // Protection against liquidation underflows
        }

        // CRITICAL FIX H-5: Return unused reward portion to vault to prevent token loss
        uint256 unusedReward = request.rewardCollateral - safeReward;
        vault.collateralAmount += request.lockedCollateral + unusedReward;

        // Principal tracking for the reward portion
        if (safeReward > 0 && lpPrincipalDeposits[vault.lpAddress] > 0) {
            uint256 totalVaultAssets = vault.collateralAmount + vault.lockedCollateral;
            uint256 principalReduction = totalVaultAssets > 0
                ? (lpPrincipalDeposits[vault.lpAddress] * safeReward) / totalVaultAssets
                : 0;
            if (principalReduction > lpPrincipalDeposits[vault.lpAddress]) {
                principalReduction = lpPrincipalDeposits[vault.lpAddress];
            }
            lpPrincipalDeposits[vault.lpAddress] -= principalReduction;
            globalLpPrincipal -= principalReduction;
            
            pendingReturns[request.user][GnosisAddresses.SDAI] += safeReward;
            globalPendingSDAI += safeReward;
            emit ReturnQueued(request.user, GnosisAddresses.SDAI, safeReward);
        }
        
        // FIX H-4: Remove from pending burn debt tracking
        if (globalPendingBurnDebt >= request.wsxmrAmount) {
            globalPendingBurnDebt -= request.wsxmrAmount;
        } else {
            globalPendingBurnDebt = 0;
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

        // Reduce principal shares proportionally
        if (lpPrincipalShares[vault.lpAddress] > 0) {
            uint256 totalVaultAssets = vault.collateralAmount + vault.lockedCollateral + actualSeized;
            uint256 sharesReduction = totalVaultAssets > 0
                ? (lpPrincipalShares[vault.lpAddress] * actualSeized) / totalVaultAssets
                : 0;
            if (sharesReduction > lpPrincipalShares[vault.lpAddress]) {
                sharesReduction = lpPrincipalShares[vault.lpAddress];
            }
            lpPrincipalShares[vault.lpAddress] -= sharesReduction;
            if (sharesReduction > globalLpPrincipalShares) {
                sharesReduction = globalLpPrincipalShares;
            }
            globalLpPrincipalShares -= sharesReduction;
        }
        
        // Queue collateral for user withdrawal (pull pattern prevents DoS)
        pendingReturns[request.user][GnosisAddresses.SDAI] += actualSeized;
        globalPendingSDAI += actualSeized;
        emit ReturnQueued(request.user, GnosisAddresses.SDAI, actualSeized);
        
        request.lockedCollateral = 0;
        request.rewardCollateral = 0;
        
        // FIX H-4: Remove from pending burn debt tracking
        if (globalPendingBurnDebt >= request.wsxmrAmount) {
            globalPendingBurnDebt -= request.wsxmrAmount;
        } else {
            globalPendingBurnDebt = 0;
        }
        
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
        
        if (block.timestamp < request.deadline) revert DeadlineNotExpired();
        
        // FIX L-4: Grace period only applies if LP took action (PROPOSED status)
        // For REQUESTED status (LP never responded), allow immediate permissionless cancellation
        if (request.status == BurnStatus.PROPOSED) {
            // Add 15-minute grace period after deadline before permissionless cancellation
            // Only the user can cancel during the grace period
            uint256 gracePeriod = 15 minutes;
            if (block.timestamp < request.deadline + gracePeriod) {
                if (msg.sender != request.user) revert GracePeriodOnlyUser();
            }
        }
        
        _syncVaultYield(request.lpVault);
        
        Vault storage vault = vaults[request.lpVault];
        if (request.vaultLiquidationNonce != vault.liquidationNonce) revert BurnInvalidatedByLiquidation();
        
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
                // Vault cannot safely absorb the restored debt.
                // The user's wsXMR was already burned in requestBurn, so no
                // unbacked supply exists. Compensate user with collateral equal
                // to the VALUE of their burned wsXMR, not the full lock amount
                // (which includes the 120% ratio buffer).
                
                // Calculate fair compensation: value of burned wsXMR in collateral
                uint256 fairCompensationUsd = getCollateralValueForDebt(request.wsxmrAmount);
                uint256 fairCompensationCollateral = usdToCollateral(fairCompensationUsd);
                
                // Cap at available locked amount
                if (fairCompensationCollateral > totalUnlock) {
                    fairCompensationCollateral = totalUnlock;
                }
                
                // Release locked collateral
                vault.lockedCollateral -= totalUnlock;
                
                // Give user fair compensation
                pendingReturns[request.user][GnosisAddresses.SDAI] += fairCompensationCollateral;
                globalPendingSDAI += fairCompensationCollateral;
                emit ReturnQueued(request.user, GnosisAddresses.SDAI, fairCompensationCollateral);
                
                // Return excess to vault (the 120% buffer minus user's fair share)
                uint256 excessCollateral = totalUnlock - fairCompensationCollateral;
                if (excessCollateral > 0) {
                    vault.collateralAmount += excessCollateral;
                }
                
                // Update principal tracking for the portion given to user
                if (lpPrincipalDeposits[vault.lpAddress] > 0 && fairCompensationCollateral > 0) {
                    uint256 totalVaultAssets = vault.collateralAmount + vault.lockedCollateral + fairCompensationCollateral;
                    uint256 principalReduction = totalVaultAssets > 0
                        ? (lpPrincipalDeposits[vault.lpAddress] * fairCompensationCollateral) / totalVaultAssets
                        : 0;
                    if (principalReduction > lpPrincipalDeposits[vault.lpAddress]) {
                        principalReduction = lpPrincipalDeposits[vault.lpAddress];
                    }
                    lpPrincipalDeposits[vault.lpAddress] -= principalReduction;
                    globalLpPrincipal -= principalReduction;
                }
                
                request.status = BurnStatus.CANCELLED;
                emit BurnCancelled(_requestId);
                return;
            }
        }
        
        // Vault is healthy enough - restore debt and re-mint
        // FIX H-2: Use the ORIGINAL normalized amount to prevent inflation
        // from index changes between requestBurn and cancelBurn
        uint256 restoredNormalized = request.normalizedDebtAmount;
        
        // Safety: cap at what would produce the original wsxmrAmount
        // at the current index to prevent over-restoration
        uint256 maxNormalized = (request.wsxmrAmount * 1e18 + globalDebtIndex - 1) / globalDebtIndex;
        
        // Use the SMALLER of stored vs fresh to prevent inflation
        if (restoredNormalized > maxNormalized) {
            restoredNormalized = maxNormalized;
        }
        
        vault.normalizedDebt += restoredNormalized;
        globalTotalDebt += request.wsxmrAmount;
        
        // FIX H-4: Remove from pending burn debt tracking since we're restoring it
        if (globalPendingBurnDebt >= request.wsxmrAmount) {
            globalPendingBurnDebt -= request.wsxmrAmount;
        } else {
            globalPendingBurnDebt = 0;
        }
        
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
        
        // NOTE: Burns must be cancelled via cancelBurn() before liquidation
        // Liquidation only seizes unlocked collateral
        if (vault.lockedCollateral > 0) {
            revert CancelBurnsFirst();
        }
        
        // Re-read actual debt after burn resolution (debt may have increased from restored burns)
        actualDebt = getActualDebt(vault.normalizedDebt);
        if (actualDebt == 0) revert InsufficientDebt();
        if (_debtToClear > actualDebt) {
            _debtToClear = actualDebt;
        }

        // Re-verify vault is still liquidatable after burn resolution
        // vault.collateralAmount excludes lockedCollateral (deducted in requestBurn)
        // actualDebt excludes debt cleared by burns (normalizedDebt was reduced in requestBurn)
        // Therefore this ratio correctly measures: unlocked collateral vs unbacked debt
        ratio = calculateCollateralRatio(vault.collateralAmount, actualDebt);
        if (ratio >= LIQUIDATION_RATIO) revert VaultHealthy();
        
        // Warn: if there are still unprocessed burn requests, the seized
        // collateral amount may be less than expected because some collateral
        // remains locked for those burns. This is correct behavior.
        
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

        // Also reduce principal shares proportionally to keep yield tracking consistent
        if (lpPrincipalShares[_lpVault] > 0) {
            uint256 sharesReduction = (lpPrincipalShares[_lpVault] * collateralAmount) / (vault.collateralAmount + collateralAmount);
            if (sharesReduction > lpPrincipalShares[_lpVault]) {
                sharesReduction = lpPrincipalShares[_lpVault];
            }
            lpPrincipalShares[_lpVault] -= sharesReduction;
            if (sharesReduction > globalLpPrincipalShares) {
                sharesReduction = globalLpPrincipalShares;
            }
            globalLpPrincipalShares -= sharesReduction;
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
        
        // CRITICAL FIX C-4: Always increment liquidationNonce to invalidate ALL burns atomically
        // This prevents race conditions where remaining REQUESTED burns can be cancelled
        // and re-mint wsXMR to an already-liquidated vault
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
        
        // CRITICAL FIX H-1: Compare DAI values, not share counts
        // sDAI is rebasing-by-value: shares stay constant but their DAI value increases
        uint256 principalShares = lpPrincipalShares[_lpAddress];
        if (principalShares == 0) return; // No principal deposited yet
        
        // Convert both to DAI values for comparison
        uint256 currentDaiValue = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(vault.collateralAmount);
        uint256 principalDaiValue = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(principalShares);
        
        if (currentDaiValue <= principalDaiValue) return; // No yield
        
        uint256 yieldDaiValue = currentDaiValue - principalDaiValue;
        
        // Convert yield DAI value back to shares for extraction
        // Use convertToShares to get exact shares needed for the yield DAI amount
        uint256 yieldShares = ISavingsDAI(GnosisAddresses.SDAI).convertToShares(yieldDaiValue);
        
        // Safety check: don't extract more shares than available
        if (yieldShares > vault.collateralAmount - principalShares) {
            yieldShares = vault.collateralAmount - principalShares;
        }
        
        if (yieldShares < 100) return;
        
        uint256 actualDebt = getActualDebt(vault.normalizedDebt);
        uint256 totalObligations = actualDebt + vault.pendingDebt;
        
        if (totalObligations > 0) {
            uint256 cachedXmrPrice = getXmrPrice();
            uint256 cachedCollateralPrice = getCollateralPrice();
            
            // Add 5% buffer above collateral ratio to prevent yield extraction
            // from making subsequent operations fail
            uint256 YIELD_BUFFER_RATIO = 155; // 155% instead of 150%
            uint256 debtValueUSD = (totalObligations * cachedXmrPrice) / 1e8;
            uint256 minCollateralUSD = (debtValueUSD * YIELD_BUFFER_RATIO) / 100;
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
        if (!allowedPoolFeeTiers[poolFeeTier]) revert InvalidPoolFeeTier();
        
        // 1. Cooldown Check
        if (block.timestamp < lastBuyTimestamp + 1800) revert CooldownActive();
        
        // 2. EMA vs Spot Check (Pyth provides both)
        PythStructs.Price memory spotData = pyth.getPriceNoOlderThan(XMR_USD_FEED_ID, 3600);
        PythStructs.Price memory emaData = pyth.getEmaPriceNoOlderThan(XMR_USD_FEED_ID, 3600);
        
        // Validate 1% dip: Spot <= EMA * 0.99
        if (spotData.price <= 0) revert InvalidSpotPrice();
        if (emaData.price <= 0) revert InvalidEMAPrice();
        if (spotData.expo != emaData.expo) revert PriceExponentMismatch();
        uint256 spotPrice = uint256(int256(spotData.price));
        uint256 emaPrice = uint256(int256(emaData.price));
        if (spotPrice > (emaPrice * 99) / 100) revert XMRNotDipped();
        
        // 3. Calculate 20% chunk
        if (yieldWarChest == 0) revert WarChestEmpty();
        uint256 totalChunk = (yieldWarChest * 20) / 100;
        
        // Calculate Keeper Bounty and Actual Swap Amount
        uint256 keeperReward = (totalChunk * 200) / BPS_DENOMINATOR;
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
        uint256 minWsxmrOut = (expectedWsxmr * 98) / 100;
        
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
        uint256 effectiveTotalDebt = globalTotalDebt > globalPendingBurnDebt 
            ? globalTotalDebt - globalPendingBurnDebt 
            : 0;
       
        if (effectiveTotalDebt > 0) {
            if (wsxmrBought >= effectiveTotalDebt) {
                globalDebtIndex = 1e18;
                globalTotalDebt = 0;
            } else {
                uint256 remainingDebt = effectiveTotalDebt - wsxmrBought;
                globalDebtIndex = (globalDebtIndex * remainingDebt) / effectiveTotalDebt;
                globalTotalDebt = remainingDebt;
                
                if (globalTotalDebt < 1e4 || globalDebtIndex < 1e10) {
                    globalDebtIndex = 1e18;
                    globalTotalDebt = 0;
                }
            }
        }
        
        if (globalBadDebt > 0 && effectiveTotalDebt > 0) {
            uint256 reduction = (globalBadDebt * wsxmrBought) / (effectiveTotalDebt + wsxmrBought);
            globalBadDebt -= reduction > globalBadDebt ? globalBadDebt : reduction;
        }
        
        emit BuyAndBurnExecuted(spendAmount, wsxmrBought, keeperReward, globalDebtIndex);
    }
    
    // ========== PRICE ORACLE FUNCTIONS ==========
    
    /**
     * @notice Get XMR price in USD (18 decimals) with custom staleness
     * @param maxAge Maximum age of price in seconds
     */
    function getXmrPriceWithAge(uint256 maxAge) public view returns (uint256) {
        PythStructs.Price memory priceData = pyth.getPriceNoOlderThan(XMR_USD_FEED_ID, maxAge);
        if (priceData.price <= 0) revert StalePrice();
        
        uint256 price = uint256(int256(priceData.price));
        uint256 conf = uint256(priceData.conf);
        if (conf * 10 > price) revert StalePrice();
        
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
        if (normalizedPrice == 0) revert PriceNormalizedToZero();
        return normalizedPrice;
    }
    
    function getXmrPrice() public view returns (uint256) {
        return getXmrPriceWithAge(PRICE_MAX_AGE);
    }
    
    /**
     * @notice Get sDAI price in USD (18 decimals) with custom staleness
     * @param maxAge Maximum age of price in seconds
     */
    function getCollateralPriceWithAge(uint256 maxAge) public view returns (uint256) {
        PythStructs.Price memory priceData = pyth.getPriceNoOlderThan(SDAI_USD_FEED_ID, maxAge);
        if (priceData.price <= 0) revert StalePrice();
        
        uint256 price = uint256(int256(priceData.price));
        uint256 conf = uint256(priceData.conf);
        if (conf * 10 > price) revert StalePrice();
        
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
        if (normalizedPrice == 0) revert PriceNormalizedToZero();
        return normalizedPrice;
    }
    
    function getCollateralPrice() public view returns (uint256) {
        return getCollateralPriceWithAge(PRICE_MAX_AGE);
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
            if (!success) revert RefundFailed();
        }
    }
}
