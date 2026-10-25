// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/// @notice Trivial verifier that accepts everything — used by test suites
///         in place of a real RedStone verifier proxy.
contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}
