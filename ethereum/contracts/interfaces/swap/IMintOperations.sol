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
        uint256 timeout
    );
    
    event LPKeyProvided(bytes32 indexed requestId, bytes32 lpPublicKey);
    event MintReady(bytes32 indexed requestId);
    event MintFinalized(bytes32 indexed requestId, bytes32 secret);
    event MintCancelled(bytes32 indexed requestId);
    
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
    /// @return requestId Unique identifier for this request
    function initiateMint(
        address lpVault,
        address recipient,
        uint256 xmrAmount,
        bytes32 claimCommitment
    ) external payable returns (bytes32 requestId);
    
    /// @notice LP provides their Ed25519 public key for atomic swap
    /// @param requestId The mint request ID
    /// @param lpPublicKey LP's Ed25519 public key (x-coordinate)
    function provideLPKey(bytes32 requestId, bytes32 lpPublicKey) external;
    
    /// @notice LP confirms XMR has been locked on Monero
    /// @param requestId The mint request ID
    function setMintReady(bytes32 requestId) external payable;
    
    /// @notice Finalize mint by revealing the secret
    /// @param requestId The mint request ID
    /// @param secret The Ed25519 secret (scalar)
    function finalizeMint(bytes32 requestId, bytes32 secret) external;
    
    /// @notice Cancel a timed-out mint request (permissionless)
    /// @param requestId The mint request ID
    function cancelMint(bytes32 requestId) external;
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @notice Get mint request details
    function getMintRequest(bytes32 requestId) external view returns (wsXmrStorage.MintRequest memory);
    
    /// @notice Get user's mint request IDs
    function getUserMintRequests(address user) external view returns (bytes32[] memory);
}
