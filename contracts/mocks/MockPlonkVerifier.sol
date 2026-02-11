// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockPlonkVerifier
 * @notice Mock PLONK verifier for testing purposes
 */
contract MockPlonkVerifier {
    bool public shouldRevert = false;
    bool public verifyResult = true;
    
    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }
    
    function setVerifyResult(bool _result) external {
        verifyResult = _result;
    }
    
    function verifyProof(
        bytes memory proof,
        uint256[] memory pubSignals
    ) public view returns (bool) {
        require(!shouldRevert, "Mock verifier: forced revert");
        return verifyResult;
    }
}
