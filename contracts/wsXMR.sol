// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title wsXMR - Wrapped and Staked Monero
 * @notice ERC-20 token representing wrapped XMR backed by overcollateralized LP vaults
 * @dev Only the VaultManager contract can mint and burn tokens
 */
contract wsXMR is ERC20, Ownable {
    // Address of the VaultManager contract that can mint/burn
    address public vaultManager;

    // Events
    event VaultManagerUpdated(address indexed oldManager, address indexed newManager);

    // Errors
    error OnlyVaultManager();
    error ZeroAddress();

    /**
     * @notice Constructor initializes the token with name and symbol
     * @param _initialOwner Address that will own the contract initially
     */
    constructor(address _initialOwner) ERC20("Wrapsynth Monero", "wsXMR") Ownable(_initialOwner) {
        if (_initialOwner == address(0)) revert ZeroAddress();
    }

    /**
     * @notice Set the VaultManager contract address
     * @param _vaultManager Address of the VaultManager contract
     */
    function setVaultManager(address _vaultManager) external onlyOwner {
        if (_vaultManager == address(0)) revert ZeroAddress();
        address oldManager = vaultManager;
        vaultManager = _vaultManager;
        emit VaultManagerUpdated(oldManager, _vaultManager);
    }

    /**
     * @notice Mint new wsXMR tokens
     * @param _to Address to receive the minted tokens
     * @param _amount Amount of tokens to mint
     */
    function mint(address _to, uint256 _amount) external {
        if (msg.sender != vaultManager) revert OnlyVaultManager();
        _mint(_to, _amount);
    }

    /**
     * @notice Burn wsXMR tokens
     * @param _from Address to burn tokens from
     * @param _amount Amount of tokens to burn
     */
    function burn(address _from, uint256 _amount) external {
        if (msg.sender != vaultManager) revert OnlyVaultManager();
        _burn(_from, _amount);
    }

    /**
     * @notice Returns the number of decimals (8 to match XMR)
     */
    function decimals() public pure override returns (uint8) {
        return 8;
    }
}
