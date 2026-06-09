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
import {IwsXmrLiquidityRouter} from "../interfaces/router/IwsXmrLiquidityRouter.sol";
import {ISavingsDAI} from "../interfaces/external/ISavingsDAI.sol";
import {IBurnOperations} from "../interfaces/swap/IBurnOperations.sol";

contract LiquidationFacet is wsXmrStorage, ILiquidationFacet {
    using SafeERC20 for IERC20;
    
    error ReentrancyGuard();
    
    event CoLPUnwound(
        uint256 indexed tokenId,
        address indexed vault,
        address indexed user,
        uint256 daiReturned,
        uint256 wsxmrReturned,
        bool liquidationTriggered
    );
    
    event BurnCancelled(bytes32 indexed requestId);
    event BurnSlashed(bytes32 indexed requestId, address indexed user, uint256 collateralSeized);
    
    constructor(address _wsxmrToken, address _verifierProxy) 
        wsXmrStorage(_wsxmrToken, _verifierProxy) 
    {}
    
    /// @dev Par-capped slash settlement for a COMMITTED burn.
    /// User receives min(par, locked) + reward in sDAI; excess locked collateral returns to vault.
    /// @notice Known residual: if XMR appreciates >30% within commit window, user is capped at
    ///         lockedCollateral (under par). This is inherent to fixed-ratio locking and accepted.
    function _settleCommittedBurnSlash(
        BurnRequest storage burnReq,
        Vault storage v,
        uint256 collateralPrice
    ) internal {
        uint256 parValueUsd = (burnReq.wsxmrAmount * burnReq.xmrPriceAtRequest) / WSXMR_DECIMALS;
        uint256 parDaiAmount = (parValueUsd * SDAI_DECIMALS) / collateralPrice;
        uint256 parShares = _daiToShares(parDaiAmount);

        uint256 userBase = parShares < burnReq.lockedCollateral
            ? parShares
            : burnReq.lockedCollateral;
        uint256 userPayout = userBase + burnReq.rewardCollateral;

        v.lockedCollateral -= (burnReq.lockedCollateral + burnReq.rewardCollateral);
        v.collateralShares -= userPayout;
        globalPendingBurnDebt -= burnReq.wsxmrAmount;

        pendingReturns[burnReq.user][GnosisAddresses.SDAI] += userPayout;
        globalPendingSDAI += userPayout;
        emit ReturnQueued(burnReq.user, GnosisAddresses.SDAI, userPayout);

        burnReq.status = BurnStatus.SLASHED;
        emit BurnSlashed(burnReq.requestId, burnReq.user, userPayout);
    }
    
    function liquidate(address lpVault, uint256 debtToClear) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        if (!_vaults[lpVault].active) revert VaultDoesNotExist();
        if (debtToClear == 0) revert ZeroAmount();
        
        Vault storage vault = _vaults[lpVault];
        
        uint256 actualDebt;
        uint256 xmrPrice;
        uint256 collateralPrice;
        
        if (vault.collateralShares > 0) {
            actualDebt = _denormalizeDebt(vault.normalizedDebt);
            xmrPrice = _getXmrPriceFromStorage();
            collateralPrice = _getCollateralPriceFromStorage();
            
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
            }
        } else {
            actualDebt = _denormalizeDebt(vault.normalizedDebt);
        }
        if (actualDebt == 0) revert InsufficientDebt();
        if (debtToClear > actualDebt) {
            debtToClear = actualDebt;
        }
        
        uint256 ratio = _calculateCRWithPositions(lpVault, actualDebt);
        if (ratio >= LIQUIDATION_RATIO) revert VaultHealthy();
        
        // Fetch prices once before burn loop (needed for par-cap slash settlement)
        collateralPrice = _getCollateralPriceFromStorage();
        xmrPrice = _getXmrPriceFromStorage();
        
        // P0-1: Handle in-flight burns inline to prevent dust-burn shield attack
        // Force-cancel REQUESTED/PROPOSED, settle COMMITTED burns before proceeding
        bytes32[] storage vaultBurns = vaultBurnRequests[lpVault];
        for (uint256 i = 0; i < vaultBurns.length; i++) {
            BurnRequest storage burnReq = burnRequests[vaultBurns[i]];
            
            if (burnReq.status == BurnStatus.REQUESTED || burnReq.status == BurnStatus.PROPOSED) {
                // Force-cancel: unwind burn to free collateral for liquidation
                if (burnReq.vaultLiquidationNonce == vault.liquidationNonce) {
                    vault.lockedCollateral -= (burnReq.lockedCollateral + burnReq.rewardCollateral);
                    vault.normalizedDebt += burnReq.normalizedDebtAmount;
                    globalTotalDebt += burnReq.wsxmrAmount;
                }
                globalPendingBurnDebt -= burnReq.wsxmrAmount;
                
                // Re-mint wsXMR to user
                IwsXmrHub(address(this)).mintTokens(burnReq.user, burnReq.wsxmrAmount);
                
                burnReq.status = BurnStatus.CANCELLED;
                emit BurnCancelled(burnReq.requestId);
                
            } else if (burnReq.status == BurnStatus.COMMITTED) {
                // Settle committed burn: par-capped slash (user gets par + reward, excess to vault)
                _settleCommittedBurnSlash(burnReq, vault, collateralPrice);
            }
        }
        
        // Atomic unwind all deployed positions before seizure
        if (_vaultPositions[lpVault].length > 0) {
            _unwindAllVaultPositions(lpVault, xmrPrice);
        }
        
        // Prices already fetched above, reuse for seizure calculation
        
        uint256 debtValueUsd = (debtToClear * xmrPrice) / WSXMR_DECIMALS; // wsXMR has 8 decimals
        uint256 collateralValueUsd = (debtValueUsd * LIQUIDATION_BONUS) / RATIO_PRECISION;
        uint256 collateralToSeizeDai = (collateralValueUsd * SDAI_DECIMALS) / collateralPrice;
        uint256 collateralToSeize = _daiToShares(collateralToSeizeDai);
        
        if (collateralToSeize > vault.collateralShares) {
            collateralToSeize = vault.collateralShares;
            uint256 actualDaiAmount = _sharesToDai(collateralToSeize);
            uint256 actualCollateralValueUsd = (actualDaiAmount * collateralPrice) / SDAI_DECIMALS;
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
        
        // H2: Write off bad debt from global totals. Do NOT scale globalDebtIndex
        // (that would incorrectly shrink healthy vaults' denormalized debts).
        if (vault.normalizedDebt > 0 && vault.collateralShares == 0) {
            uint256 badDebt = _denormalizeDebt(vault.normalizedDebt);
            if (badDebt > 0) {
                vault.normalizedDebt = 0;
                if (badDebt > globalTotalDebt) {
                    globalTotalDebt = 0;
                } else {
                    globalTotalDebt -= badDebt;
                }
                globalBadDebt += badDebt;
                emit BadDebtWrittenOff(lpVault, badDebt);
                emit BadDebtSocialized(lpVault, badDebt, globalDebtIndex);
            }
        }
        
        vault.liquidationNonce++;
        vault.mintNonce++;
        
        IwsXmrHub(address(this)).burnTokens(msg.sender, debtToClear);
        IERC20(GnosisAddresses.SDAI).safeTransfer(msg.sender, collateralToSeize);
        
        emit VaultLiquidated(lpVault, msg.sender, debtToClear, collateralToSeize);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /// @notice P1-1: Backstop an underwater vault by assuming its debt and collateral
    /// @dev New LP takes over old vault's position at a discount (no wsXMR sourcing needed)
    /// @param oldVault Address of underwater vault to backstop
    function backstopVault(address oldVault) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        if (!_vaults[oldVault].active) revert VaultDoesNotExist();
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (oldVault == msg.sender) revert InvalidValue();
        
        Vault storage oldV = _vaults[oldVault];
        Vault storage newV = _vaults[msg.sender];
        
        // Extract yield from old vault
        uint256 oldDebt;
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        
        if (oldV.collateralShares > 0) {
            oldDebt = _denormalizeDebt(oldV.normalizedDebt);
            uint256 yieldShares = YieldLogic.calculateExtractableYield(
                oldV.collateralShares,
                oldV.lockedCollateral,
                lpPrincipalDeposits[oldVault],
                oldDebt,
                oldV.pendingDebt,
                xmrPrice,
                collateralPrice
            );
            if (yieldShares > 0) {
                oldV.collateralShares -= yieldShares;
                yieldWarChest += yieldShares;
            }
        } else {
            oldDebt = _denormalizeDebt(oldV.normalizedDebt);
        }
        
        // Extract yield from new vault
        if (newV.collateralShares > 0) {
            uint256 newDebtBefore = _denormalizeDebt(newV.normalizedDebt);
            uint256 yieldShares = YieldLogic.calculateExtractableYield(
                newV.collateralShares,
                newV.lockedCollateral,
                lpPrincipalDeposits[msg.sender],
                newDebtBefore,
                newV.pendingDebt,
                xmrPrice,
                collateralPrice
            );
            if (yieldShares > 0) {
                newV.collateralShares -= yieldShares;
                yieldWarChest += yieldShares;
            }
        }
        if (oldDebt == 0) revert InsufficientDebt();
        
        // Check old vault is underwater
        uint256 ratio = _calculateCRWithPositions(oldVault, oldDebt);
        if (ratio >= LIQUIDATION_RATIO) revert VaultHealthy();
        
        // Handle in-flight burns on old vault (same as liquidate)
        bytes32[] storage vaultBurns = vaultBurnRequests[oldVault];
        for (uint256 i = 0; i < vaultBurns.length; i++) {
            BurnRequest storage burnReq = burnRequests[vaultBurns[i]];
            
            if (burnReq.status == BurnStatus.REQUESTED || burnReq.status == BurnStatus.PROPOSED) {
                if (burnReq.vaultLiquidationNonce == oldV.liquidationNonce) {
                    oldV.lockedCollateral -= (burnReq.lockedCollateral + burnReq.rewardCollateral);
                    oldV.normalizedDebt += burnReq.normalizedDebtAmount;
                    globalTotalDebt += burnReq.wsxmrAmount;
                }
                globalPendingBurnDebt -= burnReq.wsxmrAmount;
                IwsXmrHub(address(this)).mintTokens(burnReq.user, burnReq.wsxmrAmount);
                
                burnReq.status = BurnStatus.CANCELLED;
                emit BurnCancelled(burnReq.requestId);
                
            } else if (burnReq.status == BurnStatus.COMMITTED) {
                // Settle committed burn: par-capped slash (user gets par + reward, excess to vault)
                _settleCommittedBurnSlash(burnReq, oldV, collateralPrice);
            }
        }
        
        // Unwind old vault positions
        if (_vaultPositions[oldVault].length > 0) {
            _unwindAllVaultPositions(oldVault, xmrPrice);
        }
        
        // Recalculate debt after burn settlements
        oldDebt = _denormalizeDebt(oldV.normalizedDebt);
        
        // C2: Capture absorbed collateral to prevent yield-siphon
        uint256 absorbedCollateral = oldV.collateralShares;
        
        // Transfer state: new vault assumes old vault's debt and collateral
        // The discount is implicit - new LP gets collateral worth less than debt at market
        newV.normalizedDebt += oldV.normalizedDebt;
        newV.collateralShares += absorbedCollateral;
        
        // C2: Track absorbed collateral as principal to prevent yield extraction
        lpPrincipalShares[msg.sender] += absorbedCollateral;
        lpPrincipalShares[oldVault] = 0;
        
        // Zero out old vault
        oldV.normalizedDebt = 0;
        oldV.collateralShares = 0;
        oldV.liquidationNonce++;
        oldV.mintNonce++;
        
        // Verify new vault is healthy after takeover
        uint256 newDebt = _denormalizeDebt(newV.normalizedDebt);
        uint256 newRatio = _calculateCRWithPositions(msg.sender, newDebt);
        if (newRatio < COLLATERAL_RATIO) revert InsufficientCollateral();
        
        emit VaultBackstopped(oldVault, msg.sender, oldDebt, absorbedCollateral);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    function isVaultLiquidatable(address lpVault) external view returns (bool) {
        Vault memory vault = _vaults[lpVault];
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        if (!vault.active || actualDebt == 0) return false;
        
        uint256 ratio = _calculateCRWithPositions(lpVault, actualDebt);
        return ratio < LIQUIDATION_RATIO;
    }
    
    function calculateLiquidation(address lpVault, uint256 debtToClear) external view returns (uint256 collateralSeized, uint256 actualDebtCleared) {
        Vault memory vault = _vaults[lpVault];
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        
        if (debtToClear > actualDebt) {
            debtToClear = actualDebt;
        }
        
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        uint256 xmrPrice = _getXmrPriceFromStorage();
        
        uint256 debtValueUsd = (debtToClear * xmrPrice) / WSXMR_DECIMALS; // wsXMR has 8 decimals
        uint256 collateralValueUsd = (debtValueUsd * LIQUIDATION_BONUS) / RATIO_PRECISION;
        uint256 collateralToSeizeDai = (collateralValueUsd * SDAI_DECIMALS) / collateralPrice;
        collateralSeized = _daiToShares(collateralToSeizeDai);
        
        if (collateralSeized > vault.collateralShares) {
            collateralSeized = vault.collateralShares;
            uint256 actualDaiAmount = _sharesToDai(collateralSeized);
            uint256 actualCollateralValueUsd = (actualDaiAmount * collateralPrice) / SDAI_DECIMALS;
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
            Vault memory vault = _vaults[vaultAddr];
            uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
            
            if (vault.active && actualDebt > 0) {
                uint256 ratio = _calculateCRWithPositions(vaultAddr, actualDebt);
                if (ratio < LIQUIDATION_RATIO) {
                    vaults_[found] = vaultAddr;
                    debts[found] = actualDebt;
                    found++;
                }
            }
        }
    }

    function _calculateCRWithPositions(address vaultAddr, uint256 debtAmount)
        internal view returns (uint256)
    {
        Vault memory vault = _vaults[vaultAddr];
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        
        if (vault.deployedSDAIShares == 0) {
            return CollateralLogic.calculateRatioFromShares(
                vault.collateralShares, debtAmount, GnosisAddresses.SDAI, collateralPrice, xmrPrice
            );
        }
        
        (uint256 positionDAI, uint256 positionWsxmr) = _getVaultPositionTotalsAtOracle(vaultAddr, xmrPrice);
        return CollateralLogic.calculateVaultCRWithDeployment(
            vault.collateralShares,
            positionDAI,
            positionWsxmr,
            debtAmount,
            GnosisAddresses.SDAI,
            collateralPrice,
            xmrPrice
        );
    }
    
    function _getVaultPositionTotalsAtOracle(address vaultAddr, uint256 xmrPrice)
        internal view
        returns (uint256 totalDAI, uint256 totalWsxmr)
    {
        uint256[] memory positions = _vaultPositions[vaultAddr];
        for (uint256 i = 0; i < positions.length; i++) {
            (uint256 dai, uint256 wsxmr) = IwsXmrLiquidityRouter(liquidityRouter)
                .getPositionAmountsAtPrice(positions[i], xmrPrice);
            totalDAI += dai;
            totalWsxmr += wsxmr;
        }
    }
    
    function _unwindAllVaultPositions(address lpVault, uint256 xmrPrice) internal {
        Vault storage vault = _vaults[lpVault];
        
        while (_vaultPositions[lpVault].length > 0) {
            uint256 idx = _vaultPositions[lpVault].length - 1;
            uint256 tokenId = _vaultPositions[lpVault][idx];
            PositionMetadata memory meta = _positionMetadata[tokenId];
            
            (uint256 daiOut, uint256 wsxmrOut) = IwsXmrLiquidityRouter(liquidityRouter)
                .drainPosition(tokenId, uint16(DEFAULT_COLP_SLIPPAGE_BPS), xmrPrice);
            
            if (daiOut > 0) {
                vault.collateralShares += daiOut;
            }
            if (wsxmrOut > 0) {
                pendingReturns[meta.user][wsxmrToken] += wsxmrOut;
            }
            
            if (vault.deployedSDAIShares >= meta.sDAISharesOriginal) {
                vault.deployedSDAIShares -= meta.sDAISharesOriginal;
            } else {
                vault.deployedSDAIShares = 0;
            }
            
            _vaultPositions[lpVault].pop();
            
            uint256[] storage upos = _userPositions[meta.user];
            for (uint256 i = 0; i < upos.length; i++) {
                if (upos[i] == tokenId) {
                    upos[i] = upos[upos.length - 1];
                    upos.pop();
                    break;
                }
            }
            
            delete _positionMetadata[tokenId];
            
            emit CoLPUnwound(tokenId, lpVault, meta.user, daiOut, wsxmrOut, true);
        }
    }
    
    function _daiToShares(uint256 daiAmount) internal view returns (uint256) {
        (bool success, bytes memory data) = GnosisAddresses.SDAI.staticcall(
            abi.encodeWithSignature("convertToShares(uint256)", daiAmount)
        );
        require(success && data.length >= 32, "convertToShares failed");
        return abi.decode(data, (uint256));
    }
    
    function _sharesToDai(uint256 shares) internal view returns (uint256) {
        (bool success, bytes memory data) = GnosisAddresses.SDAI.staticcall(
            abi.encodeWithSignature("convertToAssets(uint256)", shares)
        );
        require(success && data.length >= 32, "convertToAssets failed");
        return abi.decode(data, (uint256));
    }
    
    // ========== DIAMOND INTROSPECTION ==========
    
    /// @notice Returns all function selectors implemented by this facet
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](5);
        sels[0] = this.liquidate.selector;
        sels[1] = this.backstopVault.selector;
        sels[2] = this.isVaultLiquidatable.selector;
        sels[3] = this.calculateLiquidation.selector;
        sels[4] = this.getLiquidatableVaults.selector;
        return sels;
    }
}
