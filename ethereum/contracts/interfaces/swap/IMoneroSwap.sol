// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IMintOperations} from "./IMintOperations.sol";
import {IBurnOperations} from "./IBurnOperations.sol";

/**
 * @title IMoneroSwap
 * @notice Combined interface for Monero atomic swap operations
 * @dev Aggregates mint and burn flows into a single interface, allowing consumers to interact with both swaps via one point of truth.
 */
interface IMoneroSwap is IMintOperations, IBurnOperations {
    // This interface inherits all necessary functions, events, and errors from its components.
}