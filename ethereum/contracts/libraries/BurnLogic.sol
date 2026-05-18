// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/external/ISavingsDAI.sol";
import "../GnosisAddresses.sol";

/**
 * @title BurnLogic
 * @notice Library for burn request lifecycle logic
 */
library BurnLogic {
    /**
     * @notice Calculate burn reward collateral
     */
    function calculateBurnReward(
        uint256 wsxmrAmount,
        uint16 burnRewardBps,
        uint256 xmrPrice,
        uint256 collateralPrice
    ) internal pure returns (uint256 rewardCollateral) {
        uint256 wsxmrValueUsd = (wsxmrAmount * xmrPrice) / 1e8;
        uint256 rewardValueUsd = (wsxmrValueUsd * burnRewardBps) / 10000;
        rewardCollateral = (rewardValueUsd * 1e18) / collateralPrice;
    }
    
    /**
     * @notice Calculate required collateral for burn
     */
    function calculateRequiredCollateral(
        uint256 wsxmrAmount,
        uint256 xmrPrice,
        uint256 collateralPrice,
        uint256 liquidationRatio
    ) internal pure returns (uint256 requiredCollateral) {
        uint256 wsxmrValueUsd = (wsxmrAmount * xmrPrice) / 1e8;
        uint256 requiredValueUsd = (wsxmrValueUsd * liquidationRatio) / 100;
        requiredCollateral = (requiredValueUsd * 1e18) / collateralPrice;
    }
    
}
