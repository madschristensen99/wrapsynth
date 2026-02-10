// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrivacySwapHook} from "./PrivacySwapHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/**
 * @title PrivacySwapHookFactory
 * @notice Factory to deploy PrivacySwapHook with CREATE2 for correct address prefix
 */
contract PrivacySwapHookFactory {
    event HookDeployed(address indexed hook, uint256 salt);
    
    /**
     * @notice Deploy PrivacySwapHook with CREATE2
     * @param salt Salt for CREATE2 address generation
     * @param poolManager Uniswap v4 PoolManager address
     * @param wrappedMonero WrappedMonero token address
     * @param mintRelayer MintRelayer contract address
     * @return hook Address of deployed hook
     */
    function deployHook(
        uint256 salt,
        address poolManager,
        address wrappedMonero,
        address mintRelayer
    ) external returns (address hook) {
        // Deploy using CREATE2
        hook = address(new PrivacySwapHook{salt: bytes32(salt)}(
            IPoolManager(poolManager),
            wrappedMonero,
            mintRelayer
        ));
        
        emit HookDeployed(hook, salt);
        return hook;
    }
    
    /**
     * @notice Compute the address of a hook before deployment
     * @param salt Salt for CREATE2 address generation
     * @param poolManager Uniswap v4 PoolManager address
     * @param wrappedMonero WrappedMonero token address
     * @param mintRelayer MintRelayer contract address
     * @return predicted Predicted address of the hook
     */
    function computeAddress(
        uint256 salt,
        address poolManager,
        address wrappedMonero,
        address mintRelayer
    ) external view returns (address predicted) {
        bytes32 bytecodeHash = keccak256(abi.encodePacked(
            type(PrivacySwapHook).creationCode,
            abi.encode(poolManager, wrappedMonero, mintRelayer)
        ));
        
        predicted = address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            bytes32(salt),
            bytecodeHash
        )))));
    }
}
