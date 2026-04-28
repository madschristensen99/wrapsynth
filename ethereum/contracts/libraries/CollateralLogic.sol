// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CollateralLogic
 * @notice Library for collateral ratio calculations
 */
library CollateralLogic {
    uint256 constant RATIO_PRECISION = 100;
    
    /**
     * @notice Calculate collateral ratio
     */
    function calculateCollateralRatio(
        uint256 collateralValueUsd,
        uint256 debtValueUsd
    ) internal pure returns (uint256 ratio) {
        if (debtValueUsd == 0) return type(uint256).max;
        ratio = (collateralValueUsd * RATIO_PRECISION) / debtValueUsd;
    }
    
    /**
     * @notice Convert collateral amount to USD value
     */
    function collateralToUsd(
        uint256 collateralAmount,
        uint256 collateralPrice
    ) internal pure returns (uint256 valueUsd) {
        valueUsd = (collateralAmount * collateralPrice) / 1e18;
    }
    
    /**
     * @notice Convert USD value to collateral amount
     */
    function usdToCollateral(
        uint256 valueUsd,
        uint256 collateralPrice
    ) internal pure returns (uint256 collateralAmount) {
        collateralAmount = (valueUsd * 1e18) / collateralPrice;
    }
    
    /**
     * @notice Calculate collateral value needed for debt
     */
    function getCollateralValueForDebt(
        uint256 debtAmount,
        uint256 xmrPrice,
        uint256 ratio
    ) internal pure returns (uint256 collateralValueUsd) {
        uint256 debtValueUsd = (debtAmount * xmrPrice) / 1e8;
        collateralValueUsd = (debtValueUsd * ratio) / RATIO_PRECISION;
    }
}
