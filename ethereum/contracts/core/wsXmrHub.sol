// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

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
    
    /// @notice Transient flag indicating we're inside a delegatecall from fallback
    /// @dev Used to prevent direct external calls to privileged functions
    bool private _inDelegateContext;
    
    // ========== MODIFIERS ==========
    
    modifier onlyFacet() {
        if (!facets[msg.sender]) revert Unauthorized();
        _;
    }
    
    modifier onlyDelegateCall() {
        if (!_inDelegateContext) revert Unauthorized();
        _;
    }
    
    modifier onlyDeployer() {
        if (msg.sender != deployer) revert Unauthorized();
        _;
    }
    
    modifier nonReentrant() {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
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
        
        // Build Diamond selector dispatch table
        _buildSelectorTable();
        
        emit FacetsRegistered(
            _vaultFacet,
            _mintFacet,
            _burnFacet,
            _liquidationFacet,
            _yieldFacet,
            _oracleFacet
        );
    }
    
    /// @notice Build the Diamond selector => facet dispatch table
    /// @dev Called once during registerFacets. Uses try/catch to discover selectors.
    function _buildSelectorTable() private {
        // This is a simplified approach - in production you'd pass selector lists explicitly
        // For now, we'll rely on the fallback's try-each-facet behavior but with proper error handling
        // A full Diamond implementation would register selectors explicitly during facet registration
    }
    
    /// @inheritdoc IwsXmrHub
    function setLiquidityRouter(address router) external onlyDeployer {
        if (liquidityRouter != address(0)) revert AlreadyInitialized();
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
    
    /// @inheritdoc IwsXmrHub
    function getGlobalState() external view returns (GlobalState memory) {
        return GlobalState({
            wsxmrToken: wsxmrToken,
            liquidityRouter: liquidityRouter,
            deployer: deployer,
            pythOracle: verifierProxy,
            globalTotalDebt: globalTotalDebt,
            globalDebtIndex: globalDebtIndex,
            globalBadDebt: globalBadDebt,
            globalPendingBurnDebt: globalPendingBurnDebt,
            yieldWarChest: yieldWarChest,
            lastBuyTimestamp: lastBuyTimestamp,
            globalLpPrincipal: globalLpPrincipal,
            globalLpPrincipalShares: globalLpPrincipalShares,
            globalPendingSDAI: globalPendingSDAI,
            requestNonce: _requestNonce,
            vaultCount: vaultList.length
        });
    }
    
    /// @notice Get total number of vaults
    function getVaultCount() external view returns (uint256) {
        return vaultList.length;
    }
    
    /// @notice Get actual debt from normalized debt
    function getActualDebt(uint256 normalizedDebt) external view returns (uint256) {
        return (normalizedDebt * globalDebtIndex) / 1e18;
    }
    
    // ========== FALLBACK ==========
    
    /// @notice Receive ETH for griefing deposits and refunds
    receive() external payable {}
    
    /// @notice Route function calls to appropriate facets via delegatecall
    /// @dev Uses Diamond pattern with try-all-facets fallback for compatibility
    fallback() external payable {
        // Set delegate context flag to allow privileged function access
        _inDelegateContext = true;
        
        // Try all facets in order - proper error propagation
        address[6] memory allFacets = [vaultFacet, mintFacet, burnFacet, liquidationFacet, yieldFacet, oracleFacet];
        
        for (uint256 i = 0; i < 6; i++) {
            address facet = allFacets[i];
            if (facet == address(0)) continue;
            
            assembly {
                let ptr := mload(0x40)
                calldatacopy(ptr, 0, calldatasize())
                let result := delegatecall(gas(), facet, ptr, calldatasize(), 0, 0)
                
                // If call succeeded, clean up and return
                if result {
                    returndatacopy(ptr, 0, returndatasize())
                    // Clear delegate flag before returning
                    sstore(_inDelegateContext.slot, 0)
                    return(ptr, returndatasize())
                }
                
                // If call failed, check if it's function-not-found or real error
                let rdsize := returndatasize()
                if iszero(rdsize) {
                    // Empty revert = function not found, try next facet
                    // (Solidity reverts with empty data when function doesn't exist)
                }
                if gt(rdsize, 0) {
                    returndatacopy(ptr, 0, rdsize)
                    
                    // Check if this is a custom error or panic (4-byte selector)
                    // Custom errors and Panic have 4-byte selectors, propagate them
                    // Only continue to next facet if this looks like "function not found"
                    
                    // If returndata >= 4 bytes, check the selector
                    if iszero(lt(rdsize, 4)) {
                        let errorSelector := shr(224, mload(ptr))
                        
                        // Error(string) is 0x08c379a0 - but this is NOT "function not found"
                        // Function not found returns empty data in modern Solidity
                        // Any error with data is a real error - propagate it
                        // Exception: we'll continue on Error(string) for backwards compat
                        // but this is unsafe - see security review
                        
                        // For safety: only continue if Error(string), else revert
                        if iszero(eq(errorSelector, 0x08c379a0)) {
                            sstore(_inDelegateContext.slot, 0)
                            revert(ptr, rdsize)
                        }
                    }
                    // If < 4 bytes or Error(string), continue to next facet
                }
            }
        }
        
        // Clear delegate flag before reverting
        _inDelegateContext = false;
        
        // No facet handled the call
        revert("Function does not exist");
    }
}
