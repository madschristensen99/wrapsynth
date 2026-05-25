// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {ILiquidationFacet} from "../interfaces/facets/ILiquidationFacet.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";
import {IwsXmrHub} from "../interfaces/core/IwsXmrHub.sol";
import {CollateralLogic} from "../libraries/CollateralLogic.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {GnosisAddresses} from "../GnosisAddresses.sol";
import {YieldLogic} from "../libraries/YieldLogic.sol";
import {GnosisAddresses} from "../GnosisAddresses.sol";

contract LiquidationFacet is wsXmrStorage, ILiquidationFacet {
    using SafeERC20 for IERC20;
    
    constructor(address _wsxmrToken, address _verifierProxy) 
        wsXmrStorage(_wsxmrToken, _verifierProxy) 
    {}
    
    function liquidate(address lpVault, uint256 debtToClear) external {
        if (!vaults[lpVault].active) revert VaultDoesNotExist();
        if (debtToClear == 0) revert ZeroAmount();
        
        Vault storage vault = vaults[lpVault];
        
        uint256 actualDebt;
        uint256 xmrPrice;
        uint256 collateralPrice;
        
        if (vault.collateralShares > 0) {
            actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
            xmrPrice = _getXmrPriceFromStorage();
            collateralPrice = _getCollateralPriceFromStorage();
            
            uint256 yieldShares = YieldLogic.calculateExtractableYield(
                vault.collateralShares,
                vault.lockedCollateral,
                lpPrincipalShares[lpVault],
                actualDebt,
                vault.pendingDebt,
                xmrPrice,
                collateralPrice
            );
            
            if (yieldShares > 0) {
                vault.collateralShares -= yieldShares;
                yieldWarChest += yieldShares;
            }
        } else {
            actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        }
        if (actualDebt == 0) revert InsufficientDebt();
        if (debtToClear > actualDebt) {
            debtToClear = actualDebt;
        }
        
        uint256 ratio = _calculateCollateralRatio(vault.collateralShares, actualDebt);
        if (ratio >= LIQUIDATION_RATIO) revert VaultHealthy();
        
        bytes32[] storage vaultBurns = vaultBurnRequests[lpVault];
        for (uint256 i = 0; i < vaultBurns.length; i++) {
            BurnRequest storage burnReq = burnRequests[vaultBurns[i]];
            if (burnReq.status == BurnStatus.REQUESTED || 
                burnReq.status == BurnStatus.PROPOSED || 
                burnReq.status == BurnStatus.COMMITTED) {
                revert CancelBurnsFirst();
            }
        }
        
        collateralPrice = _getCollateralPriceFromStorage();
        xmrPrice = _getXmrPriceFromStorage();
        
        uint256 debtValueUsd = (debtToClear * xmrPrice) / PRICE_DECIMALS;
        uint256 collateralValueUsd = (debtValueUsd * LIQUIDATION_BONUS) / RATIO_PRECISION;
        uint256 collateralToSeize = (collateralValueUsd * SDAI_DECIMALS) / collateralPrice;
        
        if (collateralToSeize > vault.collateralShares) {
            collateralToSeize = vault.collateralShares;
            uint256 actualCollateralValueUsd = (collateralToSeize * collateralPrice) / SDAI_DECIMALS;
            debtToClear = (actualCollateralValueUsd * RATIO_PRECISION * WSXMR_DECIMALS) / (LIQUIDATION_BONUS * xmrPrice);
            
            if (debtToClear > actualDebt) {
                debtToClear = actualDebt;
            }
        }
        
        uint256 normalizedDebtCleared = (debtToClear * 1e18 + globalDebtIndex - 1) / globalDebtIndex;
        if (normalizedDebtCleared > vault.normalizedDebt) {
            normalizedDebtCleared = vault.normalizedDebt;
        }
        
        vault.normalizedDebt -= normalizedDebtCleared;
        vault.collateralShares -= collateralToSeize;
        globalTotalDebt -= debtToClear;
        
        // Track bad debt if vault has remaining debt but no collateral
        // TODO M3: Implement proper socialization (war chest backing or index increase)
        // Current implementation just tracks for transparency
        if (vault.normalizedDebt > 0 && vault.collateralShares == 0) {
            uint256 badDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
            if (badDebt > 0) {
                vault.normalizedDebt = 0;
                globalBadDebt += badDebt;
                emit BadDebtWrittenOff(lpVault, badDebt);
            }
        }
        
        vault.liquidationNonce++;
        vault.mintNonce++;
        
        IwsXmrHub(address(this)).burnTokens(msg.sender, debtToClear);
        IERC20(GnosisAddresses.SDAI).safeTransfer(msg.sender, collateralToSeize);
        
        emit VaultLiquidated(lpVault, msg.sender, debtToClear, collateralToSeize);
    }
    
    function isVaultLiquidatable(address lpVault) external view returns (bool) {
        Vault memory vault = vaults[lpVault];
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        if (!vault.active || actualDebt == 0) return false;
        
        uint256 ratio = _calculateCollateralRatio(vault.collateralShares, actualDebt);
        return ratio < LIQUIDATION_RATIO;
    }
    
    function calculateLiquidation(address lpVault, uint256 debtToClear) external view returns (uint256 collateralSeized, uint256 actualDebtCleared) {
        Vault memory vault = vaults[lpVault];
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        
        if (debtToClear > actualDebt) {
            debtToClear = actualDebt;
        }
        
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        uint256 xmrPrice = _getXmrPriceFromStorage();
        
        uint256 debtValueUsd = (debtToClear * xmrPrice) / PRICE_DECIMALS;
        uint256 collateralValueUsd = (debtValueUsd * LIQUIDATION_BONUS) / RATIO_PRECISION;
        collateralSeized = (collateralValueUsd * SDAI_DECIMALS) / collateralPrice;
        
        if (collateralSeized > vault.collateralShares) {
            collateralSeized = vault.collateralShares;
            uint256 actualCollateralValueUsd = (collateralSeized * collateralPrice) / SDAI_DECIMALS;
            actualDebtCleared = (actualCollateralValueUsd * RATIO_PRECISION * WSXMR_DECIMALS) / (LIQUIDATION_BONUS * xmrPrice);
            
            if (actualDebtCleared > actualDebt) {
                actualDebtCleared = actualDebt;
            }
        } else {
            actualDebtCleared = debtToClear;
        }
    }
    
    function getLiquidatableVaults(uint256 startIndex, uint256 count) external view returns (address[] memory vaults_, uint256[] memory debts) {
        uint256 totalVaults = vaultList.length;
        uint256 maxResults = count;
        if (startIndex + maxResults > totalVaults) {
            maxResults = totalVaults - startIndex;
        }
        
        vaults_ = new address[](maxResults);
        debts = new uint256[](maxResults);
        uint256 found = 0;
        
        for (uint256 i = startIndex; i < startIndex + maxResults && i < totalVaults; i++) {
            address vaultAddr = vaultList[i];
            Vault memory vault = vaults[vaultAddr];
            uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
            
            if (vault.active && actualDebt > 0) {
                uint256 ratio = _calculateCollateralRatio(vault.collateralShares, actualDebt);
                if (ratio < LIQUIDATION_RATIO) {
                    vaults_[found] = vaultAddr;
                    debts[found] = actualDebt;
                    found++;
                }
            }
        }
    }
    
    
    function _calculateCollateralRatio(uint256 collateralShares, uint256 debtAmount) internal view returns (uint256) {
        uint256 xmrPrice = IOracleFacet(address(this)).getXmrPrice();
        uint256 collateralPrice = IOracleFacet(address(this)).getCollateralPrice();
        return CollateralLogic.calculateRatioFromShares(
            collateralShares,
            debtAmount,
            GnosisAddresses.SDAI,
            collateralPrice,
            xmrPrice
        );
    }
    
    // ========== DIAMOND INTROSPECTION ==========
    
    /// @notice Returns all function selectors implemented by this facet
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](4);
        sels[0] = this.liquidate.selector;
        sels[1] = this.isVaultLiquidatable.selector;
        sels[2] = this.calculateLiquidation.selector;
        sels[3] = this.getLiquidatableVaults.selector;
        return sels;
    }
}
