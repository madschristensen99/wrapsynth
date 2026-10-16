// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";
import {IUniswapV3Pool} from "../interfaces/external/IUniswapV3Pool.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TickMath} from "../libraries/TickMath.sol";
import {FullMath} from "../libraries/FullMath.sol";

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
    // LP liveness assumption: after a mint times out, the LP has this window to
    // reveal lpSecret (abandonKeyProvidedMint / claimGriefingDeposit) before the
    // key bond is slashed to the user. The protocol already assumes LP liveness —
    // only the LP can attest deposits (setMintReady) and un-stick XMR at the shared
    // address — so the window just defines how quickly a "live" LP must respond.
    // 3600 ≈ 1 hour at 1s/block (HyperEVM): tolerant of brief outages/restarts,
    // short enough that a permanently dead LP's bonds still resolve.
    uint256 public constant LP_CLAIM_WINDOW_BLOCKS = 3600; // ~1 hour for LP to claim after mint expiry

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

    /// @notice Best-effort oracle refresh. Runs two independent legs:
    ///         1. HyperCore XMR perp precompile read (HyperEVM only — silently
    ///            skips where the precompile doesn't exist)
    ///         2. On-chain collateral TWAP (chains where collateralTwapPool is
    ///            configured — BNB deployment)
    /// @dev Permissionless and trustless — the data source is the validator-
    ///      maintained perp oracle / the DEX's own observation accumulator,
    ///      not a WrapSynth pusher. Called at the top of state-changing entry
    ///      points and by oracle-facet refresh functions. Silently no-ops on
    ///      read failure so non-price paths (deposits, withdrawals) aren't
    ///      blocked by an oracle outage; functions that need a price still
    ///      fail closed via StalePrice.
    function _tryRefreshOracle() internal {
        _tryRefreshXmrFromPrecompile();
        _tryRefreshCollateralTwap();
    }

    /// @dev HyperEVM leg: read the native XMR perp oraclePx/markPx and store.
    ///      Collateral is pinned at $1.00 there (USDe unit of account).
    function _tryRefreshXmrFromPrecompile() internal {
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
        // Skipped when a collateral TWAP pool is configured (BNB): the TWAP
        // leg owns the collateral price there and writes it right after.
        if (collateralTwapPool == address(0)) {
            lastCollateralPrice = int192(1e8);
            lastCollateralPriceTimestamp = block.timestamp;
        }

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

    /// @dev On-chain collateral leg (BNB): recompute the collateral USD price
    ///      from the configured V3 TWAP pools. Silent no-op when unconfigured
    ///      or when a pool lacks observation history — stale detection stays
    ///      with the readers (_getCollateralPriceFromStorage → StalePrice).
    function _tryRefreshCollateralTwap() internal {
        if (collateralTwapPool == address(0) || collateralTwapWindow == 0) return;
        uint256 price8dec = _collateralTwapUsd8dec();
        if (price8dec == 0) return;
        lastCollateralPrice = int192(int256(price8dec));
        lastCollateralPriceTimestamp = block.timestamp;
    }

    /// @notice Refresh the collateral price from on-chain TWAPs and revert if
    ///         the result still isn't fresh. Callable through the oracle facet.
    function _refreshCollateralTwapOrRevert() internal {
        _tryRefreshCollateralTwap();
        if (block.timestamp > lastCollateralPriceTimestamp + 120) {
            revert IOracleFacet.StalePrice();
        }
    }

    /// @dev collateral/USD = TWAP(collateral/intermediate) × TWAP(intermediate/USD).
    ///      Returns the 8-decimal storage format, 0 on any read failure.
    ///      Decimal-corrected: _twapQuote18 quotes raw quote units per 1e18 raw
    ///      base units, so each leg is normalized by 10^(baseDec - quoteDec);
    ///      the intermediate token's decimals cancel between the two legs.
    ///      A zero quoteTwapPool selects single-leg mode: the collateral pool
    ///      quotes USD directly (pxB = 1e18, e.g. cbBTC/USDC on Base).
    function _collateralTwapUsd8dec() internal view returns (uint256) {
        uint256 pxA = _twapQuote18(collateralTwapPool, underlyingToken, twapIntermediateToken);
        if (pxA == 0) return 0;
        uint8 decU = _tryDecimals(underlyingToken);
        uint8 decI = _tryDecimals(twapIntermediateToken);
        uint8 decUsd = _tryDecimals(twapUsdToken);
        // Normalize leg A to an 18-decimal whole-token price
        uint256 legA18 = FullMath.mulDiv(pxA, 10 ** decU, 10 ** decI);
        uint256 legB18;
        if (quoteTwapPool == address(0)) {
            legB18 = 1e18; // single-leg: pool already quotes the USD token
        } else {
            uint256 pxB = _twapQuote18(quoteTwapPool, twapIntermediateToken, twapUsdToken);
            if (pxB == 0) return 0;
            legB18 = FullMath.mulDiv(pxB, 10 ** decI, 10 ** decUsd);
        }
        // 1e18 × 1e18 / 1e28 → 8-decimal price (RedStone storage format)
        return FullMath.mulDiv(legA18, legB18, 1e28);
    }

    /// @dev Smallest-unit scale of the collateral underlying (10^decimals).
    ///      "dai" amounts flowing through the protocol are raw underlying
    ///      units, so all USD↔underlying conversions must divide/multiply by
    ///      this — not a hardcoded 1e18 (cbBTC is 8-dec).
    function _underlyingUnit() internal view returns (uint256) {
        return underlyingDecimals == 0 ? 1e18 : 10 ** underlyingDecimals;
    }

    /// @dev decimals() lookup defaulting to 18 for tokens that don't expose it.
    function _tryDecimals(address token) internal view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 18;
        }
    }

    /// @dev UniV3-style getQuote: quote tokens per 1e18 raw base units, using
    ///      the pool's arithmetic-mean tick over collateralTwapWindow. The raw
    ///      scale is normalized by the caller (_collateralTwapUsd8dec) using
    ///      each token's decimals. Returns 0 on insufficient history.
    function _twapQuote18(address twapPool, address baseToken, address quoteToken)
        internal view returns (uint256)
    {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = collateralTwapWindow;
        // secondsAgos[1] = 0 (latest)

        try IUniswapV3Pool(twapPool).observe(secondsAgos)
            returns (int56[] memory tickCumulatives, uint160[] memory)
        {
            int56 delta = tickCumulatives[1] - tickCumulatives[0];
            int56 window = int56(int32(collateralTwapWindow));
            int24 tick = int24(delta / window);
            // Arithmetic-mean tick rounds toward negative infinity (UniV3 convention)
            if (delta < 0 && delta % window != 0) tick--;
            return _quoteAtTick(tick, 1e18, baseToken, quoteToken);
        } catch {
            return 0;
        }
    }

    /// @dev Port of Uniswap OracleLibrary.getQuoteAtTick — returns how much of
    ///      quoteToken one unit-scaled amount of baseToken is worth.
    function _quoteAtTick(int24 tick, uint128 baseAmount, address baseToken, address quoteToken)
        internal pure returns (uint256 quoteAmount)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
                : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
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

    // ========== ON-CHAIN COLLATERAL TWAP (BNB deployment) ==========
    // Appended state — set pre-lock via wsXmrHub.setCollateralTwapConfig.

    /// @notice V3 pool pricing the collateral asset against the intermediate
    ///         quote asset (QQQB/WBNB on BNB). 0 = TWAP refresh disabled.
    address public collateralTwapPool;

    /// @notice V3 pool pricing the intermediate quote asset against a
    ///         USD-pegged token (WBNB/USDT on BNB).
    address public quoteTwapPool;

    /// @notice Token shared by both TWAP pools (WBNB on BNB).
    address public twapIntermediateToken;

    /// @notice USD-pegged quote token of quoteTwapPool (USDT on BNB).
    address public twapUsdToken;

    /// @notice TWAP window applied to both pools, in seconds.
    uint32 public collateralTwapWindow;

    /// @notice Decimals of underlyingToken, captured in setExternalAddresses.
    ///         0 = unset (legacy deployments) → treated as 18.
    uint8 public underlyingDecimals;

    uint256[22] private __gap;
    
    // ========== CONSTRUCTOR ==========
    
    constructor(address _wsxmrToken, address _verifierProxy) {
        wsxmrToken = _wsxmrToken;
        deployer = msg.sender;
        verifierProxy = _verifierProxy;
        globalDebtIndex = 1e18;
        _reentrancyStatus = _NOT_ENTERED;
    }
}
