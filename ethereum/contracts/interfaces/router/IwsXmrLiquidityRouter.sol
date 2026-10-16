// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {ILiquidityPosition} from "./ILiquidityPosition.sol";

/**
 * @title IwsXmrLiquidityRouter
 * @notice Interface for the co-LP concentrated liquidity router.
 * @dev Thin wrapper around Uniswap V3 NFPM, called only by the diamond.
 */
interface IwsXmrLiquidityRouter is ILiquidityPosition {
    // ========== EVENTS ==========

    event PoolInitialized(
        address indexed pool,
        uint160 sqrtPriceX96,
        uint256 sDAIPrice,
        uint256 wsxmrPrice
    );

    // ========== ERRORS ==========

    error Unauthorized();
    error ZeroAddress();
    error PoolAlreadyInitialized();
    error PoolNotInitialized();

    // ========== CONSTANTS ==========

    function POOL_FEE() external view returns (uint24);
    function TICK_SPACING() external view returns (int24);

    // ========== INITIALIZATION ==========

    /// @notice Initialize the pool at the given XMR price, assuming ~$1 collateral
    ///         (call once at deployment). For volatile collateral use
    ///         initializePoolWithPrice.
    /// @param initialXmrPrice XMR price in USD (18 decimals)
    function initializePool(uint256 initialXmrPrice) external;

    /// @notice Initialize the pool at explicit XMR and collateral USD prices.
    /// @param initialXmrPrice XMR price in USD (18 decimals)
    /// @param collateralPrice Collateral asset price in USD (18 decimals)
    function initializePoolWithPrice(uint256 initialXmrPrice, uint256 collateralPrice) external;

    // ========== VIEW FUNCTIONS ==========

    function poolInitialized() external view returns (bool);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function sDAIIsToken0() external view returns (bool);
    function hub() external view returns (address);
    function sDAI() external view returns (address);
    function wsXMR() external view returns (address);
    function pool() external view returns (address);
    function positionManager() external view returns (address);
}
