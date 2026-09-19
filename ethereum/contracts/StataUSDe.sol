// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IHyperLendPool, IAToken} from "./interfaces/external/IHyperLendPool.sol";

/**
 * @title StataUSDe
 * @notice Static (non-rebasing) ERC-4626 share token over HyperLend's USDe aToken.
 * @dev    Wraps the Aave v3 rebasing aToken into a fixed-share token, mirroring the
 *         role sDAI plays in the Gnosis deployment:
 *
 *           - shares are NON-REBASING (they are Aave "scaled" aToken units)
 *           - convertToAssets(shares) = shares * liquidityIndex / 1e27
 *           - the exchange rate grows monotonically with HyperLend supply yield
 *
 *         The adapter custodies the aToken; share supply always equals the
 *         adapter's scaledBalanceOf, so the solvency invariant
 *           sum(attributed shares) == shareToken.balanceOf(holder)
 *         holds exactly — same as sDAI on Gnosis.
 *
 *         Interface matches ISavingsDAI (deposit / redeem / convertToShares /
 *         convertToAssets + IERC20) so all existing call sites work unchanged.
 */
contract StataUSDe is ERC20 {
    using SafeERC20 for IERC20;

    uint256 private constant RAY = 1e27;

    /// @notice HyperLend (Aave v3.6 fork) pool
    IHyperLendPool public immutable pool;
    /// @notice HyperLend USDe aToken (rebasing)
    IAToken public immutable aToken;
    /// @notice USDe — the underlying asset
    IERC20 public immutable underlying;

    constructor(address _pool, address _aToken, address _underlying)
        ERC20("Stata HyperLend USDe", "stataUSDe")
    {
        require(_pool != address(0) && _aToken != address(0) && _underlying != address(0), "zero addr");
        pool = IHyperLendPool(_pool);
        aToken = IAToken(_aToken);
        underlying = IERC20(_underlying);
    }

    // ========== ERC-4626-ish surface (ISavingsDAI-compatible) ==========

    /// @notice Deposit USDe, receive static shares. Shares minted equal the
    ///         scaled aToken delta, so totalSupply() == aToken.scaledBalanceOf(this).
    /// @param assets USDe amount (18 decimals)
    /// @param receiver Recipient of the shares
    /// @return shares Static shares minted
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(assets > 0, "zero assets");
        underlying.safeTransferFrom(msg.sender, address(this), assets);
        underlying.forceApprove(address(pool), assets);

        uint256 scaledBefore = aToken.scaledBalanceOf(address(this));
        pool.supply(address(underlying), assets, address(this), 0);
        shares = aToken.scaledBalanceOf(address(this)) - scaledBefore;
        require(shares > 0, "no shares minted");

        _mint(receiver, shares);
    }

    /// @notice Redeem static shares for USDe.
    /// @param shares Static shares to burn
    /// @param receiver Recipient of USDe
    /// @param owner Share owner (must be msg.sender unless allowance given)
    /// @return assets USDe received
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(shares > 0, "zero shares");
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        assets = convertToAssets(shares);
        require(assets > 0, "zero assets");

        _burn(owner, shares);
        // Withdraw the USDe-equivalent; Aave burns the corresponding scaled amount.
        pool.withdraw(address(underlying), assets, receiver);
    }

    /// @notice Convert USDe assets to static shares at the current liquidity index
    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 index = pool.getReserveNormalizedIncome(address(underlying));
        if (index == 0) return 0;
        return (assets * RAY) / index;
    }

    /// @notice Convert static shares to USDe assets at the current liquidity index
    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 index = pool.getReserveNormalizedIncome(address(underlying));
        return (shares * index) / RAY;
    }

    // ========== Additional ERC-4626 surface (completeness) ==========

    /// @notice The underlying asset (USDe)
    function asset() external view returns (address) {
        return address(underlying);
    }

    /// @notice Total USDe managed (rebased aToken balance)
    function totalAssets() external view returns (uint256) {
        return aToken.balanceOf(address(this));
    }

    /// @notice Mint exactly `shares` static shares by depositing USDe
    function mint(uint256 shares, address receiver) external returns (uint256 assets) {
        assets = convertToAssets(shares);
        require(assets > 0, "zero assets");
        underlying.safeTransferFrom(msg.sender, address(this), assets);
        underlying.forceApprove(address(pool), assets);

        uint256 scaledBefore = aToken.scaledBalanceOf(address(this));
        pool.supply(address(underlying), assets, address(this), 0);
        uint256 minted = aToken.scaledBalanceOf(address(this)) - scaledBefore;
        require(minted > 0, "no shares minted");

        _mint(receiver, minted);
        // Return USDe actually consumed (may differ by wei-level rounding)
        return assets;
    }

    /// @notice Withdraw exactly `assets` USDe, burning the required shares
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        require(assets > 0, "zero assets");
        shares = convertToShares(assets);
        require(shares > 0, "zero shares");
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        pool.withdraw(address(underlying), assets, receiver);
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxMint(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        return convertToAssets(balanceOf(owner));
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf(owner);
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        return convertToShares(assets);
    }

    function previewMint(uint256 shares) external view returns (uint256) {
        return convertToAssets(shares);
    }

    function previewWithdraw(uint256 assets) external view returns (uint256) {
        return convertToShares(assets);
    }

    function previewRedeem(uint256 shares) external view returns (uint256) {
        return convertToAssets(shares);
    }
}
