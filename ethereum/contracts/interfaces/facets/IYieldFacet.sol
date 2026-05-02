// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

/**
 * @title IYieldFacet
 * @notice Facet implementation for yield farming and reinvestment logic.
 * @dev Handles earning rewards on assets held in the hub/vault.
 */
interface IYieldFacet {
    // Placeholder functions based on typical yield mechanics, awaiting detailed spec review.
    function accrueYield(address vault) external;
    function claimAndDistributeRewards() external returns (uint256 rewardAmount);
}