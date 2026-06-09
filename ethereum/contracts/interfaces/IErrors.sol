// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IErrors {
    error ZeroAddress();
    error ZeroAmount();
    error VaultDoesNotExist();
    error InsufficientCollateral();
    error InsufficientDebt();
    error InsufficientBond();
    error InsufficientDeposit();
    error InvalidValue();
    error InvalidSecret();
    error InvalidStatus();
    error Unauthorized();
    error DeadlineExpired();
    error OnlyHub();
    error InvalidCommitment();
    error BurnExceedsVaultDebt();
}
