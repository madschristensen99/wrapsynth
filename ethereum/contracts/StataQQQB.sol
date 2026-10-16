// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title StataQQQB
 * @notice Static (non-rebasing) ERC-4626 share token over QQQB on BNB Chain.
 * @dev    QQQB has no lending venue on BNB, so the adapter is a plain 1:1
 *         wrapper — it exists only to satisfy the ISavingsDAI surface that all
 *         collateral call sites use (deposit / redeem / convertToShares /
 *         convertToAssets + IERC20). Shares never appreciate; YieldFacet has
 *         nothing to harvest on this deployment.
 *
 *           - shares are NON-REBASING, minted 1:1 against QQQB actually received
 *           - convertToAssets(shares) == shares
 *           - the solvency invariant
 *               sum(attributed shares) == shareToken.balanceOf(holder)
 *             holds exactly — same as sDAI on Gnosis / stataUSDe on HyperEVM.
 */
contract StataQQQB is ERC20 {
    using SafeERC20 for IERC20;

    /// @notice QQQB — the underlying collateral asset (18 decimals)
    IERC20 public immutable underlying;

    constructor(address _underlying) ERC20("Stata QQQB", "stataQQQB") {
        require(_underlying != address(0), "zero addr");
        underlying = IERC20(_underlying);
    }

    // ========== ERC-4626-ish surface (ISavingsDAI-compatible) ==========

    /// @notice Deposit QQQB, receive static shares 1:1. Shares are minted
    ///         against the amount actually received, so the adapter stays
    ///         solvent even if the underlying ever charges a transfer fee.
    /// @param assets QQQB amount (18 decimals)
    /// @param receiver Recipient of the shares
    /// @return shares Static shares minted
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(assets > 0, "zero assets");
        uint256 before = underlying.balanceOf(address(this));
        underlying.safeTransferFrom(msg.sender, address(this), assets);
        shares = underlying.balanceOf(address(this)) - before;
        require(shares > 0, "no shares minted");
        _mint(receiver, shares);
    }

    /// @notice Redeem static shares for QQQB.
    /// @param shares Static shares to burn
    /// @param receiver Recipient of QQQB
    /// @param owner Share owner (must be msg.sender unless allowance given)
    /// @return assets QQQB received
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(shares > 0, "zero shares");
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        underlying.safeTransfer(receiver, shares);
        return shares;
    }

    /// @notice 1:1 — no yield accrual on this deployment
    function convertToShares(uint256 assets) public pure returns (uint256) {
        return assets;
    }

    /// @notice 1:1 — no yield accrual on this deployment
    function convertToAssets(uint256 shares) public pure returns (uint256) {
        return shares;
    }

    // ========== Additional ERC-4626 surface (completeness) ==========

    /// @notice The underlying asset (QQQB)
    function asset() external view returns (address) {
        return address(underlying);
    }

    /// @notice Total QQQB managed
    function totalAssets() external view returns (uint256) {
        return underlying.balanceOf(address(this));
    }

    /// @notice Mint exactly `shares` static shares by depositing QQQB
    function mint(uint256 shares, address receiver) external returns (uint256 assets) {
        require(shares > 0, "zero shares");
        uint256 before = underlying.balanceOf(address(this));
        underlying.safeTransferFrom(msg.sender, address(this), shares);
        assets = underlying.balanceOf(address(this)) - before;
        require(assets > 0, "no assets received");
        _mint(receiver, assets);
    }

    /// @notice Withdraw exactly `assets` QQQB, burning the required shares
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        require(assets > 0, "zero assets");
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, assets);
        }
        _burn(owner, assets);
        underlying.safeTransfer(receiver, assets);
        return assets;
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxMint(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        return balanceOf(owner);
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf(owner);
    }

    function previewDeposit(uint256 assets) external pure returns (uint256) {
        return assets;
    }

    function previewMint(uint256 shares) external pure returns (uint256) {
        return shares;
    }

    function previewWithdraw(uint256 assets) external pure returns (uint256) {
        return assets;
    }

    function previewRedeem(uint256 shares) external pure returns (uint256) {
        return shares;
    }
}
