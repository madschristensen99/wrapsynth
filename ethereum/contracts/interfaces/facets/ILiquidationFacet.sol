// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IErrors} from "../IErrors.sol";

/**
 * @title ILiquidationFacet
 * @notice Interface for vault liquidation operations
 */
interface ILiquidationFacet is IErrors {
    // ========== EVENTS ==========
    
    event VaultLiquidated(
        address indexed lpVault,
        address indexed liquidator,
        uint256 debtCleared,
        uint256 collateralSeized
    );
    event VaultBackstopped(
        address indexed oldVault,
        address indexed newVault,
        uint256 debtAssumed,
        uint256 collateralReceived
    );
    event BadDebtWrittenOff(address indexed lpVault, uint256 debtAmount);
    event BadDebtSocialized(address indexed lpVault, uint256 badDebt, uint256 newGlobalDebtIndex);
    
    // ========== ERRORS ==========
    
    error VaultHealthy();
    error CancelBurnsFirst();
    
    // ========== CONSTANTS ==========
    // Note: Constants are defined in wsXmrStorage:
    // - LIQUIDATION_RATIO
    // - LIQUIDATION_BONUS
    
    // ========== FUNCTIONS ==========
    
    /// @notice Liquidate an undercollateralized vault
    /// @param lpVault Address of vault to liquidate
    /// @param debtToClear Amount of debt to clear (wsXMR)
    function liquidate(address lpVault, uint256 debtToClear) external;
    
    /// @notice Backstop an underwater vault by assuming its debt and collateral
    /// @dev Caller must have an active vault; takes over old vault at discount
    /// @param oldVault Address of underwater vault to backstop
    function backstopVault(address oldVault) external;
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @notice Check if vault is liquidatable
    function isVaultLiquidatable(address lpVault) external view returns (bool);
    
    /// @notice Calculate collateral received for liquidating debt
    function calculateLiquidation(
        address lpVault,
        uint256 debtToClear
    ) external view returns (uint256 collateralSeized, uint256 actualDebtCleared);
    
    /// @notice Get all liquidatable vaults
    function getLiquidatableVaults(
        uint256 startIndex,
        uint256 count
    ) external view returns (address[] memory vaults, uint256[] memory debts);
}
