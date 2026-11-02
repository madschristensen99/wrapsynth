// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title wsXmrStorage
 * @notice Shared storage layout for the wsXMR facet-based system
 * @dev All facets access state through this storage contract
 *
 * ORACLE-FREE MODEL (per docs/ORACLE_FREE_MIGRATION_SPEC.md):
 * - No external price dependency anywhere in consensus. Prices survive only as
 *   (a) negotiated terms on each mint/burn request, (b) LP self-declared
 *   collateralization quotes (Vault.thresholdSharesPerWsxmr), and (c)
 *   market-discovered settlement inside bonded-kick Dutch haircut auctions.
 * - Collateral is stored as raw underlying units NORMALIZED to 18 decimals at
 *   the boundary (collateralScale = 10^(18 - collateralDecimals)). Every
 *   threshold, lock, bond, and auction quantity is denominated in the same
 *   normalized unit — no share/asset conversion layer.
 * - pendingReturns is denominated in RAW token units (what withdrawReturns
 *   actually transfers out).
 *
 * CRITICAL: Storage layout must NEVER be modified after deployment.
 * Only append new variables at the end to maintain upgrade compatibility.
 * (This deployment is a fresh redeploy — the layout was rebuilt for v2.)
 */
contract wsXmrStorage {
    // ========== CONSTANTS ==========

    uint256 public constant RATIO_PRECISION = 100;

    // Block-based constants target ~1s blocks; deploy configs rescale per
    // chain block time (existing convention — same mechanism as timeouts).
    uint256 public constant MIN_MINT_TIMEOUT_BLOCKS = 1800; // ~30 min at 1s/block
    uint256 public constant MAX_MINT_TIMEOUT_BLOCKS = 86400; // ~24 hours at 1s/block
    uint256 public constant DEFAULT_MINT_TIMEOUT_BLOCKS = 3600; // ~1 hour
    uint256 public constant MINT_READY_EXTENSION_BLOCKS = 7200; // ~2 hours at 1s/block
    // LP liveness assumption: after a mint times out, the LP has this window to
    // reveal lpSecret (abandonKeyProvidedMint / claimGriefingDeposit) before the
    // key bond is slashed to the user. The protocol already assumes LP liveness —
    // only the LP can attest deposits (setMintReady) and un-stick XMR at the shared
    // address — so the window just defines how quickly a "live" LP must respond.
    // 3600 ≈ 1 hour at 1s/block: tolerant of brief outages/restarts,
    // short enough that a permanently dead LP's bonds still resolve.
    uint256 public constant LP_CLAIM_WINDOW_BLOCKS = 3600; // ~1 hour for LP to claim after mint expiry

    uint256 public constant MIN_BURN_TIMEOUT_BLOCKS = 1800; // ~30 min at 1s/block
    uint256 public constant MAX_BURN_TIMEOUT_BLOCKS = 86400; // ~24 hours at 1s/block
    uint256 public constant DEFAULT_BURN_TIMEOUT_BLOCKS = 3600; // ~1 hour
    uint256 public constant BURN_COMMIT_TIMEOUT_BLOCKS = 7200; // ~2 hours at 1s/block
    uint256 public constant BURN_FINALIZE_GRACE_BLOCKS = 600; // ~10 min grace for LP finalization

    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_MARGIN_BPS = 1000;

    uint256 public constant MAX_BURN_REQUESTS_PER_VAULT = 50;
    uint256 public constant MAX_VAULT_COUNT = 10000;
    uint256 public constant MIN_VAULT_COLLATERAL_BPS = 100; // 1% of max vault collateral — below this, dormant vaults are evictable
    uint256 public constant MIN_BURN_AMOUNT = 1e4; // 0.0001 wsXMR
    uint256 public constant MINT_LOCK_RATIO = 110; // key bond / par lock = 110% of par collateral

    uint256 public constant XMR_TO_WSXMR_DIVISOR = 1e4;
    uint256 public constant WSXMR_DECIMALS = 1e8;

    uint256 public constant MIN_COLP_RANGE_BPS = 1000;
    uint256 public constant MAX_COLP_RANGE_BPS = 10000;
    uint256 public constant DEFAULT_COLP_RANGE_BPS = 2500;
    uint256 public constant DEFAULT_COLP_SLIPPAGE_BPS = 50; // 0.5%
    uint256 public constant COLP_REBALANCE_FEE_BPS = 10;
    uint16 public constant UNISWAP_V3_FEE_TIER = 3000;

    // ========== KICK / AUCTION CONSTANTS ==========

    uint256 public constant KICK_BOND_BPS = 200;             // 2% of vault collateral
    uint256 public constant KICK_GRACE_BLOCKS = 3600;        // ~1h at 1s/block — LP respond window
    uint256 public constant KICK_COOLDOWN_BLOCKS = 21600;    // ~6h at 1s/block — per-vault re-kick rate limit
    uint256 public constant AUCTION_DURATION_BLOCKS = 86400; // ~24h at 1s/block — Dutch window
    uint256 public constant AUCTION_OPEN_DELAY_BLOCKS = 1800;// ~30min — bid-locked LP rescue window at auction start
    uint256 public constant HAIRCUT_START_BPS = 10000;       // offer opens at 100% of collateral
    uint256 public constant HAIRCUT_FLOOR_BPS = 500;         // 5% — curve end; below → inconclusive
    uint256 public constant CHIP_BPS = 50;                   // kicker's cut of liquidation surplus
    uint256 public constant KICK_SANE_BPS = 8000;            // wrongful-kick threshold: clearing X* ≤ 80%
                                                           // → vault was ≥125% collateralized → bond → LP
    uint256 public constant BURN_LOCK_MULTIPLIER_BPS = 13000;// 1.3× proportional burn lock

    // ========== EVENTS ==========

    event ReturnQueued(address indexed user, address indexed token, uint256 amount);

    /// @notice Emitted exactly once when the deployer permanently gives up its
    ///         facet-registration / selector-table / router-configuration powers.
    event DeployerOperationsLocked(address indexed deployer);

    /// @notice Emitted when an active kick is cancelled (LP rescue during grace,
    ///         or repayDebt-in-full during the auction). bondToLP = true.
    event KickCancelled(address indexed vault, address indexed kicker, uint256 bond, bool bondToLP);

    // ========== ERRORS ==========

    error PendingMintLock(); // Vault has active READY mints — state-changing ops blocked
    error NoEvictableVaultFound(); // Cap reached and no dormant vaults available for eviction
    error KickActive(); // Vault has an active kick/auction — state-changing ops blocked
    error NoActiveKick(); // No kick exists on the vault
    error KickOnCooldown(); // Per-vault re-kick cooldown has not elapsed
    error BidNotOpen(); // Bid outside the active auction window (grace, open delay, or ended)
    error AuctionNotEnded(); // Auction has not reached its end block
    error VaultIsFrozen(); // Vault froze after an inconclusive auction — only rescue paths work
    error BelowMinThreshold(); // Threshold quote below the deployment's MIN_THRESHOLD floor
    error NoReauctionAvailable(); // Vault has already consumed its one reauction

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

    /// @notice Lifecycle phase of an active kick, derived from kickBlock.
    enum KickPhase {
        GRACE,      // LP may cancel by acting (depositCollateral / repayDebt)
        OPEN_DELAY, // bid-locked rescue window — bids revert, LP may repayDebt in full
        ACTIVE,     // Dutch descending-haircut — first bid wins
        ENDED       // auctionEnd reached with no bid — awaiting resolveKick → FROZEN
    }

    // ========== STRUCTS ==========

    struct Vault {
        address lpAddress;
        uint256 collateralShares;        // collateral in NORMALIZED 18-dec units
        uint256 lockedCollateral;        // normalized — key bonds + burn locks (never counts as free)
        uint256 normalizedDebt;
        uint256 pendingDebt;
        uint256 thresholdSharesPerWsxmr; // LP-declared: normalized collateral units required
                                         // per 1e8 wsXMR of debt. Mint bound + self-declared
                                         // solvency line + par-settlement rate. ≥ minThreshold.
        uint256 maxMintWsxmr;            // LP-quoted absolute mint cap in wsXMR (0 = uncapped)
        uint256 mintGriefingDeposit;
        uint16 mintFeeBps;
        uint16 burnRewardBps;
        uint256 liquidationNonce;
        uint256 mintNonce;
        uint256 minBurnAmount;
        bool active;
        uint256 deployedCollateral;      // normalized collateral leg deployed in co-LP positions
        uint256 deployedWsxmr;           // wsXMR leg deployed in co-LP positions (netted against debt)
        uint16 maxCoLPRangeBps;
        uint256 mintTimeoutBlocks;
        uint256 burnTimeoutBlocks;
        uint256 pendingMintCount;        // Number of active READY mints — blocks withdrawals
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
        uint256 lockedCollateral;    // par-value key bond (normalized) locked at provideLPKey, repriced at setMintReady
        uint256 thresholdAtReady;    // vault threshold snapshotted at setMintReady — par-settlement rate
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
        uint256 thresholdAtRequest;     // vault threshold locked at requestBurn — par-settlement rate
        bytes32 revealedSecret;         // LP's revealed Ed25519 secret (set by revealBurnSecret/finalizeBurn); 0 = not revealed
    }

    struct PositionMetadata {
        address vaultOwner;
        address user;
        uint256 collateralOriginal;     // normalized collateral leg contributed at open
        uint256 wsxmrOriginal;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 createdAt;
    }

    /// @notice A bonded kick on a vault. Lifecycle: GRACE → OPEN_DELAY → ACTIVE → ENDED.
    ///         Phase is derived from kickBlock — see _kickPhase().
    struct Kick {
        address kicker;
        uint256 bond;               // normalized collateral escrowed by the hub
        uint256 kickBlock;          // grace window start
        uint256 auctionEnd;         // kickBlock + GRACE + OPEN_DELAY + DURATION
        uint256 offeredCollateral;  // free collateral snapshotted at auction open (post in-flight settlement)
        bool    auctionOpened;      // grace→auction transition ran (in-flight settled, nonces bumped)
        bool    active;
    }

    // ========== IMMUTABLES ==========

    address public immutable wsxmrToken;
    address public immutable deployer;
    address public immutable verifierProxy;

    /// @notice Deployment floor under Vault.thresholdSharesPerWsxmr — prevents
    ///         degenerate near-zero quotes enabling unbacked issuance. Per-chain
    ///         constant: it IS the protocol's price opinion (cbBTC ≠ QQQB ≠ SPY).
    ///         Set at construction; no on-chain update path. If it goes stale
    ///         (collateral crashes vs XMR), new mints pause until redeploy — the
    ///         auction still catches true insolvency regardless of its value.
    uint256 public immutable minThreshold;

    /// @notice Absolute minimum kick bond (normalized collateral) — spam floor.
    uint256 public immutable kickBondMin;

    // ========== STATE VARIABLES ==========

    // Facet addresses
    address public vaultFacet;
    address public mintFacet;
    address public burnFacet;
    address public liquidationAuctionFacet;
    address public coLPFacet;

    // Facet registry
    mapping(address => bool) public facets;

    // Router
    address public liquidityRouter;

    // Global state
    uint256 public globalTotalDebt;
    uint256 public globalDebtIndex;
    uint256 public globalBadDebt;
    uint256 public globalPendingBurnDebt;
    uint256 public totalPendingMints;    // Mints in READY/SECRET_REVEALED — block withdrawals while counted
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

    // Pending returns (RAW token units)
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

    // ========== COLLATERAL ASSET ==========
    // Set once pre-lock via wsXmrHub.setExternalAddresses (same lifecycle as
    // liquidityRouter). Storage — not constants — so the same bytecode deploys
    // to mainnet, testnet, and local forks with different external addresses.

    /// @notice The vault collateral ERC-20 itself (QQQB on BNB, cbBTC on Base,
    ///         SPY on Robinhood). Held naked by the hub — no share adapter.
    address public collateralToken;

    /// @notice 10^(18 - collateralDecimals) — converts raw token units to the
    ///         normalized 18-dec internal denomination. Captured in
    ///         setExternalAddresses. 0 = unset (treated as 1e18-scale).
    uint256 public collateralScale;

    // ========== KICK / AUCTION STATE ==========

    /// @notice Active kick per vault (one at a time).
    mapping(address => Kick) public vaultKicks;

    /// @notice Block at which the vault's last kick resolved — anchors
    ///         KICK_COOLDOWN_BLOCKS for the next kick/reauction.
    mapping(address => uint256) public vaultLastKickResolved;

    /// @notice Vault froze after an inconclusive (no-bid) auction. Mints,
    ///         burns, withdrawals and co-LP ops revert; only repayDebt,
    ///         depositCollateral, reauction and backstopVault are allowed.
    mapping(address => bool) public vaultFrozen;

    /// @notice Each vault gets exactly one reauction after a freeze.
    mapping(address => bool) public vaultReauctionUsed;

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

    uint256[33] private __gap;

    // ========== CONSTRUCTOR ==========

    constructor(
        address _wsxmrToken,
        address _verifierProxy,
        uint256 _minThreshold,
        uint256 _kickBondMin
    ) {
        wsxmrToken = _wsxmrToken;
        deployer = msg.sender;
        verifierProxy = _verifierProxy;
        minThreshold = _minThreshold;
        kickBondMin = _kickBondMin;
        globalDebtIndex = 1e18;
        _reentrancyStatus = _NOT_ENTERED;
    }

    // ========== INTERNAL HELPERS ==========

    /// @dev Internal helper to denormalize debt using the hub's live globalDebtIndex
    /// @notice H2: Must be internal so it reads from delegated (hub) storage, not an external facet's frozen storage
    function _denormalizeDebt(uint256 normalizedDebt) internal view returns (uint256) {
        return (normalizedDebt * globalDebtIndex) / 1e18;
    }

    /// @dev Normalization scale for the collateral token (10^(18 - decimals)).
    function _collateralScale() internal view returns (uint256) {
        return collateralScale == 0 ? 1 : collateralScale;
    }

    /// @dev Raw collateral token units → normalized 18-dec units.
    function _normFromRaw(uint256 raw) internal view returns (uint256) {
        return raw * _collateralScale();
    }

    /// @dev Normalized 18-dec units → raw collateral token units (floored).
    function _rawFromNorm(uint256 norm) internal view returns (uint256) {
        return norm / _collateralScale();
    }

    /// @dev Free (seizable / mint-eligible) collateral: total minus locked.
    ///      Key bonds and burn locks never count as free.
    function _freeCollateral(Vault memory v) internal pure returns (uint256) {
        return v.collateralShares > v.lockedCollateral
            ? v.collateralShares - v.lockedCollateral
            : 0;
    }

    /// @dev Par settlement amount: normalized collateral owed per wsXMR at the
    ///      given declared threshold (collateral-per-1e8-wsXMR).
    function _parCollateral(uint256 wsxmrAmount, uint256 threshold) internal pure returns (uint256) {
        return (wsxmrAmount * threshold) / WSXMR_DECIMALS;
    }

    /// @dev Normalized collateral the vault must hold against wsXMR debt at its
    ///      own declared threshold.
    function _requiredCollateral(uint256 wsxmrDebt, uint256 threshold) internal pure returns (uint256) {
        return (wsxmrDebt * threshold) / WSXMR_DECIMALS;
    }

    /// @dev Par-value lock for mint key bonds and the setMintReady par lock:
    ///      par collateral at the declared threshold × MINT_LOCK_RATIO (110%).
    function _parLockFor(uint256 wsxmrAmount, uint256 threshold) internal pure returns (uint256) {
        return (_parCollateral(wsxmrAmount, threshold) * MINT_LOCK_RATIO) / RATIO_PRECISION;
    }

    /// @dev Current kick phase for a vault (only meaningful while kick.active).
    function _kickPhase(Kick memory k) internal view returns (KickPhase) {
        uint256 b = block.number;
        if (b < k.kickBlock + KICK_GRACE_BLOCKS) return KickPhase.GRACE;
        if (b < k.kickBlock + KICK_GRACE_BLOCKS + AUCTION_OPEN_DELAY_BLOCKS) return KickPhase.OPEN_DELAY;
        if (b < k.auctionEnd) return KickPhase.ACTIVE;
        return KickPhase.ENDED;
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
}
