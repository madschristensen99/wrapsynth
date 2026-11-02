// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IMintFacet} from "../interfaces/facets/IMintFacet.sol";
import {IwsXmrHub} from "../interfaces/core/IwsXmrHub.sol";
import {Ed25519} from "../Ed25519.sol";

/**
 * @title MintFacet
 * @notice Handles mint operations for the wsXMR system
 * @dev Manages the minting of wsXMR tokens backed by Monero deposits.
 *      Oracle-free: the vault's thresholdSharesPerWsxmr is the LP's self-declared
 *      quote — mint capacity, key-bond sizing, and the ready-time par lock are all
 *      derived from it. No price feeds gate consensus.
 */
contract MintFacet is wsXmrStorage, IMintFacet {
    // ========== ERRORS ==========

    error ReentrancyGuard();

    // ========== CONSTRUCTOR ==========

    constructor(address _wsxmrToken, address _verifierProxy, uint256 _minThreshold, uint256 _kickBondMin)
        wsXmrStorage(_wsxmrToken, _verifierProxy, _minThreshold, _kickBondMin)
    {}

    // ========== MINT OPERATIONS ==========

    /// @notice Initiate a mint request for a specific LP vault
    /// @dev Requires a non-zero claim commitment and user public key. The vault must
    ///      not be kicked or frozen. The vault's current thresholdSharesPerWsxmr is
    ///      the par-settlement rate off-chain UIs should disclose at request time.
    ///      Non-whitelisted minters must post the vault's griefing deposit; vaults
    ///      with a zero deposit only accept whitelisted minters.
    /// @param lpVault The LP vault address to mint against
    /// @param recipient Address to receive the minted wsXMR
    /// @param xmrAmount Amount of XMR to deposit (in Monero atomic units, 1e12 = 1 XMR)
    /// @param claimCommitment Ed25519 public key for claiming XMR (32 bytes)
    /// @param userPublicKey User's Ed25519 public key for Monero address generation (32 bytes)
    /// @return requestId Unique identifier for this request
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
        if (vaultKicks[lpVault].active || vaultFrozen[lpVault]) revert KickActive();

        Vault storage vault = _vaults[lpVault];

        // Griefing deposit requirement — whitelisted minters bypass; others must
        // meet the vault's configured deposit.
        bool isWhitelisted = whitelistedMinters[lpVault][msg.sender];
        if (!isWhitelisted) {
            if (vault.mintGriefingDeposit == 0) revert InsufficientDeposit();
            if (msg.value < vault.mintGriefingDeposit) revert InsufficientDeposit();
        }

        uint256 wsxmrAmount = xmrAmount / XMR_TO_WSXMR_DIVISOR;
        uint256 feeAmount = (wsxmrAmount * vault.mintFeeBps) / BPS_DENOMINATOR;

        // LP-declared absolute per-mint cap
        if (vault.maxMintWsxmr > 0 && wsxmrAmount > vault.maxMintWsxmr) revert InvalidValue();

        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 totalProjectedDebt = actualDebt + vault.pendingDebt + wsxmrAmount;

        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;

        // Reserve the key bond (110% of par at the vault's declared threshold) in
        // the coverage check — identical to provideLPKey. Without this, a mint can
        // be initiated that the LP can never key, stranding the user's griefing
        // deposit until timeout. Nothing is reserved in storage here — the check
        // is just consistent with what provideLPKey will enforce.
        uint256 bondShares = _parLockFor(wsxmrAmount, vault.thresholdSharesPerWsxmr);

        if (availableCollateral < bondShares) revert InsufficientCollateral();
        uint256 remainingFree = availableCollateral - bondShares;

        if (remainingFree < _requiredCollateral(totalProjectedDebt, vault.thresholdSharesPerWsxmr)) {
            revert InsufficientCollateral();
        }

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
            thresholdAtReady: 0
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
     *      and locks a par-value key bond sized off the CURRENT threshold. The bond is NOT
     *      slashable on cancel — it is released when the LP attests the deposit (setMintReady
     *      converts it to the par lock) or publishes lpSecret (abandonKeyProvidedMint), and
     *      slashed to the user only if the LP never reveals.
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
        if (vaultKicks[request.lpVault].active || vaultFrozen[request.lpVault]) revert KickActive();

        Vault storage vault = _vaults[request.lpVault];
        if (request.vaultMintNonce != vault.mintNonce) revert InvalidStatus();

        // Reserve debt capacity now that the LP has engaged. Reverts if the vault
        // cannot plausibly serve this mint — prevents over-reservation.
        vault.pendingDebt += request.wsxmrAmount;
        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 projectedDebt = actualDebt + vault.pendingDebt;
        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;

        // Compute the par-value key bond — same sizing as the setMintReady lock
        uint256 bondShares = _parLockFor(request.wsxmrAmount, vault.thresholdSharesPerWsxmr);

        if (availableCollateral < bondShares) revert InsufficientCollateral();

        // Re-check coverage with the remaining free collateral after locking the bond
        uint256 remainingFree = availableCollateral - bondShares;
        if (remainingFree < _requiredCollateral(projectedDebt, vault.thresholdSharesPerWsxmr)) {
            revert InsufficientCollateral();
        }

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
    ///      bond locked at provideLPKey is re-priced to par value here using the CURRENT
    ///      threshold and adjusted by the delta. thresholdAtReady is snapshotted on the
    ///      request — it is the par-settlement rate for the swap outcome.
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
        if (vaultKicks[request.lpVault].active || vaultFrozen[request.lpVault]) revert KickActive();

        Vault storage vault = _vaults[request.lpVault];
        if (request.vaultMintNonce != vault.mintNonce) revert InvalidStatus();

        uint256 actualDebt = _denormalizeDebt(vault.normalizedDebt);
        uint256 projectedDebt = actualDebt + vault.pendingDebt;
        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;

        // Re-price the par-value lock at ready time
        uint256 lockShares = _parLockFor(request.wsxmrAmount, vault.thresholdSharesPerWsxmr);

        // availableCollateral already excludes the key bond; adding it back gives the
        // free collateral the new lock must fit within
        uint256 currentLocked = request.lockedCollateral;
        uint256 remainingFree = availableCollateral + currentLocked;
        if (remainingFree < lockShares) revert InsufficientCollateral();
        remainingFree -= lockShares;

        // Re-check coverage with the remaining free collateral after adjustment
        if (remainingFree < _requiredCollateral(projectedDebt, vault.thresholdSharesPerWsxmr)) {
            revert InsufficientCollateral();
        }

        // Adjust the bond to the re-priced lock (top up or release the excess)
        if (lockShares > currentLocked) {
            vault.lockedCollateral += lockShares - currentLocked;
        } else if (lockShares < currentLocked) {
            vault.lockedCollateral -= currentLocked - lockShares;
        }
        request.lockedCollateral = lockShares;
        request.thresholdAtReady = vault.thresholdSharesPerWsxmr;

        request.status = MintStatus.READY;
        request.timeout = block.number + MINT_READY_EXTENSION_BLOCKS;
        vault.pendingMintCount++;
        totalPendingMints++;
        emit MintCollateralLocked(requestId, lockShares);
        emit MintReady(requestId, request.lpCommitment);

        _reentrancyStatus = _NOT_ENTERED;
    }

    /// @notice User reveals the Ed25519 secret — verifies commitment and stores secret on-chain
    /// @dev This function has NO external state dependencies (no coverage check).
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
    ///      No coverage checks — the collateral was validated at setMintReady time.
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
                uint256 rawOut = _rawFromNorm(request.lockedCollateral);
                vault.lockedCollateral -= request.lockedCollateral;
                vault.collateralShares -= request.lockedCollateral;
                pendingReturns[request.initiator][collateralToken] += rawOut;
                emit ReturnQueued(request.initiator, collateralToken, rawOut);
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
    ///      Releases vault.pendingDebt (if reserved and the vault was not liquidated).
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
        // SECRET_REVEALED is excluded — _finalizeMint handles its own release.
        if (originalStatus == MintStatus.KEY_PROVIDED || originalStatus == MintStatus.READY) {
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
                    uint256 rawOut = _rawFromNorm(request.lockedCollateral);
                    vault.collateralShares -= request.lockedCollateral;
                    pendingReturns[request.initiator][collateralToken] += rawOut;
                    emit ReturnQueued(request.initiator, collateralToken, rawOut);
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
                    uint256 rawOut = _rawFromNorm(request.lockedCollateral);
                    vault.collateralShares -= request.lockedCollateral;
                    pendingReturns[request.initiator][collateralToken] += rawOut;
                    emit ReturnQueued(request.initiator, collateralToken, rawOut);
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

    // ========== VIEW FUNCTIONS ==========

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

        // Fill array
        bytes32[] memory result = new bytes32[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < vaultReqs.length; i++) {
            MintRequest storage req = mintRequests[vaultReqs[i]];
            if (req.status == MintStatus.PENDING || req.status == MintStatus.KEY_PROVIDED || req.status == MintStatus.READY || req.status == MintStatus.SECRET_REVEALED || req.status == MintStatus.EXPIRED_READY || req.status == MintStatus.KEY_CANCELLED) {
                result[index] = vaultReqs[i];
                index++;
            }
        }

        return result;
    }

    /// @notice Calculate wsXMR amount from XMR amount
    /// @param xmrAmount Amount of XMR in atomic units (1e12 = 1 XMR)
    /// @return wsxmrAmount Equivalent wsXMR amount (8 decimals)
    function calculateWsxmrAmount(uint256 xmrAmount) external pure returns (uint256 wsxmrAmount) {
        return xmrAmount / XMR_TO_WSXMR_DIVISOR;
    }

    /// @notice Calculate mint fee for a given wsXMR amount and vault
    /// @param lpVault The LP vault address (to get its mintFeeBps)
    /// @param wsxmrAmount Amount of wsXMR to mint
    /// @return feeAmount Fee amount in wsXMR
    function calculateMintFee(address lpVault, uint256 wsxmrAmount) external view returns (uint256 feeAmount) {
        Vault memory vault = _vaults[lpVault];
        return (wsxmrAmount * vault.mintFeeBps) / BPS_DENOMINATOR;
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
