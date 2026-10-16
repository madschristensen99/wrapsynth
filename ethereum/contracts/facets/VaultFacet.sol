// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IVaultFacet} from "../interfaces/facets/IVaultFacet.sol";
import {ISavingsDAI} from "../interfaces/external/ISavingsDAI.sol";
import {CollateralLogic} from "../libraries/CollateralLogic.sol";
import {YieldLogic} from "../libraries/YieldLogic.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IwsXmrLiquidityRouter} from "../interfaces/router/IwsXmrLiquidityRouter.sol";

/**
 * @title VaultFacet
 * @notice Handles vault management operations for the wsXMR system
 * @dev Manages LP _vaults, collateral deposits/withdrawals, and configuration
 */
contract VaultFacet is wsXmrStorage, IVaultFacet {
    using SafeERC20 for IERC20;
    
    // ========== ERRORS ==========
    
    error InvalidConfig();
    
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
        if (_vaults[msg.sender].lpAddress != address(0)) revert VaultAlreadyExists();

        if (activeVaultCount < MAX_VAULT_COUNT) {
            // Normal path: cap not reached, just add
            _createVaultInternal(msg.sender);
        } else {
            // Cap reached: try to evict a dormant vault
            address evictable = _findEvictableVault();
            if (evictable == address(0)) revert NoEvictableVaultFound();
            _evictVault(evictable);
            _createVaultInternal(msg.sender);
            emit VaultEvicted(evictable, msg.sender);
        }
    }

    function _createVaultInternal(address lp) internal {
        _vaults[lp] = Vault({
            lpAddress: lp,
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
            active: true,
            deployedSDAIShares: 0,
            maxCoLPRangeBps: uint16(DEFAULT_COLP_RANGE_BPS),
            mintTimeoutBlocks: DEFAULT_MINT_TIMEOUT_BLOCKS,
            burnTimeoutBlocks: DEFAULT_BURN_TIMEOUT_BLOCKS,
            pendingMintCount: 0
        });

        vaultListIndex[lp] = vaultList.length;
        vaultList.push(lp);
        activeVaultCount++;
        emit VaultCreated(lp);
    }
    
    /// @inheritdoc IVaultFacet
    function deactivateVault() external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        Vault storage vault = _vaults[msg.sender];
        if (vault.normalizedDebt > 0) revert VaultHasDebt();
        if (vault.collateralShares > 0) revert VaultHasCollateral();
        if (vault.lockedCollateral > 0) revert VaultHasLockedCollateral();
        if (_vaultPositions[msg.sender].length > 0) revert VaultHasPositions();
        vault.active = false;
        _removeFromVaultList(msg.sender);
        activeVaultCount--;
    }
    
    // ========== COLLATERAL MANAGEMENT ==========
    
    /// @inheritdoc IVaultFacet
    function depositCollateral(uint256 amount) external nonReentrant {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (amount == 0) revert ZeroAmount();
        
        Vault storage vault = _vaults[msg.sender];
        _tryRefreshOracle();
        
        // Transfer underlying (USDe) from user
        IERC20(underlyingToken).safeTransferFrom(msg.sender, address(this), amount);
        
        // Approve and deposit to the collateral adapter (StataUSDe)
        IERC20(underlyingToken).forceApprove(collateralToken, amount);
        uint256 sDAIShares = ISavingsDAI(collateralToken).deposit(amount, address(this));
        
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
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (shares == 0) revert ZeroAmount();
        
        Vault storage vault = _vaults[msg.sender];
        
        // Transfer collateral shares directly from user
        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), shares);
        
        // Convert shares to underlying value for principal tracking
        uint256 daiValue = ISavingsDAI(collateralToken).convertToAssets(shares);
        
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
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (shares == 0) revert ZeroAmount();
        
        Vault storage vault = _vaults[msg.sender];
        if (vault.pendingMintCount > 0) revert PendingMintLock();
        
        _tryRefreshOracle();
        // Sync yield FIRST
        _syncVaultYield(msg.sender);
        
        uint256 collateralAfterSync = vault.collateralShares;
        
        // Cannot withdraw locked collateral
        uint256 availableCollateral = vault.collateralShares - vault.lockedCollateral;
        if (availableCollateral < shares) revert InsufficientCollateral();
        
        // Check health ratio using same valuation as liquidation
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 totalObligations = actualDebt + vault.pendingDebt;
        
        if (totalObligations > 0) {
            vault.collateralShares -= shares;
            uint256 ratio = _calculateCRWithPositions(msg.sender, totalObligations);
            if (ratio < COLLATERAL_RATIO) {
                revert InsufficientCollateral();
            }
        } else {
            vault.collateralShares -= shares;
        }
        
        uint256 daiReceived = ISavingsDAI(collateralToken).redeem(shares, msg.sender, address(this));
        
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
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        _vaults[msg.sender].mintGriefingDeposit = deposit;
        emit MintGriefingDepositUpdated(msg.sender, deposit);
    }
    
    /// @inheritdoc IVaultFacet
    function setVaultMarketMetrics(uint16 mintFeeBps, uint16 burnRewardBps) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (mintFeeBps > MAX_MARGIN_BPS || burnRewardBps > MAX_MARGIN_BPS) revert ExceedsMaxMargin();
        
        _vaults[msg.sender].mintFeeBps = mintFeeBps;
        _vaults[msg.sender].burnRewardBps = burnRewardBps;
        emit VaultMarketMetricsUpdated(msg.sender, mintFeeBps, burnRewardBps);
    }
    
    /// @inheritdoc IVaultFacet
    function setMaxMintBps(uint16 maxMintBps) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (maxMintBps > BPS_DENOMINATOR) revert InvalidValue();
        _vaults[msg.sender].maxMintBps = maxMintBps;
        emit MaxMintBpsUpdated(msg.sender, maxMintBps);
    }
    
    /// @inheritdoc IVaultFacet
    function setMinBurnAmount(uint256 minAmount) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        _vaults[msg.sender].minBurnAmount = minAmount;
        emit MinBurnAmountUpdated(msg.sender, minAmount);
    }
    
    /// @notice Whitelist a minter to bypass griefing deposit requirement
    /// @param minter Address to whitelist
    /// @param whitelisted True to whitelist, false to remove
    function setMinterWhitelist(address minter, bool whitelisted) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (minter == address(0)) revert ZeroAddress();
        whitelistedMinters[msg.sender][minter] = whitelisted;
        emit MinterWhitelistUpdated(msg.sender, minter, whitelisted);
    }
    
    /// @notice Batch whitelist multiple minters
    /// @param minters Array of addresses to whitelist
    /// @param whitelisted True to whitelist all, false to remove all
    function batchSetMinterWhitelist(address[] calldata minters, bool whitelisted) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        for (uint256 i = 0; i < minters.length; i++) {
            if (minters[i] == address(0)) revert ZeroAddress();
            whitelistedMinters[msg.sender][minters[i]] = whitelisted;
            emit MinterWhitelistUpdated(msg.sender, minters[i], whitelisted);
        }
    }
    
    /// @inheritdoc IVaultFacet
    function setMintTimeoutBlocks(uint256 blocks) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (blocks < MIN_MINT_TIMEOUT_BLOCKS || blocks > MAX_MINT_TIMEOUT_BLOCKS) revert InvalidConfig();
        _vaults[msg.sender].mintTimeoutBlocks = blocks;
        emit MintTimeoutBlocksUpdated(msg.sender, blocks);
    }
    
    /// @inheritdoc IVaultFacet
    function setBurnTimeoutBlocks(uint256 blocks) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (blocks < MIN_BURN_TIMEOUT_BLOCKS || blocks > MAX_BURN_TIMEOUT_BLOCKS) revert InvalidConfig();
        _vaults[msg.sender].burnTimeoutBlocks = blocks;
        emit BurnTimeoutBlocksUpdated(msg.sender, blocks);
    }
    
    // ========== PENDING RETURNS ==========
    
    /// @inheritdoc IVaultFacet
    function withdrawReturns(address token) external nonReentrant {
        uint256 amount = pendingReturns[msg.sender][token];
        if (amount == 0) revert ZeroAmount();
        
        pendingReturns[msg.sender][token] = 0;
        
        if (token == collateralToken) {
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
        return _vaults[lpAddress];
    }
    
    /// @inheritdoc IVaultFacet
    function getVaultHealth(address lpAddress) external view returns (uint256 ratio) {
        Vault memory vault = _vaults[lpAddress];
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        return _calculateCollateralRatio(availableCollateral, actualDebt);
    }
    
    /// @inheritdoc IVaultFacet
    function getVaultDebt(address lpAddress) external view returns (uint256) {
        return _denormalizeDebt(_vaults[lpAddress].normalizedDebt);
    }

    /// @inheritdoc IVaultFacet
    function getMintCapacity(address lpVault) external view returns (uint256 maxWsxmrAmount) {
        Vault memory vault = _vaults[lpVault];
        if (!vault.active) return 0;

        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();

        // Simulate _syncVaultYield: calculate yield that would be extracted
        uint256 collateralShares = vault.collateralShares;
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        if (collateralShares > 0 && (actualDebt > 0 || vault.pendingDebt > 0)) {
            uint256 yieldShares = YieldLogic.calculateExtractableYield(
                collateralShares,
                vault.lockedCollateral,
                lpPrincipalDeposits[lpVault],
                actualDebt,
                vault.pendingDebt,
                xmrPrice,
                collateralPrice,
                collateralToken
            );
            collateralShares -= yieldShares;
        }

        // Available collateral after yield sync (same as initiateMint)
        uint256 availableCollateral = collateralShares > vault.lockedCollateral
            ? collateralShares - vault.lockedCollateral
            : 0;
        if (availableCollateral == 0) return 0;

        // Convert available shares to underlying, then to USD
        uint256 collateralAmount = IERC4626(collateralToken).convertToAssets(availableCollateral);
        uint256 collateralValueUsd = (collateralAmount * collateralPrice) / _underlyingUnit();

        // Current debt value in USD
        uint256 currentDebt = actualDebt + vault.pendingDebt;
        uint256 currentDebtValueUsd = (currentDebt * xmrPrice) / WSXMR_DECIMALS;

        // Max total debt at 150% CR — still needed for the per-mint maxMintBps cap,
        // which initiateMint applies to the non-bond-reduced available collateral.
        uint256 maxTotalDebtValueUsd = (collateralValueUsd * RATIO_PRECISION) / COLLATERAL_RATIO;

        // Bond-reserved capacity: a mint of x wsXMR locks a 110%-of-par key bond
        // AND must leave the remaining free collateral at CR >= 150%:
        //   (C - 1.1·x·p) · 100  >=  150 · (D0 + x) · p        [all terms USD]
        //   x <= (100·C - 150·D0) / ((150 + 110)·p)
        // Mirrors the bond-reserved check in initiateMint/provideLPKey so the
        // reported capacity is actually mintable — not just CR-eligible.
        uint256 numerator = collateralValueUsd * RATIO_PRECISION;
        uint256 debtTerm = currentDebtValueUsd * COLLATERAL_RATIO;
        if (numerator <= debtTerm) return 0;
        maxWsxmrAmount = ((numerator - debtTerm) * WSXMR_DECIMALS)
            / ((COLLATERAL_RATIO + MINT_LOCK_RATIO) * xmrPrice);

        // Apply maxMintBps limit (limits single mint USD value)
        if (vault.maxMintBps > 0) {
            uint256 maxMintAllowedUsd = (maxTotalDebtValueUsd * vault.maxMintBps) / BPS_DENOMINATOR;
            uint256 maxMintFromBps = (maxMintAllowedUsd * WSXMR_DECIMALS) / xmrPrice;
            if (maxMintFromBps < maxWsxmrAmount) {
                maxWsxmrAmount = maxMintFromBps;
            }
        }
    }
    
    /// @inheritdoc IVaultFacet
    function getMaxVaultCollateral() external view returns (uint256 maxCollateral) {
        for (uint256 i = 0; i < vaultList.length; i++) {
            Vault memory vault = _vaults[vaultList[i]];
            if (vault.active && vault.collateralShares > maxCollateral) {
                maxCollateral = vault.collateralShares;
            }
        }
    }
    
    /// @inheritdoc IVaultFacet
    function getVaultCount() external view returns (uint256) {
        return activeVaultCount;
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
        return _vaults[lpAddress].active;
    }
    
    /// @notice Check if a minter is whitelisted for a vault
    function isMinterWhitelisted(address vault, address minter) external view returns (bool) {
        return whitelistedMinters[vault][minter];
    }
    
    // ========== DIAMOND INTROSPECTION ==========
    
    /// @notice Returns all function selectors implemented by this facet
    /// @dev Used by Diamond to build selector → facet routing table
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](25);
        sels[0] = this.createVault.selector;
        sels[1] = this.deactivateVault.selector;
        sels[2] = this.depositCollateral.selector;
        sels[3] = this.depositShares.selector;
        sels[4] = this.withdrawCollateral.selector;
        sels[5] = this.setMintGriefingDeposit.selector;
        sels[6] = this.setVaultMarketMetrics.selector;
        sels[7] = this.setMaxMintBps.selector;
        sels[8] = this.setMinBurnAmount.selector;
        sels[9] = this.setMinterWhitelist.selector;
        sels[10] = this.batchSetMinterWhitelist.selector;
        sels[11] = this.withdrawReturns.selector;
        sels[12] = this.getVault.selector;
        sels[13] = this.getVaultHealth.selector;
        sels[14] = this.getVaultDebt.selector;
        sels[15] = this.getVaultCount.selector;
        sels[16] = this.getVaultAtIndex.selector;
        sels[17] = this.getPendingReturns.selector;
        sels[18] = this.hasActiveVault.selector;
        sels[19] = this.isMinterWhitelisted.selector;
        sels[20] = this.selectors.selector;
        sels[21] = this.setMintTimeoutBlocks.selector;
        sels[22] = this.setBurnTimeoutBlocks.selector;
        sels[23] = this.getMaxVaultCollateral.selector;
        sels[24] = this.calculateCollateralRatio.selector;
        return sels;
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
        Vault storage vault = _vaults[lpAddress];
        if (vault.collateralShares == 0) return;
        
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        
        // Skip yield calculation if no debt - no point checking prices
        if (actualDebt == 0 && vault.pendingDebt == 0) return;
        
        // Skip yield extraction if oracle price is stale — don't block deposits/withdrawals
        if (block.timestamp > lastXmrPriceTimestamp + 120 || block.timestamp > lastCollateralPriceTimestamp + 120) return;
        
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        
        uint256 yieldShares = YieldLogic.calculateExtractableYield(
            vault.collateralShares,
            vault.lockedCollateral,
            lpPrincipalDeposits[lpAddress],
            actualDebt,
            vault.pendingDebt,
            xmrPrice,
            collateralPrice,
            collateralToken
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
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        return CollateralLogic.calculateRatioFromShares(
            collateralShares,
            debtAmount,
            collateralToken,
            collateralPrice,
            xmrPrice
        );
    }

    function _calculateCRWithPositions(address vaultAddr, uint256 debtAmount)
        internal view returns (uint256)
    {
        Vault memory vault = _vaults[vaultAddr];
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();

        if (vault.deployedSDAIShares == 0) {
            return CollateralLogic.calculateRatioFromShares(
                vault.collateralShares, debtAmount, collateralToken, collateralPrice, xmrPrice
            );
        }

        (uint256 positionDAI, uint256 positionWsxmr) = _getVaultPositionTotalsAtOracle(vaultAddr, xmrPrice);
        return CollateralLogic.calculateVaultCRWithDeployment(
            vault.collateralShares,
            positionDAI,
            positionWsxmr,
            debtAmount,
            collateralToken,
            collateralPrice,
            xmrPrice
        );
    }
    
    function _getVaultPositionTotalsAtOracle(address vaultAddr, uint256 xmrPrice)
        internal view
        returns (uint256 totalDAI, uint256 totalWsxmr)
    {
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        uint256[] memory positions = _vaultPositions[vaultAddr];
        for (uint256 i = 0; i < positions.length; i++) {
            (uint256 dai, uint256 wsxmr) = IwsXmrLiquidityRouter(liquidityRouter)
                .getPositionAmountsAtPrice(positions[i], xmrPrice, collateralPrice);
            totalDAI += dai;
            totalWsxmr += wsxmr;
        }
    }
    
    // ========== VAULT EVICTION INTERNALS ==========

    function _removeFromVaultList(address vaultAddr) internal {
        uint256 idx = vaultListIndex[vaultAddr];
        uint256 lastIdx = vaultList.length - 1;

        if (idx != lastIdx) {
            address lastVault = vaultList[lastIdx];
            vaultList[idx] = lastVault;
            vaultListIndex[lastVault] = idx;
        }

        vaultList.pop();
        delete vaultListIndex[vaultAddr];
    }

    function _isVaultEvictable(address vaultAddr, uint256 maxCollateral) internal view returns (bool) {
        Vault memory vault = _vaults[vaultAddr];
        if (!vault.active) return false;
        if (vault.normalizedDebt > 0) return false;
        if (vault.lockedCollateral > 0) return false;
        if (vault.pendingMintCount > 0) return false;
        if (_vaultPositions[vaultAddr].length > 0) return false;

        if (maxCollateral == 0) {
            return vault.collateralShares == 0;
        }

        uint256 threshold = (maxCollateral * MIN_VAULT_COLLATERAL_BPS) / BPS_DENOMINATOR;
        return vault.collateralShares < threshold;
    }

    function _findEvictableVault() internal view returns (address) {
        uint256 maxCollateral = 0;
        for (uint256 i = 0; i < vaultList.length; i++) {
            Vault memory vault = _vaults[vaultList[i]];
            if (vault.active && vault.collateralShares > maxCollateral) {
                maxCollateral = vault.collateralShares;
            }
        }

        for (uint256 i = 0; i < vaultList.length; i++) {
            if (_isVaultEvictable(vaultList[i], maxCollateral)) {
                return vaultList[i];
            }
        }

        return address(0);
    }

    function _evictVault(address vaultAddr) internal {
        Vault storage vault = _vaults[vaultAddr];

        if (vault.collateralShares > 0) {
            uint256 shares = vault.collateralShares;
            vault.collateralShares = 0;

            uint256 daiReceived = ISavingsDAI(collateralToken).redeem(shares, vaultAddr, address(this));

            uint256 principalToDeduct = lpPrincipalDeposits[vaultAddr];
            if (principalToDeduct > globalLpPrincipal) {
                principalToDeduct = globalLpPrincipal;
            }
            lpPrincipalDeposits[vaultAddr] = 0;
            globalLpPrincipal -= principalToDeduct;

            uint256 sharesToDeduct = lpPrincipalShares[vaultAddr];
            if (sharesToDeduct > globalLpPrincipalShares) {
                sharesToDeduct = globalLpPrincipalShares;
            }
            lpPrincipalShares[vaultAddr] = 0;
            globalLpPrincipalShares -= sharesToDeduct;
        }

        vault.active = false;
        vault.lpAddress = address(0);
        vault.normalizedDebt = 0;
        vault.pendingDebt = 0;
        vault.lockedCollateral = 0;
        vault.pendingMintCount = 0;

        _removeFromVaultList(vaultAddr);
        activeVaultCount--;
    }
}
