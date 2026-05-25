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
    /// @dev Uses transient storage (EIP-1153) to prevent reentrancy bypass attacks
    /// @dev Auto-clears at transaction end, not readable across separate calls
    bool private transient _inDelegateContext;
    
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
    function _registerFacetSelectors(address facet) private {
        (bool success, bytes memory data) = facet.staticcall(
            abi.encodeWithSignature("selectors()")
        );
        require(success, "Failed to get selectors");
        
        bytes4[] memory sels = abi.decode(data, (bytes4[]));
        for (uint256 i = 0; i < sels.length; i++) {
            _selectorToFacet[sels[i]] = facet;
        }
    }
    
    /// @notice Add new selectors to the routing table
    /// @dev Only deployer can modify selector table
    function addSelectors(address facet, bytes4[] calldata selectors) external onlyDeployer {
        if (!facets[facet]) revert Unauthorized();
        
        for (uint256 i = 0; i < selectors.length; i++) {
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
    /// @dev Uses selector table for O(1) routing, transient storage prevents reentrancy
    fallback() external payable {
        address facet = _selectorToFacet[msg.sig];
        if (facet == address(0)) revert("Function does not exist");
        
        // Set transient delegate context flag - auto-clears at tx end
        _inDelegateContext = true;
        
        assembly {
            let ptr := mload(0x40)
            calldatacopy(ptr, 0, calldatasize())
            let result := delegatecall(gas(), facet, ptr, calldatasize(), 0, 0)
            returndatacopy(ptr, 0, returndatasize())
            
            switch result
            case 0 { revert(ptr, returndatasize()) }
            default { return(ptr, returndatasize()) }
        }
    }
}
