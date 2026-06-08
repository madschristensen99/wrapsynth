// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IBurnFacet} from "../interfaces/facets/IBurnFacet.sol";
import {IwsXmrHub} from "../interfaces/core/IwsXmrHub.sol";
import {Ed25519} from "../Ed25519.sol";
import {CollateralLogic} from "../libraries/CollateralLogic.sol";
import {YieldLogic} from "../libraries/YieldLogic.sol";
import {BurnLogic} from "../libraries/BurnLogic.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {GnosisAddresses} from "../GnosisAddresses.sol";

contract BurnFacet is wsXmrStorage, IBurnFacet {
    
    error ReentrancyGuard();
    
    event BurnRequestsCleanedUp(address indexed vault, uint256 removed);
    
    constructor(address _wsxmrToken, address _verifierProxy) 
        wsXmrStorage(_wsxmrToken, _verifierProxy) 
    {}
    
    function requestBurn(uint256 wsxmrAmount, address lpVault, address user, bytes32 claimCommitment) external returns (bytes32) {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        if (msg.sender != user) revert OnlyUserCanInitiate();
        bytes32 requestId = _requestBurn(wsxmrAmount, lpVault, user, claimCommitment, false);
        
        _reentrancyStatus = _NOT_ENTERED;
        return requestId;
    }
    
    function requestBurnFromRouter(uint256 wsxmrAmount, address lpVault, address user, bytes32 claimCommitment) external returns (bytes32) {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        if (msg.sender != liquidityRouter) revert OnlyRouter();
        bytes32 requestId = _requestBurn(wsxmrAmount, lpVault, user, claimCommitment, true);
        
        _reentrancyStatus = _NOT_ENTERED;
        return requestId;
    }
    
    function _requestBurn(uint256 wsxmrAmount, address lpVault, address user, bytes32 claimCommitment, bool fromRouter) internal returns (bytes32) {
        if (claimCommitment == bytes32(0)) revert InvalidCommitment();
        if (wsxmrAmount == 0) revert ZeroAmount();
        if (lpVault == address(0)) revert ZeroAddress();
        if (user == address(0)) revert ZeroAddress();
        if (!_vaults[lpVault].active) revert VaultDoesNotExist();
        
        _syncVaultYield(lpVault);
        
        if (wsxmrAmount < MIN_BURN_AMOUNT) revert BelowMinimumBurn();
        
        Vault storage vault = _vaults[lpVault];
        if (vault.minBurnAmount > 0 && wsxmrAmount < vault.minBurnAmount) revert BelowMinimumBurn();
        
        bytes32[] storage vaultBurns = vaultBurnRequests[lpVault];
        uint256 activeCount = 0;
        for (uint256 i = 0; i < vaultBurns.length; i++) {
            BurnStatus status = burnRequests[vaultBurns[i]].status;
            if (status == BurnStatus.REQUESTED || status == BurnStatus.PROPOSED || status == BurnStatus.COMMITTED) {
                activeCount++;
            }
        }
        if (activeCount >= MAX_BURN_REQUESTS_PER_VAULT) revert MaxBurnRequestsReached();
        
        (uint256 collateralToLock, uint256 rewardCollateral) = calculateBurnCollateral(lpVault, wsxmrAmount);
        uint256 totalLock = collateralToLock + rewardCollateral;
        
        // Check available unlocked collateral (total model: collateralShares = total, lockedCollateral = reserved)
        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        if (availableCollateral < totalLock) revert InsufficientCollateral();
        
        if (!fromRouter) {
            IwsXmrHub(address(this)).burnTokens(user, wsxmrAmount);
        }
        
        // B1: Total collateral model - never subtract from collateralShares when locking
        vault.lockedCollateral += totalLock;
        
        uint256 normalizedBurnAmount = (wsxmrAmount * 1e18 + globalDebtIndex - 1) / globalDebtIndex;
        if (normalizedBurnAmount > vault.normalizedDebt) {
            normalizedBurnAmount = vault.normalizedDebt;
        }
        vault.normalizedDebt -= normalizedBurnAmount;
        globalTotalDebt -= wsxmrAmount;
        globalPendingBurnDebt += wsxmrAmount;
        
        bytes32 requestId = keccak256(abi.encodePacked(user, lpVault, wsxmrAmount, ++_requestNonce));
        if (burnRequests[requestId].status != BurnStatus.INVALID) revert BurnAlreadyExists();
        
        uint256 xmrPrice = _getXmrPriceFromStorage();
        
        BurnRequest storage req = burnRequests[requestId];
        req.requestId = requestId;
        req.user = user;
        req.lpVault = lpVault;
        req.wsxmrAmount = wsxmrAmount;
        req.xmrAmount = wsxmrAmount * XMR_TO_WSXMR_DIVISOR;
        req.lockedCollateral = collateralToLock;
        req.rewardCollateral = rewardCollateral;
        req.deadline = block.number + vault.burnTimeoutBlocks;
        req.vaultLiquidationNonce = vault.liquidationNonce;
        req.normalizedDebtAmount = normalizedBurnAmount;
        req.status = BurnStatus.REQUESTED;
        req.userClaimCommitment = claimCommitment;
        req.xmrPriceAtRequest = xmrPrice;
        
        userBurnRequests[user].push(requestId);
        vaultBurnRequests[lpVault].push(requestId);
        
        emit BurnRequested(requestId, user, lpVault, wsxmrAmount, wsxmrAmount * XMR_TO_WSXMR_DIVISOR, rewardCollateral, claimCommitment);
        return requestId;
    }
    
    /**
     * @notice LP proposes secret hash after locking XMR on Monero
     * @dev The secretHash emitted here, combined with request.xmrAmount from BurnRequested event,
     *      provides all information clients need to verify the Monero lock before confirmMoneroLock
     * @param requestId The burn request ID
     * @param secretHash keccak256(secret·G) where secret unlocks the Monero output
     */
    function proposeHash(bytes32 requestId, bytes32 secretHash) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        BurnRequest storage request = burnRequests[requestId];
        if (request.status != BurnStatus.REQUESTED) revert InvalidStatus();
        
        Vault storage vault = _vaults[request.lpVault];
        if (msg.sender != vault.lpAddress) revert Unauthorized();
        if (secretHash == bytes32(0)) revert InvalidSecret();
        request.secretHash = secretHash;
        request.status = BurnStatus.PROPOSED;
        request.deadline = block.number + BURN_COMMIT_TIMEOUT_BLOCKS;
        
        emit HashProposed(requestId, secretHash);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /**
     * @notice User confirms the Monero output is locked with correct amount and secret binding
     * @dev CRITICAL CLIENT REQUIREMENT: This is a trust-minimized attestation. Clients MUST verify
     *      off-chain BEFORE calling this function:
     *      1. The Monero output amount matches request.xmrAmount (available in BurnRequested event)
     *      2. The secret binding is correct - the adaptor signature construction ensures that
     *         revealing the secret on-chain (via finalizeBurn) is the ONLY way the user can
     *         claim the locked XMR
     *      3. The LP cannot expose the secret Monero-side before finalizeBurn, or double-claim
     *         becomes possible (user gets XMR + slashes collateral)
     * 
     *      Once COMMITTED, the user is bound. If the LP fails to finalize, the user receives
     *      par value + reward via claimSlashedCollateral. There is no on-chain Monero verification.
     * @param requestId The burn request ID
     */
    function confirmMoneroLock(bytes32 requestId) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        BurnRequest storage request = burnRequests[requestId];
        if (request.status != BurnStatus.PROPOSED) revert InvalidStatus();
        if (msg.sender != request.user) revert Unauthorized();
        
        request.deadline = block.number + BURN_COMMIT_TIMEOUT_BLOCKS;
        request.status = BurnStatus.COMMITTED;
        
        emit BurnCommitted(requestId, request.deadline);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    function finalizeBurn(bytes32 requestId, bytes32 secret) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        BurnRequest storage request = burnRequests[requestId];
        if (request.status != BurnStatus.COMMITTED) revert InvalidStatus();
        if (block.number >= request.deadline + BURN_FINALIZE_GRACE_BLOCKS) revert DeadlineExpired();
        
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        bytes32 computedHash = keccak256(abi.encodePacked(px, py));
        if (computedHash != request.secretHash) revert InvalidSecret();
        
        _syncVaultYield(request.lpVault);
        
        Vault storage vault = _vaults[request.lpVault];
        
        uint256 safeReward = request.rewardCollateral;
        
        // B2: Total collateral model - release lock only, collateralShares already includes base
        vault.lockedCollateral -= (request.lockedCollateral + request.rewardCollateral);
        globalPendingBurnDebt -= request.wsxmrAmount;
        
        if (safeReward > 0) {
            pendingReturns[request.user][GnosisAddresses.SDAI] += safeReward;
            globalPendingSDAI += safeReward;
            emit ReturnQueued(request.user, GnosisAddresses.SDAI, safeReward);
        }
        
        request.status = BurnStatus.COMPLETED;
        emit BurnFinalized(requestId, secret, safeReward);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    function claimSlashedCollateral(bytes32 requestId) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        BurnRequest storage request = burnRequests[requestId];
        if (request.status != BurnStatus.COMMITTED) revert InvalidStatus();
        if (block.number < request.deadline + BURN_FINALIZE_GRACE_BLOCKS) revert DeadlineNotExpired();
        if (msg.sender != request.user) revert Unauthorized();
        
        Vault storage vault = _vaults[request.lpVault];
        
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        uint256 parValueUsd = (request.wsxmrAmount * request.xmrPriceAtRequest) / WSXMR_DECIMALS;
        uint256 parDaiAmount = (parValueUsd * SDAI_DECIMALS) / collateralPrice;
        uint256 parShares = _daiToShares(parDaiAmount);

        uint256 userBase = parShares < request.lockedCollateral
            ? parShares
            : request.lockedCollateral;
        uint256 userPayout = userBase + request.rewardCollateral;

        // B2: Total collateral model - release lock only
        vault.lockedCollateral -= (request.lockedCollateral + request.rewardCollateral);
        globalPendingBurnDebt -= request.wsxmrAmount;

        pendingReturns[request.user][GnosisAddresses.SDAI] += userPayout;
        globalPendingSDAI += userPayout;
        emit ReturnQueued(request.user, GnosisAddresses.SDAI, userPayout);
        
        request.status = BurnStatus.SLASHED;
        emit BurnSlashed(requestId, request.user, userPayout);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    function abortBurn(bytes32 requestId) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        BurnRequest storage request = burnRequests[requestId];
        if (request.status != BurnStatus.REQUESTED) revert InvalidStatus();
        if (block.number < request.deadline) revert DeadlineNotExpired();
        if (msg.sender != request.user) revert Unauthorized();
        
        Vault storage vault = _vaults[request.lpVault];
        
        if (request.vaultLiquidationNonce == vault.liquidationNonce) {
            vault.lockedCollateral -= (request.lockedCollateral + request.rewardCollateral);
            vault.normalizedDebt += request.normalizedDebtAmount;
            globalTotalDebt += request.wsxmrAmount;
        }
        
        globalPendingBurnDebt -= request.wsxmrAmount;
        
        // Restore wsXMR to holder
        IwsXmrHub(address(this)).mintTokens(request.user, request.wsxmrAmount);
        
        request.status = BurnStatus.CANCELLED;
        emit BurnAborted(requestId);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    function forceSettleBurn(bytes32 requestId) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        BurnRequest storage request = burnRequests[requestId];
        if (request.status != BurnStatus.REQUESTED) revert InvalidStatus();
        if (block.number < request.deadline) revert DeadlineNotExpired();
        if (msg.sender != request.user) revert Unauthorized();
        
        Vault storage vault = _vaults[request.lpVault];
        
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        uint256 parValueUsd = (request.wsxmrAmount * request.xmrPriceAtRequest) / WSXMR_DECIMALS;
        uint256 parDaiAmount = (parValueUsd * SDAI_DECIMALS) / collateralPrice;
        uint256 parShares = _daiToShares(parDaiAmount);
        
        uint256 userBase = parShares < request.lockedCollateral
            ? parShares
            : request.lockedCollateral;

        vault.lockedCollateral -= (request.lockedCollateral + request.rewardCollateral);
        globalPendingBurnDebt -= request.wsxmrAmount;
        
        // Pay par value to holder (no reward for force-settle)
        pendingReturns[request.user][GnosisAddresses.SDAI] += userBase;
        globalPendingSDAI += userBase;
        emit ReturnQueued(request.user, GnosisAddresses.SDAI, userBase);
        
        request.status = BurnStatus.SLASHED;
        emit BurnForceSettled(requestId, userBase);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    function resolveDeclinedProposal(bytes32 requestId) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        BurnRequest storage request = burnRequests[requestId];
        if (request.status != BurnStatus.PROPOSED) revert InvalidStatus();
        if (block.number < request.deadline) revert DeadlineNotExpired();
        
        Vault storage vault = _vaults[request.lpVault];
        
        if (request.vaultLiquidationNonce == vault.liquidationNonce) {
            vault.lockedCollateral -= (request.lockedCollateral + request.rewardCollateral);
            vault.normalizedDebt += request.normalizedDebtAmount;
            globalTotalDebt += request.wsxmrAmount;
        }
        
        globalPendingBurnDebt -= request.wsxmrAmount;
        
        // Restore wsXMR to holder
        IwsXmrHub(address(this)).mintTokens(request.user, request.wsxmrAmount);
        
        request.status = BurnStatus.CANCELLED;
        emit BurnProposalDeclined(requestId);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    function getBurnRequest(bytes32 requestId) external view returns (BurnRequest memory) {
        return burnRequests[requestId];
    }
    
    function getUserBurnRequests(address user) external view returns (bytes32[] memory) {
        return userBurnRequests[user];
    }
    
    function getVaultBurnRequests(address vault) external view returns (bytes32[] memory) {
        return vaultBurnRequests[vault];
    }
    
    function calculateBurnCollateral(address lpVault, uint256 wsxmrAmount) public view returns (uint256 baseLock, uint256 rewardLock) {
        uint256 collateralValue = _getCollateralValueForDebt(wsxmrAmount);
        uint256 baseDai = (collateralValue * BURN_LOCK_RATIO) / RATIO_PRECISION;
        baseLock = _daiToShares(baseDai);
        uint256 rewardUsd = (collateralValue * _vaults[lpVault].burnRewardBps) / BPS_DENOMINATOR;
        rewardLock = _daiToShares(rewardUsd);
    }
    
    function meetsMinimumBurn(address lpVault, uint256 wsxmrAmount) external view returns (bool) {
        if (wsxmrAmount < MIN_BURN_AMOUNT) return false;
        uint256 vaultMin = _vaults[lpVault].minBurnAmount;
        if (vaultMin > 0 && wsxmrAmount < vaultMin) return false;
        return true;
    }
    
    function getActiveBurnCount(address lpVault) external view returns (uint256) {
        bytes32[] storage vaultBurns = vaultBurnRequests[lpVault];
        uint256 count = 0;
        for (uint256 i = 0; i < vaultBurns.length; i++) {
            BurnStatus status = burnRequests[vaultBurns[i]].status;
            if (status == BurnStatus.REQUESTED || status == BurnStatus.PROPOSED || status == BurnStatus.COMMITTED) {
                count++;
            }
        }
        return count;
    }
    
    /// @notice Keeper function to cleanup completed/cancelled burn requests for a vault
    /// @dev Removes inactive requests from vaultBurnRequests array to save gas
    function cleanupVaultBurnRequests(address lpVault) external returns (uint256 removed) {
        bytes32[] storage vaultBurns = vaultBurnRequests[lpVault];
        uint256 initialLength = vaultBurns.length;
        _cleanupBurnRequests(vaultBurns);
        removed = initialLength - vaultBurns.length;
        emit BurnRequestsCleanedUp(lpVault, removed);
    }
    
    
    function _syncVaultYield(address lpAddress) internal {
        Vault storage vault = _vaults[lpAddress];
        
        // Early return if no collateral
        if (vault.collateralShares == 0) return;
        
        // Early return if no debt (skip expensive oracle calls)
        uint256 actualDebt = (vault.normalizedDebt * globalDebtIndex) / 1e18;
        if (actualDebt == 0 && vault.pendingDebt == 0) return;
        
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        
        uint256 yieldShares = YieldLogic.syncVaultYield(
            vault.collateralShares,
            vault.lockedCollateral,
            lpPrincipalShares[lpAddress],
            vault.normalizedDebt,
            vault.pendingDebt,
            globalDebtIndex,
            xmrPrice,
            collateralPrice
        );
        
        if (yieldShares > 0) {
            vault.collateralShares -= yieldShares;
            yieldWarChest += yieldShares;
        }
    }
    
    function _getCollateralValueForDebt(uint256 debtAmount) internal view returns (uint256) {
        return CollateralLogic.getCollateralValueForDebt(debtAmount, _getXmrPriceFromStorage(), COLLATERAL_RATIO);
    }
    
    function _usdToCollateral(uint256 usdValue) internal view returns (uint256) {
        return CollateralLogic.usdToCollateral(usdValue, _getCollateralPriceFromStorage());
    }
    
    function _daiToShares(uint256 daiAmount) internal view returns (uint256) {
        (bool success, bytes memory data) = GnosisAddresses.SDAI.staticcall(
            abi.encodeWithSignature("convertToShares(uint256)", daiAmount)
        );
        require(success && data.length >= 32, "convertToShares failed");
        return abi.decode(data, (uint256));
    }
    
    function _cleanupBurnRequests(bytes32[] storage vaultBurns) internal returns (uint256 activeCount) {
        uint256 writeIndex = 0;
        activeCount = 0;
        
        for (uint256 i = 0; i < vaultBurns.length; i++) {
            BurnStatus status = burnRequests[vaultBurns[i]].status;
            
            if (status == BurnStatus.REQUESTED || 
                status == BurnStatus.PROPOSED || 
                status == BurnStatus.COMMITTED) {
                if (writeIndex != i) {
                    vaultBurns[writeIndex] = vaultBurns[i];
                }
                writeIndex++;
                activeCount++;
            }
        }
        
        while (vaultBurns.length > writeIndex) {
            vaultBurns.pop();
        }
        
        return activeCount;
    }
    
    // ========== DIAMOND INTROSPECTION ==========
    
    /// @notice Returns all function selectors implemented by this facet
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](16);
        sels[0] = this.requestBurn.selector;
        sels[1] = this.requestBurnFromRouter.selector;
        sels[2] = this.proposeHash.selector;
        sels[3] = this.confirmMoneroLock.selector;
        sels[4] = this.finalizeBurn.selector;
        sels[5] = this.claimSlashedCollateral.selector;
        sels[6] = this.abortBurn.selector;
        sels[7] = this.forceSettleBurn.selector;
        sels[8] = this.resolveDeclinedProposal.selector;
        sels[9] = this.getBurnRequest.selector;
        sels[10] = this.getUserBurnRequests.selector;
        sels[11] = this.getVaultBurnRequests.selector;
        sels[12] = this.calculateBurnCollateral.selector;
        sels[13] = this.meetsMinimumBurn.selector;
        sels[14] = this.getActiveBurnCount.selector;
        sels[15] = this.cleanupVaultBurnRequests.selector;
        return sels;
    }
}
