// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IErrors} from "../IErrors.sol";
import {wsXmrStorage} from "../../core/wsXmrStorage.sol";

/**
 * @title IVaultFacet
 * @notice Interface for vault management operations
 * @dev Handles vault creation, collateral, and configuration
 */
interface IVaultFacet is IErrors {
    // ========== EVENTS ==========
    
    event VaultCreated(address indexed lpAddress);
    event CollateralDeposited(address indexed lpAddress, uint256 underlyingAmount, uint256 shares);
    event CollateralWithdrawn(address indexed lpAddress, uint256 underlyingAmount, uint256 shares);
    event MintGriefingDepositUpdated(address indexed lpVault, uint256 newDeposit);
    event VaultMarketMetricsUpdated(address indexed lpVault, uint16 mintFeeBps, uint16 burnRewardBps);
    event MaxMintBpsUpdated(address indexed lpVault, uint16 newMaxMintBps);
    event MinBurnAmountUpdated(address indexed lpVault, uint256 newMinBurnAmount);
    // Note: ReturnQueued event is defined in wsXmrStorage
    event ReturnsWithdrawn(address indexed recipient, address indexed token, uint256 amount);
    
    // ========== ERRORS ==========
    
    error VaultAlreadyExists();
    error MaxVaultsReached();
    error ExceedsMaxMargin();
    error ETHTransferFailed();
    
    // ========== VAULT LIFECYCLE ==========
    
    /// @notice Create a new LP vault
    function createVault() external;
    
    /// @notice Deactivate vault (LP can reactivate by depositing)
    function deactivateVault() external;
    
    // ========== COLLATERAL MANAGEMENT ==========
    
    /// @notice Deposit native token (auto-converts to yield-bearing)
    /// @param amount Amount of native token to deposit
    function depositCollateral(uint256 amount) external;
    
    /// @notice Deposit yield-bearing shares directly
    /// @param shares Amount of shares to deposit
    function depositShares(uint256 shares) external;
    
    /// @notice Withdraw collateral (if health ratio allows)
    /// @param shares Amount of shares to withdraw
    function withdrawCollateral(uint256 shares) external;
    
    // ========== VAULT CONFIGURATION ==========
    
    /// @notice Set griefing deposit required for mint requests
    /// @param deposit ETH amount required (0 to disable)
    function setMintGriefingDeposit(uint256 deposit) external;
    
    /// @notice Set mint fees and burn rewards
    /// @param mintFeeBps Fee charged for minting (basis points, max 1000)
    /// @param burnRewardBps Reward paid for burning (basis points, max 1000)
    function setVaultMarketMetrics(uint16 mintFeeBps, uint16 burnRewardBps) external;
    
    /// @notice Set maximum single mint size
    /// @param maxMintBps Max mint as percentage of capacity (basis points)
    function setMaxMintBps(uint16 maxMintBps) external;
    
    /// @notice Set minimum burn amount
    /// @param minAmount Minimum wsXMR for burn requests (0 = global default)
    function setMinBurnAmount(uint256 minAmount) external;
    
    // ========== PENDING RETURNS ==========
    
    /// @notice Withdraw queued returns (pull pattern)
    /// @param token Token address (address(0) for ETH)
    function withdrawReturns(address token) external;
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @notice Get vault details
    function getVault(address lpAddress) external view returns (wsXmrStorage.Vault memory);
    
    /// @notice Get vault health ratio
    /// @return ratio Collateral ratio (150 = 150%)
    function getVaultHealth(address lpAddress) external view returns (uint256 ratio);
    
    /// @notice Get vault's actual debt (after applying debt index)
    function getVaultDebt(address lpAddress) external view returns (uint256);
    
    /// @notice Get total number of vaults
    function getVaultCount() external view returns (uint256);
    
    /// @notice Get vault address by index
    function getVaultAtIndex(uint256 index) external view returns (address);
    
    /// @notice Get pending returns for user
    function getPendingReturns(address user, address token) external view returns (uint256);
    
    /// @notice Check if address has an active vault
    function hasActiveVault(address lpAddress) external view returns (bool);
    
    /// @notice Calculate collateral ratio for given amounts
    function calculateCollateralRatio(
        uint256 collateralAmount,
        uint256 debtAmount
    ) external view returns (uint256);
}
