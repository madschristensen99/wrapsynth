// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title AaveV3ERC4626Wrapper
 * @notice ERC4626-compatible wrapper for Aave V3 aTokens
 * @dev Wraps Aave V3 Pool interactions to provide ERC4626 interface
 */

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface IAToken is IERC20 {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}

contract AaveV3ERC4626Wrapper is ERC20 {
    IAavePool public immutable aavePool;
    IERC20 public immutable asset;
    IAToken public immutable aToken;
    
    constructor(
        address _aavePool,
        address _aToken,
        string memory _name,
        string memory _symbol
    ) ERC20(_name, _symbol) {
        aavePool = IAavePool(_aavePool);
        aToken = IAToken(_aToken);
        asset = IERC20(aToken.UNDERLYING_ASSET_ADDRESS());
    }
    
    /**
     * @notice Deposit assets and receive shares (ERC4626 compatible)
     * @param assets Amount of underlying asset to deposit
     * @param receiver Address to receive shares
     * @return shares Amount of shares minted
     */
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        // Transfer assets from caller (who should have approved this contract)
        require(asset.transferFrom(msg.sender, address(this), assets), "Transfer failed");
        
        // Approve Aave pool to spend our tokens
        require(asset.approve(address(aavePool), assets), "Approve failed");
        
        // Supply to Aave (receives aTokens 1:1)
        aavePool.supply(address(asset), assets, address(this), 0);
        
        // Mint wrapper shares 1:1 with aTokens received
        shares = assets;
        _mint(receiver, shares);
        
        return shares;
    }
    
    /**
     * @notice Redeem shares for assets (ERC4626 compatible)
     * @param shares Amount of shares to redeem
     * @param receiver Address to receive assets
     * @param owner Address that owns the shares
     * @return assets Amount of assets withdrawn
     */
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        // Burn shares
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        
        // Withdraw from Aave (1:1 with shares)
        assets = aavePool.withdraw(address(asset), shares, receiver);
        
        return assets;
    }
    
    /**
     * @notice Convert shares to assets (ERC4626 compatible)
     * @param shares Amount of shares
     * @return assets Equivalent amount of assets
     */
    function convertToAssets(uint256 shares) external view returns (uint256 assets) {
        // Aave V3 aTokens are 1:1 with underlying (plus accrued interest)
        // For simplicity, we use 1:1 ratio
        // In production, you'd query the actual aToken balance
        return shares;
    }
    
    /**
     * @notice Convert assets to shares (ERC4626 compatible)
     * @param assets Amount of assets
     * @return shares Equivalent amount of shares
     */
    function convertToShares(uint256 assets) external pure returns (uint256 shares) {
        return assets;
    }
    
    /**
     * @notice Get total assets under management
     */
    function totalAssets() external view returns (uint256) {
        return aToken.balanceOf(address(this));
    }
}
