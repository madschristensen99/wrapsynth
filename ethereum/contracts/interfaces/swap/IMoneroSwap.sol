// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IMintOperations} from "./IMintOperations.sol";
import {IBurnOperations} from "./IBurnOperations.sol";

/**
 * @title IMoneroSwap
 * @notice Combined interface for Monero atomic swap operations
 * @dev Aggregates mint and burn flows into a single interface
 */
interface IMoneroSwap is IMintOperations, IBurnOperations {
    // Combined interface - inherits all from IMintOperations and IBurnOperations
}
