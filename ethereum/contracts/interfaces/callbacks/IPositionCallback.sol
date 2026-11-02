// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title IPositionCallback
 * @notice Callback interface for liquidity position events
 */
interface IPositionCallback {
    /// @notice Called when a position is created
    /// @param positionIndex Index of the new position
    /// @param lp LP address
    /// @param user User address
    /// @param collateralAmount collateral in position
    /// @param wsxmrAmount wsXMR in position
    function onPositionCreated(
        uint256 positionIndex,
        address lp,
        address user,
        uint256 collateralAmount,
        uint256 wsxmrAmount
    ) external;
    
    /// @notice Called when a position is closed
    /// @param positionIndex Index of closed position
    /// @param collateralReturned collateral returned
    /// @param wsxmrReturned wsXMR returned
    function onPositionClosed(
        uint256 positionIndex,
        uint256 collateralReturned,
        uint256 wsxmrReturned
    ) external;
}
