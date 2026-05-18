// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IDataStreamsVerifier
 * @notice Minimal interface for Chainlink Data Streams verifier proxy
 * @dev Compatible with IVerifierProxy from chainlink/contracts but with relaxed pragma
 */
interface IDataStreamsVerifier {
    function verify(bytes calldata payload, bytes calldata parameterPayload) external payable returns (bytes memory verifierResponse);
}
