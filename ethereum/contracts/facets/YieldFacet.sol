// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IYieldFacet} from "../interfaces/facets/IYieldFacet.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";
import {IwsXmrHub} from "../interfaces/core/IwsXmrHub.sol";
import {ISwapRouter} from "../interfaces/external/ISwapRouter.sol";
import {ISavingsDAI} from "../interfaces/external/ISavingsDAI.sol";
import {YieldLogic} from "../libraries/YieldLogic.sol";
import {GnosisAddresses} from "../GnosisAddresses.sol";

contract YieldFacet is wsXmrStorage, IYieldFacet {
    using SafeERC20 for IERC20;
    
    constructor(address _wsxmrToken, address _verifierProxy) 
        wsXmrStorage(_wsxmrToken, _verifierProxy) 
    {}
    
    function triggerBuyAndBurn(uint24 poolFeeTier) external {
        if (!allowedPoolFeeTiers[poolFeeTier]) revert InvalidPoolFeeTier();
        if (block.timestamp < lastBuyTimestamp + COOLDOWN_PERIOD) revert CooldownActive();
        if (yieldWarChest == 0) revert WarChestEmpty();
        
        uint256 spotPrice = _getXmrPriceFromStorage();
        uint256 emaPrice = IOracleFacet(address(this)).getXmrEmaPrice();
        
        if (spotPrice > (emaPrice * EMA_TRIGGER_THRESHOLD) / 100) revert XMRNotDipped();
        
        uint256 sDAIToSpend = (yieldWarChest * BUY_CHUNK_PERCENT) / 100;
        if (sDAIToSpend == 0) revert WarChestEmpty();

        // L1: Carve keeper reward out before redeeming so it stays backed
        uint256 keeperReward = (sDAIToSpend * 200) / 10000;
        uint256 sDAIForSwap = sDAIToSpend - keeperReward;

        yieldWarChest -= sDAIToSpend;
        lastBuyTimestamp = block.timestamp;

        uint256 daiAmount = ISavingsDAI(GnosisAddresses.SDAI).redeem(sDAIForSwap, address(this), address(this));

        IERC20(GnosisAddresses.XDAI).forceApprove(GnosisAddresses.UNISWAP_V3_ROUTER, daiAmount);

        uint256 minWsxmr = (daiAmount * PRICE_PRECISION * (10000 - MEV_SLIPPAGE_BPS)) / (spotPrice * 10000);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: GnosisAddresses.XDAI,
            tokenOut: wsxmrToken,
            fee: poolFeeTier,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: daiAmount,
            amountOutMinimum: minWsxmr,
            sqrtPriceLimitX96: 0
        });

        uint256 wsxmrBought = ISwapRouter(GnosisAddresses.UNISWAP_V3_ROUTER).exactInputSingle(params);

        // Queue keeper reward in sDAI shares (still backed, never redeemed to xDAI)
        if (keeperReward > 0) {
            pendingReturns[msg.sender][GnosisAddresses.SDAI] += keeperReward;
            globalPendingSDAI += keeperReward;
            emit ReturnQueued(msg.sender, GnosisAddresses.SDAI, keeperReward);
        }
        
        IwsXmrHub(address(this)).burnTokens(address(this), wsxmrBought);
        
        uint256 netDebtReduction = wsxmrBought > globalPendingBurnDebt ? wsxmrBought - globalPendingBurnDebt : 0;
        
        if (netDebtReduction > 0 && globalTotalDebt > 0) {
            // B1: Always rescale individual vault debts when reducing the debt index.
            // Proportional index reduction without rescaling vault normalized debts
            // causes precision loss (small debts round to zero) and breaks the invariant
            // that actualDebt = normalizedDebt * index / 1e18.
            _migrateDebtIndex();
        }
        
        emit BuyAndBurnExecuted(sDAIToSpend, wsxmrBought, keeperReward, globalDebtIndex);
    }
    
    /// @notice Migrate debt index when it drops too low to prevent precision loss
    /// @dev Rescales all vault normalized debts and resets index to 1e18
    /// @dev WARNING: Expensive operation - ~30M gas for MAX_VAULT_COUNT _vaults
    function _migrateDebtIndex() private {
        uint256 oldIndex = globalDebtIndex;
        if (oldIndex >= 1e18) return; // Nothing to do
        
        // Preserve invariant: actualDebt = normalizedDebt * index / 1e18
        // After migration: actualDebt = newNormalizedDebt * 1e18 / 1e18
        // Therefore: newNormalizedDebt = normalizedDebt * oldIndex / 1e18
        for (uint256 i = 0; i < vaultList.length; i++) {
            Vault storage vault = _vaults[vaultList[i]];
            
            if (vault.normalizedDebt > 0) {
                vault.normalizedDebt = (vault.normalizedDebt * oldIndex) / 1e18;
            }
        }
        
        // Reset index to 1e18
        globalDebtIndex = 1e18;
        
        emit DebtIndexMigrated(oldIndex, 1e18, vaultList.length);
    }
    
    function syncVaultYield(address lpVault) external {
        Vault storage vault = _vaults[lpVault];
        if (vault.collateralShares == 0) return;
        
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        
        uint256 yieldShares = YieldLogic.calculateExtractableYield(
            vault.collateralShares,
            vault.lockedCollateral,
            lpPrincipalDeposits[lpVault],
            actualDebt,
            vault.pendingDebt,
            xmrPrice,
            collateralPrice
        );
        
        if (yieldShares > 0) {
            vault.collateralShares -= yieldShares;
            yieldWarChest += yieldShares;
            
            emit YieldHarvested(lpVault, yieldShares);
        }
    }
    
    function getYieldWarChest() external view returns (uint256) {
        return yieldWarChest;
    }
    
    function getLastBuyTimestamp() external view returns (uint256) {
        return lastBuyTimestamp;
    }
    
    function canTriggerBuyAndBurn() external view returns (bool possible, string memory reason) {
        if (block.timestamp < lastBuyTimestamp + COOLDOWN_PERIOD) {
            return (false, "Cooldown active");
        }
        if (yieldWarChest == 0) {
            return (false, "War chest empty");
        }
        
        uint256 spotPrice = _getXmrPriceFromStorage();
        uint256 emaPrice = IOracleFacet(address(this)).getXmrEmaPrice();
        
        if (spotPrice > (emaPrice * EMA_TRIGGER_THRESHOLD) / 100) {
            return (false, "XMR price not dipped");
        }
        
        return (true, "");
    }
    
    function getVaultExtractableYield(address lpVault) external view returns (uint256) {
        Vault storage vault = _vaults[lpVault];
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 pendingDebt = vault.pendingDebt;
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        
        return YieldLogic.calculateExtractableYield(
            vault.collateralShares,
            vault.lockedCollateral,
            lpPrincipalDeposits[lpVault],
            actualDebt,
            pendingDebt,
            xmrPrice,
            collateralPrice
        );
    }
    
    function isPoolFeeTierAllowed(uint24 tier) external view returns (bool) {
        return allowedPoolFeeTiers[tier];
    }
    
    // ========== DIAMOND INTROSPECTION ==========
    
    /// @notice Returns all function selectors implemented by this facet
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](7);
        sels[0] = this.triggerBuyAndBurn.selector;
        sels[1] = this.syncVaultYield.selector;
        sels[2] = this.getYieldWarChest.selector;
        sels[3] = this.getLastBuyTimestamp.selector;
        sels[4] = this.canTriggerBuyAndBurn.selector;
        sels[5] = this.getVaultExtractableYield.selector;
        sels[6] = this.isPoolFeeTierAllowed.selector;
        return sels;
    }
}
