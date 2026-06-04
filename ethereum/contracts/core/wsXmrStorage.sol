// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";

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
    
    uint256 public constant MIN_MINT_TIMEOUT_BLOCKS = 360; // ~30 min at 5s/block
    uint256 public constant MAX_MINT_TIMEOUT_BLOCKS = 17280; // ~24 hours at 5s/block
    uint256 public constant DEFAULT_MINT_TIMEOUT_BLOCKS = 720; // ~1 hour
    uint256 public constant MINT_READY_EXTENSION_BLOCKS = 1440; // ~2 hours at 5s/block

    uint256 public constant MIN_BURN_TIMEOUT_BLOCKS = 360; // ~30 min at 5s/block
    uint256 public constant MAX_BURN_TIMEOUT_BLOCKS = 17280; // ~24 hours at 5s/block
    uint256 public constant DEFAULT_BURN_TIMEOUT_BLOCKS = 720; // ~1 hour
    uint256 public constant BURN_COMMIT_TIMEOUT_BLOCKS = 1440; // ~2 hours at 5s/block
    
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_MARGIN_BPS = 1000;
    
    uint256 public constant COOLDOWN_PERIOD = 24 hours;
    uint256 public constant BUY_CHUNK_PERCENT = 20;
    uint256 public constant EMA_TRIGGER_THRESHOLD = 99;
    uint256 public constant MEV_SLIPPAGE_BPS = 100;
    uint256 public constant MAX_BURN_REQUESTS_PER_VAULT = 50;
    uint256 public constant MAX_VAULT_COUNT = 10000;
    uint256 public constant MIN_BURN_AMOUNT = 1e4; // 0.0001 wsXMR (~$0.04 at $400/XMR)
    uint256 public constant BURN_LOCK_RATIO = 130;
    
    uint256 public constant XMR_TO_WSXMR_DIVISOR = 1e4;
    uint256 public constant WSXMR_DECIMALS = 1e8;
    uint256 public constant SDAI_DECIMALS = 1e18;
    uint256 public constant PRICE_DECIMALS = 1e18; // Oracle prices are normalized to 18 decimals
    
    uint256 public constant MIN_COLP_RANGE_BPS = 1000;
    uint256 public constant MAX_COLP_RANGE_BPS = 10000;
    uint256 public constant DEFAULT_COLP_RANGE_BPS = 2500;
    uint256 public constant COLP_REBALANCE_FEE_BPS = 10;
    uint16 public constant UNISWAP_V3_FEE_TIER = 3000;
    
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
        uint256 mintReadyBond;        // LP bond required when calling setMintReady
        uint16 mintFeeBps;
        uint16 burnRewardBps;
        uint256 liquidationNonce;
        uint256 mintNonce;
        uint256 minBurnAmount;
        bool active;
        uint256 deployedSDAIShares;
        uint16 maxCoLPRangeBps;
        uint256 mintTimeoutBlocks;
        uint256 burnTimeoutBlocks;
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
        uint256 lpBond;              // LP bond posted when setMintReady called
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
    
    struct PositionMetadata {
        address vaultOwner;
        address user;
        uint256 sDAISharesOriginal;
        uint256 wsxmrOriginal;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 createdAt;
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
    mapping(address => bytes32[]) public vaultMintRequests;
    
    // Core mappings
    mapping(address => Vault) internal _vaults;
    mapping(bytes32 => MintRequest) public mintRequests;
    mapping(bytes32 => BurnRequest) public burnRequests;
    
    // LP public keys for atomic swap coordination (separate to avoid struct bloat)
    mapping(bytes32 => bytes32) public lpPublicKeys;  // requestId => LP's Ed25519 public key
    
    // Vault list
    address[] public vaultList;
    
    // Pending returns
    mapping(address => mapping(address => uint256)) public pendingReturns;
    
    // Whitelisted minters (vault => user => whitelisted)
    mapping(address => mapping(address => bool)) public whitelistedMinters;
    
    // Co-LP state
    mapping(uint256 => PositionMetadata) internal _positionMetadata;
    mapping(address => uint256[]) internal _vaultPositions;
    mapping(address => uint256[]) internal _userPositions;
    address public uniswapV3PositionManager;
    address public uniswapV3Pool;
    
    // Reentrancy guard
    uint256 internal _reentrancyStatus;
    uint256 internal constant _NOT_ENTERED = 1;
    uint256 internal constant _ENTERED = 2;
    
    // ========== INTERNAL HELPERS ==========
    
    /// @dev Internal helper to get XMR price from storage (avoids diamond staticcall issues)
    function _getXmrPriceFromStorage() internal view returns (uint256) {
        if (block.timestamp > lastXmrPriceTimestamp + 120) revert IOracleFacet.StalePrice();
        int192 price = lastXmrPrice;
        if (price <= 0) revert IOracleFacet.StalePrice();
        uint256 normalized = uint256(uint192(price)) * 1e10;
        if (normalized == 0) revert IOracleFacet.PriceNormalizedToZero();
        return normalized;
    }
    
    /// @dev Internal helper to get collateral price from storage (avoids diamond staticcall issues)
    function _getCollateralPriceFromStorage() internal view returns (uint256) {
        if (block.timestamp > lastCollateralPriceTimestamp + 120) revert IOracleFacet.StalePrice();
        int192 price = lastCollateralPrice;
        if (price <= 0) revert IOracleFacet.StalePrice();
        uint256 normalized = uint256(uint192(price)) * 1e10;
        if (normalized == 0) revert IOracleFacet.PriceNormalizedToZero();
        return normalized;
    }
    
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
    uint256[44] private __gap;
    
    // ========== CONSTRUCTOR ==========
    
    constructor(address _wsxmrToken, address _verifierProxy) {
        wsxmrToken = _wsxmrToken;
        deployer = msg.sender;
        verifierProxy = _verifierProxy;
        globalDebtIndex = 1e18;
        _reentrancyStatus = _NOT_ENTERED;
    }
}
