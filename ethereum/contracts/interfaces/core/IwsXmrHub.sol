// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title IwsXmrHub
 * @notice Central coordinator and state owner for the wsXMR system
 * @dev Holds all state, delegates logic to facets, controls token operations
 */
interface IwsXmrHub {
    // ========== STRUCTS ==========
    
    struct GlobalState {
        address wsxmrToken;
        address liquidityRouter;
        address deployer;
        address pythOracle;
        uint256 globalTotalDebt;
        uint256 globalDebtIndex;
        uint256 globalBadDebt;
        uint256 globalPendingBurnDebt;
        uint256 yieldWarChest;
        uint256 lastBuyTimestamp;
        uint256 globalLpPrincipal;
        uint256 globalLpPrincipalShares;
        uint256 globalPendingSDAI;
        uint256 requestNonce;
        uint256 vaultCount;
    }
    
    // ========== EVENTS ==========
    
    event FacetsRegistered(
        address vaultFacet,
        address mintFacet,
        address burnFacet,
        address liquidationFacet,
        address yieldFacet,
        address oracleFacet
    );
    event LiquidityRouterSet(address router);
    event LiquidityRouterMigrated(address indexed oldRouter, address indexed newRouter);
    
    // ========== ERRORS ==========
    
    error Unauthorized();
    error ZeroAddress();
    error AlreadyInitialized();
    error ReentrancyGuard();
    
    // ========== INITIALIZATION ==========
    
    /// @notice Register all facet contracts (one-time setup)
    /// @param vaultFacet Address of VaultFacet
    /// @param mintFacet Address of MintFacet
    /// @param burnFacet Address of BurnFacet
    /// @param liquidationFacet Address of LiquidationFacet
    /// @param yieldFacet Address of YieldFacet
    /// @param oracleFacet Address of OracleFacet
    function registerFacets(
        address vaultFacet,
        address mintFacet,
        address burnFacet,
        address liquidationFacet,
        address yieldFacet,
        address oracleFacet
    ) external;
    
    /// @notice Set the liquidity router address (one-time setup)
    /// @param router Address of wsXmrLiquidityRouter
    function setLiquidityRouter(address router) external;
    
    // ========== FACET OPERATIONS ==========
    
    /// @notice Mint wsXMR tokens (only callable by facets)
    /// @param to Recipient address
    /// @param amount Amount to mint
    function mintTokens(address to, uint256 amount) external;
    
    /// @notice Burn wsXMR tokens (only callable by facets)
    /// @param from Address to burn from
    /// @param amount Amount to burn
    function burnTokens(address from, uint256 amount) external;
    
    /// @notice Transfer ERC20 held by hub (only callable by facets)
    /// @param token Token address
    /// @param to Recipient
    /// @param amount Amount to transfer
    function transferAsset(address token, address to, uint256 amount) external;
    
    /// @notice Approve ERC20 spending (only callable by facets)
    /// @param token Token address
    /// @param spender Approved spender
    /// @param amount Approval amount
    function approveAsset(address token, address spender, uint256 amount) external;
    
    // ========== REENTRANCY GUARDS ==========
    
    /// @notice Enter reentrancy guard (only callable by facets)
    function enterNonReentrant() external;
    
    /// @notice Exit reentrancy guard (only callable by facets)
    function exitNonReentrant() external;
    
    // ========== VIEW FUNCTIONS ==========
    
    // Note: The following view functions are auto-generated from public state variables in wsXmrStorage:
    // - wsxmrToken() returns (address)
    // - deployer() returns (address)
    // - verifierProxy() returns (address)
    // - liquidityRouter() returns (address)
    // - vaultFacet() returns (address)
    // - mintFacet() returns (address)
    // - burnFacet() returns (address)
    // - liquidationFacet() returns (address)
    // - yieldFacet() returns (address)
    // - oracleFacet() returns (address)
    // - facets(address) returns (bool)
    // - vaults(address) returns (Vault memory)
    // - mintRequests(bytes32) returns (MintRequest memory)
    // - burnRequests(bytes32) returns (BurnRequest memory)
    // - pendingReturns(address, address) returns (uint256)
    // - lpPublicKeys(bytes32) returns (bytes32)
    // - globalTotalDebt() returns (uint256)
    // - globalDebtIndex() returns (uint256)
    // - lastXmrPrice() returns (int192)
    // - lastCollateralPrice() returns (int192)
    // - lastXmrPriceTimestamp() returns (uint256)
    // - lastCollateralPriceTimestamp() returns (uint256)
    // - getVaultCount() returns (uint256)
    // - getActualDebt(uint256) returns (uint256)
    // - MAX_VAULT_COUNT() returns (uint256)
}
