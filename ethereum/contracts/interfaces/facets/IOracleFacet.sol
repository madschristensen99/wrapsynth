// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

/**
 * @title IOracleFacet
 * @notice Interface for price oracle operations
 * @dev Abstracts Pyth oracle interactions
 */
interface IOracleFacet {
    // ========== ERRORS ==========
    
    error StalePrice();
    error PriceNormalizedToZero();
    error RefundFailed();
    
    // ========== CONSTANTS ==========
    // Note: Constants are defined in wsXmrStorage:
    // - PRICE_MAX_AGE
    // - LIQUIDITY_PRICE_MAX_AGE
    // - XMR_USD_FEED_ID
    // - SDAI_USD_FEED_ID
    
    // ========== FUNCTIONS ==========
    
    /// @notice Update Pyth price feeds
    /// @param updateData Signed price update data
    function updatePythPrices(bytes[] calldata updateData) external payable;
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @notice Get XMR price in USD (18 decimals)
    function getXmrPrice() external view returns (uint256);
    
    /// @notice Get XMR price with custom staleness
    function getXmrPriceWithAge(uint256 maxAge) external view returns (uint256);
    
    /// @notice Get collateral price in USD (18 decimals)
    function getCollateralPrice() external view returns (uint256);
    
    /// @notice Get collateral price with custom staleness
    function getCollateralPriceWithAge(uint256 maxAge) external view returns (uint256);
    
    /// @notice Get XMR EMA price
    function getXmrEmaPrice() external view returns (uint256);
    
    /// @notice Get required fee for price update
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256);
    
    /// @notice Convert actual debt to normalized using current index
    function normalizeDebt(uint256 actualDebt) external view returns (uint256);
    
    /// @notice Convert normalized debt to actual using current index
    function denormalizeDebt(uint256 normalizedDebt) external view returns (uint256);
}
