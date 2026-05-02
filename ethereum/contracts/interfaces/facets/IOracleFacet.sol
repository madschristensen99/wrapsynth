// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

/**
 * @title IOracleFacet
 * @notice Facet implementation for managing and retrieving external price oracle data.
 * @dev Responsible for interfacing with Pyth or similar sources.
 */
interface IOracleFacet {
    // Placeholder for methods related to fetching/validating prices
    function getPrice(address assetA, address assetB) external view returns (uint256 price);
    function updatePriceData(bytes calldata pythUpdateData) external;
}