// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

/**
 * @title wsXmrStorage
 * @notice Shared storage layout for the wsXMR facet-based system
 * @dev All facets access state through this storage contract
 * 
 * CRITICAL: Storage layout must NEVER be modified after deployment
 * Only append new variables at the end to maintain upgrade compatibility
 */
contract wsXmrStorage {
    // ========== CONSTANTS ==========
    
    uint256 public constant COLLATERAL_RATIO = 150;
    uint256 public constant LIQUIDATION_RATIO = 120;
    uint256 public constant LIQUIDATION_BONUS = 110;
    uint256 public constant RATIO_PRECISION = 100;
    uint256 public constant PRICE_PRECISION = 1e18;
    
    uint256 public constant MAX_MINT_TIMEOUT = 24 hours;
    uint256 public constant MINT_READY_EXTENSION = 2 hours;
    
    uint256 public constant BURN_REQUEST_TIMEOUT = 1 hours;
    uint256 public constant BURN_COMMIT_TIMEOUT = 2 hours;
    
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_MARGIN_BPS = 1000;
    
    uint256 public constant COOLDOWN_PERIOD = 24 hours;
    uint256 public constant BUY_CHUNK_PERCENT = 20;
    uint256 public constant EMA_TRIGGER_THRESHOLD = 99;
    uint256 public constant MEV_SLIPPAGE_BPS = 100;
    uint256 public constant MAX_BURN_REQUESTS_PER_VAULT = 50;
    uint256 public constant MAX_VAULT_COUNT = 10000;
    uint256 public constant MIN_BURN_AMOUNT = 1e6;
    uint256 public constant BURN_LOCK_RATIO = 130;
    
    uint256 public constant XMR_TO_WSXMR_DIVISOR = 1e4;
    uint256 public constant WSXMR_DECIMALS = 1e8;
    uint256 public constant SDAI_DECIMALS = 1e18;
    
    
    // ========== EVENTS ==========
    
    event ReturnQueued(address indexed user, address indexed token, uint256 amount);
    
    // ========== ENUMS ==========
    
    enum MintStatus {
        INVALID,
        PENDING,
        READY,
        COMPLETED,
        CANCELLED
    }
    
    enum BurnStatus {
        INVALID,
        REQUESTED,
        PROPOSED,
        COMMITTED,
        COMPLETED,
        SLASHED,
        CANCELLED
    }
    
    // ========== STRUCTS ==========
    
    struct Vault {
        address lpAddress;
        uint256 collateralShares;
        uint256 lockedCollateral;
        uint256 normalizedDebt;
        uint256 pendingDebt;
        uint16 maxMintBps;
        uint256 mintGriefingDeposit;
        uint16 mintFeeBps;
        uint16 burnRewardBps;
        uint256 liquidationNonce;
        uint256 mintNonce;
        uint256 minBurnAmount;
        bool active;
    }
    
    struct MintRequest {
        bytes32 requestId;
        address initiator;
        address recipient;
        address lpVault;
        uint256 xmrAmount;
        uint256 wsxmrAmount;
        uint256 feeAmount;
        bytes32 claimCommitment;
        uint256 timeout;
        uint256 griefingDeposit;
        uint256 normalizedDebtAmount;
        uint256 vaultMintNonce;
        MintStatus status;
    }
    
    struct BurnRequest {
        bytes32 requestId;
        address user;
        address lpVault;
        uint256 wsxmrAmount;
        uint256 xmrAmount;
        uint256 lockedCollateral;
        uint256 rewardCollateral;
        bytes32 secretHash;
        uint256 deadline;
        uint256 vaultLiquidationNonce;
        uint256 normalizedDebtAmount;
        BurnStatus status;
    }
    
    // ========== IMMUTABLES ==========
    
    address public immutable wsxmrToken;
    address public immutable deployer;
    address public immutable verifierProxy;
    
    // ========== STATE VARIABLES ==========
    
    // Facet addresses
    address public vaultFacet;
    address public mintFacet;
    address public burnFacet;
    address public liquidationFacet;
    address public yieldFacet;
    address public oracleFacet;
    
    // Facet registry
    mapping(address => bool) public facets;
    
    // Router
    address public liquidityRouter;
    
    // Oracle state
    int192 public lastXmrPrice;
    uint256 public lastXmrPriceTimestamp;
    int192 public lastCollateralPrice;
    uint256 public lastCollateralPriceTimestamp;
    
    // Global state
    uint256 public lastBuyTimestamp;
    uint256 public globalTotalDebt;
    uint256 public globalDebtIndex;
    uint256 public yieldWarChest;
    mapping(address => uint256) public lpPrincipalDeposits;
    uint256 public globalLpPrincipal;
    mapping(address => uint256) public lpPrincipalShares;
    uint256 public globalLpPrincipalShares;
    uint256 public globalPendingSDAI;
    uint256 public globalBadDebt;
    uint256 public globalPendingBurnDebt;
    uint256 internal _requestNonce;
    mapping(uint24 => bool) public allowedPoolFeeTiers;
    
    // Request tracking
    mapping(address => bytes32[]) public userMintRequests;
    mapping(address => bytes32[]) public userBurnRequests;
    mapping(address => bytes32[]) public vaultBurnRequests;
    
    // Core mappings
    mapping(address => Vault) public vaults;
    mapping(bytes32 => MintRequest) public mintRequests;
    mapping(bytes32 => BurnRequest) public burnRequests;
    mapping(bytes32 => bytes32) public lpPublicKeys;
    
    // Vault list
    address[] public vaultList;
    
    // Pending returns
    mapping(address => mapping(address => uint256)) public pendingReturns;
    
    // Reentrancy guard
    uint256 internal _reentrancyStatus;
    uint256 internal constant _NOT_ENTERED = 1;
    uint256 internal constant _ENTERED = 2;
    
    // ========== STORAGE GAPS ==========
    
    /**
     * @dev Storage gap for future upgrades
     * This reserves 50 storage slots that can be used in future versions
     * without breaking the storage layout of existing deployments.
     * 
     * CRITICAL: When adding new state variables in upgrades:
     * 1. ONLY append new variables at the end (before the gap)
     * 2. Reduce __gap array size by the number of slots used
     * 3. NEVER insert variables in the middle of the layout
     * 4. NEVER remove or reorder existing variables
     * 
     * Example: If adding 3 new uint256 variables, change to:
     * uint256[47] private __gap;
     */
    uint256[50] private __gap;
    
    // ========== CONSTRUCTOR ==========
    
    constructor(address _wsxmrToken, address _verifierProxy) {
        wsxmrToken = _wsxmrToken;
        deployer = msg.sender;
        verifierProxy = _verifierProxy;
        globalDebtIndex = 1e18;
        _reentrancyStatus = _NOT_ENTERED;
    }
}
