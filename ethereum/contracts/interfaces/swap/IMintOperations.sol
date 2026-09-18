// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {wsXmrStorage} from "../../core/wsXmrStorage.sol";
import {IErrors} from "../IErrors.sol";

/**
 * @title IMintOperations
 * @notice Interface for XMR -> wsXMR atomic swap mint operations
 * @dev Implements Farcaster-style PTLC atomic swap with Ed25519 commitments
 * 
 * Flow:
 * 1. User calls initiateMint() with commitment and griefing deposit
 * 2. LP calls provideLPKey() with their public key
 * 3. User locks XMR on Monero using combined keys
 * 4. LP verifies Monero lock, calls setMintReady()
 * 5. LP claims XMR on Monero (reveals secret)
 * 6. Anyone calls finalizeMint() with revealed secret
 */
interface IMintOperations is IErrors {
    // ========== ENUMS ==========
    
    // Note: MintStatus and MintRequest are defined in wsXmrStorage
    // Importing contracts should use those definitions
    
    // Note: MintRequest struct is defined in wsXmrStorage
    
    // ========== EVENTS ==========
    
    event MintInitiated(
        bytes32 indexed requestId,
        address indexed initiator,
        address indexed recipient,
        address lpVault,
        uint256 xmrAmount,
        uint256 wsxmrAmount,
        uint256 feeAmount,
        bytes32 claimCommitment,
        bytes32 userPublicKey,
        uint256 timeout
    );
    
    event LPKeyProvided(bytes32 indexed requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey);
    event MintCollateralLocked(bytes32 indexed requestId, uint256 lockedCollateral);
    event MintReady(bytes32 indexed requestId, bytes32 lpCommitment);
    event SecretRevealed(bytes32 indexed requestId, bytes32 secret);
    event MintFinalized(bytes32 indexed requestId, bytes32 secret);
    event MintCancelled(bytes32 indexed requestId);
    event MintCancelledWithSecret(bytes32 indexed requestId, bytes32 userSecret);
    event MintExpiredReady(bytes32 indexed requestId);
    /// @notice Emitted when a KEY_PROVIDED mint times out into KEY_CANCELLED — non-terminal;
    ///         the parked deposit still awaits LP claim (abandonKeyProvidedMint) or user reclaim.
    event MintKeyCancelled(bytes32 indexed requestId);
    event GriefingDepositClaimed(bytes32 indexed requestId, bytes32 lpSecret);
    event MintGriefingUnclaimed(bytes32 indexed requestId);
    event MintCollateralSlashed(bytes32 indexed requestId, uint256 slashedCollateral);
    
    // ========== ERRORS ==========
    
    error InvalidTimeout();
    error MintAlreadyExists();
    error TimeoutNotReached();
    
    // ========== FUNCTIONS ==========
    
    /// @notice Initiate a mint request
    /// @param lpVault Address of LP vault to use
    /// @param recipient Address to receive wsXMR
    /// @param xmrAmount Amount of XMR in atomic units (12 decimals)
    /// @param claimCommitment Ed25519 commitment (keccak256 of public point)
    /// @param userPublicKey User's compressed Ed25519 public key for address derivation
    /// @return requestId Unique identifier for this request
    function initiateMint(
        address lpVault,
        address recipient,
        uint256 xmrAmount,
        bytes32 claimCommitment,
        bytes32 userPublicKey
    ) external payable returns (bytes32 requestId);
    
    /// @notice LP provides their Ed25519 public keys and commits their secret for atomic swap
    /// @param requestId The mint request ID
    /// @param lpPublicSpendKey LP's Ed25519 public spend key (x-coordinate)
    /// @param lpPublicViewKey LP's Ed25519 public view key (x-coordinate)
    /// @param lpCommitment keccak256(lpSecret·G) — LP's Ed25519 point commitment
    function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey, bytes32 lpCommitment) external;
    
    /// @notice LP confirms XMR has been locked on Monero
    /// @param requestId The mint request ID
    function setMintReady(bytes32 requestId) external;
    
    /// @notice User reveals the Ed25519 secret — verifies commitment and stores secret on-chain
    /// @dev Only reverts on InvalidSecret (user's own error) or InvalidStatus (not READY).
    ///      No external state dependencies — no oracle, no yield sync, no CR check.
    ///      Transitions mint to SECRET_REVEALED. After this, finalizeMint() can be called by anyone.
    /// @param requestId The mint request ID
    /// @param secret The Ed25519 secret (scalar)
    function revealSecret(bytes32 requestId, bytes32 secret) external;
    
    /// @notice Finalize a mint whose secret has been revealed — mints wsXMR to recipient
    /// @dev Permissionless. Reads the verified secret from storage (not calldata).
    ///      No oracle or CR checks — collateral was validated at setMintReady time.
    /// @param requestId The mint request ID
    function finalizeMint(bytes32 requestId) external;
    
    /// @notice Cancel a timed-out mint request (permissionless)
    /// @dev For PENDING: refunds deposit to user. For KEY_PROVIDED: transitions to KEY_CANCELLED
    ///      and parks the deposit (LP claims it by revealing lpSecret; user reclaims after the window).
    ///      For READY: transitions to EXPIRED_READY. For SECRET_REVEALED: executes the mint.
    /// @param requestId The mint request ID
    /// @param userSecret DEPRECATED — ignored, kept for ABI compatibility
    function cancelMint(bytes32 requestId, bytes32 userSecret) external;

    /// @notice LP abandons a keyed mint that never became ready — reveals lpSecret, claims the deposit
    /// @dev Callable from KEY_PROVIDED after the mint timeout, or from KEY_CANCELLED within the
    ///      claim window. Emits lpSecret so the user can recover XMR from the shared address.
    /// @param requestId The mint request ID
    /// @param lpSecret The LP's secret scalar matching lpCommitment
    function abandonKeyProvidedMint(bytes32 requestId, bytes32 lpSecret) external;

    /// @notice Reclaim a parked griefing deposit after the LP's claim window lapses (permissionless)
    /// @param requestId The mint request ID
    function reclaimParkedDeposit(bytes32 requestId) external;

    /// @notice LP claims griefing deposit after mint expired in READY state
    /// @dev LP must reveal lpSecret matching lpCommitment set during setMintReady
    /// @param requestId The mint request ID
    /// @param lpSecret The LP's secret scalar
    function claimGriefingDeposit(bytes32 requestId, bytes32 lpSecret) external;

    /// @notice Sweep unclaimed expired mint after LP claim window passes
    /// @dev Returns griefing deposit to user, bond to LP. Callable by anyone.
    /// @param requestId The mint request ID
    function sweepUnclaimedExpiredMint(bytes32 requestId) external;
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @notice Get mint request details
    function getMintRequest(bytes32 requestId) external view returns (wsXmrStorage.MintRequest memory);
    
    /// @notice Get user's mint request IDs
    function getUserMintRequests(address user) external view returns (bytes32[] memory);
}
