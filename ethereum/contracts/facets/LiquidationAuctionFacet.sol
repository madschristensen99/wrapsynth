// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IErrors} from "../interfaces/IErrors.sol";
import {ILiquidationAuctionFacet} from "../interfaces/facets/ILiquidationAuctionFacet.sol";
import {IwsXmrHub} from "../interfaces/core/IwsXmrHub.sol";
import {IwsXmrLiquidityRouter} from "../interfaces/router/IwsXmrLiquidityRouter.sol";

/**
 * @title LiquidationAuctionFacet
 * @notice Bonded-kick Dutch haircut liquidation — the oracle-free replacement
 *         for the old oracle-triggered liquidate().
 * @dev Mechanism (docs/ORACLE_FREE_MIGRATION_SPEC.md §2.2):
 *
 *      1. kick(vault): anyone posts a bond (2% of vault collateral, floored at
 *         kickBondMin). Opens a GRACE window where the LP cancels the kick by
 *         acting — depositCollateral or repayDebt — proving liveness; the bond
 *         is paid to the vault either way the kick resolves in the LP's favor.
 *      2. After grace the auction opens. In-flight burns are settled and co-LP
 *         positions unwound so the offer is clean, then offeredCollateral is
 *         snapshotted (free collateral; key bonds excluded). During
 *         AUCTION_OPEN_DELAY bids still revert — the LP may repayDebt in full
 *         to cancel outright (bond → LP).
 *      3. ACTIVE: X(t) decays linearly from 100% to 5% over AUCTION_DURATION.
 *         First bid wins: bidder burns wsXMR equal to the vault's FULL actual
 *         debt and receives X% of offeredCollateral. Surplus above X returns to
 *         the LP; the kicker receives CHIP_BPS of the surplus plus their bond.
 *         If clearing X* ≤ KICK_SANE (80%) the kick was wrongful — the vault was
 *         ≥125% collateralized at its own threshold — and the bond goes to the LP.
 *      4. ENDED with no bid → resolveKick freezes the vault: mints/burns/
 *         withdrawals revert; only repayDebt, depositCollateral, reauction and
 *         backstopVault remain. Bond returns to the kicker.
 *      5. reauction retries discovery exactly once per vault. backstopVault lets
 *         a healthy LP absorb a frozen vault's debt+collateral outright.
 *
 *      No price is ever consulted — the auction discovers the settlement
 *      haircut in the market.
 */
