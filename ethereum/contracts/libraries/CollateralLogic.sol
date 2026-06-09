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
        uint256 debtValueUsd = (debtAmount * xmrPrice) / 1e8; // wsXMR has 8 decimals
        collateralValueUsd = (debtValueUsd * ratio) / RATIO_PRECISION;
    }
    
    /**
     * @notice Calculate collateral ratio from sDAI shares
     * @dev Converts shares to assets, then calculates USD values and ratio
     */
    function calculateRatioFromShares(
        uint256 collateralShares,
        uint256 debtAmount,
        address sdai,
        uint256 collateralPrice,
        uint256 xmrPrice
    ) internal view returns (uint256) {
        if (debtAmount == 0) return type(uint256).max;
        
        // Convert sDAI shares to underlying DAI amount
        // Using low-level call to avoid importing IERC4626
        (bool success, bytes memory data) = sdai.staticcall(
            abi.encodeWithSignature("convertToAssets(uint256)", collateralShares)
        );
        require(success && data.length >= 32, "convertToAssets failed");
        uint256 collateralAmount = abi.decode(data, (uint256));
        
        uint256 collateralValueUsd = (collateralAmount * collateralPrice) / 1e18;
        uint256 debtValueUsd = (debtAmount * xmrPrice) / 1e8; // wsXMR has 8 decimals
        
        return (collateralValueUsd * RATIO_PRECISION) / debtValueUsd;
    }
    
    /**
     * @notice Calculate CR including idle sDAI shares AND deployed pool positions.
     * @dev Position contents (positionDAI, positionWsxmr) MUST be valued at oracle prices
     *      by the caller. This function trusts those inputs.
     * @param idleShares sDAI shares held directly by vault
     * @param positionDAI Sum of DAI (1e18) across vault's active positions
     * @param debtAmount wsXMR debt
     * @param sdai sDAI token address
     * @param collateralPrice sDAI USD price (1e18)
     * @param xmrPrice XMR USD price (1e18)
     */
    function calculateVaultCRWithDeployment(
        uint256 idleShares,
        uint256 positionDAI,
        uint256 /*positionWsxmr*/,
        uint256 debtAmount,
        address sdai,
        uint256 collateralPrice,
        uint256 xmrPrice
    ) internal view returns (uint256) {
        if (debtAmount == 0) return type(uint256).max;
        
        (bool success, bytes memory data) = sdai.staticcall(
            abi.encodeWithSignature("convertToAssets(uint256)", idleShares)
        );
        require(success && data.length >= 32, "convertToAssets failed");
        uint256 idleDaiAmount = abi.decode(data, (uint256));
        
        uint256 totalDaiAmount = idleDaiAmount + positionDAI;
        uint256 collateralUsd = (totalDaiAmount * collateralPrice) / 1e18;
        // M2: Do NOT count deployed wsXMR as vault collateral. On unwind it goes
        // to the user (pendingReturns), not the vault.
        uint256 debtValueUsd = (debtAmount * xmrPrice) / 1e8;
        
        return (collateralUsd * RATIO_PRECISION) / debtValueUsd;
    }
}
