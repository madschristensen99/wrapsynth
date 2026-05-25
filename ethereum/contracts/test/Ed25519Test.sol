// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ed25519} from "../Ed25519.sol";

/**
 * @title Ed25519Test
 * @notice Test wrapper for Ed25519 library to verify frontend compatibility
 */
contract Ed25519Test {
    /**
     * @notice Test scalarMultBase function
     * @param secret The secret scalar
     * @return px The x-coordinate of the resulting point
     * @return py The y-coordinate of the resulting point
     */
    function testScalarMultBase(uint256 secret) external view returns (uint256 px, uint256 py) {
        return Ed25519.scalarMultBase(secret);
    }

    /**
     * @notice Verify that a secret matches a commitment
     * @param secret The secret to verify
     * @param commitment The expected commitment (keccak256 of public key)
     * @return bool True if secret matches commitment
     */
    function verifyCommitment(uint256 secret, bytes32 commitment) external view returns (bool) {
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(secret);
        bytes32 computedCommitment = keccak256(abi.encodePacked(px, py));
        return computedCommitment == commitment;
    }
}
