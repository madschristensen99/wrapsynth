// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IBurnOperations} from "../swap/IBurnOperations.sol";

/**
 * @title IBurnFacet
 * @notice Interface for the BurnFacet contract
 * @dev Implements IBurnOperations with additional facet-specific functionality
 */
interface IBurnFacet is IBurnOperations {
    // ========== CONSTANTS ==========
    // Note: Constants are defined in wsXmrStorage:
    // - BURN_REQUEST_TIMEOUT
    // - BURN_COMMIT_TIMEOUT
    // - BURN_LOCK_RATIO
    // - MIN_BURN_AMOUNT
    // - MAX_BURN_REQUESTS_PER_VAULT
    
    // ========== ADDITIONAL VIEWS ==========
    
    /// @notice Calculate collateral to lock for a burn
    function calculateBurnCollateral(
        address lpVault,
        uint256 wsxmrAmount
    ) external view returns (uint256 baseLock, uint256 rewardLock);
    
    /// @notice Check if burn amount meets vault minimum
    function meetsMinimumBurn(address lpVault, uint256 wsxmrAmount) external view returns (bool);
    
    /// @notice Get active burn request count for vault
    function getActiveBurnCount(address lpVault) external view returns (uint256);
}
