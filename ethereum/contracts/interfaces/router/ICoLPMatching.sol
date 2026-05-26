// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title ICoLPMatching
 * @notice Interface for co-LP matching and balance management
 */
interface ICoLPMatching {
    // ========== STRUCTS ==========
    
    struct LPConfig {
        uint256 maxPositionSize;      // Max sDAI per position
        uint256 maxTotalExposure;     // Max total sDAI in all positions
        uint16 minCollateralRatioBps; // Min wsXMR/sDAI ratio in bps (e.g., 15000 = 150%)
        bool acceptingPositions;      // On/off switch
    }
    
    // ========== EVENTS ==========
    
    event LiquidityAllocated(address indexed lp, uint256 sDAIAmount);
    event LiquidityDeallocated(address indexed lp, uint256 sDAIAmount);
    event UserDepositedWsxmr(address indexed user, uint256 amount);
    event UserWithdrewWsxmr(address indexed user, uint256 amount);
    event WsxmrDeallocated(address indexed account, uint256 amount);
    event LPConfigUpdated(address indexed lp, uint256 maxPositionSize, uint256 maxTotalExposure, uint16 minCollateralRatioBps, bool acceptingPositions);
    
    // ========== ERRORS ==========
    
    error Unauthorized();
    error InvalidAmount();
    error InsufficientBalance();
    error VaultNotActive();
    error VaultUndercollateralized();
    error MaxPositionsReached();
    error LPNotAcceptingPositions();
    error ExceedsMaxPositionSize();
    error ExceedsMaxTotalExposure();
    error InsufficientCollateralRatio();
    error InvalidConfig();
    
    // ========== LP FUNCTIONS ==========
    
    /// @notice LP allocates sDAI for liquidity provision
    /// @param sDAIAmount Amount of sDAI shares to allocate
    function allocateLiquidity(uint256 sDAIAmount) external;
    
    /// @notice Withdraw sDAI balance
    /// @param sDAIAmount Amount to withdraw
    function withdrawSDAI(uint256 sDAIAmount) external;
    
    /// @notice LP sets risk parameters for permissionless matching
    /// @param maxPositionSize Max sDAI per position
    /// @param maxTotalExposure Max total sDAI across all positions
    /// @param minCollateralRatioBps Min collateral ratio in bps (15000 = 150%)
    /// @param acceptingPositions Whether to accept new positions
    function setLPConfig(
        uint256 maxPositionSize,
        uint256 maxTotalExposure,
        uint16 minCollateralRatioBps,
        bool acceptingPositions
    ) external;
    
    // ========== USER FUNCTIONS ==========
    
    /// @notice User deposits wsXMR for liquidity provision
    /// @param amount Amount of wsXMR to deposit
    function depositWsxmr(uint256 amount) external;
    
    /// @notice Withdraw wsXMR balance
    /// @param wsxmrAmount Amount to withdraw
    function withdrawWsXMR(uint256 wsxmrAmount) external;
    
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
    
    /// @notice Get LP's configuration
    function getLPConfig(address lp) external view returns (LPConfig memory);
    
    /// @notice Get LP's available liquidity allocation
    function getLpAvailableLiquidity(address lp) external view returns (uint256);
    
    /// @notice Get LP's total exposure across all positions
    function getLpTotalExposure(address lp) external view returns (uint256);
    
    /// @notice Get user's available wsXMR deposit
    function getUserAvailableWsxmr(address user) external view returns (uint256);
    
    /// @notice Get all withdrawable balances for an account
    function getWithdrawableBalances(address account) external view returns (
        uint256 sDAIBalance,
        uint256 wsxmrBalance,
        uint256 sDAIFees,
        uint256 wsxmrFees
    );
    
    /// @notice Get pending ETH refunds
    function pendingETHRefunds(address account) external view returns (uint256);
}
