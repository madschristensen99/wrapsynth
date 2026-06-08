// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {wsXmrStorage} from "../../core/wsXmrStorage.sol";
import {IErrors} from "../IErrors.sol";

/**
 * @title IBurnOperations
 * @notice Interface for wsXMR -> XMR atomic swap burn operations
 * @dev Three-step atomic swap burn with guaranteed value redemption
 * 
 * Flow:
 * 1. User calls requestBurn() - wsXMR burned, collateral locked, XMR price locked
 * 2. LP locks XMR on Monero, calls proposeHash() with secret hash
 * 3. User verifies Monero lock, calls confirmMoneroLock()
 * 4. User claims XMR on Monero (LP sees secret)
 * 5. LP calls finalizeBurn() with secret to unlock collateral
 * 
 * Failure modes:
 * - No LP responds: User calls abortBurn() to get wsXMR back,
 *   or forceSettleBurn() for guaranteed par sDAI at locked price
 * - LP proposes but holder doesn't commit: resolveDeclinedProposal() after timeout
 *   (wsXMR restored to holder)
 * - LP doesn't reveal secret after commit: User calls claimSlashedCollateral()
 *   (holder receives par sDAI at locked price + reward)
 */
interface IBurnOperations is IErrors {
    // Note: BurnRequest struct is defined in wsXmrStorage
    
    // ========== EVENTS ==========
    
    event BurnRequested(
        bytes32 indexed requestId,
        address indexed user,
        address indexed lpVault,
        uint256 wsxmrAmount,
        uint256 xmrAmount,
        uint256 rewardCollateral,
        bytes32 claimCommitment
    );
    
    event HashProposed(bytes32 indexed requestId, bytes32 secretHash);
    event BurnCommitted(bytes32 indexed requestId, uint256 deadline);
    event BurnFinalized(bytes32 indexed requestId, bytes32 secret, uint256 rewardPaid);
    event BurnRewardShortfall(bytes32 indexed requestId, uint256 expected, uint256 actual);
    event BurnSlashed(bytes32 indexed requestId, address indexed user, uint256 collateralSeized);
    event BurnCancelled(bytes32 indexed requestId);
    event BurnAborted(bytes32 indexed requestId);
    event BurnForceSettled(bytes32 indexed requestId, uint256 sDAIPayout);
    event BurnProposalDeclined(bytes32 indexed requestId);
    
    // ========== ERRORS ==========
    
    error BelowMinimumBurn();
    error MaxBurnRequestsReached();
    error BurnAlreadyExists();
    error OnlyUserCanInitiate();
    error OnlyRouter();
    error DeadlineNotExpired();
    error GracePeriodOnlyUser();
    error BurnInvalidatedByLiquidation();
    
    // ========== FUNCTIONS ==========
    
    /// @notice Request a burn (Step 1)
    /// @dev Burns wsXMR, locks collateral, and records XMR price for settlement.
    /// @param wsxmrAmount Amount of wsXMR to burn
    /// @param lpVault LP vault to handle the burn
    /// @param user Address whose wsXMR to burn (must be msg.sender)
    /// @return requestId Unique identifier
    function requestBurn(
        uint256 wsxmrAmount,
        address lpVault,
        address user,
        bytes32 claimCommitment
    ) external returns (bytes32 requestId);
    
    /// @notice Request burn from router's internal balance
    /// @dev Only callable by authorized liquidity router.
    function requestBurnFromRouter(
        uint256 wsxmrAmount,
        address lpVault,
        address user,
        bytes32 claimCommitment
    ) external returns (bytes32 requestId);
    
    /// @notice LP proposes secret hash after locking XMR (Step 2)
    /// @param requestId The burn request ID
    /// @param secretHash Hash of LP's secret
    function proposeHash(bytes32 requestId, bytes32 secretHash) external;
    
    /// @notice User confirms Monero lock is valid (Step 3)
    /// @param requestId The burn request ID
    function confirmMoneroLock(bytes32 requestId) external;
    
    /// @notice LP reveals secret to unlock collateral (Step 4)
    /// @param requestId The burn request ID
    /// @param secret The secret to reveal
    function finalizeBurn(bytes32 requestId, bytes32 secret) external;
    
    /// @notice Claim slashed collateral after LP commits but fails to reveal
    /// @dev Holder receives par sDAI at locked price + reward
    /// @param requestId The burn request ID
    function claimSlashedCollateral(bytes32 requestId) external;
    
    /// @notice Holder aborts a REQUESTED burn after timeout. wsXMR restored.
    /// @param requestId The burn request ID
    function abortBurn(bytes32 requestId) external;
    
    /// @notice Holder force-settles a REQUESTED burn after timeout for guaranteed par sDAI.
    /// @dev wsXMR stays burned. Holder receives par value in sDAI at locked price.
    /// @param requestId The burn request ID
    function forceSettleBurn(bytes32 requestId) external;
    
    /// @notice Resolve a declined proposal after timeout (permissionless).
    /// @dev wsXMR restored to holder.
    /// @param requestId The burn request ID
    function resolveDeclinedProposal(bytes32 requestId) external;
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @notice Get burn request details
    function getBurnRequest(bytes32 requestId) external view returns (wsXmrStorage.BurnRequest memory);
    
    /// @notice Get user's burn request IDs
    function getUserBurnRequests(address user) external view returns (bytes32[] memory);
    
    /// @notice Get vault's pending burn request IDs
    function getVaultBurnRequests(address vault) external view returns (bytes32[] memory);
}
