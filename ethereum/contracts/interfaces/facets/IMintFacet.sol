// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IMintOperations} from "../swap/IMintOperations.sol";

/**
 * @title IMintFacet
 * @notice Interface for the MintFacet contract
 * @dev Implements IMintOperations with additional facet-specific functionality
 */
interface IMintFacet is IMintOperations {
    // ========== CONSTANTS ==========
    // Note: Constants are defined in wsXmrStorage:
    // - MIN_MINT_TIMEOUT_BLOCKS
    // - MAX_MINT_TIMEOUT_BLOCKS
    // - DEFAULT_MINT_TIMEOUT_BLOCKS
    // - MINT_READY_EXTENSION_BLOCKS
    
    // ========== ADDITIONAL VIEWS ==========
    
    /// @notice Get all pending mint requests for a vault
    function getVaultPendingMints(address lpVault) external view returns (bytes32[] memory);
    
    /// @notice Calculate wsXMR amount from XMR amount
    function calculateWsxmrAmount(uint256 xmrAmount) external pure returns (uint256);
    
    /// @notice Calculate fee for a given wsXMR amount and vault
    function calculateMintFee(
        address lpVault,
        uint256 wsxmrAmount
    ) external view returns (uint256 feeAmount);
}
