// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title ISavingsDAI
 * @notice Interface for Maker's Savings DAI (sDAI) on Gnosis Chain
 * @dev sDAI is an ERC4626 vault that accrues yield from the Dai Savings Rate
 */
interface ISavingsDAI is IERC20 {
    /**
     * @notice Deposit DAI and receive sDAI
     * @param assets Amount of DAI to deposit
     * @param receiver Address to receive sDAI
     * @return shares Amount of sDAI minted
     */
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    
    /**
     * @notice Redeem sDAI for DAI
     * @param shares Amount of sDAI to redeem
     * @param receiver Address to receive DAI
     * @param owner Address that owns the sDAI
     * @return assets Amount of DAI received
     */
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    
    /**
     * @notice Convert DAI amount to sDAI shares
     * @param assets Amount of DAI
     * @return shares Equivalent sDAI shares
     */
    function convertToShares(uint256 assets) external view returns (uint256 shares);
    
    /**
     * @notice Convert sDAI shares to DAI amount
     * @param shares Amount of sDAI
     * @return assets Equivalent DAI amount
     */
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}
