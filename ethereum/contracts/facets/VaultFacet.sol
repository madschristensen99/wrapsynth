// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IVaultFacet} from "../interfaces/facets/IVaultFacet.sol";
import {IwsXmrHub} from "../interfaces/core/IwsXmrHub.sol";

/**
 * @title VaultFacet
 * @notice Handles vault management operations for the wsXMR system
 * @dev Manages LP _vaults, collateral deposits/withdrawals, and configuration.
 *      Oracle-free: collateral is the raw underlying ERC-20 held by the hub,
 *      tracked in normalized 18-dec units. Each LP declares
 *      thresholdSharesPerWsxmr (normalized collateral per 1e8 wsXMR) — the mint
 *      bound, self-declared solvency line, and par-settlement rate. There is no
 *      oracle-based CR check anywhere.
 */
contract VaultFacet is wsXmrStorage, IVaultFacet {
    using SafeERC20 for IERC20;

    // ========== ERRORS ==========

    error InvalidConfig();

    // ========== CONSTRUCTOR ==========

    constructor(address _wsxmrToken, address _verifierProxy, uint256 _minThreshold, uint256 _kickBondMin)
        wsXmrStorage(_wsxmrToken, _verifierProxy, _minThreshold, _kickBondMin)
    {}

    // ========== MODIFIERS ==========

    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "ReentrancyGuard");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    /// @dev Reverts if the vault has an active kick/auction or is frozen.
    modifier vaultNotBlocked(address lpVault) {
        if (vaultFrozen[lpVault]) revert VaultIsFrozen();
        if (vaultKicks[lpVault].active) revert KickActive();
        _;
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
            thresholdSharesPerWsxmr: minThreshold,
            maxMintWsxmr: 0,
            mintGriefingDeposit: 0,
            mintFeeBps: 0,
            burnRewardBps: 0,
            liquidationNonce: 0,
            mintNonce: 0,
            minBurnAmount: 0,
            active: true,
            deployedCollateral: 0,
            deployedWsxmr: 0,
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
        if (vaultKicks[msg.sender].active) revert KickActive();
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
    /// @dev If the vault is in kick GRACE, acting (this deposit) proves liveness:
    ///      the kick cancels and the kicker's bond is paid to the vault.
    ///      Deposits during OPEN_DELAY/ACTIVE are allowed but do not cancel —
    ///      the running auction's offered collateral was already snapshotted.
    ///      Deposits while FROZEN are allowed but do not unfreeze.
    function depositCollateral(uint256 amount) external nonReentrant {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (amount == 0) revert ZeroAmount();

        Vault storage vault = _vaults[msg.sender];

        Kick storage k = vaultKicks[msg.sender];
        if (k.active && _kickPhase(k) == KickPhase.GRACE) {
            _cancelKickBondToLP(vault, k);
        }

        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), amount);
        vault.collateralShares += _normFromRaw(amount);

        emit CollateralDeposited(msg.sender, amount, _normFromRaw(amount));
    }

    /// @inheritdoc IVaultFacet
    /// @dev `shares` is in normalized collateral units. Blocked while a kick is
    ///      active or the vault is frozen. Post-withdrawal the vault must still
    ///      cover debt+pendingDebt (net of deployed wsXMR legs) at its own
    ///      declared threshold.
    function withdrawCollateral(uint256 shares) external nonReentrant vaultNotBlocked(msg.sender) {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (shares == 0) revert ZeroAmount();

        Vault storage vault = _vaults[msg.sender];
        if (vault.pendingMintCount > 0) revert PendingMintLock();

        uint256 rawOut = _rawFromNorm(shares);
        if (rawOut == 0) revert ZeroAmount();
        uint256 normOut = _normFromRaw(rawOut);

        // Cannot withdraw locked collateral
        uint256 availableCollateral = vault.collateralShares - vault.lockedCollateral;
        if (availableCollateral < normOut) revert InsufficientCollateral();

        uint256 totalObligations = _denormalizeDebt(vault.normalizedDebt) + vault.pendingDebt;

        vault.collateralShares -= normOut;
        if (totalObligations > 0 && !_coverageOk(vault, totalObligations)) {
            revert InsufficientCollateral();
        }

        IERC20(collateralToken).safeTransfer(msg.sender, rawOut);

        emit CollateralWithdrawn(msg.sender, rawOut, normOut);
    }

    // ========== THRESHOLD QUOTE & DEBT REPAY ==========

    /// @inheritdoc IVaultFacet
    /// @dev Reverts while a kick is active or the vault is frozen — the threshold
    ///      is the par-settlement rate in-flight requests snapshot, so it must be
    ///      stable through a dispute.
    function setThreshold(uint256 newThreshold) external vaultNotBlocked(msg.sender) {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (newThreshold < minThreshold) revert BelowMinThreshold();
        _vaults[msg.sender].thresholdSharesPerWsxmr = newThreshold;
        emit ThresholdUpdated(msg.sender, newThreshold);
    }

    /// @inheritdoc IVaultFacet
    function setMaxMintWsxmr(uint256 maxMintWsxmr_) external vaultNotBlocked(msg.sender) {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        _vaults[msg.sender].maxMintWsxmr = maxMintWsxmr_;
        emit MaxMintWsxmrUpdated(msg.sender, maxMintWsxmr_);
    }

    /// @inheritdoc IVaultFacet
    /// @dev Kick interaction:
    ///      - GRACE: any repay cancels the kick (liveness proven); bond → LP.
    ///      - OPEN_DELAY / ACTIVE / ENDED-unresolved: only a repay covering the
    ///        vault's FULL actual debt cancels; partial repays revert.
    ///      - FROZEN (no active kick): repays allowed; reaching zero debt unfreezes.
    function repayDebt(uint256 wsxmrAmount) external nonReentrant {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (wsxmrAmount == 0) revert ZeroAmount();

        Vault storage vault = _vaults[msg.sender];
        uint256 debt = _denormalizeDebt(vault.normalizedDebt);
        if (debt == 0) revert InsufficientDebt();

        Kick storage k = vaultKicks[msg.sender];
        if (k.active) {
            if (_kickPhase(k) == KickPhase.GRACE) {
                _cancelKickBondToLP(vault, k);
            } else {
                // Post-grace rescue: full debt only, cancels the auction outright.
                if (wsxmrAmount != debt) revert InsufficientDebt();
                _cancelKickBondToLP(vault, k);
            }
        }

        uint256 repayAmount = wsxmrAmount > debt ? debt : wsxmrAmount;
        IwsXmrHub(address(this)).burnTokens(msg.sender, repayAmount);

        uint256 normalizedRepay = (repayAmount * 1e18) / globalDebtIndex;
        vault.normalizedDebt =
            normalizedRepay > vault.normalizedDebt ? 0 : vault.normalizedDebt - normalizedRepay;
        globalTotalDebt = globalTotalDebt > repayAmount ? globalTotalDebt - repayAmount : 0;

        // A debt-free frozen vault is trivially solvent — unfreeze.
        if (vaultFrozen[msg.sender] && vault.normalizedDebt == 0) {
            vaultFrozen[msg.sender] = false;
        }

        emit DebtRepaid(msg.sender, repayAmount);
    }

    /// @dev Cancels an active kick, crediting the kicker's bond to the vault's
    ///      collateral (bond → LP path). Emitted here and reused by the
    ///      LiquidationAuctionFacet's in-house copy.
    function _cancelKickBondToLP(Vault storage vault, Kick storage k) internal {
        vault.collateralShares += k.bond;
        vaultLastKickResolved[msg.sender] = block.number;
        delete vaultKicks[msg.sender];
        emit KickCancelled(msg.sender, k.kicker, k.bond, true);
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
    /// @dev pendingReturns is denominated in raw token units — transferred as-is.
    function withdrawReturns(address token) external nonReentrant {
        uint256 amount = pendingReturns[msg.sender][token];
        if (amount == 0) revert ZeroAmount();

        pendingReturns[msg.sender][token] = 0;

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
    /// @dev INFORMATIONAL ONLY — self-declared coverage:
    ///      freeCollateral / (debt × threshold) × RATIO_PRECISION.
    ///      100+ = vault covers debt at its own declared threshold.
    ///      This is not a solvency oracle — the LP sets the threshold.
    function getVaultHealth(address lpAddress) external view returns (uint256 ratio) {
        Vault memory vault = _vaults[lpAddress];
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 freeCollateral = _freeCollateral(vault);
        return _coverageRatio(freeCollateral, actualDebt, vault.thresholdSharesPerWsxmr);
    }

    /// @inheritdoc IVaultFacet
    function getVaultDebt(address lpAddress) external view returns (uint256) {
        return _denormalizeDebt(_vaults[lpAddress].normalizedDebt);
    }

    /// @inheritdoc IVaultFacet
    /// @dev Threshold-derived, quote-capped. Mirrors the bond-reserved coverage
    ///      check in MintFacet so the reported capacity is actually mintable:
    ///        free·1e8 >= T·(D0 + x) + 1.1·x·T
    ///        x <= (free·1e8 − T·D0)·100 / (T·(100 + MINT_LOCK_RATIO))
    function getMintCapacity(address lpVault) external view returns (uint256 maxWsxmrAmount) {
        Vault memory vault = _vaults[lpVault];
        if (!vault.active) return 0;
        uint256 threshold = vault.thresholdSharesPerWsxmr;
        if (threshold < minThreshold) return 0;

        uint256 freeCollateral = _freeCollateral(vault);
        if (freeCollateral == 0) return 0;

        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 headroom = freeCollateral * WSXMR_DECIMALS;
        uint256 committed = threshold * (actualDebt + vault.pendingDebt);
        if (headroom <= committed) return 0;
        maxWsxmrAmount = ((headroom - committed) * RATIO_PRECISION)
            / (threshold * (RATIO_PRECISION + MINT_LOCK_RATIO));

        if (vault.maxMintWsxmr > 0 && maxWsxmrAmount > vault.maxMintWsxmr) {
            maxWsxmrAmount = vault.maxMintWsxmr;
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
        bytes4[] memory sels = new bytes4[](26);
        sels[0] = this.createVault.selector;
        sels[1] = this.deactivateVault.selector;
        sels[2] = this.depositCollateral.selector;
        sels[3] = this.withdrawCollateral.selector;
        sels[4] = this.setMintGriefingDeposit.selector;
        sels[5] = this.setVaultMarketMetrics.selector;
        sels[6] = this.setMaxMintWsxmr.selector;
        sels[7] = this.setMinBurnAmount.selector;
        sels[8] = this.setMinterWhitelist.selector;
        sels[9] = this.batchSetMinterWhitelist.selector;
        sels[10] = this.withdrawReturns.selector;
        sels[11] = this.getVault.selector;
        sels[12] = this.getVaultHealth.selector;
        sels[13] = this.getVaultDebt.selector;
        sels[14] = this.getVaultCount.selector;
        sels[15] = this.getVaultAtIndex.selector;
        sels[16] = this.getPendingReturns.selector;
        sels[17] = this.hasActiveVault.selector;
        sels[18] = this.isMinterWhitelisted.selector;
        sels[19] = this.selectors.selector;
        sels[20] = this.setMintTimeoutBlocks.selector;
        sels[21] = this.setBurnTimeoutBlocks.selector;
        sels[22] = this.getMaxVaultCollateral.selector;
        sels[23] = this.calculateCollateralRatio.selector;
        sels[24] = this.setThreshold.selector;
        sels[25] = this.repayDebt.selector;
        return sels;
    }

    /// @inheritdoc IVaultFacet
    /// @dev Coverage ratio for arbitrary amounts at a threshold quote:
    ///      collateral / (debt × threshold) × RATIO_PRECISION.
    function calculateCollateralRatio(
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 threshold
    ) external pure returns (uint256) {
        return _coverageRatio(collateralAmount, debtAmount, threshold);
    }

    // ========== INTERNAL FUNCTIONS ==========

    /// @dev Coverage ratio: collateral / (debt × threshold) × RATIO_PRECISION.
    ///      debt == 0 or required == 0 → max (fully covered).
    function _coverageRatio(uint256 collateralNorm, uint256 wsxmrDebt, uint256 threshold)
        internal pure returns (uint256)
    {
        if (wsxmrDebt == 0) return type(uint256).max;
        uint256 required = _requiredCollateral(wsxmrDebt, threshold);
        if (required == 0) return type(uint256).max;
        return (collateralNorm * RATIO_PRECISION) / required;
    }

    /// @dev Threshold-relative coverage including co-LP legs at face value:
    ///      backing = free + deployedCollateral; effectiveDebt = debt − deployedWsxmr.
    ///      Used by withdrawCollateral — `collateralShares` must already reflect
    ///      the withdrawal before calling.
    function _coverageOk(Vault memory vault, uint256 wsxmrObligations) internal pure returns (bool) {
        uint256 effective = wsxmrObligations > vault.deployedWsxmr
            ? wsxmrObligations - vault.deployedWsxmr
            : 0;
        uint256 backing = _freeCollateral(vault) + vault.deployedCollateral;
        return backing >= _requiredCollateral(effective, vault.thresholdSharesPerWsxmr);
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
            uint256 normShares = vault.collateralShares;
            vault.collateralShares = 0;
            uint256 rawOut = _rawFromNorm(normShares);
            if (rawOut > 0) {
                vault.collateralShares = normShares - _normFromRaw(rawOut);
                IERC20(collateralToken).safeTransfer(vaultAddr, rawOut);
                vault.collateralShares = 0;
            }
        }

        vault.active = false;
        _removeFromVaultList(vaultAddr);
        activeVaultCount--;
    }
}
