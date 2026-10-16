// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/external/ISavingsDAI.sol";

/**
 * @title YieldLogic
 * @notice Library for yield harvesting and management
 */
library YieldLogic {
    uint256 constant YIELD_DUST_THRESHOLD = 100;
    uint256 constant COLLATERAL_RATIO = 150;
    uint256 constant RATIO_PRECISION = 100;
    uint256 constant PRICE_DECIMALS = 1e18;
    uint256 constant WSXMR_DECIMALS = 1e8;
    
    event YieldHarvested(uint256 yieldDai, uint256 yieldShares);

    /// @dev Smallest-unit scale of the collateral underlying (10^decimals).
    ///      convertToAssets returns raw underlying units — USD conversions
    ///      must use this, not 1e18 (cbBTC is 8-dec). Defaults to 1e18 if the
    ///      adapter doesn't expose asset().
    function _underlyingUnit(address collateralToken) internal view returns (uint256) {
        (bool ok, bytes memory data) = collateralToken.staticcall(abi.encodeWithSignature("asset()"));
        if (ok && data.length >= 32) {
            address underlying = abi.decode(data, (address));
            (bool ok2, bytes memory d2) = underlying.staticcall(abi.encodeWithSignature("decimals()"));
            if (ok2 && d2.length >= 32) return 10 ** abi.decode(d2, (uint8));
        }
        return 1e18;
    }
    
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
        uint256 collateralPrice,
        address collateralToken
    ) internal view returns (uint256 yieldShares) {
        // Convert collateral shares to underlying amount
        uint256 totalDaiValue = ISavingsDAI(collateralToken).convertToAssets(collateralShares);
        
        if (totalDaiValue <= principalDeposits) {
            return 0;
        }
        
        uint256 yieldDai = totalDaiValue - principalDeposits;
        uint256 vaultYieldShares = ISavingsDAI(collateralToken).convertToShares(yieldDai);
        
        if (vaultYieldShares < YIELD_DUST_THRESHOLD || vaultYieldShares > collateralShares) {
            return 0;
        }
        
        uint256 totalObligations = actualDebt + pendingDebt;
        
        if (totalObligations > 0) {
            // Convert available collateral shares to underlying, then to USD
            uint256 availableCollateralDai = ISavingsDAI(collateralToken).convertToAssets(collateralShares);
            uint256 availableCollateralUSD = (availableCollateralDai * collateralPrice) / _underlyingUnit(collateralToken);
            
            uint256 debtValueUSD = (totalObligations * xmrPrice) / WSXMR_DECIMALS; // wsXMR has 8 decimals
            uint256 minCollateralUSD = (debtValueUSD * COLLATERAL_RATIO) / RATIO_PRECISION;
            
            // Convert locked collateral shares to USD and add to minimum
            uint256 lockedCollateralDai = ISavingsDAI(collateralToken).convertToAssets(lockedCollateral);
            uint256 lockedCollateralUSD = (lockedCollateralDai * collateralPrice) / _underlyingUnit(collateralToken);
            minCollateralUSD += lockedCollateralUSD;
            
            if (availableCollateralUSD <= minCollateralUSD) {
                return 0;
            }
            
            uint256 maxExtractableUSD = availableCollateralUSD - minCollateralUSD;
            uint256 maxExtractableDai = (maxExtractableUSD * _underlyingUnit(collateralToken)) / collateralPrice;
            uint256 maxExtractableShares = ISavingsDAI(collateralToken).convertToShares(maxExtractableDai);
            
            if (vaultYieldShares > maxExtractableShares) {
                vaultYieldShares = maxExtractableShares;
            }
        }
        
        // M4: Share-level floor — never extract so much that collateralShares drops below lockedCollateral.
        // The USD-level check above can pass when sDAI exchange rate appreciates, but lockedCollateral
        // is denominated in shares and must always remain covered.
        if (collateralShares > lockedCollateral) {
            uint256 maxByLocked = collateralShares - lockedCollateral;
            if (vaultYieldShares > maxByLocked) {
                vaultYieldShares = maxByLocked;
            }
        } else {
            return 0;
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
        uint256 lpPrincipalDeposits,
        uint256 normalizedDebt,
        uint256 pendingDebt,
        uint256 globalDebtIndex,
        uint256 xmrPrice,
        uint256 collateralPrice,
        address collateralToken
    ) internal view returns (uint256 yieldToExtract) {
        if (collateralShares == 0) return 0;
        
        uint256 actualDebt = (normalizedDebt * globalDebtIndex) / 1e18;
        
        // Skip yield calculation if no debt
        if (actualDebt == 0 && pendingDebt == 0) return 0;
        
        yieldToExtract = calculateExtractableYield(
            collateralShares,
            lockedCollateral,
            lpPrincipalDeposits,
            actualDebt,
            pendingDebt,
            xmrPrice,
            collateralPrice,
            collateralToken
        );
    }
    
    /**
     * @notice Calculate collateral ratio for a vault
     */
    function calculateVaultCollateralRatio(
        uint256 collateralShares,
        uint256 debtAmount,
        uint256 collateralPrice,
        uint256 xmrPrice,
        address collateralToken
    ) internal view returns (uint256) {
        if (debtAmount == 0) return type(uint256).max;
        
        // Convert collateral shares to underlying amount
        uint256 collateralAmount = ISavingsDAI(collateralToken).convertToAssets(collateralShares);
        
        uint256 collateralValueUsd = (collateralAmount * collateralPrice) / _underlyingUnit(collateralToken);
        uint256 debtValueUsd = (debtAmount * xmrPrice) / 1e8; // wsXMR has 8 decimals
        
        return (collateralValueUsd * RATIO_PRECISION) / debtValueUsd;
    }
}
