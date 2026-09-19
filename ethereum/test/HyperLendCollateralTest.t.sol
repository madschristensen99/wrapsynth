// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {HyperEVMTestBase} from "./HyperEVMTestBase.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHyperLendPool, IAToken} from "../contracts/interfaces/external/IHyperLendPool.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";

/**
 * @title HyperLendCollateralTest
 * @notice Verifies the StataUSDe collateral adapter over the real HyperLend
 *         USDe market (Aave v3.6 fork) on the HyperEVM fork: deposit → static
 *         shares, aToken rebase accrual, redeem/withdraw, the share-supply
 *         solvency invariant, and the VaultFacet deposit path.
 * @dev    Runs against the live HyperLend pool + USDe aToken on the fork.
 *         Rebase accrual is time-driven (Aave liquidity index), so tests use
 *         vm.warp to advance time rather than vm.roll.
 */
contract HyperLendCollateralTest is HyperEVMTestBase {
    IHyperLendPool constant HLEND = IHyperLendPool(0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b);
    IAToken constant ATOKEN = IAToken(0x333819c04975554260AaC119948562a0E24C2bd6);

    function setUp() public override {
        super.setUp();
    }

    // ========== Deposit → static shares ==========

    /// @notice Depositing USDe mints static shares backed by real aToken
    function test_Deposit_MintsBackedShares() public {
        uint256 assets = 100 ether;
        deal(USDE, user, assets);

        vm.startPrank(user);
        IERC20(USDE).approve(address(stata), assets);
        uint256 shares = stata.deposit(assets, user);
        vm.stopPrank();

        assertGt(shares, 0, "should mint shares");
        assertEq(stata.balanceOf(user), shares, "user holds the shares");
        // Solvency invariant: share supply == adapter's scaled aToken balance
        assertEq(stata.totalSupply(), ATOKEN.scaledBalanceOf(address(stata)), "supply == scaledBalanceOf");
        // The adapter custodies the rebasing aToken (wei-level rounding on mint)
        assertApproxEqAbs(ATOKEN.balanceOf(address(stata)), assets, 2, "aToken backing ~ deposited assets");
    }

    /// @notice convertToShares/convertToAssets are consistent at the current index
    function test_Conversion_Roundtrip() public {
        uint256 assets = 100 ether;
        uint256 shares = stata.convertToShares(assets);
        uint256 back = stata.convertToAssets(shares);
        // Roundtrip loses at most wei-level rounding
        assertApproxEqAbs(back, assets, 2, "convertToAssets(convertToShares) ~ assets");
    }

    /// @notice Share supply always equals the adapter's scaled aToken balance
    function test_SolvencyInvariant_SupplyEqualsScaled() public {
        deal(USDE, user, 500 ether);
        vm.startPrank(user);
        IERC20(USDE).approve(address(stata), 500 ether);
        stata.deposit(120 ether, user);
        stata.deposit(80 ether, lp);
        vm.stopPrank();

        assertEq(
            stata.totalSupply(),
            ATOKEN.scaledBalanceOf(address(stata)),
            "totalSupply must equal adapter scaledBalanceOf"
        );
    }

    // ========== Rebase accrual ==========

    /// @notice The aToken rebases: convertToAssets grows as the liquidity index rises
    function test_RebaseAccrual_SharesAppreciate() public {
        uint256 assets = 100 ether;
        deal(USDE, user, assets);
        vm.startPrank(user);
        IERC20(USDE).approve(address(stata), assets);
        uint256 shares = stata.deposit(assets, user);
        vm.stopPrank();

        uint256 assetsBefore = stata.convertToAssets(shares);
        uint256 indexBefore = HLEND.getReserveNormalizedIncome(USDE);

        // Advance ~30 days — HyperLend supply yield accrues to the aToken index
        vm.warp(block.timestamp + 30 days);

        uint256 assetsAfter = stata.convertToAssets(shares);
        uint256 indexAfter = HLEND.getReserveNormalizedIncome(USDE);

        // Index is monotonic non-decreasing; shares are static so value tracks index
        assertGe(indexAfter, indexBefore, "liquidity index should not decrease");
        assertGe(assetsAfter, assetsBefore, "share value should not decrease");
        console.log("index before:", indexBefore);
        console.log("index after: ", indexAfter);
        console.log("assets before:", assetsBefore);
        console.log("assets after: ", assetsAfter);
    }

    /// @notice The rebasing aToken balance grows while the scaled balance is fixed
    function test_ATokenRebase_BalanceGrowsScaledFixed() public {
        deal(USDE, user, 100 ether);
        vm.startPrank(user);
        IERC20(USDE).approve(address(stata), 100 ether);
        stata.deposit(100 ether, user);
        vm.stopPrank();

        uint256 scaledBefore = ATOKEN.scaledBalanceOf(address(stata));
        uint256 rebasedBefore = ATOKEN.balanceOf(address(stata));

        vm.warp(block.timestamp + 30 days);
        // Poke the pool so the index is updated on-chain (Aave accrues lazily)
        deal(USDE, address(this), 1 ether);
        IERC20(USDE).approve(HYPERLEND_POOL, 1 ether);
        HLEND.supply(USDE, 1 ether, address(this), 0);

        uint256 scaledAfter = ATOKEN.scaledBalanceOf(address(stata));
        uint256 rebasedAfter = ATOKEN.balanceOf(address(stata));

        assertEq(scaledAfter, scaledBefore, "scaled balance is static");
        assertGe(rebasedAfter, rebasedBefore, "rebased balance grows with yield");
    }

    // ========== Redeem / withdraw ==========

    /// @notice Redeeming shares returns USDe and burns the shares
    function test_Redeem_ReturnsUSDe() public {
        uint256 assets = 100 ether;
        deal(USDE, user, assets);
        vm.startPrank(user);
        IERC20(USDE).approve(address(stata), assets);
        uint256 shares = stata.deposit(assets, user);

        uint256 usdeBefore = IERC20(USDE).balanceOf(user);
        uint256 out = stata.redeem(shares, user, user);
        vm.stopPrank();

        assertGt(out, 0, "redeem should return USDe");
        assertEq(IERC20(USDE).balanceOf(user), usdeBefore + out, "user received USDe");
        assertEq(stata.balanceOf(user), 0, "shares burned");
        assertApproxEqAbs(out, assets, 2, "redeemed ~ deposited (wei rounding)");
    }

    /// @notice Withdrawing an exact USDe amount burns the required shares
    function test_Withdraw_ExactAssets() public {
        deal(USDE, user, 100 ether);
        vm.startPrank(user);
        IERC20(USDE).approve(address(stata), 100 ether);
        stata.deposit(100 ether, user);

        uint256 usdeBefore = IERC20(USDE).balanceOf(user);
        uint256 sharesBurned = stata.withdraw(40 ether, user, user);
        vm.stopPrank();

        assertGt(sharesBurned, 0, "should burn shares");
        assertEq(IERC20(USDE).balanceOf(user), usdeBefore + 40 ether, "withdrew exact 40 USDe");
    }

    // ========== VaultFacet integration ==========

    /// @notice depositCollateral wraps USDe into shares and credits the vault
    function test_VaultDepositCollateral() public {
        uint256 amount = 100 ether;
        _lpVaultWithCollateral(lp, amount);

        wsXmrStorage.Vault memory v = _getVault(lp);
        assertTrue(v.active, "vault active");
        assertGt(v.collateralShares, 0, "vault holds collateral shares");
        // Shares are held by the hub on the vault's behalf
        assertApproxEqAbs(
            v.collateralShares,
            stata.convertToShares(amount),
            2,
            "vault shares ~ convertToShares(deposit)"
        );
    }

    /// @notice Withdrawal returns the vault's collateral as USDe value
    function test_VaultWithdrawCollateral() public {
        uint256 amount = 100 ether;
        _lpVaultWithCollateral(lp, amount);
        _configureVault(lp);

        wsXmrStorage.Vault memory v = _getVault(lp);
        uint256 shares = v.collateralShares;
        uint256 usdeBefore = IERC20(USDE).balanceOf(lp);

        vm.prank(lp);
        VaultFacet(address(hub)).withdrawCollateral(shares);

        uint256 usdeAfter = IERC20(USDE).balanceOf(lp);
        assertGt(usdeAfter, usdeBefore, "withdrawal returned USDe value");
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
