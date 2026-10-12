use anchor_lang::prelude::*;

#[error_code]
pub enum WrapSynthError {
    #[msg("Zero address provided")]
    ZeroAddress,
    #[msg("Zero amount provided")]
    ZeroAmount,
    #[msg("Vault already exists")]
    VaultAlreadyExists,
    #[msg("Vault does not exist")]
    VaultDoesNotExist,
    #[msg("Vault not active")]
    VaultNotActive,
    #[msg("Insufficient collateral")]
    InsufficientCollateral,
    #[msg("Fee or reward exceeds maximum")]
    ExceedsMaxMargin,
    #[msg("Invalid mint request")]
    InvalidMintRequest,
    #[msg("Invalid burn request")]
    InvalidBurnRequest,
    #[msg("Mint request already exists")]
    MintAlreadyExists,
    #[msg("Burn request already exists")]
    BurnAlreadyExists,
    #[msg("Invalid secret")]
    InvalidSecret,
    #[msg("Invalid user secret")]
    InvalidUserSecret,
    #[msg("Burn exceeds vault debt")]
    BurnExceedsVaultDebt,
    #[msg("Invalid commitment")]
    InvalidCommitment,
    #[msg("Pending mints must be resolved first")]
    PendingMintLock,
    #[msg("Invalid status for operation")]
    InvalidStatus,
    #[msg("Timeout not reached")]
    TimeoutNotReached,
    #[msg("Deadline expired")]
    DeadlineExpired,
    #[msg("Deadline not yet expired")]
    DeadlineNotExpired,
    #[msg("Vault is healthy, cannot liquidate")]
    VaultHealthy,
    #[msg("Insufficient debt")]
    InsufficientDebt,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid value")]
    InvalidValue,
    #[msg("Stale or invalid price")]
    StalePrice,
    #[msg("Insufficient deposit")]
    InsufficientDeposit,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Active burns must be resolved before liquidation")]
    UnresolvedBurns,
    #[msg("Pool not initialized")]
    PoolNotInitialized,
    #[msg("Below minimum burn amount")]
    BelowMinimumBurn,
    #[msg("Maximum burn requests per vault reached")]
    MaxBurnRequestsReached,
    #[msg("Only user can initiate this operation")]
    OnlyUserCanInitiate,
    #[msg("Burn invalidated by liquidation")]
    BurnInvalidatedByLiquidation,
    #[msg("Buy-and-burn cooldown active")]
    CooldownActive,
    #[msg("XMR price has not dipped below EMA threshold")]
    XMRNotDipped,
    #[msg("Yield war chest is empty")]
    WarChestEmpty,
    #[msg("Debt wipe already in progress")]
    WipeInProgress,
    #[msg("Debt index migration already in progress")]
    MigrationInProgress,
    #[msg("No debt wipe in progress")]
    WipeNotInProgress,
    #[msg("No debt index migration in progress")]
    MigrationNotInProgress,
    #[msg("Maximum vault count reached")]
    MaxVaultsReached,
    #[msg("Liquidity router already set")]
    RouterAlreadySet,
    #[msg("Only liquidity router can call this")]
    OnlyRouter,
    #[msg("Only deployer can call this")]
    OnlyDeployer,
    #[msg("Vault mint nonce mismatch")]
    MintNonceMismatch,
    #[msg("Price normalized to zero")]
    PriceNormalizedToZero,
    #[msg("XMR amount too small (minimum 1e4 atomic units)")]
    XmrAmountTooSmall,
    #[msg("Collateral depegged: minting paused")]
    CollateralDepegged,
}
