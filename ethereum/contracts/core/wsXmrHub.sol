// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {wsXmrStorage} from "./wsXmrStorage.sol";
import {IwsXmrHub} from "../interfaces/core/IwsXmrHub.sol";
import {IwsXMR} from "../interfaces/core/IwsXMR.sol";
import {IwsXmrLiquidityRouter} from "../interfaces/router/IwsXmrLiquidityRouter.sol";
import {VaultFacet} from "../facets/VaultFacet.sol";
import {GnosisAddresses} from "../GnosisAddresses.sol";

/**
 * @title wsXmrHub
 * @notice Central coordinator and state owner for the wsXMR system
 * @dev Holds all state, delegates logic to facets, controls token operations
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
        _;
    }
    
    // ========== CONSTRUCTOR ==========
    
    constructor(
        address _wsxmrToken,
        address _verifierProxy
    ) wsXmrStorage(_wsxmrToken, _verifierProxy) {
        // Initialize allowed pool fee tiers
        allowedPoolFeeTiers[500] = true;   // 0.05%
        allowedPoolFeeTiers[3000] = true;  // 0.3%
        allowedPoolFeeTiers[10000] = true; // 1%
    }
    
    // ========== INITIALIZATION ==========
    
    /// @inheritdoc IwsXmrHub
    function registerFacets(
        address _vaultFacet,
        address _mintFacet,
        address _burnFacet,
        address _liquidationFacet,
        address _yieldFacet,
        address _oracleFacet
    ) external onlyDeployer {
        if (vaultFacet != address(0)) revert AlreadyInitialized();
        if (_vaultFacet == address(0) || _mintFacet == address(0) || 
            _burnFacet == address(0) || _liquidationFacet == address(0) ||
            _yieldFacet == address(0) || _oracleFacet == address(0)) {
            revert ZeroAddress();
        }
        
        vaultFacet = _vaultFacet;
        mintFacet = _mintFacet;
        burnFacet = _burnFacet;
        liquidationFacet = _liquidationFacet;
        yieldFacet = _yieldFacet;
        oracleFacet = _oracleFacet;
        
        facets[_vaultFacet] = true;
        facets[_mintFacet] = true;
        facets[_burnFacet] = true;
        facets[_liquidationFacet] = true;
        facets[_yieldFacet] = true;
        facets[_oracleFacet] = true;
        
        // Build selector table by querying each facet's selectors()
        _registerFacetSelectors(_vaultFacet);
        _registerFacetSelectors(_mintFacet);
        _registerFacetSelectors(_burnFacet);
        _registerFacetSelectors(_liquidationFacet);
        _registerFacetSelectors(_yieldFacet);
        _registerFacetSelectors(_oracleFacet);
        
        emit FacetsRegistered(
            _vaultFacet,
            _mintFacet,
            _burnFacet,
            _liquidationFacet,
            _yieldFacet,
            _oracleFacet
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
    
    /// @notice Get total number of vaults
    function getVaultCount() external view returns (uint256) {
        return vaultList.length;
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
    ///      Includes co-LP positions so it matches LiquidationFacet CR logic.
    /// @param lpAddress The LP address to check
    /// @return ratio The collateralization ratio (e.g., 150 = 150%)
    function getVaultHealth(address lpAddress) external view returns (uint256 ratio) {
        Vault memory vault = _vaults[lpAddress];
        uint256 actualDebt = (vault.normalizedDebt * globalDebtIndex) / 1e18;
        
        if (actualDebt == 0) return type(uint256).max;
        
        // Get prices from storage (set by oracle facet)
        uint256 xmrPrice = _getXmrPriceFromStorage();  // 18 decimals (normalized)
        uint256 daiPrice = _getCollateralPriceFromStorage();  // 18 decimals (normalized)
        
        // Only count unlocked collateral toward health ratio
        uint256 availableShares = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;

        // Convert unlocked sDAI shares to DAI
        (bool success, bytes memory data) = GnosisAddresses.SDAI.staticcall(
            abi.encodeWithSignature("convertToAssets(uint256)", availableShares)
        );
        require(success && data.length >= 32, "convertToAssets failed");
        uint256 idleDai = abi.decode(data, (uint256));
        
        uint256 totalDai = idleDai;
        
        // Add co-LP position DAI values (ignore wsXMR — belongs to user)
        uint256[] storage positions = _vaultPositions[lpAddress];
        if (positions.length > 0 && liquidityRouter != address(0)) {
            for (uint256 i = 0; i < positions.length; i++) {
                (uint256 posDai, ) = IwsXmrLiquidityRouter(liquidityRouter)
                    .getPositionAmountsAtPrice(positions[i], xmrPrice);
                totalDai += posDai;
            }
        }
        
        // Calculate USD values (prices are 18 decimals, totalDai is 18 decimals)
        uint256 collateralValueUsd = (totalDai * daiPrice) / 1e18; // 18 decimals
        uint256 debtValueUsd = (actualDebt * xmrPrice) / 1e8; // wsXMR has 8 decimals, result 18 decimals
        
        // Calculate ratio: (collateral / debt) * 100
        return (collateralValueUsd * 100) / debtValueUsd;
    }
    
    /// @notice Get vault debt for a given LP
    /// @dev Direct implementation to avoid TSTORE in staticcall issue
    /// @param lpAddress The LP address to check
    /// @return The denormalized debt amount
    function getVaultDebt(address lpAddress) external view returns (uint256) {
        return (_vaults[lpAddress].normalizedDebt * globalDebtIndex) / 1e18;
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
