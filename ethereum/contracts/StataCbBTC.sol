// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title StataCbBTC
 * @notice Static (non-rebasing) ERC-4626-style share token over cbBTC on Base.
 * @dev    cbBTC has no lending venue on Base, so the adapter is a plain
 *         wrapper — it exists only to satisfy the ISavingsDAI surface that all
 *         collateral call sites use (deposit / redeem / convertToShares /
 *         convertToAssets + IERC20). Shares never appreciate; YieldFacet has
 *         nothing to harvest on this deployment.
 *
 *         DECIMALS: cbBTC is 8-decimal, but every collateral call site values
 *         shares as 18-decimal USD-priced units (shares × price / 1e18).
 *         The adapter therefore mints SCALE (1e10) shares per raw cbBTC unit —
 *         1 whole cbBTC (1e8 raw) ↔ 1e18 shares — so protocol math is
 *         identical to the 18-decimal QQQB/USDe deployments.
 *
 *           - shares are NON-REBASING, minted SCALE:1 against cbBTC received
 *           - convertToAssets(shares) == shares / SCALE
 *           - the solvency invariant
 *               sum(attributed shares) == shareToken.balanceOf(holder)
 *             holds exactly — same as sDAI on Gnosis / stataUSDe on HyperEVM.
 */
contract StataCbBTC is ERC20 {
    using SafeERC20 for IERC20;

    /// @notice Shares per raw cbBTC unit (8-dec → 18-dec)
    uint256 public constant SCALE = 1e10;

    /// @notice cbBTC — the underlying collateral asset (8 decimals)
    IERC20 public immutable underlying;

    constructor(address _underlying) ERC20("Stata cbBTC", "stataCbBTC") {
        require(_underlying != address(0), "zero addr");
        underlying = IERC20(_underlying);
    }

    // ========== ERC-4626-ish surface (ISavingsDAI-compatible) ==========

    /// @notice Deposit cbBTC, receive static shares at SCALE:1. Shares are
    ///         minted against the amount actually received, so the adapter
    ///         stays solvent even if the underlying ever charges a fee.
    /// @param assets cbBTC amount (8 decimals)
    /// @param receiver Recipient of the shares
    /// @return shares Static shares minted (18 decimals)
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(assets > 0, "zero assets");
        uint256 before = underlying.balanceOf(address(this));
        underlying.safeTransferFrom(msg.sender, address(this), assets);
        uint256 received = underlying.balanceOf(address(this)) - before;
        shares = received * SCALE;
        require(shares > 0, "no shares minted");
        _mint(receiver, shares);
    }

    /// @notice Redeem static shares for cbBTC.
    /// @param shares Static shares to burn (18 decimals)
    /// @param receiver Recipient of cbBTC
    /// @param owner Share owner (must be msg.sender unless allowance given)
    /// @return assets cbBTC received (8 decimals)
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(shares > 0, "zero shares");
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        assets = shares / SCALE;
        require(assets > 0, "dust redeem");
        underlying.safeTransfer(receiver, assets);
    }

    /// @notice assets → shares at SCALE:1 — no yield on this deployment
    function convertToShares(uint256 assets) public pure returns (uint256) {
        return assets * SCALE;
    }

    /// @notice shares → assets at SCALE:1 — no yield on this deployment
    function convertToAssets(uint256 shares) public pure returns (uint256) {
        return shares / SCALE;
    }

    // ========== Additional ERC-4626 surface (completeness) ==========

    /// @notice The underlying asset (cbBTC)
    function asset() external view returns (address) {
        return address(underlying);
    }

    /// @notice Total cbBTC managed (8 decimals)
    function totalAssets() external view returns (uint256) {
        return underlying.balanceOf(address(this));
    }

    /// @notice Mint exactly `shares` static shares by depositing cbBTC
    function mint(uint256 shares, address receiver) external returns (uint256 assets) {
        require(shares > 0, "zero shares");
        uint256 before = underlying.balanceOf(address(this));
        underlying.safeTransferFrom(msg.sender, address(this), (shares + SCALE - 1) / SCALE);
        assets = underlying.balanceOf(address(this)) - before;
        require(assets > 0, "no assets received");
        _mint(receiver, assets * SCALE);
    }

    /// @notice Withdraw exactly `assets` cbBTC, burning the required shares
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        require(assets > 0, "zero assets");
        shares = assets * SCALE;
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        underlying.safeTransfer(receiver, assets);
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

    function previewDeposit(uint256 assets) external pure returns (uint256) {
        return assets * SCALE;
    }

    function previewMint(uint256 shares) external pure returns (uint256) {
        return (shares + SCALE - 1) / SCALE;
    }

    function previewWithdraw(uint256 assets) external pure returns (uint256) {
        return assets * SCALE;
    }

    function previewRedeem(uint256 shares) external pure returns (uint256) {
        return shares / SCALE;
    }
}
