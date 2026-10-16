// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {BnbMockTestBase} from "./BnbTestBase.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";
import {BnbAddresses} from "../contracts/BnbAddresses.sol";

/**
 * @title BnbCollateralAdapterTest
 * @notice BNB port of HyperLendCollateralTest, adapted to StataQQQB — the
 *         static 1:1 ERC-4626 wrapper over QQQB (no yield venue, no rebase).
 *         Covers deposit → shares, conversion roundtrip, the share-supply
 *         solvency invariant, redeem/withdraw, and the VaultFacet deposit path.
 * @dev    Runs against the real QQQB token on the BSC fork. Where the
 *         HyperLend suite asserted aToken rebase accrual, the analogue here is
 *         exact 1:1 stasis — share value must NOT drift over time.
 */
contract BnbCollateralAdapterTest is BnbMockTestBase {

    function setUp() public override {
        super.setUp();
    }

    // ========== Deposit → shares ==========

    /// @notice Depositing QQQB mints static shares backed 1:1 by QQQB
    function test_Deposit_MintsBackedShares() public {
        uint256 assets = 100 ether;
        deal(USDE, user, assets);

        vm.startPrank(user);
        IERC20(USDE).approve(address(stata), assets);
        uint256 shares = stata.deposit(assets, user);
        vm.stopPrank();

        assertGt(shares, 0, "should mint shares");
        assertEq(stata.balanceOf(user), shares, "user holds the shares");
        // Solvency invariant: share supply == adapter's QQQB balance (1:1 static)
        assertEq(stata.totalSupply(), IERC20(USDE).balanceOf(address(stata)), "supply == QQQB backing");
        assertEq(IERC20(USDE).balanceOf(address(stata)), assets, "QQQB backing == deposited assets");
    }

    /// @notice convertToShares/convertToAssets are consistent (exactly 1:1)
    function test_Conversion_Roundtrip() public {
        uint256 assets = 100 ether;
        uint256 shares = stata.convertToShares(assets);
        uint256 back = stata.convertToAssets(shares);
        assertEq(back, assets, "convertToAssets(convertToShares) == assets");
    }

    /// @notice Share supply always equals the adapter's QQQB balance
    function test_SolvencyInvariant_SupplyEqualsBacking() public {
        deal(USDE, user, 500 ether);
        vm.startPrank(user);
        IERC20(USDE).approve(address(stata), 500 ether);
        stata.deposit(120 ether, user);
        stata.deposit(80 ether, lp);
        vm.stopPrank();

        assertEq(
            stata.totalSupply(),
            IERC20(USDE).balanceOf(address(stata)),
            "totalSupply must equal adapter QQQB balance"
        );
    }

    // ========== Static rate (no rebase) ==========

    /// @notice StataQQQB does NOT rebase — share value is exactly constant.
    ///         (QQQB earns no yield; the TWAP oracle handles price drift.)
    function test_StaticRate_NoAppreciation() public {
        uint256 assets = 100 ether;
        deal(USDE, user, assets);
        vm.startPrank(user);
        IERC20(USDE).approve(address(stata), assets);
        uint256 shares = stata.deposit(assets, user);
        vm.stopPrank();

        uint256 assetsBefore = stata.convertToAssets(shares);

        vm.warp(block.timestamp + 30 days);

        uint256 assetsAfter = stata.convertToAssets(shares);
        assertEq(assetsAfter, assetsBefore, "static adapter: share value constant over time");
    }

    // ========== Redeem / withdraw ==========

    /// @notice Redeeming shares returns QQQB and burns the shares
    function test_Redeem_ReturnsQQQB() public {
        uint256 assets = 100 ether;
        deal(USDE, user, assets);
        vm.startPrank(user);
        IERC20(USDE).approve(address(stata), assets);
        uint256 shares = stata.deposit(assets, user);

        uint256 qqqbBefore = IERC20(USDE).balanceOf(user);
        uint256 out = stata.redeem(shares, user, user);
        vm.stopPrank();

        assertGt(out, 0, "redeem should return QQQB");
        assertEq(IERC20(USDE).balanceOf(user), qqqbBefore + out, "user received QQQB");
        assertEq(stata.balanceOf(user), 0, "shares burned");
        assertEq(out, assets, "redeemed == deposited (1:1)");
    }

    /// @notice Withdrawing an exact QQQB amount burns the required shares
    function test_Withdraw_ExactAssets() public {
        deal(USDE, user, 100 ether);
        vm.startPrank(user);
        IERC20(USDE).approve(address(stata), 100 ether);
        stata.deposit(100 ether, user);

        uint256 qqqbBefore = IERC20(USDE).balanceOf(user);
        uint256 sharesBurned = stata.withdraw(40 ether, user, user);
        vm.stopPrank();

        assertGt(sharesBurned, 0, "should burn shares");
        assertEq(IERC20(USDE).balanceOf(user), qqqbBefore + 40 ether, "withdrew exact 40 QQQB");
    }

    // ========== VaultFacet integration ==========

    /// @notice depositCollateral wraps QQQB into shares and credits the vault
    function test_VaultDepositCollateral() public {
        uint256 amount = 100 ether;
        _lpVaultWithCollateral(lp, amount);

        wsXmrStorage.Vault memory v = _getVault(lp);
        assertTrue(v.active, "vault active");
        assertGt(v.collateralShares, 0, "vault holds collateral shares");
        assertEq(v.collateralShares, stata.convertToShares(amount), "vault shares == deposit (1:1)");
    }

    /// @notice Withdrawal returns the vault's collateral as QQQB value
    function test_VaultWithdrawCollateral() public {
        uint256 amount = 100 ether;
        _lpVaultWithCollateral(lp, amount);
        _configureVault(lp);

        wsXmrStorage.Vault memory v = _getVault(lp);
        uint256 shares = v.collateralShares;
        uint256 qqqbBefore = IERC20(USDE).balanceOf(lp);

        vm.prank(lp);
        VaultFacet(address(hub)).withdrawCollateral(shares);

        uint256 qqqbAfter = IERC20(USDE).balanceOf(lp);
        assertGt(qqqbAfter, qqqbBefore, "withdrawal returned QQQB value");
        assertEq(_getVault(lp).collateralShares, 0, "vault collateral drained");
    }

    // ========== Helpers ==========

    function _getVault(address vaultAddr) internal returns (wsXmrStorage.Vault memory) {
        (bool ok, bytes memory r) = address(hub).call(
            abi.encodeWithSelector(VaultFacet.getVault.selector, vaultAddr)
        );
        require(ok, "getVault failed");
        return abi.decode(r, (wsXmrStorage.Vault));
    }

    function _configureVault(address who) internal {
        vm.startPrank(who);
        VaultFacet(address(hub)).setMaxMintBps(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        vm.stopPrank();
    }
}
