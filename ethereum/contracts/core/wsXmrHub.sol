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
    
    // ========== MODIFIERS ==========
    
    modifier onlyFacet() {
        if (!facets[msg.sender]) revert Unauthorized();
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
        
        emit FacetsRegistered(
            _vaultFacet,
            _mintFacet,
            _burnFacet,
            _liquidationFacet,
            _yieldFacet,
            _oracleFacet
        );
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
    function mintTokens(address to, uint256 amount) external onlyFacet {
        IwsXMR(wsxmrToken).mint(to, amount);
    }
    
    /// @inheritdoc IwsXmrHub
    function burnTokens(address from, uint256 amount) external onlyFacet {
        IwsXMR(wsxmrToken).burn(from, amount);
    }
    
    /// @inheritdoc IwsXmrHub
    function transferAsset(address token, address to, uint256 amount) external onlyFacet {
        IERC20(token).safeTransfer(to, amount);
    }
    
    /// @inheritdoc IwsXmrHub
    function approveAsset(address token, address spender, uint256 amount) external onlyFacet {
        IERC20(token).forceApprove(spender, amount);
    }
    
    // ========== REENTRANCY GUARDS ==========
    
    /// @inheritdoc IwsXmrHub
    function enterNonReentrant() external onlyFacet {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
    }
    
    function exitNonReentrant() external onlyFacet {
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
    /// @dev Try all facets in order until one succeeds
    fallback() external payable {
        // Try all facets in order
        address[6] memory allFacets = [vaultFacet, mintFacet, burnFacet, liquidationFacet, yieldFacet, oracleFacet];
        
        for (uint256 i = 0; i < 6; i++) {
            address facet = allFacets[i];
            if (facet == address(0)) continue;
            
            assembly {
                // Use free memory pointer for safety
                let ptr := mload(0x40)
                calldatacopy(ptr, 0, calldatasize())
                let result := delegatecall(gas(), facet, ptr, calldatasize(), 0, 0)
                
                // If call succeeded, return the data
                if result {
                    returndatacopy(ptr, 0, returndatasize())
                    return(ptr, returndatasize())
                }
                
                // If call failed, check if it's a real revert or just function not found
                let rdsize := returndatasize()
                if gt(rdsize, 0) {
                    returndatacopy(ptr, 0, rdsize)
                    
                    let errorSig := mload(ptr)
                    let errorSelector := shr(224, errorSig)
                    
                    // Error(string) selector is 0x08c379a0 - this is used for "function not found"
                    // For any other error (Panic, custom errors, etc), propagate it
                    // Only propagate if NOT Error(string)
                    if iszero(eq(errorSelector, 0x08c379a0)) {
                        revert(ptr, rdsize)
                    }
                    // If it is Error(string), continue to next facet
                }
                // No return data means function not found, continue to next facet
            }
        }
        
        // No facet handled the call
        revert("Function does not exist");
    }
}
