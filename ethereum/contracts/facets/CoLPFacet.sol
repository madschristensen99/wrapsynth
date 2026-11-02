// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {ICoLPFacet} from "../interfaces/facets/ICoLPFacet.sol";
import {IwsXmrLiquidityRouter} from "../interfaces/router/IwsXmrLiquidityRouter.sol";

/**
 * @title CoLPFacet
 * @notice Handles co-LP (co-liquidity-provision) operations for the wsXMR system
 * @dev Oracle-free (spec §3.7): the user and vault agree on leg amounts
 *      directly — no oracle conversion. Range bounds come from the pool's own
 *      slot0 tick, and slippage protection is the user's supplied bounds. The
 *      collateral leg counts toward vault backing at face value and the wsXMR
 *      leg nets against vault debt — no cross-asset oracle math anywhere.
 */
contract CoLPFacet is wsXmrStorage, ICoLPFacet {
    using SafeERC20 for IERC20;

    // ========== ERRORS ==========

    error InvalidConfig();
    error InvalidRange();
    error PositionNotFound();
    error PositionInRange();
    error InsufficientLPBuffer();

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

    // ========== CO-LP OPERATIONS ==========

    /// @inheritdoc ICoLPFacet
    function setMaxCoLPRange(uint16 newMaxBps) external nonReentrant vaultNotBlocked(msg.sender) {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (newMaxBps < MIN_COLP_RANGE_BPS || newMaxBps > MAX_COLP_RANGE_BPS) {
            revert InvalidConfig();
        }
        _vaults[msg.sender].maxCoLPRangeBps = newMaxBps;
        emit CoLPRangePreferenceUpdated(msg.sender, newMaxBps);
    }

    /// @inheritdoc ICoLPFacet
    /// @param collateralAmount Collateral the vault deploys, in RAW token units —
    ///        agreed between user and LP off-chain; the pool consumes what its
    ///        range needs and leftovers reconcile back to the vault.
    function userOpenCoLP(
        address lpVault,
        uint256 wsxmrAmount,
        uint256 collateralAmount,
        uint256 deadline
    ) external nonReentrant vaultNotBlocked(lpVault) returns (uint256 tokenId) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (!_vaults[lpVault].active) revert VaultDoesNotExist();
        if (wsxmrAmount == 0) revert ZeroAmount();
        if (collateralAmount == 0) revert ZeroAmount();

        Vault storage vault = _vaults[lpVault];

        uint256 collateralNorm = _normFromRaw(collateralAmount);
        uint256 availableIdle = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        if (availableIdle < collateralNorm) revert InsufficientLPBuffer();

        IERC20(wsxmrToken).safeTransferFrom(msg.sender, address(this), wsxmrAmount);

        vault.collateralShares -= collateralNorm;

        uint16 rangeBps = vault.maxCoLPRangeBps > 0
            ? vault.maxCoLPRangeBps
            : uint16(DEFAULT_COLP_RANGE_BPS);

        // Pool trades wsXMR/collateral — hand the raw tokens to the router.
        IERC20(collateralToken).safeTransfer(liquidityRouter, collateralAmount);
        IERC20(wsxmrToken).safeTransfer(liquidityRouter, wsxmrAmount);

        (uint256 _tokenId, uint128 liquidity, int24 tickLower, int24 tickUpper, uint256 collateralConsumed, uint256 wsxmrConsumed) =
            IwsXmrLiquidityRouter(liquidityRouter).mintConcentratedPosition(
                collateralAmount, wsxmrAmount, rangeBps, deadline, uint16(DEFAULT_COLP_SLIPPAGE_BPS)
            );
        tokenId = _tokenId;

        // M2: Reconcile accounting with actual consumed amounts. Leftover tokens swept back to hub.
        uint256 leftoverCollateral = collateralAmount > collateralConsumed ? collateralAmount - collateralConsumed : 0;
        uint256 leftoverWsxmr = wsxmrAmount > wsxmrConsumed ? wsxmrAmount - wsxmrConsumed : 0;
        if (leftoverCollateral > 0) {
            vault.collateralShares += _normFromRaw(leftoverCollateral);
        }
        if (leftoverWsxmr > 0) {
            pendingReturns[msg.sender][wsxmrToken] += leftoverWsxmr;
        }

        vault.deployedCollateral += _normFromRaw(collateralConsumed);
        vault.deployedWsxmr += wsxmrConsumed;
        _positionMetadata[tokenId] = PositionMetadata({
            vaultOwner: lpVault,
            user: msg.sender,
            collateralOriginal: _normFromRaw(collateralConsumed),
            wsxmrOriginal: wsxmrConsumed,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            createdAt: block.timestamp
        });
        _vaultPositions[lpVault].push(tokenId);
        _userPositions[msg.sender].push(tokenId);

        // Verify vault remains covered at its own threshold post-deploy:
        // (free + deployed legs) ≥ (debt + pending − netted wsXMR legs) × T.
        _requireThresholdCoverage(lpVault, vault);

        emit CoLPDeployed(lpVault, msg.sender, tokenId, collateralConsumed, wsxmrConsumed, rangeBps);
    }

    /// @inheritdoc ICoLPFacet
    function collectCoLPFees(uint256 tokenId) external nonReentrant {
        PositionMetadata memory meta = _positionMetadata[tokenId];
        if (meta.vaultOwner == address(0)) revert PositionNotFound();
        if (meta.vaultOwner != msg.sender && meta.user != msg.sender) revert Unauthorized();

        (uint256 collFees, uint256 wsxmrFees) = IwsXmrLiquidityRouter(liquidityRouter).collectFees(tokenId);

        if (collFees > 0) {
            pendingReturns[meta.vaultOwner][collateralToken] += collFees;
        }
        if (wsxmrFees > 0) {
            pendingReturns[meta.user][wsxmrToken] += wsxmrFees;
        }

        emit CoLPFeesCollected(tokenId, collFees, wsxmrFees);
    }

    /// @inheritdoc ICoLPFacet
    function unwindCoLP(uint256 tokenId, uint256 deadline) external nonReentrant {
        if (block.timestamp > deadline) revert DeadlineExpired();
        PositionMetadata memory meta = _positionMetadata[tokenId];
        if (meta.vaultOwner != msg.sender && meta.user != msg.sender) revert Unauthorized();
        if (vaultFrozen[meta.vaultOwner]) revert VaultIsFrozen();
        if (vaultKicks[meta.vaultOwner].active) revert KickActive();

        _unwindAndDistribute(tokenId, false);
    }

    /// @inheritdoc ICoLPFacet
    /// @dev Threshold-derived: the vault's free collateral supports
    ///      freeCollateral × 1e8 / threshold wsXMR of debt; subtract current debt.
    function getCoLPCapacity(address lpVault) external view returns (uint256 maxWsxmrAcceptable) {
        Vault memory vault = _vaults[lpVault];
        if (!vault.active) return 0;

        uint256 threshold = vault.thresholdSharesPerWsxmr;
        if (threshold < minThreshold) return 0;

        uint256 availableIdle = _freeCollateral(vault);
        if (availableIdle == 0) return 0;

        uint256 supportable = (availableIdle * WSXMR_DECIMALS) / threshold;
        uint256 debt = _denormalizeDebt(vault.normalizedDebt);
        maxWsxmrAcceptable = supportable > debt ? supportable - debt : 0;
    }

    /// @inheritdoc ICoLPFacet
    function rebalanceCoLP(uint256 tokenId, uint16 newRangeBps, uint256 deadline)
        external nonReentrant
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        PositionMetadata memory meta = _positionMetadata[tokenId];
        if (meta.vaultOwner == address(0)) revert PositionNotFound();
        if (vaultFrozen[meta.vaultOwner]) revert VaultIsFrozen();
        if (vaultKicks[meta.vaultOwner].active) revert KickActive();

        Vault storage vault = _vaults[meta.vaultOwner];
        if (newRangeBps < MIN_COLP_RANGE_BPS || newRangeBps > vault.maxCoLPRangeBps) {
            revert InvalidRange();
        }

        // Pool-native check: position out of range iff its tick window no
        // longer contains the pool's own slot0 tick.
        bool outOfRange = IwsXmrLiquidityRouter(liquidityRouter).isPositionOutOfRange(tokenId);
        bool isOwner = msg.sender == meta.vaultOwner;
        if (!outOfRange && !isOwner) revert PositionInRange();

        address user = meta.user;
        (uint256 collOut, uint256 wsxmrOut) = IwsXmrLiquidityRouter(liquidityRouter)
            .drainPosition(tokenId, uint16(DEFAULT_COLP_SLIPPAGE_BPS));

        uint256 keeperFee = 0;
        if (!isOwner) {
            keeperFee = (collOut * COLP_REBALANCE_FEE_BPS) / BPS_DENOMINATOR;
            IERC20(collateralToken).safeTransfer(msg.sender, keeperFee);
            collOut -= keeperFee;
        }

        _removePositionFromArrays(tokenId, meta.vaultOwner, user);
        if (vault.deployedCollateral >= meta.collateralOriginal) {
            vault.deployedCollateral -= meta.collateralOriginal;
        } else {
            vault.deployedCollateral = 0;
        }
        if (vault.deployedWsxmr >= meta.wsxmrOriginal) {
            vault.deployedWsxmr -= meta.wsxmrOriginal;
        } else {
            vault.deployedWsxmr = 0;
        }
        delete _positionMetadata[tokenId];

        if (collOut > 0 && wsxmrOut > 0) {
            uint256 newTokenId = _deployToNewPosition(meta.vaultOwner, user, collOut, wsxmrOut, newRangeBps, deadline);
            emit CoLPRebalanced(tokenId, newTokenId, meta.vaultOwner, user, msg.sender, newRangeBps);
        } else {
            if (collOut > 0) {
                vault.collateralShares += _normFromRaw(collOut);
            }
            if (wsxmrOut > 0) {
                pendingReturns[user][wsxmrToken] += wsxmrOut;
            }
            emit CoLPUnwound(tokenId, meta.vaultOwner, user, collOut, wsxmrOut, false);
        }
    }

    // ========== VIEW FUNCTIONS ==========

    /// @inheritdoc ICoLPFacet
    function getPositionMetadata(uint256 tokenId) external view returns (PositionMetadata memory) {
        return _positionMetadata[tokenId];
    }

    /// @inheritdoc ICoLPFacet
    function getUserPositions(address user) external view returns (uint256[] memory) {
        return _userPositions[user];
    }

    // ========== DIAMOND INTROSPECTION ==========

    /// @notice Returns all function selectors implemented by this facet
    /// @dev selectors() itself is deliberately NOT registered — the hub calls
    ///      it directly on the facet address during registration.
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](8);
        sels[0] = this.setMaxCoLPRange.selector;
        sels[1] = this.userOpenCoLP.selector;
        sels[2] = this.collectCoLPFees.selector;
        sels[3] = this.unwindCoLP.selector;
        sels[4] = this.rebalanceCoLP.selector;
        sels[5] = this.getCoLPCapacity.selector;
        sels[6] = this.getPositionMetadata.selector;
        sels[7] = this.getUserPositions.selector;
        return sels;
    }

    // ========== INTERNAL FUNCTIONS ==========

    /// @dev Post-deploy coverage check: the vault's collateral backing (free +
    ///      deployed collateral legs at face) must cover effective debt
    ///      (normalized debt + pendingDebt − deployed wsXMR legs, floored at 0)
    ///      at its own declared threshold.
    function _requireThresholdCoverage(address lpVault, Vault storage vault) internal view {
        uint256 threshold = vault.thresholdSharesPerWsxmr;
        if (threshold < minThreshold) revert BelowMinThreshold();

        uint256 debt = _denormalizeDebt(vault.normalizedDebt) + vault.pendingDebt;
        uint256 effectiveDebt = debt > vault.deployedWsxmr ? debt - vault.deployedWsxmr : 0;
        uint256 backing = _freeCollateral(vault) + vault.deployedCollateral;

        if (backing < _requiredCollateral(effectiveDebt, threshold)) {
            revert InsufficientCollateral();
        }
        lpVault; // silence unused-param warning (struct already loaded)
    }

    function _unwindAndDistribute(uint256 tokenId, bool fromLiquidation) internal {
        PositionMetadata memory meta = _positionMetadata[tokenId];
        Vault storage vault = _vaults[meta.vaultOwner];

        (uint256 collOut, uint256 wsxmrOut) = IwsXmrLiquidityRouter(liquidityRouter)
            .drainPosition(tokenId, uint16(DEFAULT_COLP_SLIPPAGE_BPS));

        if (vault.deployedCollateral >= meta.collateralOriginal) {
            vault.deployedCollateral -= meta.collateralOriginal;
        } else {
            vault.deployedCollateral = 0;
        }
        if (vault.deployedWsxmr >= meta.wsxmrOriginal) {
            vault.deployedWsxmr -= meta.wsxmrOriginal;
        } else {
            vault.deployedWsxmr = 0;
        }

        if (collOut > 0) {
            vault.collateralShares += _normFromRaw(collOut);
        }

        if (wsxmrOut > 0) {
            pendingReturns[meta.user][wsxmrToken] += wsxmrOut;
        }

        _removePositionFromArrays(tokenId, meta.vaultOwner, meta.user);
        delete _positionMetadata[tokenId];

        emit CoLPUnwound(tokenId, meta.vaultOwner, meta.user, collOut, wsxmrOut, fromLiquidation);
    }

    function _removePositionFromArrays(uint256 tokenId, address vaultAddr, address userAddr) internal {
        uint256[] storage vpos = _vaultPositions[vaultAddr];
        for (uint256 i = 0; i < vpos.length; i++) {
            if (vpos[i] == tokenId) {
                vpos[i] = vpos[vpos.length - 1];
                vpos.pop();
                break;
            }
        }
        uint256[] storage upos = _userPositions[userAddr];
        for (uint256 i = 0; i < upos.length; i++) {
            if (upos[i] == tokenId) {
                upos[i] = upos[upos.length - 1];
                upos.pop();
                break;
            }
        }
    }

    function _deployToNewPosition(
        address lpVault,
        address user,
        uint256 collateralAmount,
        uint256 wsxmrAmount,
        uint16 rangeBps,
        uint256 deadline
    ) internal returns (uint256 tokenId) {
        Vault storage vault = _vaults[lpVault];

        // collateralAmount is raw collateral — the pool's quote token
        IERC20(collateralToken).safeTransfer(liquidityRouter, collateralAmount);
        IERC20(wsxmrToken).safeTransfer(liquidityRouter, wsxmrAmount);

        (uint256 _tokenId, uint128 liquidity, int24 tickLower, int24 tickUpper, uint256 collateralConsumed, uint256 wsxmrConsumed) =
            IwsXmrLiquidityRouter(liquidityRouter).mintConcentratedPosition(
                collateralAmount, wsxmrAmount, rangeBps, deadline, uint16(DEFAULT_COLP_SLIPPAGE_BPS)
            );
        tokenId = _tokenId;

        // M2: Reconcile accounting with actual consumed amounts
        uint256 leftoverCollateral = collateralAmount > collateralConsumed ? collateralAmount - collateralConsumed : 0;
        uint256 leftoverWsxmr = wsxmrAmount > wsxmrConsumed ? wsxmrAmount - wsxmrConsumed : 0;
        if (leftoverCollateral > 0) {
            vault.collateralShares += _normFromRaw(leftoverCollateral);
        }
        if (leftoverWsxmr > 0) {
            pendingReturns[user][wsxmrToken] += leftoverWsxmr;
        }

        vault.deployedCollateral += _normFromRaw(collateralConsumed);
        vault.deployedWsxmr += wsxmrConsumed;

        _positionMetadata[tokenId] = PositionMetadata({
            vaultOwner: lpVault,
            user: user,
            collateralOriginal: _normFromRaw(collateralConsumed),
            wsxmrOriginal: wsxmrConsumed,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            createdAt: block.timestamp
        });
        _vaultPositions[lpVault].push(tokenId);
        _userPositions[user].push(tokenId);

        emit CoLPDeployed(lpVault, user, tokenId, collateralConsumed, wsxmrConsumed, rangeBps);
    }
}
