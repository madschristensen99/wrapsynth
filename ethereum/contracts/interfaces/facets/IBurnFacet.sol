// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IBurnOperations} from "./IBurnOperations.sol";

/**
 * @title IBurnFacet
 * @notice Facet implementation for burning wsXMR tokens.
 * @dev Delegates core logic to IMoneroSwap's burn operations.
 */
interface IBurnFacet is IBurnOperations {
    // This facet primarily exposes the required functions from IMoneroSwap/IBurnOperations
}