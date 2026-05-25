// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title IMoneroSwapCallback
 * @notice Callback interface for external integrations with atomic swaps
 * @dev Implement to receive notifications about swap state changes
 */
interface IMoneroSwapCallback {
    /// @notice Called when a mint request is ready for finalization
    /// @param requestId The mint request ID
    /// @param lpVault The LP vault handling the mint
    /// @param wsxmrAmount Amount of wsXMR to be minted
    function onMintReady(
        bytes32 requestId,
        address lpVault,
        uint256 wsxmrAmount
    ) external;
    
    /// @notice Called when a burn request needs LP action
    /// @param requestId The burn request ID
    /// @param user The user requesting the burn
    /// @param xmrAmount Amount of XMR to be sent
    function onBurnRequested(
        bytes32 requestId,
        address user,
        uint256 xmrAmount
    ) external;
    
    /// @notice Called when user confirms Monero lock
    /// @param requestId The burn request ID
    /// @param deadline Deadline for LP to reveal secret
    function onBurnCommitted(
        bytes32 requestId,
        uint256 deadline
    ) external;
    
    /// @notice Called when a swap completes successfully
    /// @param requestId The request ID
    /// @param isMint True if mint, false if burn
    function onSwapCompleted(
        bytes32 requestId,
        bool isMint
    ) external;
}
