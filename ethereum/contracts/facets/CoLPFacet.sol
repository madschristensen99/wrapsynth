// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {ICoLPFacet} from "../interfaces/facets/ICoLPFacet.sol";
import {ISavingsDAI} from "../interfaces/external/ISavingsDAI.sol";
import {CollateralLogic} from "../libraries/CollateralLogic.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IwsXmrLiquidityRouter} from "../interfaces/router/IwsXmrLiquidityRouter.sol";

/**
 * @title CoLPFacet
 * @notice Handles co-LP (co-liquidity-provision) operations for the wsXMR system
 * @dev Split from VaultFacet to keep both facets under the EIP-170 contract
 *      size limit. Shares the diamond's AppStorage — position bookkeeping in
 *      _positionMetadata/_vaultPositions/_userPositions is identical to what
 *      LiquidationFacet reads when force-unwinding positions.
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

    // ========== CO-LP OPERATIONS ==========

    /// @inheritdoc ICoLPFacet
    function setMaxCoLPRange(uint16 newMaxBps) external nonReentrant {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (newMaxBps < MIN_COLP_RANGE_BPS || newMaxBps > MAX_COLP_RANGE_BPS) {
            revert InvalidConfig();
        }
        _vaults[msg.sender].maxCoLPRangeBps = newMaxBps;
        emit CoLPRangePreferenceUpdated(msg.sender, newMaxBps);
    }

    /// @inheritdoc ICoLPFacet
    function userOpenCoLP(
        address lpVault,
        uint256 wsxmrAmount,
        uint256 deadline
    ) external nonReentrant returns (uint256 tokenId) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (!_vaults[lpVault].active) revert VaultDoesNotExist();
        if (wsxmrAmount == 0) revert ZeroAmount();

        Vault storage vault = _vaults[lpVault];
        _tryRefreshOracle();
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();

        uint256 wsxmrUsd = (wsxmrAmount * xmrPrice) / WSXMR_DECIMALS;
        uint256 daiNeeded = (wsxmrUsd * _underlyingUnit()) / collateralPrice;
        uint256 sharesNeeded = IERC4626(collateralToken).convertToShares(daiNeeded);

        uint256 availableIdle = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        if (availableIdle < sharesNeeded) revert InsufficientLPBuffer();

        IERC20(wsxmrToken).safeTransferFrom(msg.sender, address(this), wsxmrAmount);

        vault.collateralShares -= sharesNeeded;

        uint16 rangeBps = vault.maxCoLPRangeBps > 0
            ? vault.maxCoLPRangeBps
            : uint16(DEFAULT_COLP_RANGE_BPS);

        // Pool trades wsXMR/USDe — redeem shares to USDe before deploying
        uint256 usdeForPosition = ISavingsDAI(collateralToken).redeem(sharesNeeded, address(this), address(this));
        IERC20(underlyingToken).safeTransfer(liquidityRouter, usdeForPosition);
        IERC20(wsxmrToken).safeTransfer(liquidityRouter, wsxmrAmount);

        (uint256 _tokenId, uint128 liquidity, int24 tickLower, int24 tickUpper, uint256 daiConsumed, uint256 wsxmrConsumed) =
            IwsXmrLiquidityRouter(liquidityRouter).mintConcentratedPosition(
                usdeForPosition, wsxmrAmount, rangeBps, xmrPrice, deadline, uint16(DEFAULT_COLP_SLIPPAGE_BPS)
            );
        tokenId = _tokenId;

        // M2: Reconcile accounting with actual consumed amounts. Leftover tokens swept back to hub.
        uint256 leftoverDai = usdeForPosition > daiConsumed ? usdeForPosition - daiConsumed : 0;
        uint256 leftoverWsxmr = wsxmrAmount > wsxmrConsumed ? wsxmrAmount - wsxmrConsumed : 0;
        if (leftoverDai > 0) {
            // Re-wrap leftover USDe into shares for the vault
            IERC20(underlyingToken).forceApprove(collateralToken, leftoverDai);
            vault.collateralShares += ISavingsDAI(collateralToken).deposit(leftoverDai, address(this));
        }
        if (leftoverWsxmr > 0) {
            pendingReturns[msg.sender][wsxmrToken] += leftoverWsxmr;
        }

        vault.deployedSDAIShares += daiConsumed;
        _positionMetadata[tokenId] = PositionMetadata({
            vaultOwner: lpVault,
            user: msg.sender,
            sDAISharesOriginal: daiConsumed,
            wsxmrOriginal: wsxmrConsumed,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            createdAt: block.timestamp
        });
        _vaultPositions[lpVault].push(tokenId);
        _userPositions[msg.sender].push(tokenId);

        // Verify vault remains healthy after co-LP deployment
        uint256 postDeployDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 postDeployRatio = _calculateCRWithPositions(lpVault, postDeployDebt);
        if (postDeployRatio < COLLATERAL_RATIO) revert InsufficientCollateral();

        emit CoLPDeployed(lpVault, msg.sender, tokenId, daiConsumed, wsxmrConsumed, rangeBps);
    }

    /// @inheritdoc ICoLPFacet
    function collectCoLPFees(uint256 tokenId) external nonReentrant {
        PositionMetadata memory meta = _positionMetadata[tokenId];
        if (meta.vaultOwner == address(0)) revert PositionNotFound();
        if (meta.vaultOwner != msg.sender && meta.user != msg.sender) revert Unauthorized();

        (uint256 daiFees, uint256 wsxmrFees) = IwsXmrLiquidityRouter(liquidityRouter).collectFees(tokenId);

        if (daiFees > 0) {
            // Fees arrive as USDe — wrap to shares so pendingReturns stays
            // denominated in the collateral share token like every other flow.
            IERC20(underlyingToken).forceApprove(collateralToken, daiFees);
            uint256 feeShares = ISavingsDAI(collateralToken).deposit(daiFees, address(this));
            pendingReturns[meta.vaultOwner][collateralToken] += feeShares;
            globalPendingSDAI += feeShares;
        }
        if (wsxmrFees > 0) {
            pendingReturns[meta.user][wsxmrToken] += wsxmrFees;
        }

        emit CoLPFeesCollected(tokenId, daiFees, wsxmrFees);
    }

    /// @inheritdoc ICoLPFacet
    function unwindCoLP(uint256 tokenId, uint256 deadline) external nonReentrant {
        if (block.timestamp > deadline) revert DeadlineExpired();
        PositionMetadata memory meta = _positionMetadata[tokenId];
        if (meta.vaultOwner != msg.sender && meta.user != msg.sender) revert Unauthorized();

        _unwindAndDistribute(tokenId, false);
    }

    /// @inheritdoc ICoLPFacet
    function getCoLPCapacity(address lpVault) external view returns (uint256 maxWsxmrAcceptable) {
        Vault memory vault = _vaults[lpVault];
        if (!vault.active) return 0;

        uint256 availableIdle = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        if (availableIdle == 0) return 0;

        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();

        uint256 daiAmount = IERC4626(collateralToken).convertToAssets(availableIdle);
        uint256 daiUsd = (daiAmount * collateralPrice) / _underlyingUnit();
        maxWsxmrAcceptable = (daiUsd * WSXMR_DECIMALS) / xmrPrice;
    }

    /// @inheritdoc ICoLPFacet
    function rebalanceCoLP(uint256 tokenId, uint16 newRangeBps, uint256 deadline)
        external nonReentrant
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        PositionMetadata memory meta = _positionMetadata[tokenId];
        if (meta.vaultOwner == address(0)) revert PositionNotFound();

        Vault storage vault = _vaults[meta.vaultOwner];
        if (newRangeBps < MIN_COLP_RANGE_BPS || newRangeBps > vault.maxCoLPRangeBps) {
            revert InvalidRange();
        }

        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        bool outOfRange = IwsXmrLiquidityRouter(liquidityRouter).isPositionOutOfRange(tokenId, xmrPrice, collateralPrice);
        bool isOwner = msg.sender == meta.vaultOwner;
        if (!outOfRange && !isOwner) revert PositionInRange();

        address user = meta.user;
        (uint256 daiOut, uint256 wsxmrOut) = IwsXmrLiquidityRouter(liquidityRouter)
            .drainPosition(tokenId, uint16(DEFAULT_COLP_SLIPPAGE_BPS), xmrPrice, collateralPrice);

        uint256 keeperFee = 0;
        if (!isOwner) {
            keeperFee = (daiOut * COLP_REBALANCE_FEE_BPS) / BPS_DENOMINATOR;
            IERC20(underlyingToken).safeTransfer(msg.sender, keeperFee);
            daiOut -= keeperFee;
        }

        _removePositionFromArrays(tokenId, meta.vaultOwner, user);
        if (vault.deployedSDAIShares >= meta.sDAISharesOriginal) {
            vault.deployedSDAIShares -= meta.sDAISharesOriginal;
        } else {
            vault.deployedSDAIShares = 0;
        }
        delete _positionMetadata[tokenId];

        if (daiOut > 0 && wsxmrOut > 0) {
            uint256 newTokenId = _deployToNewPosition(meta.vaultOwner, user, daiOut, wsxmrOut, newRangeBps, deadline);
            emit CoLPRebalanced(tokenId, newTokenId, meta.vaultOwner, user, msg.sender, newRangeBps);
        } else {
            if (daiOut > 0) {
                // daiOut is USDe — wrap to shares before crediting the vault
                IERC20(underlyingToken).forceApprove(collateralToken, daiOut);
                vault.collateralShares += ISavingsDAI(collateralToken).deposit(daiOut, address(this));
            }
            if (wsxmrOut > 0) {
                pendingReturns[user][wsxmrToken] += wsxmrOut;
            }
            emit CoLPUnwound(tokenId, meta.vaultOwner, user, daiOut, wsxmrOut, false);
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

    function _unwindAndDistribute(uint256 tokenId, bool fromLiquidation) internal {
        PositionMetadata memory meta = _positionMetadata[tokenId];
        Vault storage vault = _vaults[meta.vaultOwner];
        uint256 xmrPrice = _getXmrPriceFromStorage();

        (uint256 daiOut, uint256 wsxmrOut) = IwsXmrLiquidityRouter(liquidityRouter)
            .drainPosition(tokenId, uint16(DEFAULT_COLP_SLIPPAGE_BPS), xmrPrice, _getCollateralPriceFromStorage());

        if (vault.deployedSDAIShares >= meta.sDAISharesOriginal) {
            vault.deployedSDAIShares -= meta.sDAISharesOriginal;
        } else {
            vault.deployedSDAIShares = 0;
        }

        if (daiOut > 0) {
            // daiOut is USDe — wrap to shares before crediting the vault
            IERC20(underlyingToken).forceApprove(collateralToken, daiOut);
            vault.collateralShares += ISavingsDAI(collateralToken).deposit(daiOut, address(this));
        }

        if (wsxmrOut > 0) {
            pendingReturns[meta.user][wsxmrToken] += wsxmrOut;
        }

        _removePositionFromArrays(tokenId, meta.vaultOwner, meta.user);
        delete _positionMetadata[tokenId];

        emit CoLPUnwound(tokenId, meta.vaultOwner, meta.user, daiOut, wsxmrOut, fromLiquidation);
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
        uint256 daiAmount,
        uint256 wsxmrAmount,
        uint16 rangeBps,
        uint256 deadline
    ) internal returns (uint256 tokenId) {
        Vault storage vault = _vaults[lpVault];
        uint256 xmrPrice = _getXmrPriceFromStorage();

        // daiAmount is USDe — the pool's quote token
        IERC20(underlyingToken).safeTransfer(liquidityRouter, daiAmount);
        IERC20(wsxmrToken).safeTransfer(liquidityRouter, wsxmrAmount);

        (uint256 _tokenId, uint128 liquidity, int24 tickLower, int24 tickUpper, uint256 daiConsumed, uint256 wsxmrConsumed) =
            IwsXmrLiquidityRouter(liquidityRouter).mintConcentratedPosition(
                daiAmount, wsxmrAmount, rangeBps, xmrPrice, deadline, uint16(DEFAULT_COLP_SLIPPAGE_BPS)
            );
        tokenId = _tokenId;

        // M2: Reconcile accounting with actual consumed amounts
        uint256 leftoverDai = daiAmount > daiConsumed ? daiAmount - daiConsumed : 0;
        uint256 leftoverWsxmr = wsxmrAmount > wsxmrConsumed ? wsxmrAmount - wsxmrConsumed : 0;
        if (leftoverDai > 0) {
            // Re-wrap leftover USDe into shares for the vault
            IERC20(underlyingToken).forceApprove(collateralToken, leftoverDai);
            vault.collateralShares += ISavingsDAI(collateralToken).deposit(leftoverDai, address(this));
        }
        if (leftoverWsxmr > 0) {
            pendingReturns[user][wsxmrToken] += leftoverWsxmr;
        }

        vault.deployedSDAIShares += daiConsumed;

        _positionMetadata[tokenId] = PositionMetadata({
            vaultOwner: lpVault,
            user: user,
            sDAISharesOriginal: daiConsumed,
            wsxmrOriginal: wsxmrConsumed,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            createdAt: block.timestamp
        });
        _vaultPositions[lpVault].push(tokenId);
        _userPositions[user].push(tokenId);

        emit CoLPDeployed(lpVault, user, tokenId, daiConsumed, wsxmrConsumed, rangeBps);
    }
}
