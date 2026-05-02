// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/**
 * @title IwsXMR
 * @notice Interface for the wrapped synthetic Monero token
 * @dev ERC20 with privileged mint/burn controlled by wsXmrHub
 */
interface IwsXMR is IERC20, IERC20Permit {
    // ========== ERRORS ==========\n    \n    /// @notice Thrown when caller is not the authorized minter\n    error OnlyHub();
    \n    // ========== VIEWS ==========\n    \n    /// @notice Address authorized to mint and burn tokens\n    /// @return The hub contract address\n    function hub() external view returns (address);\n    \n    /// @notice Token decimals (8, matching XMR piconero / 1e4)\n    /// @return Number of decimals\n    function decimals() external view returns (uint8);\n    \n    // ========== PRIVILEGED OPERATIONS ==========\n    \n    /// @notice Mint tokens to an address\n    /// @dev Only callable by hub\n    /// @param to Recipient address\n    /// @param amount Amount to mint (8 decimals)\n    function mint(address to, uint256 amount) external;\n    \n    /// @notice Burn tokens from an address\n    /// @dev Only callable by hub\n    /// @param from Address to burn from\n    /// @param amount Amount to burn (8 decimals)\n    function burn(address from, uint256 amount) external;\n}