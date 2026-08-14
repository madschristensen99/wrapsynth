// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IMintFacet} from "../interfaces/facets/IMintFacet.sol";
import {IwsXmrHub} from "../interfaces/core/IwsXmrHub.sol";
import {Ed25519} from "../Ed25519.sol";
import {CollateralLogic} from "../libraries/CollateralLogic.sol";
import {YieldLogic} from "../libraries/YieldLogic.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {GnosisAddresses} from "../GnosisAddresses.sol";

contract MintFacet is wsXmrStorage, IMintFacet {
    
    error ReentrancyGuard();
    
    constructor(address _wsxmrToken, address _verifierProxy) 
        wsXmrStorage(_wsxmrToken, _verifierProxy) 
    {}
    
    /// @notice Initiate a mint request — user commits to sending XMR and posts a griefing deposit
    /// @dev Creates a mint request in PENDING status. The user's claimCommitment binds them to an Ed25519 secret
    ///      that will be revealed at finalization. Checks vault capacity, collateral ratio, and optional max mint limit.
    ///      Whitelisted minters bypass the griefing deposit requirement.
    /// @param lpVault Address of the LP vault that will serve the mint
    /// @param recipient Address that will receive the minted wsXMR (can differ from msg.sender)
    /// @param xmrAmount Amount of XMR to send (12 decimals, atomic units)
    /// @param claimCommitment keccak256(secret·G) — Ed25519 point commitment binding the user's secret
    /// @param userPublicKey User's Ed25519 public spend key (x-coordinate, 32 bytes)
    /// @return requestId Unique mint request identifier
    function initiateMint(
        address lpVault,
        address recipient,
        uint256 xmrAmount,
        bytes32 claimCommitment,
        bytes32 userPublicKey
    ) external payable returns (bytes32 requestId) {
        if (lpVault == address(0)) revert ZeroAddress();
        if (recipient == address(0)) revert ZeroAddress();
        if (xmrAmount == 0) revert ZeroAmount();
        if (claimCommitment == bytes32(0)) revert InvalidCommitment();
        if (userPublicKey == bytes32(0)) revert InvalidCommitment();
        if (!_vaults[lpVault].active) revert VaultDoesNotExist();
        if (xmrAmount < 1e4) revert ZeroAmount();
        
        Vault storage vault = _vaults[lpVault];
        _syncVaultYield(lpVault);
        
        // P0-2: Check griefing deposit requirement
        // Whitelisted minters can bypass; others must meet vault's configured deposit
        bool isWhitelisted = whitelistedMinters[lpVault][msg.sender];
        if (!isWhitelisted) {
            if (vault.mintGriefingDeposit == 0) revert InsufficientDeposit();
            if (msg.value < vault.mintGriefingDeposit) revert InsufficientDeposit();
        }
        
        uint256 wsxmrAmount = xmrAmount / XMR_TO_WSXMR_DIVISOR;
        uint256 feeAmount = (wsxmrAmount * vault.mintFeeBps) / BPS_DENOMINATOR;
        
        if (vault.maxMintBps > 0) {
            uint256 collateralPrice = _getCollateralPriceFromStorage();
            uint256 availableShares = vault.collateralShares > vault.lockedCollateral
                ? vault.collateralShares - vault.lockedCollateral
                : 0;
            
            // Convert sDAI shares to underlying DAI assets
            uint256 availableForMint = IERC4626(GnosisAddresses.SDAI).convertToAssets(availableShares);
            
            uint256 collateralValueUsd = (availableForMint * collateralPrice) / SDAI_DECIMALS;
            uint256 maxTotalDebtCapacity = (collateralValueUsd * RATIO_PRECISION) / COLLATERAL_RATIO;
            uint256 maxMintAllowed = (maxTotalDebtCapacity * vault.maxMintBps) / BPS_DENOMINATOR;
            
            uint256 xmrPrice = _getXmrPriceFromStorage();
            uint256 wsxmrValueUsd = (wsxmrAmount * xmrPrice) / WSXMR_DECIMALS; // wsXMR has 8 decimals
            
            if (wsxmrValueUsd > maxMintAllowed) revert InvalidValue();
        }
        
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 totalProjectedDebt = actualDebt + vault.pendingDebt + wsxmrAmount;
        
        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral 
            ? vault.collateralShares - vault.lockedCollateral 
            : 0;
        
        uint256 ratio = _calculateCollateralRatio(availableCollateral, totalProjectedDebt);
        if (ratio < COLLATERAL_RATIO) revert InsufficientCollateral();
        
        requestId = keccak256(abi.encodePacked(
            msg.sender,
            lpVault,
            xmrAmount,
            claimCommitment,
            ++_requestNonce
        ));
        
        if (mintRequests[requestId].status != MintStatus.INVALID) revert MintAlreadyExists();
        
        vault.pendingDebt += wsxmrAmount;
        
        uint256 timeoutBlock = block.number + vault.mintTimeoutBlocks;
        mintRequests[requestId] = MintRequest({
            requestId: requestId,
            initiator: msg.sender,
            recipient: recipient,
            lpVault: lpVault,
            xmrAmount: xmrAmount,
            wsxmrAmount: wsxmrAmount,
            feeAmount: feeAmount,
            claimCommitment: claimCommitment,
            userPublicKey: userPublicKey,
            timeout: timeoutBlock,
            griefingDeposit: msg.value,
            normalizedDebtAmount: 0,
            vaultMintNonce: vault.mintNonce,
            lpCommitment: bytes32(0),
            status: MintStatus.PENDING
        });
        
        userMintRequests[msg.sender].push(requestId);
        vaultMintRequests[lpVault].push(requestId);
        
        emit MintInitiated(
            requestId,
            msg.sender,
            recipient,
            lpVault,
            xmrAmount,
            wsxmrAmount,
            feeAmount,
            claimCommitment,
            userPublicKey,
            timeoutBlock
        );
    }
    
    /**
     * @notice LP provides their Ed25519 public keys for atomic swap coordination
     * @dev User combines LP's public keys with their secret to derive shared Monero address
     * @param requestId The mint request ID
     * @param lpPublicSpendKey LP's Ed25519 public spend key (32 bytes, x-coordinate only)
     * @param lpPublicViewKey LP's Ed25519 public view key (32 bytes, x-coordinate only)
     */
    function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external {
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.PENDING) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();
        if (block.number >= request.timeout) revert DeadlineExpired();
        if (lpPublicSpendKey == bytes32(0)) revert InvalidCommitment();
        if (lpPublicViewKey == bytes32(0)) revert InvalidCommitment();
        if (lpPublicKeys[requestId] != bytes32(0)) revert InvalidStatus(); // Already provided
        
        lpPublicKeys[requestId] = lpPublicSpendKey;
        lpPublicViewKeys[requestId] = lpPublicViewKey;
        request.status = MintStatus.KEY_PROVIDED;
        
        emit LPKeyProvided(requestId, lpPublicSpendKey, lpPublicViewKey);
    }
    
    /// @notice LP confirms XMR receipt and signals the mint is ready for finalization
    /// @dev Transitions from KEY_PROVIDED to READY. LP posts their commitment (keccak256 of LP secret·G).
    ///      Re-checks collateral ratio after yield sync to ensure vault is still healthy.
    ///      Extends timeout by MINT_READY_EXTENSION_BLOCKS. Increments vault pendingMintCount and totalPendingMints,
    ///      which blocks other state-changing vault operations until the mint is finalized or cancelled.
    /// @param requestId The mint request ID
    /// @param lpCommitment keccak256(lpSecret·G) — LP's Ed25519 point commitment
    function setMintReady(bytes32 requestId, bytes32 lpCommitment) external {
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.KEY_PROVIDED) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();
        if (block.number >= request.timeout) revert DeadlineExpired();
        if (lpCommitment == bytes32(0)) revert InvalidCommitment();
        
        Vault storage vault = _vaults[request.lpVault];
        if (request.vaultMintNonce != vault.mintNonce) revert InvalidStatus();
        
        _syncVaultYield(request.lpVault);
        
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 projectedDebt = actualDebt + vault.pendingDebt;
        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        uint256 currentRatio = _calculateCollateralRatio(availableCollateral, projectedDebt);
        if (currentRatio < COLLATERAL_RATIO) revert InsufficientCollateral();
        
        request.lpCommitment = lpCommitment;
        request.status = MintStatus.READY;
        request.timeout = block.number + MINT_READY_EXTENSION_BLOCKS;
        vault.pendingMintCount++;
        totalPendingMints++;
        emit MintReady(requestId, lpCommitment);
    }
    
    /// @notice User reveals the Ed25519 secret to finalize the mint — wsXMR is minted to recipient
    /// @dev Verifies scalarMultBase(secret) matches the user's claimCommitment from initiateMint.
    ///      Mints wsXMR (minus fee) to recipient and fee to LP. Returns griefing deposit via pendingReturns.
    ///      Reduces vault.pendingDebt, increases vault.normalizedDebt and globalTotalDebt.
    ///      If the vault was liquidated since the mint was set ready (mintNonce changed), the mint is cancelled
    ///      and the griefing deposit is returned instead.
    /// @param requestId The mint request ID
    /// @param secret The Ed25519 scalar matching the user's claimCommitment
    function finalizeMint(bytes32 requestId, bytes32 secret) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.READY) revert InvalidStatus();
        if (secret == bytes32(0)) revert InvalidSecret();
        
        // Verify the secret matches the commitment
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        bytes32 computedCommitment = keccak256(abi.encodePacked(px, py));
        if (computedCommitment != request.claimCommitment) revert InvalidSecret();
        
        Vault storage vault = _vaults[request.lpVault];
        _syncVaultYield(request.lpVault);
        
        // Low: Re-check CR after yield sync to ensure vault is still healthy
        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        // N-1: pendingDebt already includes request.wsxmrAmount (decremented at line 205)
        uint256 projectedDebt = _denormalizeDebt(vault.normalizedDebt) + vault.pendingDebt;
        uint256 crAfterSync = _calculateCollateralRatio(availableCollateral, projectedDebt);
        if (crAfterSync < COLLATERAL_RATIO) revert InsufficientCollateral();
        
        if (request.vaultMintNonce != vault.mintNonce) {
            request.status = MintStatus.CANCELLED;
            vault.pendingMintCount--;
            totalPendingMints--;
            if (request.griefingDeposit > 0) {
                pendingReturns[request.initiator][address(0)] += request.griefingDeposit;
                emit ReturnQueued(request.initiator, address(0), request.griefingDeposit);
            }
            emit MintCancelled(request.requestId);
            _reentrancyStatus = _NOT_ENTERED;
            return;
        }
        
        vault.pendingDebt -= request.wsxmrAmount;
        uint256 normalizedAmount = (request.wsxmrAmount * 1e18 + globalDebtIndex - 1) / globalDebtIndex;
        vault.normalizedDebt += normalizedAmount;
        request.normalizedDebtAmount = normalizedAmount;
        globalTotalDebt += request.wsxmrAmount;
        
        IwsXmrHub(address(this)).mintTokens(request.recipient, request.wsxmrAmount - request.feeAmount);
        if (request.feeAmount > 0) {
            IwsXmrHub(address(this)).mintTokens(vault.lpAddress, request.feeAmount);
        }
        
        if (request.griefingDeposit > 0) {
            pendingReturns[request.initiator][address(0)] += request.griefingDeposit;
            emit ReturnQueued(request.initiator, address(0), request.griefingDeposit);
        }
        
        vault.pendingMintCount--;
        totalPendingMints--;
        request.status = MintStatus.COMPLETED;
        emit MintFinalized(requestId, secret);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /// @notice Cancel a timed-out mint request — permissionless after the deadline expires
    /// @dev For PENDING or KEY_PROVIDED status: cancels and returns griefing deposit to the user.
    ///      For READY status: transitions to EXPIRED_READY instead — the LP has posted a bond and may
    ///      claim the griefing deposit by revealing their secret within LP_CLAIM_WINDOW_BLOCKS.
    ///      Reduces vault.pendingDebt if the vault has not been liquidated (mintNonce unchanged).
    /// @param requestId The mint request ID
    function cancelMint(bytes32 requestId) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.PENDING && request.status != MintStatus.KEY_PROVIDED && request.status != MintStatus.READY) {
            revert InvalidStatus();
        }
        
        if (block.number < request.timeout) revert TimeoutNotReached();
        
        Vault storage vault = _vaults[request.lpVault];
        if (request.vaultMintNonce == vault.mintNonce) {
            vault.pendingDebt -= request.wsxmrAmount;
        }
        
        MintStatus originalStatus = request.status;
        uint256 depositToTransfer = request.griefingDeposit;
        
        if (originalStatus == MintStatus.PENDING || originalStatus == MintStatus.KEY_PROVIDED) {
            request.status = MintStatus.CANCELLED;
            emit MintCancelled(requestId);
            if (depositToTransfer > 0) {
                pendingReturns[request.initiator][address(0)] += depositToTransfer;
                emit ReturnQueued(request.initiator, address(0), depositToTransfer);
            }
        } else {
            // READY, timed out, user never finalized.
            // Move to EXPIRED_READY — LP must claim with secret reveal.
            request.status = MintStatus.EXPIRED_READY;
            request.timeout = block.number + LP_CLAIM_WINDOW_BLOCKS;
            emit MintExpiredReady(requestId);
        }
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /// @notice LP claims the user's griefing deposit for an expired-ready mint by revealing their secret
    /// @dev Only callable by the LP vault. Verifies that scalarMultBase(lpSecret) matches the LP commitment
    ///      from setMintReady. This proves the LP was ready to finalize and the user abandoned the mint.
    /// @param requestId The mint request ID
    /// @param lpSecret The LP's Ed25519 scalar matching their lpCommitment
    function claimGriefingDeposit(bytes32 requestId, bytes32 lpSecret) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.EXPIRED_READY) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();
        
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 computed = keccak256(abi.encodePacked(px, py));
        if (computed != request.lpCommitment) revert InvalidSecret();
        
        Vault storage vault = _vaults[request.lpVault];
        request.status = MintStatus.CANCELLED;
        vault.pendingMintCount--;
        totalPendingMints--;
        
        if (request.griefingDeposit > 0) {
            pendingReturns[request.lpVault][address(0)] += request.griefingDeposit;
            emit ReturnQueued(request.lpVault, address(0), request.griefingDeposit);
        }
        emit GriefingDepositClaimed(requestId, lpSecret);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /// @notice Permissionless sweep of an expired-ready mint where the LP never claimed the griefing deposit
    /// @dev After LP_CLAIM_WINDOW_BLOCKS expires with no LP claim, returns the griefing deposit to the user.
    ///      This handles the case where the LP abandoned the mint after setting it ready.
    /// @param requestId The mint request ID
    function sweepUnclaimedExpiredMint(bytes32 requestId) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.EXPIRED_READY) revert InvalidStatus();
        if (block.number < request.timeout) revert TimeoutNotReached();
        
        Vault storage vault = _vaults[request.lpVault];
        request.status = MintStatus.CANCELLED;
        vault.pendingMintCount--;
        totalPendingMints--;
        
        // LP never proved liveness — return user's deposit
        if (request.griefingDeposit > 0) {
            pendingReturns[request.initiator][address(0)] += request.griefingDeposit;
            emit ReturnQueued(request.initiator, address(0), request.griefingDeposit);
        }
        emit MintGriefingUnclaimed(requestId);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /// @notice Get full mint request state
    /// @param requestId The mint request ID
    /// @return MintRequest struct with all fields
    function getMintRequest(bytes32 requestId) external view returns (MintRequest memory) {
        return mintRequests[requestId];
    }
    
    /// @notice Get all mint request IDs for a user
    /// @param user Address to query
    /// @return Array of mint request IDs
    function getUserMintRequests(address user) external view returns (bytes32[] memory) {
        return userMintRequests[user];
    }
    
    /// @notice Get all pending mint request IDs for a vault (PENDING, KEY_PROVIDED, READY, or EXPIRED_READY)
    /// @param lpVault Vault address to query
    /// @return Array of active mint request IDs
    function getVaultPendingMints(address lpVault) external view returns (bytes32[] memory) {
        bytes32[] storage vaultReqs = vaultMintRequests[lpVault];
        uint256 count = 0;
        
        // Count pending/ready requests
        for (uint256 i = 0; i < vaultReqs.length; i++) {
            MintRequest storage req = mintRequests[vaultReqs[i]];
            if (req.status == MintStatus.PENDING || req.status == MintStatus.KEY_PROVIDED || req.status == MintStatus.READY || req.status == MintStatus.EXPIRED_READY) {
                count++;
            }
        }
        
        // Collect pending/ready requests
        bytes32[] memory result = new bytes32[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < vaultReqs.length; i++) {
            MintRequest storage req = mintRequests[vaultReqs[i]];
            if (req.status == MintStatus.PENDING || req.status == MintStatus.KEY_PROVIDED || req.status == MintStatus.READY || req.status == MintStatus.EXPIRED_READY) {
                result[index++] = vaultReqs[i];
            }
        }
        
        return result;
    }
    
    /// @notice Convert XMR atomic units (12 decimals) to wsXMR amount (8 decimals)
    /// @param xmrAmount Amount in XMR atomic units
    /// @return Equivalent wsXMR amount
    function calculateWsxmrAmount(uint256 xmrAmount) external pure returns (uint256) {
        return xmrAmount / XMR_TO_WSXMR_DIVISOR;
    }
    
    /// @notice Calculate the mint fee for a given wsXMR amount and vault
    /// @param lpVault The LP vault address
    /// @param wsxmrAmount Amount of wsXMR to mint (8 decimals)
    /// @return Fee amount in wsXMR (8 decimals)
    function calculateMintFee(address lpVault, uint256 wsxmrAmount) external view returns (uint256) {
        return (wsxmrAmount * _vaults[lpVault].mintFeeBps) / BPS_DENOMINATOR;
    }
    
    
    /// @dev Syncs vault yield by harvesting excess sDAI shares generated since the last sync.
    ///      Uses YieldLogic to compute the yield portion (collateral growth above principal).
    ///      Harvested shares are moved from vault.collateralShares to yieldWarChest.
    ///      Skips oracle calls if vault has no debt and no pending debt (gas optimization).
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
            lpPrincipalDeposits[lpAddress],
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
    
    /// @dev Calculates the collateral ratio from sDAI shares and wsXMR debt using current oracle prices.
    ///      Delegates to CollateralLogic.calculateRatioFromShares which converts shares to DAI via sDAI convertToAssets.
    /// @return Ratio as (collateralValueUSD * 100) / debtValueUSD, where 150 = 150%
    function _calculateCollateralRatio(uint256 collateralShares, uint256 debtAmount) internal view returns (uint256) {
        // Read prices directly from storage using inherited helpers
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        return CollateralLogic.calculateRatioFromShares(
            collateralShares,
            debtAmount,
            GnosisAddresses.SDAI,
            collateralPrice,
            xmrPrice
        );
    }
    
    // ========== DIAMOND INTROSPECTION ==========
    
    /// @notice Returns all function selectors implemented by this facet
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](12);
        sels[0] = this.initiateMint.selector;
        sels[1] = this.provideLPKey.selector;
        sels[2] = this.setMintReady.selector;
        sels[3] = this.finalizeMint.selector;
        sels[4] = this.cancelMint.selector;
        sels[5] = this.claimGriefingDeposit.selector;
        sels[6] = this.sweepUnclaimedExpiredMint.selector;
        sels[7] = this.getMintRequest.selector;
        sels[8] = this.getUserMintRequests.selector;
        sels[9] = this.getVaultPendingMints.selector;
        sels[10] = this.calculateWsxmrAmount.selector;
        sels[11] = this.calculateMintFee.selector;
        return sels;
    }
}
