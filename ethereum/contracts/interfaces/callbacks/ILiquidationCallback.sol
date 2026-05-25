// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title ILiquidationCallback
 * @notice Callback interface for flash liquidations
 * @dev Implement for integration with flash loan protocols
 */
interface ILiquidationCallback {
    /// @notice Called during liquidation to allow flash loan repayment
    /// @param lpVault The vault being liquidated
    /// @param debtCleared Amount of debt being cleared
    /// @param collateralReceived Amount of collateral being received
    /// @param data Arbitrary data passed through
    function onLiquidation(
        address lpVault,
        uint256 debtCleared,
        uint256 collateralReceived,
        bytes calldata data
    ) external;
}
