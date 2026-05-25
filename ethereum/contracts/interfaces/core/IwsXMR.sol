// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/**
 * @title IwsXMR
 * @notice Interface for the wrapped synthetic Monero token
 * @dev ERC20 with privileged mint/burn controlled by wsXmrHub
 */
interface IwsXMR is IERC20, IERC20Permit {
    // ========== ERRORS ==========
    
    /// @notice Thrown when caller is not the authorized minter
    error OnlyHub();
    
    // ========== VIEWS ==========
    
    /// @notice Address authorized to mint and burn tokens
    /// @return The hub contract address
    function hub() external view returns (address);
    
    /// @notice Token decimals (8, matching XMR piconero / 1e4)
    /// @return Number of decimals
    function decimals() external view returns (uint8);
    
    // ========== PRIVILEGED OPERATIONS ==========
    
    /// @notice Mint tokens to an address
    /// @dev Only callable by hub
    /// @param to Recipient address
    /// @param amount Amount to mint (8 decimals)
    function mint(address to, uint256 amount) external;
    
    /// @notice Burn tokens from an address
    /// @dev Only callable by hub
    /// @param from Address to burn from
    /// @param amount Amount to burn (8 decimals)
    function burn(address from, uint256 amount) external;
}
