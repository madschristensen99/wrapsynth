// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockSDAI
 * @notice Mock ERC4626 vault for testing
 * @dev Simplified sDAI implementation with 1:1 share:asset ratio
 */
contract MockSDAI is ERC20 {
    
    IERC20 public immutable asset; // DAI
    uint256 public totalAssets;
    
    constructor(address _asset) ERC20("Savings DAI", "sDAI") {
        asset = IERC20(_asset);
    }
    
    /**
     * @notice Deposit DAI and receive sDAI shares
     */
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(assets > 0, "Zero deposit");
        
        // Transfer DAI from sender
        require(asset.transferFrom(msg.sender, address(this), assets), "Transfer failed");
        
        // Mint shares 1:1 (simplified)
        shares = assets;
        _mint(receiver, shares);
        
        totalAssets += assets;
        
        return shares;
    }
    
    /**
     * @notice Redeem sDAI shares for DAI
     */
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) external returns (uint256 assets) {
        require(shares > 0, "Zero redeem");
        require(balanceOf(owner) >= shares, "Insufficient balance");
        
        // Burn shares
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        
        // Transfer DAI 1:1 (simplified)
        assets = shares;
        require(asset.transfer(receiver, assets), "Transfer failed");
        
        totalAssets -= assets;
        
        return assets;
    }
    
    /**
     * @notice Convert shares to assets (1:1 for simplicity)
     */
    function convertToAssets(uint256 shares) external pure returns (uint256) {
        return shares;
    }
    
    /**
     * @notice Convert assets to shares (1:1 for simplicity)
     */
    function convertToShares(uint256 assets) external pure returns (uint256) {
        return assets;
    }
}
