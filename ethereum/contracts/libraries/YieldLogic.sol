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
    
    event YieldHarvested(uint256 yieldDai, uint256 yieldShares);
    
    /**
     * @notice Calculate extractable yield from vault
     */
    function calculateExtractableYield(
        uint256 collateralAmount,
        uint256 lockedCollateral,
        uint256 principalDeposits,
        uint256 actualDebt,
        uint256 pendingDebt,
        uint256 xmrPrice,
        uint256 collateralPrice
    ) internal view returns (uint256 yieldShares) {
        uint256 currentRate = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(1e18);
        uint256 totalDaiValue = (collateralAmount * currentRate) / 1e18;
        
        if (totalDaiValue <= principalDeposits) {
            return 0;
        }
        
        uint256 yieldDai = totalDaiValue - principalDeposits;
        uint256 vaultYieldShares = ISavingsDAI(GnosisAddresses.SDAI).convertToShares(yieldDai);
        
        if (vaultYieldShares < YIELD_DUST_THRESHOLD || vaultYieldShares > collateralAmount) {
            return 0;
        }
        
        uint256 totalObligations = actualDebt + pendingDebt;
        
        if (totalObligations > 0) {
            uint256 debtValueUSD = (totalObligations * xmrPrice) / 1e8;
            uint256 minCollateralUSD = (debtValueUSD * COLLATERAL_RATIO) / RATIO_PRECISION;
            uint256 minCollateralShares = (minCollateralUSD * 1e18) / collateralPrice;
            minCollateralShares += lockedCollateral;
            
            if (collateralAmount <= minCollateralShares) {
                return 0;
            }
            
            uint256 maxExtractable = collateralAmount - minCollateralShares;
            if (vaultYieldShares > maxExtractable) {
                vaultYieldShares = maxExtractable;
            }
        }
        
        return vaultYieldShares;
    }
}
