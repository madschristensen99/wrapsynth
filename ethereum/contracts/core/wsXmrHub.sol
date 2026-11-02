// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {wsXmrStorage} from "./wsXmrStorage.sol";
import {IwsXmrHub} from "../interfaces/core/IwsXmrHub.sol";
import {IwsXMR} from "../interfaces/core/IwsXMR.sol";

/**
 * @title wsXmrHub
 * @notice Central coordinator and state owner for the wsXMR system
 * @dev Holds all state, delegates logic to facets, controls token operations
 *
 * Oracle-free: no price feeds, no TWAP config, no perp index. Collateral is the
 * raw ERC-20 held by the hub, tracked in normalized 18-dec units. Vaults quote
 * their own thresholdSharesPerWsxmr; settlement happens at declared thresholds
 * and market-discovered auction clearing prices — never at oracle prices.
 *
 * Architecture:
 * - Hub owns all state (inherits from wsXmrStorage)
 * - Hub controls wsXMR token mint/burn
 * - Hub holds all collateral assets
 * - Facets contain logic only, access state through Hub
 * - Only registered facets can modify state
 */
contract wsXmrHub is wsXmrStorage, IwsXmrHub {
    using SafeERC20 for IERC20;

    // ========== STORAGE ==========

    /// @notice Diamond selector dispatch table: function selector => facet address
    mapping(bytes4 => address) private _selectorToFacet;

    /// @notice Transient storage slot for delegate context flag (EIP-1153)
    /// @dev WARNING: Per EIP-1153 spec, TSTORE fails in STATICCALL context
    /// @dev This means view functions CANNOT be called through the hub's fallback
    /// @dev Workaround: Expose view functions directly on hub, or use multicall pattern
    /// @dev Slot 0x00 is used for the transient flag
    uint256 private constant _DELEGATE_CONTEXT_SLOT = 0x00;

    // ========== EVENTS ==========

    /// @notice Emitted once when the deployment's collateral asset is wired.
    event ExternalAddressesSet(address collateralToken, uint256 collateralScale);

    // ========== MODIFIERS ==========

    modifier onlyFacet() {
        if (!facets[msg.sender]) revert Unauthorized();
        _;
    }

    modifier onlyDelegateCall() {
        // C1: Origin check defeats reentrancy bypass. Legitimate calls always come from the hub calling itself.
        if (msg.sender != address(this)) revert Unauthorized();
        bool inContext;
        assembly {
            inContext := tload(_DELEGATE_CONTEXT_SLOT)
        }
        if (!inContext) revert Unauthorized();
        _;
    }

    modifier onlyDeployer() {
        if (msg.sender != deployer) revert Unauthorized();
        // One-way kill switch: once the deployer has locked its own powers,
        // no privileged configuration call can ever be made again.
        if (deployerOperationsLocked) revert Unauthorized();
        _;
    }

    // ========== CONSTRUCTOR ==========

    constructor(
        address _wsxmrToken,
        address _verifierProxy,
        uint256 _minThreshold,
        uint256 _kickBondMin
    ) wsXmrStorage(_wsxmrToken, _verifierProxy, _minThreshold, _kickBondMin) {
        // Initialize allowed pool fee tiers
        allowedPoolFeeTiers[500] = true;   // 0.05%
        allowedPoolFeeTiers[3000] = true;  // 0.3%
        allowedPoolFeeTiers[10000] = true; // 1%
    }

    // ========== INITIALIZATION ==========

    /// @notice Permanently disable every `onlyDeployer` action. Irreversible.
    /// @dev Removes the deployer's ability to register/route facets or configure the
    ///      liquidity router. Must be the final step of the deployment script.
    ///      Deliberately does NOT use `onlyDeployer` so it stays callable after locking
    ///      is triggered; it re-checks the deployer address inline.
    function lockDeployer() external {
        if (msg.sender != deployer) revert Unauthorized();
        if (deployerOperationsLocked) revert AlreadyInitialized();
        deployerOperationsLocked = true;
        emit DeployerOperationsLocked(deployer);
    }

    /// @inheritdoc IwsXmrHub
    /// @dev Registers the five core facets and auto-builds the selector table by
    ///      querying each facet's selectors() list. The old Yield/Oracle facet
    ///      slots are gone — LiquidationAuctionFacet replaces LiquidationFacet.
    function registerFacets(
        address _vaultFacet,
        address _mintFacet,
        address _burnFacet,
        address _liquidationAuctionFacet,
        address _coLPFacet
    ) external onlyDeployer {
        if (vaultFacet != address(0)) revert AlreadyInitialized();
        if (_vaultFacet == address(0) || _mintFacet == address(0) ||
            _burnFacet == address(0) || _liquidationAuctionFacet == address(0) ||
            _coLPFacet == address(0)) {
            revert ZeroAddress();
        }

        vaultFacet = _vaultFacet;
        mintFacet = _mintFacet;
        burnFacet = _burnFacet;
        liquidationAuctionFacet = _liquidationAuctionFacet;
        coLPFacet = _coLPFacet;

        facets[_vaultFacet] = true;
        facets[_mintFacet] = true;
        facets[_burnFacet] = true;
        facets[_liquidationAuctionFacet] = true;
        facets[_coLPFacet] = true;

        // Build selector table by querying each facet's selectors()
        _registerFacetSelectors(_vaultFacet);
        _registerFacetSelectors(_mintFacet);
        _registerFacetSelectors(_burnFacet);
        _registerFacetSelectors(_liquidationAuctionFacet);
        _registerFacetSelectors(_coLPFacet);

        emit FacetsRegistered(
            _vaultFacet,
            _mintFacet,
            _burnFacet,
            _liquidationAuctionFacet,
            _coLPFacet
        );
    }

    /// @notice Register all selectors from a facet into the routing table
    /// @dev Calls facet.selectors() and maps each selector to the facet address
    /// @dev Reverts if any selector is already registered to prevent silent overwrites
    function _registerFacetSelectors(address facet) private {
        (bool success, bytes memory data) = facet.staticcall(
            abi.encodeWithSignature("selectors()")
        );
        require(success, "Failed to get selectors");

        bytes4[] memory sels = abi.decode(data, (bytes4[]));
        for (uint256 i = 0; i < sels.length; i++) {
            if (_selectorToFacet[sels[i]] != address(0)) {
                revert("Selector collision");
            }
            _selectorToFacet[sels[i]] = facet;
        }
    }

    /// @inheritdoc IwsXmrHub
    /// @dev Used for facets beyond the five core slots. The deployer can only
    ///      add facets before lockDeployer() is called.
    function addFacet(address facet) external onlyDeployer {
        if (facet == address(0)) revert ZeroAddress();
        if (facets[facet]) revert AlreadyInitialized();
        facets[facet] = true;
        _registerFacetSelectors(facet);
        emit FacetAdded(facet);
    }

    /// @notice Add new selectors to the routing table
    /// @dev Only deployer can modify selector table
    function addSelectors(address facet, bytes4[] calldata selectors) external onlyDeployer {
        if (!facets[facet]) revert Unauthorized();

        for (uint256 i = 0; i < selectors.length; i++) {
            if (_selectorToFacet[selectors[i]] != address(0)) revert("Selector collision");
            _selectorToFacet[selectors[i]] = facet;
        }
    }

    /// @notice Remove selectors from the routing table
    /// @dev Only deployer can modify selector table
    function removeSelectors(bytes4[] calldata selectors) external onlyDeployer {
        for (uint256 i = 0; i < selectors.length; i++) {
            delete _selectorToFacet[selectors[i]];
        }
    }

    /// @inheritdoc IwsXmrHub
    function setLiquidityRouter(address router) external onlyDeployer {
        if (liquidityRouter != address(0)) revert AlreadyInitialized();
        if (router == address(0)) revert ZeroAddress();

        liquidityRouter = router;
        emit LiquidityRouterSet(router);
    }

    /// @notice Replace the liquidity router address (allows upgrades)
    /// @dev Only callable by deployer; emits same event as setLiquidityRouter
    function replaceLiquidityRouter(address router) external onlyDeployer {
        if (router == address(0)) revert ZeroAddress();
        liquidityRouter = router;
        emit LiquidityRouterSet(router);
    }

    /// @notice Configure the vault collateral asset. Callable once per
    ///         deployment phase by the deployer before lockDeployer().
    /// @dev    The collateral ERC-20 itself is the vault asset — no share
    ///         adapter, no underlying indirection. `collateralScale` =
    ///         10^(18 - token decimals) converts raw units to the normalized
    ///         18-dec internal denomination used by every threshold, lock,
    ///         bond, and auction quantity.
    /// @param _collateralToken The collateral ERC-20 (cbBTC, QQQB, SPY, ...)
    function setExternalAddresses(address _collateralToken) external onlyDeployer {
        if (_collateralToken == address(0)) revert ZeroAddress();
        if (collateralToken != address(0)) revert AlreadyInitialized();
        collateralToken = _collateralToken;
        uint8 decs = _tryDecimals(_collateralToken);
        collateralScale = decs >= 18 ? 1 : 10 ** uint256(18 - decs);
        emit ExternalAddressesSet(_collateralToken, collateralScale);
    }

    /// @dev Best-effort ERC-20 decimals() probe; defaults to 18 on failure.
    function _tryDecimals(address token) private view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || data.length < 32) return 18;
        return abi.decode(data, (uint8));
    }

    // ========== FACET OPERATIONS ==========

    /// @inheritdoc IwsXmrHub
    function mintTokens(address to, uint256 amount) external onlyDelegateCall {
        IwsXMR(wsxmrToken).mint(to, amount);
    }

    /// @inheritdoc IwsXmrHub
    function burnTokens(address from, uint256 amount) external onlyDelegateCall {
        IwsXMR(wsxmrToken).burn(from, amount);
    }

    /// @inheritdoc IwsXmrHub
    function transferAsset(address token, address to, uint256 amount) external onlyDelegateCall {
        IERC20(token).safeTransfer(to, amount);
    }

    /// @inheritdoc IwsXmrHub
    function approveAsset(address token, address spender, uint256 amount) external onlyDelegateCall {
        IERC20(token).forceApprove(spender, amount);
    }

    // ========== REENTRANCY GUARDS ==========

    /// @inheritdoc IwsXmrHub
    function enterNonReentrant() external onlyDelegateCall {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
    }

    function exitNonReentrant() external onlyDelegateCall {
        _reentrancyStatus = _NOT_ENTERED;
    }

    // ========== VIEW FUNCTIONS ==========

    /// @notice Get total number of active vaults
    function getVaultCount() external view returns (uint256) {
        return activeVaultCount;
    }

    /// @notice Get actual debt from normalized debt
    function getActualDebt(uint256 normalizedDebt) external view returns (uint256) {
        return (normalizedDebt * globalDebtIndex) / 1e18;
    }

    /// @notice Get the facet address for a given function selector
    /// @dev Allows external callers to bypass hub and call view functions directly on facets
    /// @param selector The function selector to look up
    /// @return The facet address that implements this function
    function getFacetAddress(bytes4 selector) external view returns (address) {
        return _selectorToFacet[selector];
    }

    /// @notice Get vault health ratio for a given LP
    /// @dev Direct implementation to avoid TSTORE in staticcall issue.
    ///      INFORMATIONAL ONLY — self-declared coverage:
    ///      freeCollateral / (debt × threshold) × RATIO_PRECISION.
    ///      This is not a solvency oracle — the LP sets the threshold.
    /// @param lpAddress The LP address to check
    /// @return ratio Coverage ratio (100 = vault covers debt at its own threshold)
    function getVaultHealth(address lpAddress) external view returns (uint256 ratio) {
        Vault memory vault = _vaults[lpAddress];
        uint256 actualDebt = (vault.normalizedDebt * globalDebtIndex) / 1e18;
        uint256 freeCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        if (actualDebt == 0) return type(uint256).max;
        uint256 required = (actualDebt * vault.thresholdSharesPerWsxmr) / WSXMR_DECIMALS;
        if (required == 0) return type(uint256).max;
        return (freeCollateral * RATIO_PRECISION) / required;
    }

    /// @notice Get vault debt for a given LP
    /// @dev Direct implementation to avoid TSTORE in staticcall issue
    /// @param lpAddress The LP address to check
    /// @return The denormalized debt amount
    function getVaultDebt(address lpAddress) external view returns (uint256) {
        return (_vaults[lpAddress].normalizedDebt * globalDebtIndex) / 1e18;
    }

    /// @notice Get max wsXMR amount a vault can mint in a single transaction
    /// @dev Direct implementation to avoid TSTORE in staticcall issue.
    ///      Mirrors the bond-reserved coverage check in MintFacet so the
    ///      reported capacity is actually mintable:
    ///        free·1e8 >= T·(D0 + x) + 1.1·x·T
    ///        x <= (free·1e8 − T·D0) / (T·(1 + MINT_LOCK_RATIO/RATIO_PRECISION))
    ///      Then capped by the vault's LP-quoted maxMintWsxmr.
    /// @param lpVault LP vault address
    /// @return maxWsxmrAmount Maximum wsXMR (8 decimals) that can be minted
    function getMintCapacity(address lpVault) external view returns (uint256 maxWsxmrAmount) {
        Vault memory vault = _vaults[lpVault];
        if (!vault.active) return 0;
        uint256 threshold = vault.thresholdSharesPerWsxmr;
        if (threshold < minThreshold) return 0;

        uint256 freeCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        if (freeCollateral == 0) return 0;

        uint256 actualDebt = (vault.normalizedDebt * globalDebtIndex) / 1e18;
        uint256 headroom = freeCollateral * WSXMR_DECIMALS;
        uint256 committed = threshold * (actualDebt + vault.pendingDebt);
        if (headroom <= committed) return 0;
        maxWsxmrAmount = ((headroom - committed) * RATIO_PRECISION)
            / (threshold * (RATIO_PRECISION + MINT_LOCK_RATIO));

        if (vault.maxMintWsxmr > 0 && maxWsxmrAmount > vault.maxMintWsxmr) {
            maxWsxmrAmount = vault.maxMintWsxmr;
        }
    }

    // ========== FALLBACK ==========

    /// @notice Receive ETH for griefing deposits and refunds
    receive() external payable {}

    /// @notice Route function calls to appropriate facets via delegatecall
    /// @dev Uses selector table for O(1) routing
    /// @dev Uses EIP-1153 transient storage (TSTORE/TLOAD) for reentrancy protection
    /// @dev LIMITATION: Per EIP-1153, TSTORE fails in STATICCALL, so view functions revert
    /// @dev Solution: Important view functions are duplicated directly on this contract
    fallback() external payable {
        address facet = _selectorToFacet[msg.sig];
        if (facet == address(0)) revert("Function does not exist");

        assembly ("memory-safe") {
            // C1: Save previous transient flag and restore after delegatecall.
            // This prevents the flag from persisting across the entire transaction.
            let prev := tload(_DELEGATE_CONTEXT_SLOT)
            tstore(_DELEGATE_CONTEXT_SLOT, 1)

            let ptr := mload(0x40)
            calldatacopy(ptr, 0, calldatasize())
            let result := delegatecall(gas(), facet, ptr, calldatasize(), 0, 0)
            returndatacopy(ptr, 0, returndatasize())

            tstore(_DELEGATE_CONTEXT_SLOT, prev)

            switch result
            case 0 { revert(ptr, returndatasize()) }
            default { return(ptr, returndatasize()) }
        }
    }
}
