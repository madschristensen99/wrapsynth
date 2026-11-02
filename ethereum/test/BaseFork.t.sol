// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {BaseTestBase} from "./BaseTestBase.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {CoLPFacet} from "../contracts/facets/CoLPFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ed25519} from "../contracts/Ed25519.sol";
import {BaseAddresses} from "../contracts/BaseAddresses.sol";

/**
 * @title BaseForkTest
 * @notice Base fork tests: deployment wiring, raw cbBTC collateral with
 *         8→18 decimal boundary scaling, vault lifecycle, full mint cycle,
 *         burn request, and a co-LP position minted on real Uniswap V3.
 *         Oracle-free: thresholds are the declared par/capacity rate.
 */
contract BaseForkTest is BaseTestBase {

    bytes32 public testSecret = bytes32(uint256(0x1234567890abcdef));

    function setUp() public override {
        super.setUp();
        console.log("=== BASE FORK DEPLOYMENT ===");
        console.log("wsXmrHub:", address(hub));
        console.log("collateral (cbBTC):", USDE);
        console.log("wsXMR/cbBTC pool:", pool);
    }

    // ========== DEPLOYMENT ==========

    function testDeployment() public view {
        assertTrue(hub.facets(address(vaultFacet)), "vaultFacet not registered");
        assertTrue(hub.facets(address(liquidationAuctionFacet)), "auctionFacet not registered");
        assertTrue(hub.facets(address(coLPFacet)), "coLPFacet not registered");
        assertEq(hub.collateralToken(), USDE, "collateralToken");
        assertEq(hub.collateralScale(), 1e10, "cbBTC 8->18 scale");
        assertEq(router.POOL_FEE(), BaseAddresses.WSXMR_POOL_FEE, "router fee");
        assertEq(router.TICK_SPACING(), BaseAddresses.WSXMR_TICK_SPACING, "router spacing");
    }

    // ========== VAULT LIFECYCLE ==========

    /// @notice cbBTC is 8-decimal and held raw; the vault's normalized
    ///         collateralShares are deposit × 1e10 (18-dec).
    function testVaultDepositWithdraw() public {
        uint256 deposit = 2e8; // 2 cbBTC
        _lpVaultWithCollateral(lp, deposit);

        assertEq(
            IERC20(USDE).balanceOf(address(hub)),
            deposit,
            "hub should hold raw cbBTC"
        );

        // No debt → health is max
        assertEq(hub.getVaultHealth(lp), type(uint256).max, "empty vault health should be max");

        // Withdraw everything (normalized units)
        uint256 balBefore = IERC20(BaseAddresses.CBBTC).balanceOf(lp);
        vm.prank(lp);
        VaultFacet(address(hub)).withdrawCollateral(deposit * 1e10);
        assertEq(IERC20(BaseAddresses.CBBTC).balanceOf(lp), balBefore + deposit, "cbBTC not returned");
    }

    /// @notice Mint capacity derives from the vault's declared threshold, not
    ///         any external price. At the minThreshold floor, 2 cbBTC of free
    ///         collateral yields ~0.95 wsXMR of capacity.
    function testMintCapacityUsesThreshold() public {
        _lpVaultWithCollateral(lp, 2e8); // 2 cbBTC => 2e18 normalized
        uint256 cap = hub.getMintCapacity(lp);
        assertGt(cap, 0, "capacity should be nonzero");

        // cap = freeNorm * 1e8 * 100 / (T * (100+110)) = 2e18*1e8*100/(1e18*210)
        //     ≈ 0.95e8 wsXMR
        assertLt(cap, 2e8, "capacity absurdly large");
        assertGt(cap, 0.5e8, "capacity too small");
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
        uint256 tokenId = CoLPFacet(address(hub)).userOpenCoLP(lp, amount, 1e7, block.timestamp + 1 hours);
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
