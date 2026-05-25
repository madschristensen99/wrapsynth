// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDataStreamsVerifier} from "../interfaces/external/IDataStreamsVerifier.sol";

/**
 * @title MockVerifierProxy
 * @notice Mock Chainlink Data Streams verifier proxy for testing
 * @dev Accepts any payload and returns an encoded ReportV3 with the pre-set price
 */
contract MockVerifierProxy is IDataStreamsVerifier {
    struct ReportV3 {
        bytes32 feedId;
        uint32 validFromTimestamp;
        uint32 observationsTimestamp;
        uint192 nativeFee;
        uint192 linkFee;
        uint32 expiresAt;
        int192 price;
        int192 bid;
        int192 ask;
    }

    mapping(bytes32 => int192) public prices;

    function setPrice(bytes32 feedId, int192 price) external {
        prices[feedId] = price;
    }

    function verify(bytes calldata payload, bytes calldata) external payable returns (bytes memory) {
        // Decode payload to extract feedId from reportData
        // Payload format: abi.encode(bytes32[3] reportContext, bytes reportData)
        (, bytes memory reportData) = abi.decode(payload, (bytes32[3], bytes));

        // Skip 2-byte schema version, then read 32-byte feedId
        require(reportData.length >= 34, "Invalid report data");
        bytes32 feedId;
        assembly {
            feedId := mload(add(reportData, 34))
        }

        int192 price = prices[feedId];
        require(price != 0, "Price not set for feed");

        // Use block.timestamp for all timestamp fields
        // This ensures prices are always "fresh" in tests since block.timestamp doesn't auto-advance
        ReportV3 memory report = ReportV3({
            feedId: feedId,
            validFromTimestamp: uint32(block.timestamp),
            observationsTimestamp: uint32(block.timestamp),
            nativeFee: 0,
            linkFee: 0,
            expiresAt: uint32(block.timestamp + 365 days), // Far future expiry
            price: price,
            bid: price,
            ask: price
        });

        return abi.encode(report);
    }

}
