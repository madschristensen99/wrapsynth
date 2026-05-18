// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

/**
 * @title ILiquidityPosition
 * @notice Interface for liquidity position management
 */
interface ILiquidityPosition {
    // ========== STRUCTS ==========
    
    struct Position {
        uint256 positionId;         // DEX NFT token ID
        address lpProvider;         // LP who provided sDAI
        address userProvider;       // User who provided wsXMR
        uint256 sDAIAmount;         // sDAI in position
        uint256 wsxmrAmount;        // wsXMR in position
        uint256 lpInitialValueUSD;  // LP's initial contribution value
        uint256 userInitialValueUSD;// User's initial contribution value
        uint256 createdAt;          // Creation timestamp
    }
    
    // ========== EVENTS ==========
    
    event PositionCreated(
        uint256 indexed positionIndex,
        uint256 dexTokenId,
        address indexed lp,
        address indexed user,
        uint256 sDAIAmount,
        uint256 wsxmrAmount
    );
    
    event PositionClosed(
        uint256 indexed positionIndex,
        uint256 sDAIReturned,
        uint256 wsxmrReturned
    );
    
    event FeesCollected(
        uint256 indexed positionIndex,
        uint256 sDAIFees,
        uint256 wsxmrFees
    );
    
    event FeesWithdrawn(
        address indexed recipient,
        uint256 sDAIAmount,
        uint256 wsxmrAmount
    );
    
    event ILSDAICredited(address indexed user, uint256 amount, uint256 positionIndex);
    event ILWsxmrCredited(address indexed lp, uint256 amount, uint256 positionIndex);
    
    // ========== ERRORS ==========
    
    error PositionNotFound();
    error PositionTooYoung();
    error BelowCallerMinimum();
    error WithdrawalValueTooLow();
    
    // ========== FUNCTIONS ==========
    
    /// @notice Create position with fresh price update
    function createPositionWithPriceUpdate(
        address lp,
        address user,
        uint256 sDAIAmount,
        uint256 wsxmrAmount,
        uint256 deadline,
        bytes[] calldata pythUpdateData
    ) external payable returns (uint256 positionIndex);
    
    /// @notice Create position (requires recent price update)
    function createPosition(
        address lp,
        address user,
        uint256 sDAIAmount,
        uint256 wsxmrAmount,
        uint256 deadline
    ) external returns (uint256 positionIndex);
    
    /// @notice Close a position and return assets
    /// @param positionIndex Index of position to close
    /// @param deadline Transaction deadline
    /// @param minTotalValueUSD Minimum USD value to receive
    function closePosition(
        uint256 positionIndex,
        uint256 deadline,
        uint256 minTotalValueUSD
    ) external;
    
    /// @notice Collect fees from active position
    function collectFees(uint256 positionIndex) external;
    
    /// @notice Withdraw accumulated fees
    function withdrawFees() external;
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @notice Get position details
    function getPosition(uint256 positionIndex) external view returns (Position memory);
    
    /// @notice Get paginated positions for account
    function getUserPositions(
        address account,
        uint256 cursor,
        uint256 limit
    ) external view returns (Position[] memory positions, uint256 nextCursor);
    
    /// @notice Get pending fees for account
    function getPendingFees(address account) external view returns (
        uint256 sDAIFees,
        uint256 wsxmrFees
    );
    
    /// @notice Get active position count for account
    function activePositionCount(address account) external view returns (uint256);
    
    /// @notice Get next position index
    function nextPositionIndex() external view returns (uint256);
}
