// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IMintOperations} from "./IMintOperations.sol";

/**
 * @title IMintFacet
 * @notice Facet implementation for minting wsXMR tokens.
 * @dev Delegates core logic to IMoneroSwap's mint operations.
 */
interface IMintFacet is IMintOperations {
    // This facet primarily exposes the required functions from IMoneroSwap/IMintOperations
}