contract LiquidationAuctionFacet is wsXmrStorage, ILiquidationAuctionFacet {
    using SafeERC20 for IERC20;

    error ReentrancyGuard();

    // ========== EVENTS ==========
    // Kick lifecycle events come from ILiquidationAuctionFacet. The burn/co-LP
    // events below mirror IBurnOperations/ICoLPFacet — declared locally because
    // this facet only ports their settlement semantics, not their interfaces.

    event CoLPUnwound(
        uint256 indexed tokenId,
        address indexed vault,
        address indexed user,
        uint256 collateralReturned,
        uint256 wsxmrReturned,
        bool liquidationTriggered
    );
    event BurnCancelled(bytes32 indexed requestId);
    event BurnSlashed(bytes32 indexed requestId, address indexed user, uint256 collateralSeized, bytes32 userSecret);
    event BurnFinalized(bytes32 indexed requestId, bytes32 secret, uint256 rewardPaid);

    // ========== CONSTRUCTOR ==========

    constructor(address _wsxmrToken, address _verifierProxy, uint256 _minThreshold, uint256 _kickBondMin)
        wsXmrStorage(_wsxmrToken, _verifierProxy, _minThreshold, _kickBondMin)
    {}

    // ========== KICK LIFECYCLE ==========

    /**
     * @notice Kick a vault — post a bond and open the grace window.
     * @dev Permissionless. No solvency proof required: the auction itself is
     *      the solvency test. Requires the vault be active, unfrozen, not
     *      already kicked, past its re-kick cooldown, and carrying debt.
     */
    function kick(address lpVault) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;

        Vault storage v = _vaults[lpVault];
        if (!v.active) revert IErrors.VaultDoesNotExist();
        if (vaultFrozen[lpVault]) revert VaultIsFrozen();
        if (vaultKicks[lpVault].active) revert KickActive();
        if (block.number < vaultLastKickResolved[lpVault] + KICK_COOLDOWN_BLOCKS) {
            revert KickOnCooldown();
        }
        if (_denormalizeDebt(v.normalizedDebt) == 0) revert IErrors.InsufficientDebt();

        _startKick(lpVault, v, false);

        _reentrancyStatus = _NOT_ENTERED;
    }

    /**
     * @notice Retry liquidation on a frozen vault — exactly once per vault.
     * @dev Clears the frozen flag and starts a fresh kick with the full
     *      grace/auction lifecycle.
     */
    function reauction(address lpVault) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;

        Vault storage v = _vaults[lpVault];
        if (!v.active) revert IErrors.VaultDoesNotExist();
        if (!vaultFrozen[lpVault]) revert IErrors.InvalidStatus();
        if (vaultReauctionUsed[lpVault]) revert NoReauctionAvailable();
        if (vaultKicks[lpVault].active) revert KickActive();
        if (block.number < vaultLastKickResolved[lpVault] + KICK_COOLDOWN_BLOCKS) {
            revert KickOnCooldown();
        }
        if (_denormalizeDebt(v.normalizedDebt) == 0) revert IErrors.InsufficientDebt();

        vaultReauctionUsed[lpVault] = true;
        vaultFrozen[lpVault] = false;

        _startKick(lpVault, v, true);

        _reentrancyStatus = _NOT_ENTERED;
    }

    /// @dev Pulls the kick bond from msg.sender and records the kick.
    function _startKick(address lpVault, Vault storage v, bool isReauction) internal {
        uint256 bondNorm = (v.collateralShares * KICK_BOND_BPS) / BPS_DENOMINATOR;
        if (bondNorm < kickBondMin) bondNorm = kickBondMin;

        uint256 bondRaw = _rawFromNorm(bondNorm);
        if (bondRaw == 0) revert IErrors.InsufficientCollateral();
        uint256 bondMoved = _normFromRaw(bondRaw);

        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), bondRaw);

        uint256 end = block.number + KICK_GRACE_BLOCKS + AUCTION_OPEN_DELAY_BLOCKS + AUCTION_DURATION_BLOCKS;
        vaultKicks[lpVault] = Kick({
            kicker: msg.sender,
            bond: bondMoved,
            kickBlock: block.number,
            auctionEnd: end,
            offeredCollateral: 0,
            auctionOpened: false,
            active: true
        });

        if (isReauction) {
            emit ReauctionStarted(lpVault, msg.sender, bondMoved, end);
        } else {
            emit KickStarted(lpVault, msg.sender, bondMoved, end);
        }
    }

    /**
     * @notice Transition a kicked vault from grace into the auction —
     *         permissionless, idempotent.
     * @dev Settles every in-flight burn, unwinds all co-LP positions, bumps
     *      liquidation/mint nonces (invalidating pending mints and future burn
     *      cancellations), and snapshots the collateral being auctioned.
     *      Callable by anyone once the grace window has elapsed; also invoked
     *      lazily inside bid()/resolveKick()/backstopVault().
     */
    function openAuction(address lpVault) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;

        Kick storage k = vaultKicks[lpVault];
        if (!k.active) revert NoActiveKick();
        if (block.number < k.kickBlock + KICK_GRACE_BLOCKS) revert BidNotOpen();

        _ensureAuctionOpened(lpVault, _vaults[lpVault], k);

        _reentrancyStatus = _NOT_ENTERED;
    }

    /// @dev Runs the grace→auction transition exactly once.
    function _ensureAuctionOpened(address lpVault, Vault storage v, Kick storage k) internal {
        if (k.auctionOpened) return;
        k.auctionOpened = true;

        _settleInFlightBurns(v, lpVault);

        if (_vaultPositions[lpVault].length > 0) {
            _unwindAllVaultPositions(lpVault);
        }

        v.liquidationNonce++;
        v.mintNonce++;

        // Offer = free collateral post-settlement; locked key bonds are never seizable.
        k.offeredCollateral = _freeCollateral(v);

        emit AuctionOpened(lpVault, k.offeredCollateral);
    }

    /**
     * @notice Bid on an active auction — pay the vault's FULL debt, receive
     *         X(t)% of the offered collateral.
     * @dev Caller must have approved the hub for ≥ vault debt in wsXMR.
     *      Whole-debt bids only in v1. Clearing haircut:
     *          X* ≤ KICK_SANE (80%) → wrongful kick, bond → LP
     *          else               → bond + chip → kicker
     */
    function bid(address lpVault) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;

        Vault storage v = _vaults[lpVault];
        Kick storage k = vaultKicks[lpVault];
        if (!k.active) revert NoActiveKick();
        if (_kickPhase(k) != KickPhase.ACTIVE) revert BidNotOpen();

        _ensureAuctionOpened(lpVault, v, k);

        uint256 debt = _denormalizeDebt(v.normalizedDebt);
        if (debt == 0) {
            // In-flight settlement cleared the vault's whole debt — nothing left
            // to liquidate. Cancel the kick; bond → LP.
            _cancelKickBondToLP(v, k, lpVault);
            _reentrancyStatus = _NOT_ENTERED;
            return;
        }

        uint256 xBps = _currentXBps(k);
        uint256 bidderNorm = (k.offeredCollateral * xBps) / BPS_DENOMINATOR;
        uint256 surplusNorm = k.offeredCollateral - bidderNorm;
        uint256 chipNorm = (surplusNorm * CHIP_BPS) / BPS_DENOMINATOR;

        // Payout legs in raw units; vault equity deducts exactly what moves.
        uint256 bidderRaw = _rawFromNorm(bidderNorm);
        uint256 chipRaw = _rawFromNorm(chipNorm);
        uint256 bondRaw = _rawFromNorm(k.bond);

        uint256 totalOutNorm = _normFromRaw(bidderRaw) + _normFromRaw(chipRaw);
        v.collateralShares = totalOutNorm > v.collateralShares ? 0 : v.collateralShares - totalOutNorm;

        bool wrongful = xBps <= KICK_SANE_BPS;
        uint256 kickerPayout;
        if (wrongful) {
            // Wrongful kick — bond compensates the LP (credited to vault equity).
            v.collateralShares += k.bond;
            kickerPayout = chipRaw;
        } else {
            kickerPayout = bondRaw + chipRaw;
        }
        if (kickerPayout > 0) {
            pendingReturns[k.kicker][collateralToken] += kickerPayout;
            emit ReturnQueued(k.kicker, collateralToken, kickerPayout);
        }

        // Debt cleared exactly as liquidate() did — full denormalized debt.
        uint256 actualDebt = debt;
        v.normalizedDebt = 0;
        globalTotalDebt = globalTotalDebt > actualDebt ? globalTotalDebt - actualDebt : 0;

        // Nonces were bumped at auction open; record resolution + clear the kick.
        vaultLastKickResolved[lpVault] = block.number;
        delete vaultKicks[lpVault];

        IwsXmrHub(address(this)).burnTokens(msg.sender, actualDebt);
        IERC20(collateralToken).safeTransfer(msg.sender, bidderRaw);

        emit AuctionSettled(lpVault, msg.sender, actualDebt, xBps, bidderRaw, kickerPayout, wrongful);

        _reentrancyStatus = _NOT_ENTERED;
    }

    /**
     * @notice Resolve a no-bid auction — freeze the vault and return the bond.
     * @dev Permissionless, callable once the auction window has fully elapsed.
     */
    function resolveKick(address lpVault) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;

        _resolveKickToFrozen(lpVault);

        _reentrancyStatus = _NOT_ENTERED;
    }

    /// @dev ENDED kick → FROZEN. Runs in-flight settlement first if the auction
    ///      never opened, then returns the kicker's bond.
    function _resolveKickToFrozen(address lpVault) internal {
        Vault storage v = _vaults[lpVault];
        Kick storage k = vaultKicks[lpVault];
        if (!k.active) revert NoActiveKick();
        if (_kickPhase(k) != KickPhase.ENDED) revert AuctionNotEnded();

        _ensureAuctionOpened(lpVault, v, k);

        vaultFrozen[lpVault] = true;
        vaultLastKickResolved[lpVault] = block.number;

        uint256 bondRaw = _rawFromNorm(k.bond);
        if (bondRaw > 0) {
            pendingReturns[k.kicker][collateralToken] += bondRaw;
            emit ReturnQueued(k.kicker, collateralToken, bondRaw);
        }

        delete vaultKicks[lpVault];
        emit VaultFrozen(lpVault);
    }

    /// @dev Shared by bid() (debt-already-cleared edge) and post-grace rescues.
    ///      Cancels the kick and pays the bond to the LP's vault equity.
    function _cancelKickBondToLP(Vault storage v, Kick storage k, address lpVault) internal {
        v.collateralShares += k.bond;
        vaultLastKickResolved[lpVault] = block.number;
        delete vaultKicks[lpVault];
        emit KickCancelled(lpVault, k.kicker, k.bond, true);
    }

    /// @dev Dutch haircut X(t): linear decay from HAIRCUT_START_BPS to
    ///      HAIRCUT_FLOOR_BPS over AUCTION_DURATION_BLOCKS, measured from the
    ///      end of the open delay.
    function _currentXBps(Kick memory k) internal view returns (uint256) {
        uint256 auctionStart = k.kickBlock + KICK_GRACE_BLOCKS + AUCTION_OPEN_DELAY_BLOCKS;
        if (block.number <= auctionStart) return HAIRCUT_START_BPS;
        uint256 elapsed = block.number - auctionStart;
        if (elapsed >= AUCTION_DURATION_BLOCKS) return HAIRCUT_FLOOR_BPS;
        uint256 span = HAIRCUT_START_BPS - HAIRCUT_FLOOR_BPS;
        return HAIRCUT_START_BPS - (span * elapsed) / AUCTION_DURATION_BLOCKS;
    }

    // ========== BACKSTOP ==========

    /**
     * @notice Backstop a frozen vault — a healthy LP assumes its debt and collateral.
     * @dev Callable only when the vault is FROZEN (or the kick has ended
     *      unresolved, which is resolved to frozen inline first). No wsXMR
     *      sourcing needed — the new vault takes on the normalized debt and
     *      absorbs all remaining collateral. Post-check: the absorbing vault
     *      must still cover debt+pendingDebt at its OWN declared threshold.
     */
    function backstopVault(address oldVault) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;

        if (!_vaults[oldVault].active) revert IErrors.VaultDoesNotExist();
        if (!_vaults[msg.sender].active) revert IErrors.VaultDoesNotExist();
        if (oldVault == msg.sender) revert IErrors.InvalidValue();
        // The absorbing vault must itself be unencumbered.
        if (vaultFrozen[msg.sender]) revert VaultIsFrozen();
        if (vaultKicks[msg.sender].active) revert KickActive();

        Vault storage oldV = _vaults[oldVault];
        Vault storage newV = _vaults[msg.sender];

        Kick storage k = vaultKicks[oldVault];
        if (k.active) {
            if (_kickPhase(k) != KickPhase.ENDED) revert KickActive();
            _resolveKickToFrozen(oldVault);
        }
        if (!vaultFrozen[oldVault]) revert IErrors.InvalidStatus();

        // Belt & suspenders: settle anything that didn't run through the auction.
        _settleInFlightBurns(oldV, oldVault);
        if (_vaultPositions[oldVault].length > 0) {
            _unwindAllVaultPositions(oldVault);
        }

        uint256 oldDebt = _denormalizeDebt(oldV.normalizedDebt);
        if (oldDebt == 0) revert IErrors.InsufficientDebt();

        uint256 absorbedCollateral = oldV.collateralShares;

        // New vault assumes the debt and absorbs all remaining collateral.
        newV.normalizedDebt += oldV.normalizedDebt;
        newV.collateralShares += absorbedCollateral;

        // Zero out old vault — clear ALL state to prevent phantom locked collateral.
        oldV.normalizedDebt = 0;
        oldV.collateralShares = 0;
        oldV.lockedCollateral = 0;
        oldV.deployedCollateral = 0;
        oldV.liquidationNonce++;
        oldV.mintNonce++;
        vaultFrozen[oldVault] = false;

        // Post-check: absorbing vault must cover debt+pendingDebt at its own threshold.
        uint256 newDebt = _denormalizeDebt(newV.normalizedDebt);
        uint256 freeNew = _freeCollateral(newV);
        if (freeNew < _requiredCollateral(newDebt + newV.pendingDebt, newV.thresholdSharesPerWsxmr)) {
            revert IErrors.InsufficientCollateral();
        }

        emit VaultBackstopped(oldVault, msg.sender, oldDebt, absorbedCollateral);

        _reentrancyStatus = _NOT_ENTERED;
    }

    // ========== VIEWS ==========

    /**
     * @notice Current auction state for a vault — display/keeper view.
     * @return active True while a kick exists on the vault
     * @return phase 0=GRACE, 1=OPEN_DELAY, 2=ACTIVE, 3=ENDED (invalid if !active)
     * @return xBps Current haircut in bps (what a bidder receives of offeredCollateral)
     * @return offeredCollateral Normalized collateral the auction pays X% of
     * @return bond Kicker's bond (normalized)
     * @return kicker Kick initiator
     * @return auctionEnd Block at which a no-bid auction becomes resolvable
     * @return frozen Vault frozen after an inconclusive auction
     */
    function auctionState(address lpVault)
        external
        view
        returns (
            bool active,
            uint8 phase,
            uint256 xBps,
            uint256 offeredCollateral,
            uint256 bond,
            address kicker,
            uint256 auctionEnd,
            bool frozen
        )
    {
        Kick memory k = vaultKicks[lpVault];
        active = k.active;
        frozen = vaultFrozen[lpVault];
        if (!active) return (false, 0, 0, 0, 0, address(0), 0, frozen);
        KickPhase p = _kickPhase(k);
        return (
            true,
            uint8(p),
            p == KickPhase.ACTIVE ? _currentXBps(k) : HAIRCUT_START_BPS,
            k.offeredCollateral,
            k.bond,
            k.kicker,
            k.auctionEnd,
            frozen
        );
    }

    /// @notice Bond required to kick (or reauction) a vault right now — normalized units.
    function getKickBond(address lpVault) external view returns (uint256) {
        uint256 bondNorm = (_vaults[lpVault].collateralShares * KICK_BOND_BPS) / BPS_DENOMINATOR;
        return bondNorm < kickBondMin ? kickBondMin : bondNorm;
    }

    // ========== IN-FLIGHT SETTLEMENT (ported from LiquidationFacet) ==========

    /// @dev Par-capped slash settlement for a COMMITTED burn.
    ///      User receives min(par, locked) + reward; excess locked collateral returns
    ///      to the vault. Par = wsxmrAmount × thresholdAtRequest (declared rate
    ///      snapshotted at request — no oracle).
    function _settleCommittedBurnSlash(BurnRequest storage burnReq, Vault storage v) internal {
        uint256 parCollateral = _parCollateral(burnReq.wsxmrAmount, burnReq.thresholdAtRequest);

        uint256 userBase = parCollateral < burnReq.lockedCollateral
            ? parCollateral
            : burnReq.lockedCollateral;
        uint256 userPayout = userBase + burnReq.rewardCollateral;

        uint256 totalLockSlash = burnReq.lockedCollateral + burnReq.rewardCollateral;
        if (v.lockedCollateral < totalLockSlash) v.lockedCollateral = 0;
        else v.lockedCollateral -= totalLockSlash;

        uint256 payoutRaw = _rawFromNorm(userPayout);
        uint256 payoutNorm = _normFromRaw(payoutRaw);
        if (v.collateralShares < payoutNorm) v.collateralShares = 0;
        else v.collateralShares -= payoutNorm;

        if (globalPendingBurnDebt < burnReq.wsxmrAmount) globalPendingBurnDebt = 0;
        else globalPendingBurnDebt -= burnReq.wsxmrAmount;

        // Debt reduction happens here at settlement
        uint256 normalizedBurnAmount = (burnReq.wsxmrAmount * 1e18 + globalDebtIndex - 1) / globalDebtIndex;
        if (normalizedBurnAmount > v.normalizedDebt) {
            normalizedBurnAmount = v.normalizedDebt;
        }
        v.normalizedDebt -= normalizedBurnAmount;
        globalTotalDebt -= _denormalizeDebt(normalizedBurnAmount);

        if (payoutRaw > 0) {
            pendingReturns[burnReq.user][collateralToken] += payoutRaw;
            emit ReturnQueued(burnReq.user, collateralToken, payoutRaw);
        }

        burnReq.status = BurnStatus.SLASHED;
        // userSecret unknown to the liquidator — zero signals the LP server there is
        // nothing to sweep (the user's key half was not revealed on this path).
        emit BurnSlashed(burnReq.requestId, burnReq.user, payoutRaw, bytes32(0));
    }

    /// @dev Settles a COMMITTED burn whose secret was already revealed, during liquidation.
    ///      The user can claim the XMR with the public secret, so they receive only the burn
    ///      reward — the locked collateral is released to the vault (and becomes seizable),
    ///      unlike _settleCommittedBurnSlash which would pay out par + reward.
    function _settleRevealedBurnLiquidation(BurnRequest storage burnReq, Vault storage v) internal {
        uint256 totalLock = burnReq.lockedCollateral + burnReq.rewardCollateral;
        if (v.lockedCollateral < totalLock) v.lockedCollateral = 0;
        else v.lockedCollateral -= totalLock;

        uint256 rewardNorm = burnReq.rewardCollateral;
        if (v.collateralShares < rewardNorm) rewardNorm = v.collateralShares;
        v.collateralShares -= rewardNorm;
        uint256 rewardRaw = _rawFromNorm(rewardNorm);

        uint256 normalizedBurnAmount = (burnReq.wsxmrAmount * 1e18 + globalDebtIndex - 1) / globalDebtIndex;
        if (normalizedBurnAmount > v.normalizedDebt) {
            normalizedBurnAmount = v.normalizedDebt;
        }
        v.normalizedDebt -= normalizedBurnAmount;
        globalTotalDebt -= _denormalizeDebt(normalizedBurnAmount);

        if (globalPendingBurnDebt < burnReq.wsxmrAmount) globalPendingBurnDebt = 0;
        else globalPendingBurnDebt -= burnReq.wsxmrAmount;

        if (rewardRaw > 0) {
            pendingReturns[burnReq.user][collateralToken] += rewardRaw;
            emit ReturnQueued(burnReq.user, collateralToken, rewardRaw);
        }

        burnReq.status = BurnStatus.COMPLETED;
        emit BurnFinalized(burnReq.requestId, burnReq.revealedSecret, rewardRaw);
    }

    /// @dev Settles every active burn on the vault so the auction offers clean state.
    ///      REQUESTED/PROPOSED force-cancel (wsXMR re-minted to user); COMMITTED
    ///      settle via par-capped slash or reward-only if the secret was revealed.
    function _settleInFlightBurns(Vault storage v, address lpVault) internal {
        bytes32[] storage vaultBurns = vaultBurnRequests[lpVault];
        for (uint256 i = 0; i < vaultBurns.length; i++) {
            BurnRequest storage burnReq = burnRequests[vaultBurns[i]];
            delete burnRequestIndexPlusOne[vaultBurns[i]];

            if (burnReq.status == BurnStatus.REQUESTED || burnReq.status == BurnStatus.PROPOSED) {
                // Force-cancel: unwind burn to free collateral for liquidation
                if (burnReq.vaultLiquidationNonce == v.liquidationNonce) {
                    uint256 totalLock = burnReq.lockedCollateral + burnReq.rewardCollateral;
                    if (v.lockedCollateral < totalLock) v.lockedCollateral = 0;
                    else v.lockedCollateral -= totalLock;
                }
                if (globalPendingBurnDebt < burnReq.wsxmrAmount) globalPendingBurnDebt = 0;
                else globalPendingBurnDebt -= burnReq.wsxmrAmount;

                // Re-mint wsXMR to user
                IwsXmrHub(address(this)).mintTokens(burnReq.user, burnReq.wsxmrAmount);

                burnReq.status = BurnStatus.CANCELLED;
                emit BurnCancelled(burnReq.requestId);

            } else if (burnReq.status == BurnStatus.COMMITTED) {
                if (burnReq.revealedSecret != bytes32(0)) {
                    // LP already revealed — the user can claim the XMR. Settle rather than
                    // slash: release the lock to the vault (seizable) and pay only the reward.
                    _settleRevealedBurnLiquidation(burnReq, v);
                } else {
                    // Settle committed burn: par-capped slash (user gets par + reward, excess to vault)
                    _settleCommittedBurnSlash(burnReq, v);
                }
            }
        }
        // Every entry was transitioned to terminal above — clear the array outright.
        delete vaultBurnRequests[lpVault];
    }

    /// @dev Unwinds all deployed Uniswap V3 positions for a vault during auction
    ///      open or backstop. Drains each position via the router (spot-tick
    ///      bounded — no oracle), returns raw collateral to the vault and wsXMR
    ///      to the user via pendingReturns. Removes positions from both arrays.
    function _unwindAllVaultPositions(address lpVault) internal {
        Vault storage vault = _vaults[lpVault];

        while (_vaultPositions[lpVault].length > 0) {
            uint256 idx = _vaultPositions[lpVault].length - 1;
            uint256 tokenId = _vaultPositions[lpVault][idx];
            PositionMetadata memory meta = _positionMetadata[tokenId];

            (uint256 collOut, uint256 wsxmrOut) = IwsXmrLiquidityRouter(liquidityRouter)
                .drainPosition(tokenId, uint16(DEFAULT_COLP_SLIPPAGE_BPS));

            if (collOut > 0) {
                vault.collateralShares += _normFromRaw(collOut);
            }
            if (wsxmrOut > 0) {
                pendingReturns[meta.user][wsxmrToken] += wsxmrOut;
            }

            if (vault.deployedCollateral >= meta.collateralOriginal) {
                vault.deployedCollateral -= meta.collateralOriginal;
            } else {
                vault.deployedCollateral = 0;
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

            emit CoLPUnwound(tokenId, lpVault, meta.user, collOut, wsxmrOut, true);
        }
    }

    // ========== DIAMOND INTROSPECTION ==========

    /// @notice Returns all function selectors implemented by this facet
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](8);
        sels[0] = this.kick.selector;
        sels[1] = this.reauction.selector;
        sels[2] = this.openAuction.selector;
        sels[3] = this.bid.selector;
        sels[4] = this.resolveKick.selector;
        sels[5] = this.backstopVault.selector;
        sels[6] = this.auctionState.selector;
        sels[7] = this.getKickBond.selector;
        return sels;
    }
}
