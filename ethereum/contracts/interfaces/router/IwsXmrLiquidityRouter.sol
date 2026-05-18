// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {ILiquidityPosition} from "./ILiquidityPosition.sol";
import {ICoLPMatching} from "./ICoLPMatching.sol";

/**
 * @title IwsXmrLiquidityRouter
 * @notice Interface for the co-LP matchmaking and liquidity management system
 * @dev Pairs LP collateral with user wsXMR for DEX liquidity provision
 */
interface IwsXmrLiquidityRouter is ILiquidityPosition, ICoLPMatching {
    // ========== EVENTS ==========
    
    event PoolInitialized(
        address indexed pool,
        uint160 sqrtPriceX96,
        uint256 sDAIPrice,
        uint256 wsxmrPrice
    );
    
    // ========== ERRORS ==========
    
    error PoolAlreadyInitialized();
    error PoolNotInitialized();
    
    // ========== CONSTANTS ==========
    
    /// @notice DEX pool fee tier
    function POOL_FEE() external pure returns (uint24);
    
    /// @notice Tick spacing for the pool
    function TICK_SPACING() external pure returns (int24);
    
    /// @notice Minimum deposit to prevent dust
    function MIN_DEPOSIT_AMOUNT() external pure returns (uint256);
    
    /// @notice Minimum position duration
    function MIN_POSITION_DURATION() external pure returns (uint256);
    
    /// @notice Maximum positions per user
    function MAX_ACTIVE_POSITIONS_PER_USER() external pure returns (uint256);
    
    // ========== INITIALIZATION ==========
    
    /// @notice Initialize the DEX pool with oracle-derived price
    /// @param pythUpdateData Price update data for oracle
    /// @return pool Address of initialized pool
    function initializePool(bytes[] calldata pythUpdateData) external payable returns (address pool);
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @notice Check if pool has been initialized
    function poolInitialized() external view returns (bool);
    
    /// @notice Get token0 address (lower address)
    function token0() external view returns (address);
    
    /// @notice Get token1 address (higher address)
    function token1() external view returns (address);
    
    /// @notice Check if sDAI is token0
    function sDAIIsToken0() external view returns (bool);
    
    /// @notice Get hub contract address
    function hub() external view returns (address);
    
    /// @notice Get wsXMR token address
    function wsxmrToken() external view returns (address);
}
