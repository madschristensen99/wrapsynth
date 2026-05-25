// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IVaultFacet} from "../interfaces/facets/IVaultFacet.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";
import {ISavingsDAI} from "../interfaces/external/ISavingsDAI.sol";
import {GnosisAddresses} from "../GnosisAddresses.sol";
import {CollateralLogic} from "../libraries/CollateralLogic.sol";
import {YieldLogic} from "../libraries/YieldLogic.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/**
 * @title VaultFacet
 * @notice Handles vault management operations for the wsXMR system
 * @dev Manages LP vaults, collateral deposits/withdrawals, and configuration
 */
contract VaultFacet is wsXmrStorage, IVaultFacet {
    using SafeERC20 for IERC20;
    
    // ========== CONSTRUCTOR ==========
    
    constructor(address _wsxmrToken, address _verifierProxy) 
        wsXmrStorage(_wsxmrToken, _verifierProxy) 
    {}
    
    // ========== MODIFIERS ==========
    
    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "ReentrancyGuard");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    // ========== VAULT LIFECYCLE ==========
    
    /// @inheritdoc IVaultFacet
    function createVault() external {
        if (vaults[msg.sender].active) revert VaultAlreadyExists();
        if (vaultList.length >= MAX_VAULT_COUNT) revert MaxVaultsReached();
        
        vaults[msg.sender] = Vault({
            lpAddress: msg.sender,
            collateralShares: 0,
            lockedCollateral: 0,
            normalizedDebt: 0,
            pendingDebt: 0,
            maxMintBps: 0,
            mintGriefingDeposit: 0,
            mintFeeBps: 0,
            burnRewardBps: 0,
            liquidationNonce: 0,
            mintNonce: 0,
            minBurnAmount: 0,
            active: true
        });
        
        vaultList.push(msg.sender);
        emit VaultCreated(msg.sender);
    }
    
    /// @inheritdoc IVaultFacet
    function deactivateVault() external {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        vaults[msg.sender].active = false;
    }
    
    // ========== COLLATERAL MANAGEMENT ==========
    
    /// @inheritdoc IVaultFacet
    function depositCollateral(uint256 amount) external nonReentrant {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (amount == 0) revert ZeroAmount();
        
        Vault storage vault = vaults[msg.sender];
        
        // Transfer xDAI from user
        IERC20(GnosisAddresses.XDAI).safeTransferFrom(msg.sender, address(this), amount);
        
        // Approve and deposit to sDAI
        IERC20(GnosisAddresses.XDAI).forceApprove(GnosisAddresses.SDAI, amount);
        uint256 sDAIShares = ISavingsDAI(GnosisAddresses.SDAI).deposit(amount, address(this));
        
        _syncVaultYield(msg.sender);
        
        vault.collateralShares += sDAIShares;
        lpPrincipalDeposits[msg.sender] += amount;
        globalLpPrincipal += amount;
        lpPrincipalShares[msg.sender] += sDAIShares;
        globalLpPrincipalShares += sDAIShares;
        
        emit CollateralDeposited(msg.sender, amount, sDAIShares);
    }
    
    /// @inheritdoc IVaultFacet
    function depositShares(uint256 shares) external nonReentrant {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (shares == 0) revert ZeroAmount();
        
        Vault storage vault = vaults[msg.sender];
        
        // Transfer sDAI shares directly from user
        IERC20(GnosisAddresses.SDAI).safeTransferFrom(msg.sender, address(this), shares);
        
        // Convert shares to underlying DAI value for principal tracking
        uint256 daiValue = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(shares);
        
        _syncVaultYield(msg.sender);
        
        vault.collateralShares += shares;
        lpPrincipalDeposits[msg.sender] += daiValue;
        globalLpPrincipal += daiValue;
        lpPrincipalShares[msg.sender] += shares;
        globalLpPrincipalShares += shares;
        
        emit CollateralDeposited(msg.sender, daiValue, shares);
    }
    
    /// @inheritdoc IVaultFacet
    function withdrawCollateral(uint256 shares) external nonReentrant {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (shares == 0) revert ZeroAmount();
        
        Vault storage vault = vaults[msg.sender];
        
        // Sync yield FIRST
        _syncVaultYield(msg.sender);
        
        uint256 collateralAfterSync = vault.collateralShares;
        
        // Cannot withdraw locked collateral
        uint256 availableCollateral = vault.collateralShares - vault.lockedCollateral;
        if (availableCollateral < shares) revert InsufficientCollateral();
        
        // Check health ratio
        uint256 newCollateralAmount = vault.collateralShares - shares;
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        uint256 totalObligations = actualDebt + vault.pendingDebt;
        
        if (totalObligations > 0) {
            uint256 availableForDebt = newCollateralAmount > vault.lockedCollateral 
                ? newCollateralAmount - vault.lockedCollateral 
                : 0;
            uint256 ratio = _calculateCollateralRatio(availableForDebt, totalObligations);
            if (ratio < COLLATERAL_RATIO) revert InsufficientCollateral();
        }
        
        vault.collateralShares -= shares;
        
        uint256 daiReceived = ISavingsDAI(GnosisAddresses.SDAI).redeem(shares, msg.sender, address(this));
        
        // Deduct principal proportionally
        uint256 withdrawalProportion = (shares * 1e18) / collateralAfterSync;
        uint256 principalToDeduct = (lpPrincipalDeposits[msg.sender] * withdrawalProportion) / 1e18;
        if (principalToDeduct > lpPrincipalDeposits[msg.sender]) {
            principalToDeduct = lpPrincipalDeposits[msg.sender];
        }
        lpPrincipalDeposits[msg.sender] -= principalToDeduct;
        if (principalToDeduct > globalLpPrincipal) {
            principalToDeduct = globalLpPrincipal;
        }
        globalLpPrincipal -= principalToDeduct;
        
        uint256 sharesToDeduct = (lpPrincipalShares[msg.sender] * withdrawalProportion) / 1e18;
        if (sharesToDeduct > lpPrincipalShares[msg.sender]) {
            sharesToDeduct = lpPrincipalShares[msg.sender];
        }
        lpPrincipalShares[msg.sender] -= sharesToDeduct;
        if (sharesToDeduct > globalLpPrincipalShares) {
            sharesToDeduct = globalLpPrincipalShares;
        }
        globalLpPrincipalShares -= sharesToDeduct;
        
        emit CollateralWithdrawn(msg.sender, daiReceived, shares);
    }
    
    // ========== VAULT CONFIGURATION ==========
    
    /// @inheritdoc IVaultFacet
    function setMintGriefingDeposit(uint256 deposit) external {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        vaults[msg.sender].mintGriefingDeposit = deposit;
        emit MintGriefingDepositUpdated(msg.sender, deposit);
    }
    
    /// @inheritdoc IVaultFacet
    function setVaultMarketMetrics(uint16 mintFeeBps, uint16 burnRewardBps) external {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (mintFeeBps > MAX_MARGIN_BPS || burnRewardBps > MAX_MARGIN_BPS) revert ExceedsMaxMargin();
        
        vaults[msg.sender].mintFeeBps = mintFeeBps;
        vaults[msg.sender].burnRewardBps = burnRewardBps;
        emit VaultMarketMetricsUpdated(msg.sender, mintFeeBps, burnRewardBps);
    }
    
    /// @inheritdoc IVaultFacet
    function setMaxMintBps(uint16 maxMintBps) external {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (maxMintBps > BPS_DENOMINATOR) revert InvalidValue();
        vaults[msg.sender].maxMintBps = maxMintBps;
        emit MaxMintBpsUpdated(msg.sender, maxMintBps);
    }
    
    /// @inheritdoc IVaultFacet
    function setMinBurnAmount(uint256 minAmount) external {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        vaults[msg.sender].minBurnAmount = minAmount;
        emit MinBurnAmountUpdated(msg.sender, minAmount);
    }
    
    // ========== PENDING RETURNS ==========
    
    /// @inheritdoc IVaultFacet
    function withdrawReturns(address token) external nonReentrant {
        uint256 amount = pendingReturns[msg.sender][token];
        if (amount == 0) revert ZeroAmount();
        
        pendingReturns[msg.sender][token] = 0;
        
        if (token == GnosisAddresses.SDAI) {
            globalPendingSDAI -= amount;
        }
        
        if (token == address(0)) {
            (bool success, ) = payable(msg.sender).call{value: amount}("");
            if (!success) revert ETHTransferFailed();
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }
        
        emit ReturnsWithdrawn(msg.sender, token, amount);
    }
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @inheritdoc IVaultFacet
    function getVault(address lpAddress) external view returns (Vault memory) {
        return vaults[lpAddress];
    }
    
    /// @inheritdoc IVaultFacet
    function getVaultHealth(address lpAddress) external view returns (uint256 ratio) {
        Vault memory vault = vaults[lpAddress];
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        return _calculateCollateralRatio(vault.collateralShares, actualDebt);
    }
    
    /// @inheritdoc IVaultFacet
    function getVaultDebt(address lpAddress) external view returns (uint256) {
        return IOracleFacet(oracleFacet).denormalizeDebt(vaults[lpAddress].normalizedDebt);
    }
    
    /// @inheritdoc IVaultFacet
    function getVaultCount() external view returns (uint256) {
        return vaultList.length;
    }
    
    /// @inheritdoc IVaultFacet
    function getVaultAtIndex(uint256 index) external view returns (address) {
        return vaultList[index];
    }
    
    /// @inheritdoc IVaultFacet
    function getPendingReturns(address user, address token) external view returns (uint256) {
        return pendingReturns[user][token];
    }
    
    /// @inheritdoc IVaultFacet
    function hasActiveVault(address lpAddress) external view returns (bool) {
        return vaults[lpAddress].active;
    }
    
    /// @inheritdoc IVaultFacet
    function calculateCollateralRatio(
        uint256 collateralAmount,
        uint256 debtAmount
    ) external view returns (uint256) {
        return _calculateCollateralRatio(collateralAmount, debtAmount);
    }
    
    // ========== INTERNAL FUNCTIONS ==========
    
    function _syncVaultYield(address lpAddress) internal {
        Vault storage vault = vaults[lpAddress];
        if (vault.collateralShares == 0) return;
        
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        
        // Skip yield calculation if no debt - no point checking prices
        if (actualDebt == 0 && vault.pendingDebt == 0) return;
        
        uint256 xmrPrice = IOracleFacet(oracleFacet).getXmrPrice();
        uint256 collateralPrice = IOracleFacet(oracleFacet).getCollateralPrice();
        
        uint256 yieldShares = YieldLogic.calculateExtractableYield(
            vault.collateralShares,
            vault.lockedCollateral,
            lpPrincipalShares[lpAddress],
            actualDebt,
            vault.pendingDebt,
            xmrPrice,
            collateralPrice
        );
        
        if (yieldShares > 0) {
            vault.collateralShares -= yieldShares;
            yieldWarChest += yieldShares;
        }
    }
    
    function _calculateCollateralRatio(
        uint256 collateralShares,
        uint256 debtAmount
    ) internal view returns (uint256 ratio) {
        uint256 xmrPrice = IOracleFacet(oracleFacet).getXmrPrice();
        uint256 collateralPrice = IOracleFacet(oracleFacet).getCollateralPrice();
        return CollateralLogic.calculateRatioFromShares(
            collateralShares,
            debtAmount,
            GnosisAddresses.SDAI,
            collateralPrice,
            xmrPrice
        );
    }
}
