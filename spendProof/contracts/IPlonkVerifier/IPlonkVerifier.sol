// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPlonkVerifier {
    function verifyProof(
        uint256[24] calldata proof,
        uint256[70] calldata pubSignals
    ) external view returns (bool);
}