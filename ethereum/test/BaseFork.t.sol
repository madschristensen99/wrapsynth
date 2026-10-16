// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {BaseTestBase} from "./BaseTestBase.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {BaseOracleFacet} from "../contracts/facets/BaseOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ed25519} from "../contracts/Ed25519.sol";
import {BaseAddresses} from "../contracts/BaseAddresses.sol";

/**
 * @title BaseForkTest
 * @notice Base fork tests: deployment wiring, on-chain cbBTC collateral
 *         TWAP (single-leg cbBTC/USDC), StataCbBTC 8→18 decimal scaling,
 *         vault lifecycle, full mint cycle, burn request, and a co-LP
 *         position minted on real Uniswap V3.
 */
contract BaseForkTest is BaseTestBase {

    bytes32 public testSecret = bytes32(uint256(0x1234567890abcdef));

    function setUp() public override {
        super.setUp();
        console.log("=== BASE FORK DEPLOYMENT ===");
        console.log("wsXmrHub:", address(hub));
        console.log("StataCbBTC:", address(stata));
        console.log("wsXMR/cbBTC pool:", pool);
    }

    // ========== DEPLOYMENT ==========

    function testDeployment() public view {
        assertTrue(hub.facets(address(vaultFacet)), "vaultFacet not registered");
        assertTrue(hub.facets(address(oracleFacet)), "oracleFacet not registered");
        assertEq(hub.collateralToken(), address(stata), "collateralToken");
        assertEq(hub.underlyingToken(), BaseAddresses.CBBTC, "underlyingToken");
        assertEq(hub.collateralTwapPool(), BaseAddresses.CBBTC_USDC_POOL, "collateralTwapPool");
        assertEq(hub.collateralTwapWindow(), BaseAddresses.COLLATERAL_TWAP_WINDOW, "twapWindow");
        assertEq(router.POOL_FEE(), BaseAddresses.WSXMR_POOL_FEE, "router fee");
        assertEq(router.TICK_SPACING(), BaseAddresses.WSXMR_TICK_SPACING, "router spacing");
    }

    // ========== ORACLE ==========

    /// @notice Collateral price comes from the real on-chain cbBTC/USDC TWAP
    ///         — sanity-band it ($30k–$500k covers BTC across any realistic
    ///         fork block).
    function testCollateralTwapPrice() public {
        uint256 px = _collateralPrice18();
        console.log("cbBTC TWAP USD price:", px / 1e18);
        assertGt(px, 30_000e18, "cbBTC price below sanity floor");
        assertLt(px, 500_000e18, "cbBTC price above sanity ceiling");

        // Second refresh must succeed too (idempotent, keeps fresh timestamp)
        _refreshCollateral();
        assertEq(hub.lastCollateralPriceTimestamp(), block.timestamp, "collateral ts not fresh");
    }

    /// @notice Stale collateral price fails closed.
    function testCollateralStaleness() public {
        vm.warp(block.timestamp + 3 minutes);
        vm.expectRevert();
        BaseOracleFacet(address(hub)).getCollateralPrice();
    }

    // ========== VAULT LIFECYCLE ==========

    /// @notice cbBTC is 8-decimal; StataCbBTC mints 1e10 shares per raw unit,
    ///         so the hub's share balance is deposit × 1e10 (18-dec).
    function testVaultDepositWithdraw() public {
        uint256 deposit = 2e8; // 2 cbBTC ~ $200k
        _lpVaultWithCollateral(lp, deposit);

        assertEq(
            stata.balanceOf(address(hub)),
            deposit * 1e10,
            "hub should hold stataCbBTC shares (18-dec scaled)"
        );

        // No debt → health is max
        assertEq(hub.getVaultHealth(lp), type(uint256).max, "empty vault health should be max");

        // Withdraw everything
        uint256 balBefore = IERC20(BaseAddresses.CBBTC).balanceOf(lp);
        vm.prank(lp);
        VaultFacet(address(hub)).withdrawCollateral(deposit * 1e10);
        assertEq(IERC20(BaseAddresses.CBBTC).balanceOf(lp), balBefore + deposit, "cbBTC not returned");
    }

    /// @notice Mint capacity must reflect the cbBTC collateral price, not $1.
    function testMintCapacityUsesCollateralPrice() public {
        _lpVaultWithCollateral(lp, 2e8); // 2 cbBTC ~ $200k collateral
        uint256 cap = hub.getMintCapacity(lp);
        assertGt(cap, 0, "capacity should be nonzero");

        // 2 cbBTC * ~$100k / 150% CR => ~$133k capacity => ~340 wsXMR at $390.
        // Loose band: anything sane between 10 and 10_000 wsXMR (1e8 dec).
        assertLt(cap, 10_000e8, "capacity absurdly large");
        assertGt(cap, 10e8, "capacity too small");
    }

    // ========== FULL MINT CYCLE ==========

    function testFullMintCycle() public returns (bytes32 requestId) {
        _lpVaultWithCollateral(lp, 2e8);
        _configureVaultForMint();
        return _performMint();
    }

    function _performMint() internal returns (bytes32 requestId) {

        uint256 xmrAmount = 50000000000; // 0.5 XMR atomic units

        // Ed25519 commitment like E2EFullCycle
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        bytes32 userPublicKey = bytes32(Ed25519.compressPoint(px, py));

        vm.prank(user);
        requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user, xmrAmount, commitment, userPublicKey
        );

        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(
            requestId,
            bytes32(uint256(0xdeadbeef)),
            bytes32(uint256(0xdeadbeef)),
            bytes32(uint256(0xdeadbeef))
        );

        _refreshCollateral();
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(requestId);

        vm.prank(user);
        MintFacet(address(hub)).revealSecret(requestId, testSecret);
        MintFacet(address(hub)).finalizeMint(requestId);

        uint256 minted = wsxmr.balanceOf(user);
        assertEq(minted, xmrAmount / 1e4, "minted wsXMR mismatch");
        console.log("Minted wsXMR:", minted);
    }

    // ========== BURN REQUEST ==========

    function testBurnRequestAndAbort() public {
        _lpVaultWithCollateral(lp, 2e8);
        _configureVaultForMint();
        _performMint();

        uint256 burnAmount = wsxmr.balanceOf(user) / 2;

        vm.startPrank(user);
        wsxmr.approve(address(hub), burnAmount);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(
            burnAmount,
            lp,
            user,
            bytes32(uint256(0xcafe)),
            bytes32(uint256(0xbeef)),
            bytes32(uint256(0xfeed))
        );
        vm.stopPrank();

        assertEq(wsxmr.balanceOf(user), burnAmount, "wsXMR should be burned/locked at request");

        // User aborts after the request deadline passes
        (,,,,,,,, uint256 deadline,,,,,,,,) = hub.burnRequests(burnId);
        vm.roll(deadline + 1);
        vm.prank(user);
        BurnFacet(address(hub)).abortBurn(burnId);

        assertEq(wsxmr.balanceOf(user), burnAmount * 2, "abortBurn should restore wsXMR");
    }

    // ========== CO-LP ON REAL UNISWAP V3 ==========

    /// @notice Opens a co-LP position pairing user wsXMR with vault cbBTC
    ///         collateral on real UniV3 — exercises the NFPM ABI path and the
    ///         router's decimal-aware sqrt-price math (8-dec collateral).
    function testCoLPOnUniswapV3() public {
        _lpVaultWithCollateral(lp, 2e8);
        _configureVaultForMint();
        _performMint();
        _initializePool();

        uint256 amount = wsxmr.balanceOf(user) / 2;
        // getCoLPCapacity is a facet view — hub fallback TSTOREs, so it must
        // be reached via a non-static low-level call
        (bool capOk, bytes memory capData) = address(hub).call(
            abi.encodeWithSignature("getCoLPCapacity(address)", lp)
        );
        require(capOk, "getCoLPCapacity failed");
        uint256 cap = abi.decode(capData, (uint256));
        assertGt(cap, 0, "no co-LP capacity");
        if (amount > cap) amount = cap / 2;

        vm.startPrank(user);
        wsxmr.approve(address(hub), amount);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, amount, block.timestamp + 1 hours);
        vm.stopPrank();

        assertGt(tokenId, 0, "no NFT position minted");
        console.log("UniV3 position tokenId:", tokenId);
    }

    // ========== INTERNALS ==========

    function _configureVaultForMint() internal {
        vm.startPrank(lp);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        vm.stopPrank();
    }
}
