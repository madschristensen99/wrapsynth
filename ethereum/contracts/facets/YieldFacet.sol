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
    
    /// @notice Keeper-triggered buy-and-burn — redeems sDAI yield to buy wsXMR on Uniswap V3 and burns it, reducing global debt
    /// @dev Only executes when XMR spot price is below the EMA threshold (buying the dip). Spends a configurable
    ///      chunk (BUY_CHUNK_PERCENT) of the yield war chest per call. Keeper receives a 2% reward of the sDAI spent.
    ///      Burns the purchased wsXMR and forgives debt: if wsXMR bought >= effective debt, zeroes all vault debts
    ///      and resets globalDebtIndex to 1e18 (full wipe). Otherwise, scales globalDebtIndex down proportionally.
    ///      Subject to cooldown (COOLDOWN_PERIOD) and pending mint lock (totalPendingMints must be 0).
    /// @param poolFeeTier Uniswap V3 pool fee tier to use for the swap (must be in allowedPoolFeeTiers)
    function triggerBuyAndBurn(uint24 poolFeeTier) external {
        if (!allowedPoolFeeTiers[poolFeeTier]) revert InvalidPoolFeeTier();
        if (block.timestamp < lastBuyTimestamp + COOLDOWN_PERIOD) revert CooldownActive();
        if (yieldWarChest == 0) revert WarChestEmpty();
        if (totalPendingMints > 0) revert PendingMintLock();
        if (debtWipeBatchStart != 0) revert WipeInProgress();
        if (migrationBatchStart != 0) revert MigrationInProgress();
        
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

        // Effective debt excludes wsXMR already locked in pending burns (burned by users,
        // not yet settled). Only effective debt is eligible for proportional forgiveness.
        uint256 effectiveDebt = globalTotalDebt > globalPendingBurnDebt
            ? globalTotalDebt - globalPendingBurnDebt
            : 0;

        if (wsxmrBought >= effectiveDebt) {
            // Full wipe: start batch zeroing of vault normalized debts.
            // Index is NOT reset to 1e18 until all vaults are zeroed via continueDebtWipe().
            // Until then, globalDebtIndex stays at its current value so _denormalizeDebt
            // remains correct for un-wiped vaults.
            globalTotalDebt = globalPendingBurnDebt; // only pending burn debt remains
            debtWipeBatchStart = 1; // begin batch from index 0
        } else {
            uint256 remainingDebt = effectiveDebt - wsxmrBought;
            globalTotalDebt -= wsxmrBought;
            globalDebtIndex = (globalDebtIndex * remainingDebt) / effectiveDebt;
        }

        _migrateDebtIndex();
        
        emit BuyAndBurnExecuted(sDAIToSpend, wsxmrBought, keeperReward, globalDebtIndex);
    }
    
    /// @notice Migrate debt index when it drops too low to prevent precision loss
    /// @dev Rescales all vault normalized debts and resets index to 1e18
    /// @dev WARNING: Expensive operation - ~30M gas for MAX_VAULT_COUNT _vaults
    function _migrateDebtIndex() private {
        uint256 oldIndex = globalDebtIndex;
        if (oldIndex >= 1e18) return; // Nothing to do
        
        // Start batch migration — index is NOT reset to 1e18 until all vaults are processed
        // via continueDebtMigration(). Until then, globalDebtIndex stays at oldIndex so
        // _denormalizeDebt remains correct for un-migrated vaults.
        migrationOldIndex = oldIndex;
        migrationBatchStart = 1; // begin batch from index 0
    }
    
    /// @notice Continue an in-progress debt wipe (zeroing vault normalized debts after a full buy-and-burn)
    /// @dev Processes up to batchSize vaults per call. Resets globalDebtIndex to 1e18 when complete.
    /// @param batchSize Maximum number of vaults to process in this call
    function continueDebtWipe(uint256 batchSize) external {
        if (debtWipeBatchStart == 0) revert WipeNotInProgress();
        uint256 start = debtWipeBatchStart - 1; // convert to 0-indexed
        uint256 end = start + batchSize;
        if (end > vaultList.length) end = vaultList.length;
        
        for (uint256 i = start; i < end; i++) {
            _vaults[vaultList[i]].normalizedDebt = 0;
        }
        
        if (end >= vaultList.length) {
            debtWipeBatchStart = 0;
            globalDebtIndex = 1e18;
            emit DebtIndexMigrated(globalDebtIndex, 1e18, vaultList.length);
        } else {
            debtWipeBatchStart = end + 1; // 1-indexed next start
        }
    }
    
    /// @notice Continue an in-progress debt index migration (rescaling vault normalized debts)
    /// @dev Processes up to batchSize vaults per call. Resets globalDebtIndex to 1e18 when complete.
    /// @param batchSize Maximum number of vaults to process in this call
    function continueDebtMigration(uint256 batchSize) external {
        if (migrationBatchStart == 0) revert MigrationNotInProgress();
        uint256 start = migrationBatchStart - 1; // convert to 0-indexed
        uint256 end = start + batchSize;
        if (end > vaultList.length) end = vaultList.length;
        
        uint256 oldIndex = migrationOldIndex;
        for (uint256 i = start; i < end; i++) {
            Vault storage vault = _vaults[vaultList[i]];
            if (vault.normalizedDebt > 0) {
                vault.normalizedDebt = (vault.normalizedDebt * oldIndex) / 1e18;
            }
        }
        
        if (end >= vaultList.length) {
            migrationBatchStart = 0;
            globalDebtIndex = 1e18;
            emit DebtIndexMigrated(oldIndex, 1e18, vaultList.length);
        } else {
            migrationBatchStart = end + 1; // 1-indexed next start
        }
    }
    
    /// @notice Harvest extractable yield from a vault into the yield war chest
    /// @dev Public wrapper for yield extraction. Computes excess sDAI shares above the vault's principal
    ///      and moves them to yieldWarChest. Anyone can call — benefits the protocol by filling the war chest.
    /// @param lpVault The LP vault address to harvest yield from
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
    
    /// @notice Get the current yield war chest balance (sDAI shares available for buy-and-burn)
    /// @return sDAI shares in the war chest
    function getYieldWarChest() external view returns (uint256) {
        return yieldWarChest;
    }
    
    /// @notice Get the timestamp of the last buy-and-burn execution
    /// @return Unix timestamp of last execution
    function getLastBuyTimestamp() external view returns (uint256) {
        return lastBuyTimestamp;
    }
    
    /// @notice Check if buy-and-burn can be triggered now (cooldown elapsed, war chest non-empty, XMR dipped)
    /// @return possible True if triggerBuyAndBurn would succeed
    /// @return reason Human-readable reason if not possible (empty string if possible)
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
    
    /// @notice Calculate the extractable yield for a vault without modifying state
    /// @param lpVault The LP vault address
    /// @return sDAI shares that would be harvested if syncVaultYield were called
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
    
    /// @notice Check if a Uniswap V3 pool fee tier is allowed for buy-and-burn swaps
    /// @param tier Pool fee tier (e.g. 3000 for 0.3%)
    /// @return True if the tier is whitelisted
    function isPoolFeeTierAllowed(uint24 tier) external view returns (bool) {
        return allowedPoolFeeTiers[tier];
    }
    
    // ========== DIAMOND INTROSPECTION ==========
    
    /// @notice Returns all function selectors implemented by this facet
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](9);
        sels[0] = this.triggerBuyAndBurn.selector;
        sels[1] = this.syncVaultYield.selector;
        sels[2] = this.getYieldWarChest.selector;
        sels[3] = this.getLastBuyTimestamp.selector;
        sels[4] = this.canTriggerBuyAndBurn.selector;
        sels[5] = this.getVaultExtractableYield.selector;
        sels[6] = this.isPoolFeeTierAllowed.selector;
        sels[7] = this.continueDebtWipe.selector;
        sels[8] = this.continueDebtMigration.selector;
        return sels;
    }
}
