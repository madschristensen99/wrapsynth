// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Ed25519} from "./Ed25519.sol";

contract Ed25519Helper {
    function computeCommitment(bytes32 secret) external view returns (bytes32) {
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        return keccak256(abi.encodePacked(px, py));
    }
    
    function scalarMultBase(uint256 scalar) external view returns (uint256, uint256) {
        return Ed25519.scalarMultBase(scalar);
    }

    function compressPublicKey(uint256 px, uint256 py) external pure returns (uint256) {
        return Ed25519.compressPoint(px, py);
    }
}
