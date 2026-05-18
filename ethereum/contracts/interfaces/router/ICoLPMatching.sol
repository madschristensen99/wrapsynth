// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

/**
 * @title ICoLPMatching
 * @notice Interface for co-LP matching and balance management
 */
interface ICoLPMatching {
    // ========== EVENTS ==========
    
    event LiquidityAllocated(address indexed lp, uint256 sDAIAmount);
    event LiquidityDeallocated(address indexed lp, uint256 sDAIAmount);
    event UserDepositedWsxmr(address indexed user, uint256 amount);
    event UserWithdrewWsxmr(address indexed user, uint256 amount);
    event WsxmrDeallocated(address indexed account, uint256 amount);
    event LpApprovedUser(address indexed lp, address indexed user, uint256 amount);
    event UserApprovedLp(address indexed user, address indexed lp, uint256 amount);
    
    // ========== ERRORS ==========
    
    error Unauthorized();
    error InvalidAmount();
    error InsufficientBalance();
    error VaultNotActive();
    error VaultUndercollateralized();
    error MaxPositionsReached();
    
    // ========== LP FUNCTIONS ==========
    
    /// @notice LP allocates sDAI for liquidity provision
    /// @param sDAIAmount Amount of sDAI shares to allocate
    function allocateLiquidity(uint256 sDAIAmount) external;
    
    /// @notice Withdraw sDAI balance
    /// @param sDAIAmount Amount to withdraw
    function withdrawSDAI(uint256 sDAIAmount) external;
    
    /// @notice LP increases approval for a user
    /// @param user Address of user
    /// @param additionalSDAI Additional sDAI to approve
    function increaseUserApproval(address user, uint256 additionalSDAI) external;
    
    /// @notice LP decreases approval for a user
    /// @param user Address of user
    /// @param reduceSDAI Amount to reduce
    function decreaseUserApproval(address user, uint256 reduceSDAI) external;
    
    // ========== USER FUNCTIONS ==========
    
    /// @notice User deposits wsXMR for liquidity provision
    /// @param amount Amount of wsXMR to deposit
    function depositWsxmr(uint256 amount) external;
    
    /// @notice Withdraw wsXMR balance
    /// @param wsxmrAmount Amount to withdraw
    function withdrawWsXMR(uint256 wsxmrAmount) external;
    
    /// @notice User increases approval for an LP
    /// @param lp Address of LP
    /// @param additionalWsxmr Additional wsXMR to approve
    function increaseLpApproval(address lp, uint256 additionalWsxmr) external;
    
    /// @notice User decreases approval for an LP
    /// @param lp Address of LP
    /// @param reduceWsxmr Amount to reduce
    function decreaseLpApproval(address lp, uint256 reduceWsxmr) external;
    
    /// @notice Burn wsXMR from internal balance to reduce vault debt
    /// @param wsxmrAmount Amount to burn
    /// @param lpVault LP vault for the burn
    /// @return requestId Burn request identifier
    function burnFromInternalBalance(
        uint256 wsxmrAmount,
        address lpVault
    ) external returns (bytes32 requestId);
    
    // ========== ETH MANAGEMENT ==========
    
    /// @notice Withdraw pending ETH refunds
    function withdrawETH() external;
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @notice Get LP's available liquidity allocation
    function getLpAvailableLiquidity(address lp) external view returns (uint256);
    
    /// @notice Get user's available wsXMR deposit
    function getUserAvailableWsxmr(address user) external view returns (uint256);
    
    /// @notice Get LP's approval amount for a user
    function lpApprovalAmount(address lp, address user) external view returns (uint256);
    
    /// @notice Get user's approval amount for an LP
    function userApprovalAmount(address user, address lp) external view returns (uint256);
    
    /// @notice Get all withdrawable balances for an account
    function getWithdrawableBalances(address account) external view returns (
        uint256 sDAIBalance,
        uint256 wsxmrBalance,
        uint256 sDAIFees,
        uint256 wsxmrFees
    );
    
    /// @notice Get pending ETH refunds
    function pendingETHRefunds(address account) external view returns (uint256);
    
    /// @notice Get approval nonce (for front-running protection)
    function approvalNonce(address account) external view returns (uint256);
}
