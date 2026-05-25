// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

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
        
        uint256 spotPrice = IOracleFacet(oracleFacet).getXmrPrice();
        uint256 emaPrice = IOracleFacet(oracleFacet).getXmrEmaPrice();
        
        if (spotPrice > (emaPrice * EMA_TRIGGER_THRESHOLD) / 100) revert XMRNotDipped();
        
        uint256 sDAIToSpend = (yieldWarChest * BUY_CHUNK_PERCENT) / 100;
        if (sDAIToSpend == 0) revert WarChestEmpty();
        
        yieldWarChest -= sDAIToSpend;
        lastBuyTimestamp = block.timestamp;
        
        uint256 daiAmount = ISavingsDAI(GnosisAddresses.SDAI).redeem(sDAIToSpend, address(this), address(this));
        
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
        
        uint256 keeperReward = (sDAIToSpend * 200) / 10000;
        if (keeperReward > 0) {
            pendingReturns[msg.sender][GnosisAddresses.SDAI] += keeperReward;
            globalPendingSDAI += keeperReward;
            emit ReturnQueued(msg.sender, GnosisAddresses.SDAI, keeperReward);
        }
        
        IwsXmrHub(address(this)).burnTokens(address(this), wsxmrBought);
        
        uint256 netDebtReduction = wsxmrBought > globalPendingBurnDebt ? wsxmrBought - globalPendingBurnDebt : 0;
        
        if (netDebtReduction > 0 && globalTotalDebt > 0) {
            uint256 reductionRatio = (netDebtReduction * 1e18) / globalTotalDebt;
            uint256 newIndex = (globalDebtIndex * (1e18 - reductionRatio)) / 1e18;
            // Prevent index from going to zero, but allow natural decrease
            // If index would drop below 1e6, it means >99.9999% debt reduction - cap at 1e6
            globalDebtIndex = newIndex > 1e6 ? newIndex : 1e6;
        }
        
        emit BuyAndBurnExecuted(sDAIToSpend, wsxmrBought, keeperReward, globalDebtIndex);
    }
    
    function syncVaultYield(address lpVault) external {
        Vault storage vault = vaults[lpVault];
        if (vault.collateralShares == 0) return;
        
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        uint256 xmrPrice = IOracleFacet(oracleFacet).getXmrPrice();
        uint256 collateralPrice = IOracleFacet(oracleFacet).getCollateralPrice();
        
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
        
        uint256 spotPrice = IOracleFacet(oracleFacet).getXmrPrice();
        uint256 emaPrice = IOracleFacet(oracleFacet).getXmrEmaPrice();
        
        if (spotPrice > (emaPrice * EMA_TRIGGER_THRESHOLD) / 100) {
            return (false, "XMR price not dipped");
        }
        
        return (true, "");
    }
    
    function getVaultExtractableYield(address lpVault) external view returns (uint256) {
        Vault storage vault = vaults[lpVault];
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        uint256 pendingDebt = vault.pendingDebt;
        uint256 xmrPrice = IOracleFacet(oracleFacet).getXmrPrice();
        uint256 collateralPrice = IOracleFacet(oracleFacet).getCollateralPrice();
        
        return YieldLogic.calculateExtractableYield(
            vault.collateralShares,
            vault.lockedCollateral,
            lpPrincipalShares[lpVault],
            actualDebt,
            pendingDebt,
            xmrPrice,
            collateralPrice
        );
    }
    
    function isPoolFeeTierAllowed(uint24 tier) external view returns (bool) {
        return allowedPoolFeeTiers[tier];
    }
    
}
