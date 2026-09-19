// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IHyperLendPool
 * @notice Minimal Aave v3 Pool interface for HyperLend on HyperEVM
 * @dev HyperLend is an Aave v3.6 fork — supply/withdraw/getReserveNormalizedIncome
 *      signatures are identical to upstream Aave v3.
 */
interface IHyperLendPool {
    /**
     * @notice Supply an asset to the pool, minting aTokens to onBehalfOf
     * @param asset The underlying asset address (USDe)
     * @param amount Amount to supply
     * @param onBehalfOf Recipient of the aToken position
     * @param referralCode Referral code (0)
     */
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    /**
     * @notice Withdraw an asset from the pool, burning aTokens
     * @param asset The underlying asset address (USDe)
     * @param amount Amount to withdraw (type(uint256).max = entire balance)
     * @param to Recipient of the underlying
     * @return The actual amount withdrawn
     */
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /**
     * @notice Returns the normalized income (liquidity index) of the reserve, in RAY (1e27)
     * @dev Multiply a scaled aToken balance by this index / 1e27 to get the current
     *      rebased balance including accrued interest.
     * @param asset The underlying asset address
     */
    function getReserveNormalizedIncome(address asset) external view returns (uint256);
}

/**
 * @title IAToken
 * @notice Minimal Aave v3 aToken interface
 */
interface IAToken {
    /// @notice Rebasing balance — grows with accrued interest
    function balanceOf(address account) external view returns (uint256);
    /// @notice Non-rebasing scaled balance (principal / index at interaction time)
    function scaledBalanceOf(address account) external view returns (uint256);
    /// @notice Total scaled supply
    function scaledTotalSupply() external view returns (uint256);
    /// @notice The underlying asset address
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}
