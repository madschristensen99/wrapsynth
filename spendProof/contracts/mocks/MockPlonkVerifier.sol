// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockPlonkVerifier
 * @notice Mock verifier for testing - always returns true
 */
contract MockPlonkVerifier {
    
    bool public shouldPass = true;
    
    function verifyProof(
        uint256[24] calldata, // proof
        uint256[70] calldata  // pubSignals
    ) external view returns (bool) {
        return shouldPass;
    }
    
    function setShouldPass(bool _shouldPass) external {
        shouldPass = _shouldPass;
    }
}
