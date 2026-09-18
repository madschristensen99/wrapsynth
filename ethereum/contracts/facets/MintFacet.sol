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
        
        // NOTE: pendingDebt is NOT reserved here — it is reserved at provideLPKey
        // when the LP actually engages. PENDING mints consume no vault capacity,
        // so spamming initiateMint cannot DoS the vault's minting ability.
        
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
            revealedSecret: bytes32(0),
            status: MintStatus.PENDING,
            lockedCollateral: 0,
            xmrPriceAtReady: 0
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
     * @notice LP provides their Ed25519 public keys and commits their secret for atomic swap coordination
     * @dev User combines LP's public keys with their secret to derive shared Monero address.
     *      LP also posts their secret commitment (keccak256(lpSecret·G)), reserves pendingDebt,
     *      and locks a par-value key bond. The bond is NOT slashable on cancel — it is released
     *      when the LP attests the deposit (setMintReady converts it to the par lock) or publishes
     *      lpSecret (abandonKeyProvidedMint), and slashed to the user only if the LP never reveals.
     *      Since non-reveal is a verifiable on-chain fact, a user who never sent XMR cannot farm
     *      the bond — the LP always reveals to collect the parked griefing deposit.
     * @param requestId The mint request ID
     * @param lpPublicSpendKey LP's Ed25519 public spend key (32 bytes, x-coordinate only)
     * @param lpPublicViewKey LP's Ed25519 public view key (32 bytes, x-coordinate only)
     * @param lpCommitment keccak256(lpSecret·G) — LP's Ed25519 point commitment
     */
    function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey, bytes32 lpCommitment) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.PENDING) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();
        if (block.number >= request.timeout) revert DeadlineExpired();
        if (lpPublicSpendKey == bytes32(0)) revert InvalidCommitment();
        if (lpPublicViewKey == bytes32(0)) revert InvalidCommitment();
        if (lpCommitment == bytes32(0)) revert InvalidCommitment();
        if (lpPublicKeys[requestId] != bytes32(0)) revert InvalidStatus(); // Already provided
        
        Vault storage vault = _vaults[request.lpVault];
        if (request.vaultMintNonce != vault.mintNonce) revert InvalidStatus();
        
        _syncVaultYield(request.lpVault);
        
        // Reserve debt capacity now that the LP has engaged. Reverts if the vault
        // cannot plausibly serve this mint — prevents over-reservation.
        vault.pendingDebt += request.wsxmrAmount;
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 projectedDebt = actualDebt + vault.pendingDebt;
        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;

        // Compute the par-value key bond — same sizing as the setMintReady lock
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        uint256 parValueUsd = (request.wsxmrAmount * xmrPrice) / WSXMR_DECIMALS;
        uint256 parDaiAmount = (parValueUsd * SDAI_DECIMALS) / collateralPrice;
        uint256 lockDaiAmount = (parDaiAmount * MINT_LOCK_RATIO) / RATIO_PRECISION;
        uint256 bondShares = _daiToShares(lockDaiAmount);

        if (availableCollateral < bondShares) revert InsufficientCollateral();

        // Re-check CR with the remaining free collateral after locking the bond
        uint256 remainingFree = availableCollateral - bondShares;
        uint256 currentRatio = _calculateCollateralRatio(remainingFree, projectedDebt);
        if (currentRatio < COLLATERAL_RATIO) revert InsufficientCollateral();

        // Lock the key bond (total model: only increment lockedCollateral)
        vault.lockedCollateral += bondShares;
        request.lockedCollateral = bondShares;

        lpPublicKeys[requestId] = lpPublicSpendKey;
        lpPublicViewKeys[requestId] = lpPublicViewKey;
        request.lpCommitment = lpCommitment;
        request.status = MintStatus.KEY_PROVIDED;
        
        emit MintCollateralLocked(requestId, bondShares);
        emit LPKeyProvided(requestId, lpPublicSpendKey, lpPublicViewKey);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /// @notice LP confirms XMR has been locked on Monero and signals the mint is ready for finalization
    /// @dev Transitions from KEY_PROVIDED to READY. This is the LP's deposit attestation: the key
    ///      bond locked at provideLPKey is re-priced to par value here and adjusted by the delta.
    ///      An LP that attests without a real deposit keeps collateral locked for a mint that will
    ///      mint unbacked wsXMR against its own vault — self-policing.
    ///      Extends timeout by MINT_READY_EXTENSION_BLOCKS.
    ///      Increments vault pendingMintCount and totalPendingMints, which blocks other state-changing
    ///      vault operations until the mint is finalized or cancelled.
    /// @param requestId The mint request ID
    function setMintReady(bytes32 requestId) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.KEY_PROVIDED) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();
        if (block.number >= request.timeout) revert DeadlineExpired();
        
        Vault storage vault = _vaults[request.lpVault];
        if (request.vaultMintNonce != vault.mintNonce) revert InvalidStatus();
        
        _syncVaultYield(request.lpVault);
        
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 projectedDebt = actualDebt + vault.pendingDebt;
        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;

        // Re-price the par-value lock at ready time
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        uint256 parValueUsd = (request.wsxmrAmount * xmrPrice) / WSXMR_DECIMALS;
        uint256 parDaiAmount = (parValueUsd * SDAI_DECIMALS) / collateralPrice;
        uint256 lockDaiAmount = (parDaiAmount * MINT_LOCK_RATIO) / RATIO_PRECISION;
        uint256 lockShares = _daiToShares(lockDaiAmount);

        // availableCollateral already excludes the key bond; adding it back gives the
        // free collateral the new lock must fit within
        uint256 currentLocked = request.lockedCollateral;
        uint256 remainingFree = availableCollateral + currentLocked;
        if (remainingFree < lockShares) revert InsufficientCollateral();
        remainingFree -= lockShares;

        // Re-check CR with the remaining free collateral after adjustment
        uint256 currentRatio = _calculateCollateralRatio(remainingFree, projectedDebt);
        if (currentRatio < COLLATERAL_RATIO) revert InsufficientCollateral();

        // Adjust the bond to the re-priced lock (top up or release the excess)
        if (lockShares > currentLocked) {
            vault.lockedCollateral += lockShares - currentLocked;
        } else if (lockShares < currentLocked) {
            vault.lockedCollateral -= currentLocked - lockShares;
        }
        request.lockedCollateral = lockShares;
        request.xmrPriceAtReady = xmrPrice;
        
        request.status = MintStatus.READY;
        request.timeout = block.number + MINT_READY_EXTENSION_BLOCKS;
        vault.pendingMintCount++;
        totalPendingMints++;
        emit MintCollateralLocked(requestId, lockShares);
        emit MintReady(requestId, request.lpCommitment);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /// @notice User reveals the Ed25519 secret — verifies commitment and stores secret on-chain
    /// @dev This function has NO external state dependencies (no oracle, no yield sync, no CR check).
    ///      It only reverts on InvalidSecret (user's own error) or InvalidStatus (not READY).
    ///      The secret is stored on-chain and the mint transitions to SECRET_REVEALED.
    ///      After this, finalizeMint() can be called by anyone to complete the mint.
    ///      This split ensures the user's secret is only exposed in calldata of a tx that succeeds.
    /// @param requestId The mint request ID
    /// @param secret The Ed25519 scalar matching the user's claimCommitment
    function revealSecret(bytes32 requestId, bytes32 secret) external {
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.READY) revert InvalidStatus();
        if (secret == bytes32(0)) revert InvalidSecret();
        
        // Verify the secret matches the commitment
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        bytes32 computedCommitment = keccak256(abi.encodePacked(px, py));
        if (computedCommitment != request.claimCommitment) revert InvalidSecret();
        
        request.revealedSecret = secret;
        request.status = MintStatus.SECRET_REVEALED;
        emit SecretRevealed(requestId, secret);
    }
    
    /// @notice Finalize a mint whose secret has been revealed — mints wsXMR to recipient
    /// @dev Permissionless. Reads the verified secret from storage (not calldata).
    ///      Mints wsXMR (minus fee) to recipient and fee to LP. Returns griefing deposit via pendingReturns.
    ///      Reduces vault.pendingDebt, increases vault.normalizedDebt and globalTotalDebt.
    ///      If the vault was liquidated since the mint was set ready (mintNonce changed), the mint is cancelled
    ///      and the locked collateral is slashed to the user (their secret is public — the LP can take the XMR).
    ///      No oracle or CR checks — the collateral was validated at setMintReady time.
    /// @param requestId The mint request ID
    function finalizeMint(bytes32 requestId) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.SECRET_REVEALED) revert InvalidStatus();
        _finalizeMint(requestId);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /// @dev Shared finalize logic used by finalizeMint and by cancelMint's SECRET_REVEALED branch.
    ///      Caller must have verified status == SECRET_REVEALED and hold the reentrancy guard.
    function _finalizeMint(bytes32 requestId) internal {
        MintRequest storage request = mintRequests[requestId];
        Vault storage vault = _vaults[request.lpVault];
        
        if (request.vaultMintNonce != vault.mintNonce) {
            request.status = MintStatus.CANCELLED;
            vault.pendingMintCount--;
            totalPendingMints--;
            // Release the debt reservation — liquidation never touches pendingDebt, so the
            // reservation is still held and must be freed here. The nonce guard applies to
            // collateral only, never to debt.
            if (vault.pendingDebt < request.wsxmrAmount) {
                vault.pendingDebt = 0;
            } else {
                vault.pendingDebt -= request.wsxmrAmount;
            }
            // Vault was liquidated post-reveal — the user's secret is public, so the LP can
            // sweep the XMR. Compensate the user with the locked collateral if still held.
            if (request.lockedCollateral > 0 && vault.lockedCollateral >= request.lockedCollateral
                && vault.collateralShares >= request.lockedCollateral) {
                vault.lockedCollateral -= request.lockedCollateral;
                vault.collateralShares -= request.lockedCollateral;
                pendingReturns[request.initiator][GnosisAddresses.SDAI] += request.lockedCollateral;
                globalPendingSDAI += request.lockedCollateral;
                emit ReturnQueued(request.initiator, GnosisAddresses.SDAI, request.lockedCollateral);
                emit MintCollateralSlashed(requestId, request.lockedCollateral);
            }
            if (request.griefingDeposit > 0) {
                pendingReturns[request.initiator][address(0)] += request.griefingDeposit;
                emit ReturnQueued(request.initiator, address(0), request.griefingDeposit);
            }
            emit MintCancelled(request.requestId);
            return;
        }

        // Release locked collateral — mint succeeded, reservation no longer needed
        if (request.lockedCollateral > 0) {
            vault.lockedCollateral -= request.lockedCollateral;
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
        emit MintFinalized(requestId, request.revealedSecret);
    }
    
    /// @notice Cancel a timed-out mint request — permissionless after the deadline expires
    /// @dev For PENDING status: cancels and returns griefing deposit to the user. No debt was
    ///      reserved and no collateral was locked — the LP never engaged.
    ///      For KEY_PROVIDED status: transitions to KEY_CANCELLED and parks the griefing deposit.
    ///      The key bond stays locked — it backs the LP's obligation to publish lpSecret via
    ///      abandonKeyProvidedMint (which lets the user recover any XMR at the shared address).
    ///      If the LP never reveals within LP_CLAIM_WINDOW_BLOCKS, reclaimParkedDeposit slashes
    ///      the bond to the user and returns the deposit.
    ///      For READY status: transitions to EXPIRED_READY — the LP may claim the griefing deposit
    ///      by revealing their secret within LP_CLAIM_WINDOW_BLOCKS.
    ///      For SECRET_REVEALED status: the secret is already public, so the mint MUST complete —
    ///      cancelling would let the LP sweep the XMR while paying nothing. Executes finalize.
    ///      Reduces vault.pendingDebt (if reserved and the vault was not liquidated).
    /// @param requestId The mint request ID
    /// @param userSecret DEPRECATED — ignored. Retained in the signature for ABI compatibility
    ///        with existing callers; no secret is required for any cancel path.
    function cancelMint(bytes32 requestId, bytes32 userSecret) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        (userSecret); // silence unused-parameter warning — no path requires it anymore
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.PENDING && request.status != MintStatus.KEY_PROVIDED && request.status != MintStatus.READY && request.status != MintStatus.SECRET_REVEALED) {
            revert InvalidStatus();
        }
        
        if (block.number < request.timeout) revert TimeoutNotReached();
        
        Vault storage vault = _vaults[request.lpVault];
        MintStatus originalStatus = request.status;
        uint256 depositToTransfer = request.griefingDeposit;
        
        // Release reserved debt for mints that engaged the LP (KEY_PROVIDED/READY).
        // SECRET_REVEALED is excluded — _finalizeMint handles its own debt accounting.
        // Unconditional: liquidation never touches pendingDebt, so the reservation is
        // still held even when the nonce no longer matches.
        if (originalStatus != MintStatus.PENDING && originalStatus != MintStatus.SECRET_REVEALED) {
            if (vault.pendingDebt < request.wsxmrAmount) {
                vault.pendingDebt = 0;
            } else {
                vault.pendingDebt -= request.wsxmrAmount;
            }
        }
        
        if (originalStatus == MintStatus.PENDING) {
            request.status = MintStatus.CANCELLED;
            emit MintCancelled(requestId);
            if (depositToTransfer > 0) {
                pendingReturns[request.initiator][address(0)] += depositToTransfer;
                emit ReturnQueued(request.initiator, address(0), depositToTransfer);
            }
        } else if (originalStatus == MintStatus.KEY_PROVIDED) {
            // LP keyed but the mint never became READY — either no deposit arrived or the LP
            // ghosted. The key bond stays locked: it is released if the LP publishes lpSecret,
            // slashed to the user if they don't. Park the deposit as the reveal bounty.
            request.status = MintStatus.KEY_CANCELLED;
            request.timeout = block.number + LP_CLAIM_WINDOW_BLOCKS;
            emit MintKeyCancelled(requestId);
        } else if (originalStatus == MintStatus.SECRET_REVEALED) {
            // Secret already public via SecretRevealed — mint anyway (see _finalizeMint).
            _finalizeMint(requestId);
        } else {
            // READY, timed out, user never finalized.
            // Move to EXPIRED_READY — LP must claim with secret reveal.
            request.status = MintStatus.EXPIRED_READY;
            request.timeout = block.number + LP_CLAIM_WINDOW_BLOCKS;
            emit MintExpiredReady(requestId);
        }
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /// @notice LP abandons a keyed mint that never became ready — reveals lpSecret and claims the deposit
    /// @dev Callable from KEY_PROVIDED after the mint timeout, or from KEY_CANCELLED within the
    ///      LP claim window. Verifies scalarMultBase(lpSecret) == lpCommitment, pays the griefing
    ///      deposit to the LP, and emits lpSecret on-chain — the user combines it with their own
    ///      userSecret to sweep any XMR they sent to the shared Monero address. This prices the
    ///      lpSecret at the deposit amount: the LP is paid to publish the key that makes the user
    ///      whole, and a user who never sent XMR forfeits the deposit for wasting LP engagement.
    /// @param requestId The mint request ID
    /// @param lpSecret The LP's Ed25519 scalar matching their lpCommitment
    function abandonKeyProvidedMint(bytes32 requestId, bytes32 lpSecret) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.KEY_PROVIDED && request.status != MintStatus.KEY_CANCELLED) {
            revert InvalidStatus();
        }
        if (msg.sender != request.lpVault) revert Unauthorized();
        
        Vault storage vault = _vaults[request.lpVault];
        
        if (request.status == MintStatus.KEY_PROVIDED) {
            // Direct abandon — only after the mint timeout so the LP cannot key-then-instant-
            // abandon to farm griefing deposits from users who were about to send XMR.
            if (block.number < request.timeout) revert TimeoutNotReached();
            // Release the debt reservation unconditionally — liquidation never touches
            // pendingDebt, so it is still held even when the nonce no longer matches.
            if (vault.pendingDebt < request.wsxmrAmount) {
                vault.pendingDebt = 0;
            } else {
                vault.pendingDebt -= request.wsxmrAmount;
            }
        } else {
            // KEY_CANCELLED — must claim within the parked-deposit window.
            if (block.number >= request.timeout) revert DeadlineExpired();
        }
        
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 computed = keccak256(abi.encodePacked(px, py));
        if (computed != request.lpCommitment) revert InvalidSecret();
        
        request.status = MintStatus.CANCELLED;
        
        // Release the key bond — the LP fulfilled their obligation by publishing lpSecret.
        // Guard covers the liquidation-takeover case where lockedCollateral was zeroed.
        if (request.lockedCollateral > 0 && vault.lockedCollateral >= request.lockedCollateral) {
            vault.lockedCollateral -= request.lockedCollateral;
            request.lockedCollateral = 0;
        }
        
        if (request.griefingDeposit > 0) {
            pendingReturns[request.lpVault][address(0)] += request.griefingDeposit;
            emit ReturnQueued(request.lpVault, address(0), request.griefingDeposit);
        }
        // lpSecret is revealed on-chain — user reads it and combines with userSecret to sweep XMR
        emit MintCancelled(requestId);
        emit GriefingDepositClaimed(requestId, lpSecret);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /// @notice Reclaim a parked griefing deposit after the LP's claim window lapses
    /// @dev Permissionless — the deposit always goes to the initiator. Covers the dead-LP case:
    ///      the mint was cancelled from KEY_PROVIDED and the LP never published lpSecret, so the
    ///      key bond is slashed to the user as compensation for any XMR stuck at the shared
    ///      address. If the vault was liquidated mid-window (mintNonce changed), the bond is not
    ///      slashed — it was already handled by liquidation.
    /// @param requestId The mint request ID
    function reclaimParkedDeposit(bytes32 requestId) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.KEY_CANCELLED) revert InvalidStatus();
        if (block.number < request.timeout) revert TimeoutNotReached();
        
        request.status = MintStatus.CANCELLED;
        
        // Release the key bond reservation. If the vault was not liquidated, slash it to
        // the user — LP never revealed lpSecret. If liquidated (nonce changed), release it
        // back to the vault's free balance instead of leaving it locked forever.
        Vault storage vault = _vaults[request.lpVault];
        if (request.lockedCollateral > 0) {
            if (request.vaultMintNonce == vault.mintNonce) {
                if (vault.lockedCollateral >= request.lockedCollateral) {
                    vault.lockedCollateral -= request.lockedCollateral;
                }
                if (vault.collateralShares >= request.lockedCollateral) {
                    vault.collateralShares -= request.lockedCollateral;
                    pendingReturns[request.initiator][GnosisAddresses.SDAI] += request.lockedCollateral;
                    globalPendingSDAI += request.lockedCollateral;
                    emit ReturnQueued(request.initiator, GnosisAddresses.SDAI, request.lockedCollateral);
                }
                emit MintCollateralSlashed(requestId, request.lockedCollateral);
            } else if (vault.lockedCollateral >= request.lockedCollateral) {
                vault.lockedCollateral -= request.lockedCollateral;
            }
        }
        
        if (request.griefingDeposit > 0) {
            pendingReturns[request.initiator][address(0)] += request.griefingDeposit;
            emit ReturnQueued(request.initiator, address(0), request.griefingDeposit);
        }
        emit MintCancelled(requestId);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /// @notice LP claims the user's griefing deposit for an expired-ready mint by revealing their secret
    /// @dev Only callable by the LP vault. Verifies that scalarMultBase(lpSecret) matches the LP commitment
    ///      from provideLPKey. This proves the LP was ready to finalize and the user abandoned the mint.
    ///      The LP's secret is revealed via the GriefingDepositClaimed event — the user can read it
    ///      and combine with their own secret to recover the XMR from the shared Monero address.
    ///      Releases the locked par-value collateral back to the vault (LP keeps their collateral).
    /// @param requestId The mint request ID
    /// @param lpSecret The LP's Ed25519 scalar matching their lpCommitment
    function claimGriefingDeposit(bytes32 requestId, bytes32 lpSecret) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.EXPIRED_READY) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();
        // Enforce the LP claim window — after it lapses the deposit belongs to the sweep.
        if (block.number >= request.timeout) revert DeadlineExpired();
        
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 computed = keccak256(abi.encodePacked(px, py));
        if (computed != request.lpCommitment) revert InvalidSecret();
        
        Vault storage vault = _vaults[request.lpVault];
        request.status = MintStatus.CANCELLED;
        vault.pendingMintCount--;
        totalPendingMints--;
        
        // Release locked collateral back to vault — LP revealed their secret, user can recover XMR
        if (request.lockedCollateral > 0 && vault.lockedCollateral >= request.lockedCollateral) {
            vault.lockedCollateral -= request.lockedCollateral;
        }
        
        if (request.griefingDeposit > 0) {
            pendingReturns[request.lpVault][address(0)] += request.griefingDeposit;
            emit ReturnQueued(request.lpVault, address(0), request.griefingDeposit);
        }
        // LP secret is revealed on-chain — user reads it and combines with their secret to sweep XMR
        emit GriefingDepositClaimed(requestId, lpSecret);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    /// @notice Permissionless sweep of an expired-ready mint where the LP never claimed the griefing deposit
    /// @dev After LP_CLAIM_WINDOW_BLOCKS expires with no LP claim, slashes par-value collateral to the user
    ///      and returns the griefing deposit. This compensates the user for the XMR stuck at the shared
    ///      Monero address when the LP ghosts after setMintReady.
    ///      If the vault was liquidated since the mint was set ready (mintNonce changed), the locked
    ///      collateral is not slashed (it was already handled by liquidation).
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
        
        // Release the par-value lock. If the vault was not liquidated, slash it to the
        // user — LP ghosted. If liquidated (nonce changed), release it back to the
        // vault's free balance instead of leaving it locked forever.
        if (request.lockedCollateral > 0) {
            if (request.vaultMintNonce == vault.mintNonce) {
                if (vault.lockedCollateral >= request.lockedCollateral) {
                    vault.lockedCollateral -= request.lockedCollateral;
                }
                if (vault.collateralShares >= request.lockedCollateral) {
                    vault.collateralShares -= request.lockedCollateral;
                    pendingReturns[request.initiator][GnosisAddresses.SDAI] += request.lockedCollateral;
                    globalPendingSDAI += request.lockedCollateral;
                    emit ReturnQueued(request.initiator, GnosisAddresses.SDAI, request.lockedCollateral);
                }
                emit MintCollateralSlashed(requestId, request.lockedCollateral);
            } else if (vault.lockedCollateral >= request.lockedCollateral) {
                vault.lockedCollateral -= request.lockedCollateral;
            }
        }
        
        // Return user's griefing deposit
        if (request.griefingDeposit > 0) {
            pendingReturns[request.initiator][address(0)] += request.griefingDeposit;
            emit ReturnQueued(request.initiator, address(0), request.griefingDeposit);
        }
        
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
            if (req.status == MintStatus.PENDING || req.status == MintStatus.KEY_PROVIDED || req.status == MintStatus.READY || req.status == MintStatus.SECRET_REVEALED || req.status == MintStatus.EXPIRED_READY || req.status == MintStatus.KEY_CANCELLED) {
                count++;
            }
        }
        
        // Collect pending/ready requests
        bytes32[] memory result = new bytes32[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < vaultReqs.length; i++) {
            MintRequest storage req = mintRequests[vaultReqs[i]];
            if (req.status == MintStatus.PENDING || req.status == MintStatus.KEY_PROVIDED || req.status == MintStatus.READY || req.status == MintStatus.SECRET_REVEALED || req.status == MintStatus.EXPIRED_READY || req.status == MintStatus.KEY_CANCELLED) {
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
        
        // Skip yield extraction if oracle price is stale — don't block mint operations
        if (block.timestamp > lastXmrPriceTimestamp + 120 || block.timestamp > lastCollateralPriceTimestamp + 120) return;
        
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

    /// @dev Convert DAI amount to sDAI shares via staticcall to the sDAI contract's convertToShares
    function _daiToShares(uint256 daiAmount) internal view returns (uint256) {
        (bool success, bytes memory data) = GnosisAddresses.SDAI.staticcall(
            abi.encodeWithSignature("convertToShares(uint256)", daiAmount)
        );
        require(success && data.length >= 32, "convertToShares failed");
        return abi.decode(data, (uint256));
    }
    
    // ========== DIAMOND INTROSPECTION ==========
    
    /// @notice Returns all function selectors implemented by this facet
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](15);
        sels[0] = this.initiateMint.selector;
        sels[1] = this.provideLPKey.selector;
        sels[2] = this.setMintReady.selector;
        sels[3] = this.revealSecret.selector;
        sels[4] = this.finalizeMint.selector;
        sels[5] = this.cancelMint.selector;
        sels[6] = this.claimGriefingDeposit.selector;
        sels[7] = this.sweepUnclaimedExpiredMint.selector;
        sels[8] = this.abandonKeyProvidedMint.selector;
        sels[9] = this.reclaimParkedDeposit.selector;
        sels[10] = this.getMintRequest.selector;
        sels[11] = this.getUserMintRequests.selector;
        sels[12] = this.getVaultPendingMints.selector;
        sels[13] = this.calculateWsxmrAmount.selector;
        sels[14] = this.calculateMintFee.selector;
        return sels;
    }
}
