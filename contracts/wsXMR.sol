// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title wsXMR - Wrapped Monero
 * @notice Immutable ERC-20 token representing wrapped XMR.
 * @dev Deployed exclusively by the VaultManager. No admin keys exist.
 */
contract wsXMR is ERC20 {
    address public immutable vaultManager;

    error OnlyVaultManager();

    constructor() ERC20("Wrapsynth Monero", "wsXMR") {
        // The contract that deploys this token becomes the vaultManager forever
        vaultManager = msg.sender;
    }

    function mint(address _to, uint256 _amount) external {
        if (msg.sender != vaultManager) revert OnlyVaultManager();
        _mint(_to, _amount);
    }

    function burn(address _from, uint256 _amount) external {
        if (msg.sender != vaultManager) revert OnlyVaultManager();
        _burn(_from, _amount);
    }

    function decimals() public pure override returns (uint8) {
        return 8; 
    }
}
