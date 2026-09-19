// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {HyperEVMTestBase} from "./HyperEVMTestBase.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool} from "../contracts/interfaces/external/IUniswapV3Pool.sol";
import {INonfungiblePositionManager} from "../contracts/interfaces/external/INonfungiblePositionManager.sol";
import {ISwapRouter} from "../contracts/interfaces/external/ISwapRouter.sol";
import {Ed25519} from "../contracts/Ed25519.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";

/**
 * @title DexLiquidationTest
 * @notice Verifies the Phase A liquidation path end-to-end on the real
 *         HyperSwap V3 venue: an underwater vault is liquidated by a keeper
 *         that sources wsXMR from the wsXMR/USDe pool, burns it to clear debt,
 *         and receives bonus collateral redeemable for USDe.
 * @dev    The keeper sources wsXMR via the HyperSwap SwapRouter02's
 *         exactInputSingle — the same entry point triggerBuyAndBurn uses. The
 *         oracle price (native XMR perp) drives the collateral ratio, NOT the
 *         pool price — per the anti-reflexivity design rule.
 */
contract DexLiquidationTest is HyperEVMTestBase {
    address seeder = makeAddr("seeder");
    uint24 constant POOL_FEE = 3000;

    function setUp() public override {
        super.setUp();
        vm.deal(seeder, 100 ether);
        _initializePool();
        _seedPoolLiquidity();
    }

    /// @dev Keeper swaps USDe -> wsXMR on the HyperSwap router (7-field params,
    ///      no deadline — HyperSwap's non-standard exactInputSingle signature).
    function _buyWsxmr(uint256 usdeIn) internal returns (uint256 wsxmrOut) {
        deal(USDE, address(this), usdeIn);
        IERC20(USDE).approve(HYPERSWAP_ROUTER, usdeIn);
        wsxmrOut = ISwapRouter(HYPERSWAP_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: USDE,
                tokenOut: address(wsxmr),
                fee: POOL_FEE,
                recipient: address(this),
                amountIn: usdeIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// @notice Phase A liquidation: underwater vault -> keeper buys wsXMR on
    ///         the DEX -> liquidate -> seize bonus collateral -> redeem USDe.
    function test_Liquidation_DexBuyback() public {
        _lpVaultWithCollateral(lp, 200 ether);
        _configureVault(lp);

        uint256 minted = _mintForUser(user, lp);
        assertGt(minted, 0, "user minted wsXMR");
        assertGt(_getVault(lp).normalizedDebt, 0, "vault has debt");

        // Pump XMR so the vault is underwater (CR < 120%)
        _setXmrPrice8dec(50000_00000000); // $50,000 XMR
        assertTrue(_isLiquidatable(lp), "vault should be liquidatable");

        // Keeper (this contract) sources wsXMR on the HyperSwap router
        uint256 usdeIn = 50 ether;
        uint256 wsxmrBought = _buyWsxmr(usdeIn);
        assertGt(wsxmrBought, 0, "keeper bought wsXMR on the DEX");
        console.log("wsXMR bought on HyperSwap:", wsxmrBought);

        // Liquidate: burn wsXMR, seize bonus collateral shares
        uint256 sharesBefore = stata.balanceOf(address(this));
        LiquidationFacet(address(hub)).liquidate(lp, type(uint256).max);
        uint256 sharesSeized = stata.balanceOf(address(this)) - sharesBefore;
        assertGt(sharesSeized, 0, "keeper seized collateral shares");
        console.log("stataUSDe shares seized:", sharesSeized);

        // Redeem seized collateral -> USDe (the aToken -> USDe leg)
        uint256 usdeBefore = IERC20(USDE).balanceOf(address(this));
        uint256 usdeOut = stata.redeem(sharesSeized, address(this), address(this));
        assertEq(IERC20(USDE).balanceOf(address(this)), usdeBefore + usdeOut, "redeemed collateral to USDe");
        console.log("USDe recovered from seized collateral:", usdeOut);

        // Profitable: USDe recovered exceeds USDe spent (10% bonus on deep-underwater vault)
        assertGt(usdeOut, usdeIn, "liquidation should be profitable for the keeper");
    }

    /// @notice A healthy vault cannot be liquidated
    function test_Liquidation_HealthyVaultReverts() public {
        _lpVaultWithCollateral(lp, 200 ether);
        _configureVault(lp);
        _mintForUser(user, lp);

        deal(address(wsxmr), address(this), 1e8);
        vm.expectRevert(); // VaultHealthy
        LiquidationFacet(address(hub)).liquidate(lp, type(uint256).max);
    }

    /// @notice Partial liquidation clears only the requested debt
    function test_Liquidation_PartialDebtClear() public {
        _lpVaultWithCollateral(lp, 200 ether);
        _configureVault(lp);
        _mintForUser(user, lp);

        _setXmrPrice8dec(50000_00000000);
        assertTrue(_isLiquidatable(lp), "vault underwater");

        // Keeper buys a small amount of wsXMR and clears part of the debt
        _buyWsxmr(20 ether);
        uint256 wsxmrHeld = wsxmr.balanceOf(address(this));

        uint256 debtBefore = _getVault(lp).normalizedDebt;
        LiquidationFacet(address(hub)).liquidate(lp, wsxmrHeld);
        uint256 debtAfter = _getVault(lp).normalizedDebt;

        assertLt(debtAfter, debtBefore, "partial liquidation reduced debt");
        assertGt(stata.balanceOf(address(this)), 0, "keeper received collateral");
    }

    // ========== Setup helpers ==========

    /// @dev Seed a wide in-range liquidity position so the keeper can swap.
    function _seedPoolLiquidity() internal {
        (, int24 tick,,,,,) = IUniswapV3Pool(pool).slot0();
        int24 ts = 60;
        int24 tl = ((tick - 6000) / ts) * ts;
        int24 tu = ((tick + 6000) / ts) * ts;
        (address t0, address t1) = USDE < address(wsxmr) ? (USDE, address(wsxmr)) : (address(wsxmr), USDE);
        uint256 usdeAmt = 100_000 ether;
        uint256 wx = 200 * 1e8;
        deal(USDE, seeder, usdeAmt);
        deal(address(wsxmr), seeder, wx);
        vm.startPrank(seeder);
        IERC20(USDE).approve(HYPERSWAP_NFPM, usdeAmt);
        wsxmr.approve(HYPERSWAP_NFPM, wx);
        INonfungiblePositionManager(HYPERSWAP_NFPM).mint(INonfungiblePositionManager.MintParams({
            token0: t0, token1: t1, fee: POOL_FEE, tickLower: tl, tickUpper: tu,
            amount0Desired: t0 == USDE ? usdeAmt : wx, amount1Desired: t0 == USDE ? wx : usdeAmt,
            amount0Min: 0, amount1Min: 0, recipient: seeder, deadline: block.timestamp + 1 hours }));
        vm.stopPrank();
    }

    function _configureVault(address who) internal {
        vm.startPrank(who);
        VaultFacet(address(hub)).setMaxMintBps(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        vm.stopPrank();
    }

    function _mintForUser(address _user, address _lp) internal returns (uint256) {
        uint256 xmrAmount = 20000000000; // 0.02 XMR (atomic) -> 0.02 wsXMR
        bytes32 secret = bytes32(uint256(0x1234));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        vm.prank(_user);
        bytes32 reqId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            _lp, _user, xmrAmount, commitment, bytes32(uint256(0xdeadbeef)));
        vm.prank(_lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)), bytes32(uint256(0xdeadbeef)));
        vm.prank(_lp);
        MintFacet(address(hub)).setMintReady(reqId);
        vm.prank(_user);
        MintFacet(address(hub)).revealSecret(reqId, secret);
        MintFacet(address(hub)).finalizeMint(reqId);
        return wsxmr.balanceOf(_user);
    }

    function _getVault(address vaultAddr) internal returns (wsXmrStorage.Vault memory) {
        (bool ok, bytes memory r) = address(hub).call(
            abi.encodeWithSelector(VaultFacet.getVault.selector, vaultAddr));
        require(ok, "getVault failed");
        return abi.decode(r, (wsXmrStorage.Vault));
    }

    function _isLiquidatable(address vaultAddr) internal returns (bool) {
        (bool ok, bytes memory r) = address(hub).call(
            abi.encodeWithSelector(LiquidationFacet.isVaultLiquidatable.selector, vaultAddr));
        if (!ok) return false;
        return abi.decode(r, (bool));
    }
}
