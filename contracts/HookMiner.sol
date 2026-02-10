// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

/**
 * @title HookMiner
 * @notice Helper contract to deploy hooks with correct address prefix using CREATE2
 */
contract HookMiner {
    // Compute the address for a hook deployed with CREATE2
    function computeAddress(
        address deployer,
        uint256 salt,
        bytes memory creationCode
    ) public pure returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                deployer,
                salt,
                keccak256(creationCode)
            )
        );
        return address(uint160(uint256(hash)));
    }

    // Find a salt that produces a valid hook address
    function findSalt(
        address deployer,
        bytes memory creationCode,
        uint160 flags
    ) public view returns (uint256, address) {
        uint256 salt = 0;
        
        // Try up to 100,000 salts (should find one quickly)
        for (uint256 i = 0; i < 100000; i++) {
            address hookAddress = computeAddress(deployer, salt, creationCode);
            
            // Check if address matches required flags
            if (uint160(hookAddress) & uint160(0xFF << 152) == flags << 152) {
                return (salt, hookAddress);
            }
            
            salt++;
        }
        
        revert("No valid salt found");
    }

    // Deploy a contract using CREATE2
    function deploy(
        uint256 salt,
        bytes memory creationCode
    ) public returns (address) {
        address addr;
        assembly {
            addr := create2(0, add(creationCode, 0x20), mload(creationCode), salt)
            if iszero(extcodesize(addr)) {
                revert(0, 0)
            }
        }
        return addr;
    }
}
