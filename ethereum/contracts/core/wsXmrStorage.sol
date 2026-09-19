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
    
    // HyperEVM produces ~1s blocks (vs ~5s on Gnosis) — constants rescaled x5
    // to preserve the same wall-clock timeouts.
    uint256 public constant MIN_MINT_TIMEOUT_BLOCKS = 1800; // ~30 min at 1s/block
    uint256 public constant MAX_MINT_TIMEOUT_BLOCKS = 86400; // ~24 hours at 1s/block
    uint256 public constant DEFAULT_MINT_TIMEOUT_BLOCKS = 3600; // ~1 hour
    uint256 public constant MINT_READY_EXTENSION_BLOCKS = 7200; // ~2 hours at 1s/block
    uint256 public constant LP_CLAIM_WINDOW_BLOCKS = 1800; // ~30 min for LP to claim after mint expiry

    uint256 public constant MIN_BURN_TIMEOUT_BLOCKS = 1800; // ~30 min at 1s/block
    uint256 public constant MAX_BURN_TIMEOUT_BLOCKS = 86400; // ~24 hours at 1s/block
    uint256 public constant DEFAULT_BURN_TIMEOUT_BLOCKS = 3600; // ~1 hour
    uint256 public constant BURN_COMMIT_TIMEOUT_BLOCKS = 7200; // ~2 hours at 1s/block
    uint256 public constant BURN_FINALIZE_GRACE_BLOCKS = 600; // ~10 min grace for LP finalization
    
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_MARGIN_BPS = 1000;
    
    uint256 public constant COOLDOWN_PERIOD = 24 hours;
    uint256 public constant BUY_CHUNK_PERCENT = 20;
    uint256 public constant EMA_TRIGGER_THRESHOLD = 99;
    uint256 public constant MEV_SLIPPAGE_BPS = 100;
    uint256 public constant EMA_DENOMINATOR = 1000;
    uint256 public constant EMA_ALPHA_NUMERATOR = 182; // ≈ 0.182, ~10-period EMA
    uint256 public constant MAX_PRICE_DEVIATION_BPS = 2000; // 20%
    uint256 public constant MAX_BURN_REQUESTS_PER_VAULT = 50;
    uint256 public constant MAX_VAULT_COUNT = 10000;
    uint256 public constant MIN_VAULT_COLLATERAL_BPS = 100; // 1% of max vault collateral — below this, dormant vaults are evictable
    uint256 public constant MIN_BURN_AMOUNT = 1e4; // 0.0001 wsXMR (~$0.04 at $400/XMR)
    // Collateral reserved per burn as a buffer OVER PAR (not the vault solvency ratio).
    // Par is fixed at request via xmrPriceAtRequest, so this only needs to cover DAI depeg
    // between request and settlement (sDAI yield only improves coverage).
    uint256 public constant BURN_LOCK_RATIO = 110;
    // Collateral reserved per mint at setMintReady time as a buffer OVER PAR.
    // Same rationale as BURN_LOCK_RATIO: covers sDAI depeg between ready and slash.
    uint256 public constant MINT_LOCK_RATIO = 110;
    
    uint256 public constant XMR_TO_WSXMR_DIVISOR = 1e4;
    uint256 public constant WSXMR_DECIMALS = 1e8;
    uint256 public constant SDAI_DECIMALS = 1e18;
    uint256 public constant PRICE_DECIMALS = 1e18; // Oracle prices are normalized to 18 decimals
    
    uint256 public constant MIN_COLP_RANGE_BPS = 1000;
    uint256 public constant MAX_COLP_RANGE_BPS = 10000;
    uint256 public constant DEFAULT_COLP_RANGE_BPS = 2500;
    uint256 public constant DEFAULT_COLP_SLIPPAGE_BPS = 50; // 0.5%
    uint256 public constant COLP_REBALANCE_FEE_BPS = 10;
    uint16 public constant UNISWAP_V3_FEE_TIER = 3000;
    
    // ========== EVENTS ==========
    
    event ReturnQueued(address indexed user, address indexed token, uint256 amount);

    /// @notice Emitted exactly once when the deployer permanently gives up its
    ///         facet-registration / selector-table / router-configuration powers.
    event DeployerOperationsLocked(address indexed deployer);
    
    // ========== ERRORS ==========
    
    error PendingMintLock(); // Vault has active READY mints — state-changing ops blocked
    error NoEvictableVaultFound(); // Cap reached and no dormant vaults available for eviction
    
    // ========== ENUMS ==========
    
    enum MintStatus {
        INVALID,
        PENDING,
        KEY_PROVIDED,
        READY,
        SECRET_REVEALED,
        COMPLETED,
        CANCELLED,
        EXPIRED_READY,
        KEY_CANCELLED   // KEY_PROVIDED mint timed out — deposit parked awaiting LP claim via lpSecret reveal
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
        uint256 deployedSDAIShares;
        uint16 maxCoLPRangeBps;
        uint256 mintTimeoutBlocks;
        uint256 burnTimeoutBlocks;
        uint256 pendingMintCount;     // Number of active READY mints — blocks state-changing ops
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
        bytes32 userPublicKey;       // User's compressed Ed25519 public key for 2-of-2 address derivation
        uint256 timeout;
        uint256 griefingDeposit;
        uint256 normalizedDebtAmount;
        uint256 vaultMintNonce;
        bytes32 lpCommitment;   // keccak256(Ed25519.scalarMultBase(lpSecret)) — set in provideLPKey
        bytes32 revealedSecret;  // User's Ed25519 secret, stored after revealSecret() succeeds
        MintStatus status;
        uint256 lockedCollateral;   // sDAI key bond locked at provideLPKey, re-priced to par at setMintReady — slashed to user if LP ghosts
        uint256 xmrPriceAtReady;    // XMR price at setMintReady time (18 decimals) for par settlement
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
        bytes32 userClaimCommitment;  // User's Ed25519 public point commitment for deriving Monero receive address
        bytes32 userPublicKey;          // User's Ed25519 public spend key (compressed point) for shared address derivation
        bytes32 userViewKey;            // User's Ed25519 public view key (compressed point) so user can scan the shared address
        uint256 xmrPriceAtRequest;      // XMR price locked at request time (18 decimals) for fair settlement
        bytes32 revealedSecret;         // LP's revealed Ed25519 secret (set by revealBurnSecret/finalizeBurn); 0 = not revealed
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
    uint256 internal lastBuyTimestamp;
    uint256 public globalTotalDebt;
    uint256 public globalDebtIndex;
    uint256 public yieldWarChest;
    mapping(address => uint256) public lpPrincipalDeposits;
    uint256 internal globalLpPrincipal;
    mapping(address => uint256) public lpPrincipalShares;
    uint256 internal globalLpPrincipalShares;
    uint256 public globalPendingSDAI;
    uint256 public globalBadDebt;
    uint256 public globalPendingBurnDebt;
    uint256 internal _requestNonce;
    mapping(uint24 => bool) internal allowedPoolFeeTiers;
    
    // Request tracking
    mapping(address => bytes32[]) internal userMintRequests;
    mapping(address => bytes32[]) internal userBurnRequests;
    mapping(address => bytes32[]) internal vaultBurnRequests;
    mapping(address => bytes32[]) internal vaultMintRequests;
    
    // Core mappings
    mapping(address => Vault) internal _vaults;
    mapping(bytes32 => MintRequest) public mintRequests;
    mapping(bytes32 => BurnRequest) public burnRequests;
    
    // LP public keys for atomic swap coordination (separate to avoid struct bloat)
    mapping(bytes32 => bytes32) public lpPublicKeys;  // requestId => LP's Ed25519 public spend key (for mints)
    mapping(bytes32 => bytes32) public lpPublicViewKeys;  // requestId => LP's Ed25519 public view key (for mints)
    mapping(bytes32 => bytes32) public burnLpPublicKeys;  // requestId => LP's Ed25519 public spend key (for burns)
    mapping(bytes32 => bytes32) public burnLpPublicViewKeys;  // requestId => LP's Ed25519 public view key (for burns)
    
    // Vault list
    address[] public vaultList;
    uint256 internal activeVaultCount;
    mapping(address => uint256) internal vaultListIndex; // address => index in vaultList (O(1) removal)
    
    // Pending returns
    mapping(address => mapping(address => uint256)) public pendingReturns;
    
    // Whitelisted minters (vault => user => whitelisted)
    mapping(address => mapping(address => bool)) internal whitelistedMinters;
    
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

    // M1: On-chain EMA price accumulator (18 decimals, 0 until first oracle update)
    uint256 public xmrEmaPrice;

    // Total pending READY mints across all vaults — blocks triggerBuyAndBurn (global index shift)
    uint256 public totalPendingMints;

    // Oracle price updater (moved from SimpleOracleFacet to avoid storage collision with _selectorToFacet)
    address public priceUpdater;

    // H2: Batch processing state for debt wipe and index migration (avoids unbounded loops)
    uint256 internal debtWipeBatchStart;   // 0 = idle, 1-indexed start when active
    uint256 internal migrationBatchStart;  // 0 = idle, 1-indexed start when active
    uint256 internal migrationOldIndex;    // old index to apply during lazy migration

    // ========== HYPEREVM EXTERNAL DEPENDENCIES ==========
    // Set once pre-lock via wsXmrHub.setExternalAddresses (same lifecycle as
    // liquidityRouter). Storage — not constants — so the same bytecode deploys
    // to mainnet, testnet, and local forks with different external addresses.

    /// @notice Yield-bearing collateral share token (StataUSDe — ERC-4626 over
    ///         HyperLend USDe aToken). Plays the role sDAI played on Gnosis:
    ///         vault collateralShares, lockedCollateral, pendingReturns and the
    ///         yieldWarChest are all denominated in this token.
    address public collateralToken;

    /// @notice Underlying collateral asset (USDe). Users deposit this; it is
    ///         wrapped into collateralToken via the adapter.
    address public underlyingToken;

    /// @notice DEX swap router for buy-and-burn (HyperSwap SwapRouter02).
    address public swapRouter;

    /// @notice HyperCore native XMR perp index, stored as index+1 (0 = unset).
    ///         Mainnet: 224, testnet: 202.
    uint32 public xmrPerpIndex;

    /// @notice Last time the on-chain EMA was sampled (gates EMA updates to
    ///         EMA_SAMPLE_INTERVAL so refresh frequency doesn't distort it).
    uint256 internal lastEmaSampleTime;

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

    // ========== HYPERCORE ORACLE REFRESH ==========

    /// @dev HyperEVM L1-read precompiles — universal system addresses, same on
    ///      every HyperEVM network. Raw ABI-encoded args, NO function selector.
    address internal constant ORACLE_PX_PRECOMPILE = 0x0000000000000000000000000000000000000807;
    address internal constant MARK_PX_PRECOMPILE   = 0x0000000000000000000000000000000000000806;

    /// @dev XMR perp szDecimals = 3 → precompile returns price * 10^(6-3) = price*1e3.
    ///      Storage format is RedStone-style 8 decimals → multiply by 1e5.
    uint256 internal constant PRECOMPILE_TO_8DEC = 1e5;
    /// @dev EMA samples at most once per interval so refresh cadence doesn't
    ///      collapse the ~10-period EMA into a spot tracker.
    uint256 internal constant EMA_SAMPLE_INTERVAL = 30 seconds;
    /// @dev oraclePx/markPx divergence threshold — beyond this, use the higher
    ///      price (conservative: makes wsXMR debt look largest).
    uint256 internal constant ORACLE_MARK_MAX_DIVERGENCE = 1.02e18;

    /// @notice Best-effort oracle refresh from the HyperCore native XMR perp.
    /// @dev Permissionless and trustless — the data source is the validator-
    ///      maintained perp oracle, not a WrapSynth pusher. Called at the top of
    ///      state-changing entry points and by HyperCoreOracleFacet.refreshPrices().
    ///      Silently no-ops when the precompile read fails or the index is unset,
    ///      so non-price paths (deposits, withdrawals) aren't blocked by an oracle
    ///      outage; functions that need a price still fail closed via StalePrice.
    function _tryRefreshOracle() internal {
        uint32 idx = xmrPerpIndex;
        if (idx == 0) return; // unset (stored as index+1)
        idx -= 1;

        (bool okO, bytes memory outO) = ORACLE_PX_PRECOMPILE.staticcall(abi.encode(idx));
        if (!okO || outO.length != 32) return;
        uint256 oraclePx = uint256(abi.decode(outO, (uint64)));
        if (oraclePx == 0) return;

        uint256 px = oraclePx;
        (bool okM, bytes memory outM) = MARK_PX_PRECOMPILE.staticcall(abi.encode(idx));
        if (okM && outM.length == 32) {
            uint256 markPx = uint256(abi.decode(outM, (uint64)));
            if (markPx > 0) {
                uint256 ratio = oraclePx > markPx
                    ? (oraclePx * 1e18) / markPx
                    : (markPx * 1e18) / oraclePx;
                if (ratio > ORACLE_MARK_MAX_DIVERGENCE) {
                    px = oraclePx > markPx ? oraclePx : markPx; // conservative max
                }
            }
        }

        // Store in the existing 8-decimal format (read helpers multiply by 1e10)
        lastXmrPrice = int192(int256(px * PRECOMPILE_TO_8DEC));
        lastXmrPriceTimestamp = block.timestamp;

        // USDe is the unit of account — collateral price fixed at $1.00 (8 dec).
        // The 150% ratio absorbs depeg tail risk; see migration spec §10.1.
        lastCollateralPrice = int192(1e8);
        lastCollateralPriceTimestamp = block.timestamp;

        // EMA update, gated to preserve ~10-period semantics
        if (block.timestamp >= lastEmaSampleTime + EMA_SAMPLE_INTERVAL) {
            uint256 newPrice = px * PRECOMPILE_TO_8DEC * 1e10; // 18-dec normalized
            if (xmrEmaPrice == 0) {
                xmrEmaPrice = newPrice;
            } else {
                xmrEmaPrice = (EMA_ALPHA_NUMERATOR * newPrice
                    + (EMA_DENOMINATOR - EMA_ALPHA_NUMERATOR) * xmrEmaPrice) / EMA_DENOMINATOR;
            }
            lastEmaSampleTime = block.timestamp;
        }
    }
    
    /// @dev Internal helper to denormalize debt using the hub's live globalDebtIndex
    /// @notice H2: Must be internal so it reads from delegated (hub) storage, not an external facet's frozen storage
    function _denormalizeDebt(uint256 normalizedDebt) internal view returns (uint256) {
        return (normalizedDebt * globalDebtIndex) / 1e18;
    }

    /// @dev Removes a burn request from its vault's vaultBurnRequests array via swap-and-pop.
    ///      Uses burnRequestIndexPlusOne for O(1) lookup; falls back to a linear scan for
    ///      entries created before the index existed. No-ops if the entry is not present
    ///      (e.g. already removed by abandonProposedBurn before a late claim).
    ///      Keeps the array holding only active burns so liquidation loops stay bounded.
    function _removeVaultBurnRequest(address lpVault, bytes32 requestId) internal {
        bytes32[] storage vaultBurns = vaultBurnRequests[lpVault];
        uint256 idxPlusOne = burnRequestIndexPlusOne[requestId];
        uint256 idx;
        bool found = false;

        if (idxPlusOne > 0) {
            idx = idxPlusOne - 1;
            // Defensive: verify the slot actually holds this request
            if (idx < vaultBurns.length && vaultBurns[idx] == requestId) {
                found = true;
            }
        }
        if (!found) {
            // Linear scan fallback — legacy entries or a stale index
            for (uint256 i = 0; i < vaultBurns.length; i++) {
                if (vaultBurns[i] == requestId) {
                    idx = i;
                    found = true;
                    break;
                }
            }
            if (!found) return;
        }

        uint256 lastIdx = vaultBurns.length - 1;
        if (idx != lastIdx) {
            bytes32 swapped = vaultBurns[lastIdx];
            vaultBurns[idx] = swapped;
            burnRequestIndexPlusOne[swapped] = idx + 1;
        }
        vaultBurns.pop();
        delete burnRequestIndexPlusOne[requestId];
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
    /// @notice One-way switch that permanently disables every `onlyDeployer` action.
    /// @dev Defaults to false so a fresh deployment can be configured; the deploy
    ///      script calls `wsXmrHub.lockDeployer()` as its final setup step.
    ///      Once true, registerFacets / addSelectors / removeSelectors /
    ///      setLiquidityRouter can never be called again by anyone.
    bool public deployerOperationsLocked;

    /// @notice Marks a PROPOSED burn the LP abandoned via abandonProposedBurn.
    /// @dev The burn is CANCELLED and collateral released, but the user's wsXMR is
    ///      NOT restored — it stays claimable only via resolveDeclinedProposal, which
    ///      requires the user to reveal userSecret (emitted for the LP to sweep the
    ///      shared XMR). Cleared when the late claim executes.
    mapping(bytes32 => bool) public abandonedBurns;

    /// @notice 1-indexed position of each burn request in vaultBurnRequests[lpVault].
    /// @dev 0 = untracked (pre-upgrade entries). Enables O(1) swap-and-pop removal at
    ///      settlement so the array holds only active burns and liquidation loops stay bounded.
    mapping(bytes32 => uint256) internal burnRequestIndexPlusOne;

    uint256[28] private __gap;
    
    // ========== CONSTRUCTOR ==========
    
    constructor(address _wsxmrToken, address _verifierProxy) {
        wsxmrToken = _wsxmrToken;
        deployer = msg.sender;
        verifierProxy = _verifierProxy;
        globalDebtIndex = 1e18;
        _reentrancyStatus = _NOT_ENTERED;
    }
}
