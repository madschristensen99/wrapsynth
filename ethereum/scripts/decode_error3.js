const { ethers } = require('ethers');

const target = '0x3a23d825';

const errors = [
    'AlreadyInitialized()',
    'BelowMinimumBurn()',
    'BurnAlreadyExists()',
    'BurnExceedsVaultDebt()',
    'BurnInvalidatedByLiquidation()',
    'CancelBurnsFirst()',
    'CooldownActive()',
    'DeadlineExpired()',
    'DeadlineNotExpired()',
    'DeploymentTooAggressive()',
    'ETHTransferFailed()',
    'ExceedsMaxMargin()',
    'GracePeriodOnlyUser()',
    'InsufficientBond()',
    'InsufficientCollateral()',
    'InsufficientDebt()',
    'InsufficientDeposit()',
    'InsufficientLPBuffer()',
    'InvalidCommitment()',
    'InvalidConfig()',
    'InvalidEMAPrice()',
    'InvalidPoolFeeTier()',
    'InvalidRange()',
    'InvalidSecret()',
    'InvalidSpotPrice()',
    'InvalidStatus()',
    'InvalidTimeout()',
    'InvalidValue()',
    'MaxBurnRequestsReached()',
    'MaxVaultsReached()',
    'MintAlreadyExists()',
    'OnlyHub()',
    'OnlyRouter()',
    'OnlyUserCanInitiate()',
    'PoolAlreadyInitialized()',
    'PoolNotInitialized()',
    'PositionInRange()',
    'PositionNotFound()',
    'PriceDeviationTooHigh()',
    'PriceExponentMismatch()',
    'PriceNormalizedToZero()',
    'ReentrancyGuard()',
    'RefundFailed()',
    'SlippageExceeded()',
    'StalePrice()',
    'TimeoutNotReached()',
    'Unauthorized()',
    'UnbalancedPair()',
    'VaultAlreadyExists()',
    'VaultDoesNotExist()',
    'VaultHealthy()',
    'WarChestEmpty()',
    'XMRNotDipped()',
    'ZeroAddress()',
    'ZeroAmount()',
];

let found = false;
for (const err of errors) {
    const hash = ethers.utils.id(err);
    if (hash.slice(0, 10) === target) {
        console.log('MATCH:', err, hash);
        found = true;
    }
}

if (!found) {
    console.log('No exact match');
}
