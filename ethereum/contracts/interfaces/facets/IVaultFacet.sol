// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

/**
 * @title IVaultFacet
 * @notice Interface for vault management operations
 * @dev Handles vault creation, collateral, and configuration parameters.
 */
interface IVaultFacet {
    // ========== STRUCTS ==========\n    \n    struct Vault {\n        address lpAddress;\n        uint256 collateralShares;\n        uint256 lockedCollateral;\n        uint256 normalizedDebt;\n        uint256 pendingDebt;\n        uint16 maxMintBps;\n        uint256 mintGriefingDeposit;\n        uint16 mintFeeBps;\n        uint16 burnRewardBps;\n        uint256 liquidationNonce;\n        uint256 mintNonce;\n        uint256 minBurnAmount;\n        bool active;\n    }\n    \n    // ========== EVENTS ==========\n    \n    event VaultCreated(address indexed lpAddress);\n    event CollateralDeposited(address indexed lpAddress, uint256 underlyingAmount, uint256 shares);\n    event CollateralWithdrawn(address indexed lpAddress, uint256 underlyingAmount, uint256 shares);\n    \n    // ========== FUNCTIONS ==========\n    \n    /// @notice Creates a new vault instance for an LP.\n    function createVault() external;\n    \n    /// @notice Deposits collateral into the vault.\n    function depositCollateral(uint256 amount) external;\n    \n    /// @notice Sets key operational metrics for the vault (e.g., fee percentages).\n    function setVaultMarketMetrics(\n        uint16 mintFeeBps,\n        uint16 burnRewardBps\n    ) external;\n    \n    /// @notice Sets the minimum deposit required to initiate a mint.\n    function setMintGriefingDeposit(uint256 depositAmount) external;\n
}