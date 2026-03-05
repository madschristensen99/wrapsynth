use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("A computational overflow boundary was hit in u128 downcasting")]
    MathOverflow,
    
    #[msg("The selected Vault PDA is disabled or uninitialized")]
    VaultNotActive,
    
    #[msg("Operation rejected: Vault Health drops below collateralization ratio")]
    InsufficientCollateral,
    
    #[msg("Pyth price feed confidence interval exceeds 10% risk variance")]
    OracleConfidenceTooWide,
    
    #[msg("Pyth Price Update PDA exceeds maximum age timestamp")]
    OraclePriceStale,
    
    #[msg("Provided key fails secp256k1 multiplier validation")]
    InvalidSecret,
    
    #[msg("Signer does not match the associated LP or User record")]
    Unauthorized,
    
    #[msg("Attempted to cancel Request PDA before SLA timeout")]
    DeadlineNotReached,
    
    #[msg("Mint requested surpasses Vault LP configuration thresholds")]
    ExceedsMaxMintBounds,
    
    #[msg("Invalid request status for this operation")]
    InvalidRequestStatus,
    
    #[msg("Insufficient griefing deposit provided")]
    InsufficientGriefingDeposit,
    
    #[msg("Invalid collateral mint")]
    InvalidCollateralMint,
    
    #[msg("Vault health ratio is below minimum threshold")]
    VaultHealthTooLow,
    
    #[msg("Cannot withdraw collateral while vault has active debt")]
    CannotWithdrawWithDebt,
    
    #[msg("Burn deadline has not been reached yet")]
    BurnDeadlineNotReached,
    
    #[msg("Invalid fee or reward parameters")]
    InvalidFeeParameters,
}
