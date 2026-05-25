// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/external/ISavingsDAI.sol";
import "../GnosisAddresses.sol";

/**
 * @title YieldLogic
 * @notice Library for yield harvesting and management
 */
library YieldLogic {
    uint256 constant YIELD_DUST_THRESHOLD = 100;
    uint256 constant COLLATERAL_RATIO = 150;
    uint256 constant RATIO_PRECISION = 100;
    uint256 constant PRICE_DECIMALS = 1e18;
    
    event YieldHarvested(uint256 yieldDai, uint256 yieldShares);
    
    /**
     * @notice Calculate extractable yield from vault
     */
    function calculateExtractableYield(
        uint256 collateralShares,
        uint256 lockedCollateral,
        uint256 principalDeposits,
        uint256 actualDebt,
        uint256 pendingDebt,
        uint256 xmrPrice,
        uint256 collateralPrice
    ) internal view returns (uint256 yieldShares) {
        // Convert sDAI shares to underlying DAI amount
        uint256 totalDaiValue = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(collateralShares);
        
        if (totalDaiValue <= principalDeposits) {
            return 0;
        }
        
        uint256 yieldDai = totalDaiValue - principalDeposits;
        uint256 vaultYieldShares = ISavingsDAI(GnosisAddresses.SDAI).convertToShares(yieldDai);
        
        if (vaultYieldShares < YIELD_DUST_THRESHOLD || vaultYieldShares > collateralShares) {
            return 0;
        }
        
        uint256 totalObligations = actualDebt + pendingDebt;
        
        if (totalObligations > 0) {
            // Convert available collateral shares to DAI, then to USD
            uint256 availableCollateralDai = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(collateralShares);
            uint256 availableCollateralUSD = (availableCollateralDai * collateralPrice) / 1e18;
            
            uint256 debtValueUSD = (totalObligations * xmrPrice) / 1e18; // Price decimals (oracle returns 18 decimals)
            uint256 minCollateralUSD = (debtValueUSD * COLLATERAL_RATIO) / RATIO_PRECISION;
            
            // Convert locked collateral shares to USD and add to minimum
            uint256 lockedCollateralDai = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(lockedCollateral);
            uint256 lockedCollateralUSD = (lockedCollateralDai * collateralPrice) / 1e18;
            minCollateralUSD += lockedCollateralUSD;
            
            if (availableCollateralUSD <= minCollateralUSD) {
                return 0;
            }
            
            uint256 maxExtractableUSD = availableCollateralUSD - minCollateralUSD;
            uint256 maxExtractableDai = (maxExtractableUSD * 1e18) / collateralPrice;
            uint256 maxExtractableShares = ISavingsDAI(GnosisAddresses.SDAI).convertToShares(maxExtractableDai);
            
            if (vaultYieldShares > maxExtractableShares) {
                vaultYieldShares = maxExtractableShares;
            }
        }
        
        return vaultYieldShares;
    }
    
    /**
     * @notice Sync vault yield extraction
     * @dev Extracts yield to war chest if vault is overcollateralized
     */
    function syncVaultYield(
        uint256 collateralShares,
        uint256 lockedCollateral,
        uint256 lpPrincipalShares,
        uint256 normalizedDebt,
        uint256 pendingDebt,
        uint256 globalDebtIndex,
        uint256 xmrPrice,
        uint256 collateralPrice
    ) internal view returns (uint256 yieldToExtract) {
        if (collateralShares == 0) return 0;
        
        uint256 actualDebt = (normalizedDebt * globalDebtIndex) / 1e18;
        
        // Skip yield calculation if no debt
        if (actualDebt == 0 && pendingDebt == 0) return 0;
        
        yieldToExtract = calculateExtractableYield(
            collateralShares,
            lockedCollateral,
            lpPrincipalShares,
            actualDebt,
            pendingDebt,
            xmrPrice,
            collateralPrice
        );
    }
    
    /**
     * @notice Calculate collateral ratio for a vault
     */
    function calculateVaultCollateralRatio(
        uint256 collateralShares,
        uint256 debtAmount,
        uint256 collateralPrice,
        uint256 xmrPrice
    ) internal view returns (uint256) {
        if (debtAmount == 0) return type(uint256).max;
        
        // Convert sDAI shares to underlying DAI amount
        uint256 collateralAmount = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(collateralShares);
        
        uint256 collateralValueUsd = (collateralAmount * collateralPrice) / PRICE_DECIMALS;
        uint256 debtValueUsd = (debtAmount * xmrPrice) / 1e8; // wsXMR has 8 decimals
        
        return (collateralValueUsd * RATIO_PRECISION) / debtValueUsd;
    }
}
