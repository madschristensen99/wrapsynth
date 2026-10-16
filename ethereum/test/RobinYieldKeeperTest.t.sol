// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {console} from "forge-std/Test.sol";
import {RobinhoodMockTestBase} from "./RobinhoodTestBase.sol";
import {HyperCoreOracleFacet} from "../contracts/facets/HyperCoreOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ed25519} from "../contracts/Ed25519.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";
import {ISwapRouter} from "../contracts/interfaces/external/ISwapRouter.sol";

/// @notice Swap-router mock that enforces `amountOutMinimum` like a real V3
///         router — pays a configured output, pulls tokenIn, and reverts
///         "Too little received" if the caller's minimum exceeds the output.
///         vm.mockCall returns wsxmrOut unconditionally, which is the gap that
///         let the 1e10× minWsxmr precision bug (wrapsynth#67) ship undetected.
contract EnforcingV3SwapRouter {
    uint256 public amountOut;
    uint256 public lastAmountIn;
    uint256 public lastAmountOutMinimum;

    function setAmountOut(uint256 _amountOut) external {
        amountOut = _amountOut;
    }

    function exactInputSingle(ISwapRouter.ExactInputSingleParams calldata params)
        external
        returns (uint256)
    {
        lastAmountIn = params.amountIn;
        lastAmountOutMinimum = params.amountOutMinimum;
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        require(amountOut >= params.amountOutMinimum, "Too little received");
        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
        return amountOut;
    }
}

contract YieldKeeperTestRobin is RobinhoodMockTestBase {
    address keeper = makeAddr("keeper");

    uint256 constant XMR_PRICE = 300 * 1e18;
    uint256 constant TEST_XMR_PRICE_8DEC = 300_00000000; // $300

    function setUp() public override {
        super.setUp();
        vm.deal(keeper, 10 ether);

        // Initialize the HyperSwap pool and set the test's XMR price ($300)
        vm.prank(address(hub));
        router.initializePool(XMR_PRICE);
        _setXmrPrice8dec(TEST_XMR_PRICE_8DEC);

        // Setup LP vault with large collateral (10,000 USDe)
        vm.startPrank(lp);
        VaultFacet(address(hub)).createVault();
        VaultFacet(address(hub)).setMaxMintBps(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);

        deal(USDE, lp, 10000 ether);
        IERC20(USDE).approve(address(hub), 10000 ether);
        VaultFacet(address(hub)).depositCollateral(5000 ether);
        vm.stopPrank();

        // Give user wsXMR via quick mint to create vault debt
        vm.startPrank(user);
        bytes32 testSecret = bytes32(uint256(0xabcdef));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, 20000000000, commitment, bytes32(uint256(0xdeadbeef)));
        vm.stopPrank();

        bytes32[] memory userMints = _getUserMintRequests(user);

        bytes32 lpPublicKey = bytes32(uint256(0xdeadbeef));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(userMints[0], lpPublicKey, lpPublicKey, bytes32(uint256(0xdeadbeef)));
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(userMints[0]);
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(userMints[0], testSecret);
        MintFacet(address(hub)).finalizeMint(userMints[0]);
    }

    // ========== TEST 1: syncVaultYield extracts yield after time passes ==========

    function test_SyncVaultYield_AfterTimeWarp() public {
        uint256 warChestBefore = _getYieldWarChest();

        // Warp 1 year to let sDAI yield accrue
        vm.warp(block.timestamp + 365 days);
        vm.roll(block.number + 500000);

        // Refresh oracle prices after warp (prevent StalePrice)
        _updatePrices();

        YieldFacet(address(hub)).syncVaultYield(lp);

        uint256 warChestAfter = _getYieldWarChest();
        console.log("War chest before:", warChestBefore);
        console.log("War chest after:", warChestAfter);

        assertGe(warChestAfter, warChestBefore, "Yield should be extracted to war chest");
    }

    // ========== TEST 2: syncVaultYield no-op when no debt ==========

    function test_SyncVaultYield_NoDebtReturnsZero() public {
        // Create a new vault with no mints (no debt)
        address newLp = makeAddr("newLp");
        vm.deal(newLp, 10 ether);
        vm.startPrank(newLp);
        VaultFacet(address(hub)).createVault();
        deal(USDE, newLp, 1000 ether);
        IERC20(USDE).approve(address(hub), 1000 ether);
        VaultFacet(address(hub)).depositCollateral(500 ether);
        vm.stopPrank();

        uint256 warChestBefore = _getYieldWarChest();

        vm.warp(block.timestamp + 365 days);
        vm.roll(block.number + 500000);
        _updatePrices();

        YieldFacet(address(hub)).syncVaultYield(newLp);

        uint256 warChestAfter = _getYieldWarChest();
        // Contract extracts yield even without debt (all appreciation above principal is yield)
        assertGe(warChestAfter, warChestBefore, "Yield should be extracted even without debt");
    }

    // ========== TEST 3: canTriggerBuyAndBurn ==========

    function test_CanTriggerBuyAndBurn_InitialState() public {
        // Mock getXmrEmaPrice on hub to avoid TSTORE/STATICCALL in fallback
        vm.mockCall(
            address(hub),
            abi.encodeWithSelector(oracleFacet.getXmrEmaPrice.selector),
            abi.encode(300 * 1e18)
        );

        (bool success, bytes memory result) = address(hub).call(
            abi.encodeWithSelector(YieldFacet.canTriggerBuyAndBurn.selector)
        );
        require(success, "canTriggerBuyAndBurn call failed");
        (bool possible, string memory reason) = abi.decode(result, (bool, string));

        // H-1 fix: No phantom yield on fresh deposits, so war chest is empty
        assertFalse(possible, "Should not be possible - war chest empty");
        assertEq(reason, "War chest empty", "Reason should be War chest empty");
    }

    // ========== TEST 4: triggerBuyAndBurn cooldown reverts ==========

    function test_TriggerBuyAndBurn_CooldownReverts() public {
        // Inject yield directly (vm.warp does not accrue sDAI yield on Gnosis fork)
        _injectWarChestYield(1000 ether);

        // Mock EMA to allow trigger
        _mockEmaPrice(400 * 1e18); // EMA higher than spot (300)

        // First trigger should succeed (with mocked swap)
        _mockSwapRouter(1_000_000);
        deal(address(wsxmr), address(hub), 1_000_000); // simulate swap output (small to avoid underflow)
        vm.prank(keeper);
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);

        // Second trigger immediately should revert (cooldown)
        vm.prank(keeper);
        vm.expectRevert();
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);
    }

    // ========== TEST 5: triggerBuyAndBurn war chest empty reverts ==========

    function test_TriggerBuyAndBurn_WarChestEmptyReverts() public {
        // Warp and sync to consume any existing yield
        vm.warp(block.timestamp + 365 days);
        vm.roll(block.number + 500000);
        _updatePrices();
        YieldFacet(address(hub)).syncVaultYield(lp);

        uint256 warChest = _getYieldWarChest();
        if (warChest > 0) {
            // If yield exists, trigger once to drain war chest (mocked swap)
            _mockEmaPrice(400 * 1e18);
            _mockSwapRouter(1_000_000);
            deal(address(wsxmr), address(hub), 1_000_000); // simulate swap output
            vm.prank(keeper);
            YieldFacet(address(hub)).triggerBuyAndBurn(3000);
            // Warp past cooldown for next test
            vm.warp(block.timestamp + 25 hours);
            _updatePrices();
        }

        // Now war chest should be empty
        vm.prank(keeper);
        vm.expectRevert();
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);
    }

    // ========== TEST 6: triggerBuyAndBurn invalid fee tier reverts ==========

    function test_TriggerBuyAndBurn_InvalidFeeTierReverts() public {
        vm.prank(keeper);
        vm.expectRevert();
        YieldFacet(address(hub)).triggerBuyAndBurn(123);
    }

    // ========== TEST 7: triggerBuyAndBurn XMR not dipped reverts ==========

    function test_TriggerBuyAndBurn_XMRNotDippedReverts() public {
        // Ensure war chest has yield
        vm.warp(block.timestamp + 365 days);
        vm.roll(block.number + 500000);
        _updatePrices();
        YieldFacet(address(hub)).syncVaultYield(lp);

        // Warp past cooldown
        vm.warp(block.timestamp + 25 hours);
        _updatePrices();

        // Don't mock EMA - spot == EMA (300), so XMR didn't dip
        vm.prank(keeper);
        vm.expectRevert();
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);
    }

    // ========== TEST 8: triggerBuyAndBurn keeper gets reward ==========

    function test_TriggerBuyAndBurn_KeeperGetsReward() public {
        // Inject yield directly (vm.warp does not accrue sDAI yield on Gnosis fork)
        _injectWarChestYield(1000 ether);

        // Warp past cooldown
        vm.warp(block.timestamp + 25 hours);
        _updatePrices();

        // Mock EMA to allow trigger (EMA > spot)
        _mockEmaPrice(400 * 1e18);

        // Mock swap to return wsXMR
        _mockSwapRouter(1_000_000);
        deal(address(wsxmr), address(hub), 1_000_000); // simulate swap output

        uint256 pendingBefore = _getPendingReturns(keeper, address(stata));

        vm.prank(keeper);
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);

        uint256 pendingAfter = _getPendingReturns(keeper, address(stata));

        console.log("Keeper reward:", (pendingAfter - pendingBefore) / 1e18, "sDAI");
        assertGt(pendingAfter, pendingBefore, "Keeper should earn reward");
    }

    // ========== TEST 9: triggerBuyAndBurn reduces war chest ==========

    function test_TriggerBuyAndBurn_ReducesWarChest() public {
        // Inject yield directly (vm.warp does not accrue sDAI yield on Gnosis fork)
        _injectWarChestYield(1000 ether);

        uint256 warChestBefore = _getYieldWarChest();

        vm.warp(block.timestamp + 25 hours);
        _updatePrices();
        _mockEmaPrice(400 * 1e18);
        _mockSwapRouter(1_000_000);
        deal(address(wsxmr), address(hub), 1_000_000); // simulate swap output

        vm.prank(keeper);
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);

        uint256 warChestAfter = _getYieldWarChest();
        console.log("War chest before:", warChestBefore);
        console.log("War chest after:", warChestAfter);
        assertLt(warChestAfter, warChestBefore, "War chest should decrease after buy-and-burn");
    }

    // ========== TEST 10: triggerBuyAndBurn minWsxmr uses wsXMR decimals (issue #67) ==========

    function test_TriggerBuyAndBurn_MinOutUsesWsxmrDecimals() public {
        _injectWarChestYield(1000 ether);

        vm.warp(block.timestamp + 25 hours);
        _updatePrices();
        _mockEmaPrice(400 * 1e18);

        // Etch a router with real V3 semantics onto the configured swapRouter:
        // it reverts when the output is below amountOutMinimum. The buggy
        // 1e18-scaled bound demanded ~1e10× the fair output and would revert
        // here; the 1e8-scaled bound clears.
        EnforcingV3SwapRouter impl = new EnforcingV3SwapRouter();
        vm.etch(HYPERSWAP_ROUTER, address(impl).code);
        EnforcingV3SwapRouter enforcingRouter = EnforcingV3SwapRouter(HYPERSWAP_ROUTER);

        // Spend = 20% of the 1000-share war chest minus the 2% keeper reward
        // = 196 shares. Pay out exactly the fair wsXMR amount at $300 spot.
        uint256 daiAmount = stata.convertToAssets(196 ether);
        uint256 fairOut = (daiAmount * 1e8) / XMR_PRICE;
        enforcingRouter.setAmountOut(fairOut);
        deal(address(wsxmr), HYPERSWAP_ROUTER, fairOut);

        vm.prank(keeper);
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);

        // Pin the bound itself: amountOutMinimum must be denominated in
        // 8-decimal wsXMR (1e8), not 1e18.
        uint256 expectedMin =
            (enforcingRouter.lastAmountIn() * 1e8 * 9900) / (XMR_PRICE * 10000);
        assertEq(enforcingRouter.lastAmountOutMinimum(), expectedMin);
    }

    // ========== TEST 11: minWsxmr scales with collateral price ==========

    /// @notice The underlying isn't $1 on BNB (QQQB). If the bound dropped the
    ///         collateralPrice leg, minOut here would be ~2× too low — the swap
    ///         would still clear, so this must be caught by the assertion, not
    ///         the router's enforcement.
    function test_TriggerBuyAndBurn_MinOutScalesWithCollateralPrice() public {
        _injectWarChestYield(1000 ether);

        // Crank collateral to ~$2 (tick granularity → approximate, ~1bp steps)
        _setCollateralPrice8dec(2e8);

        vm.warp(block.timestamp + 25 hours);
        _updatePrices();
        _mockEmaPrice(400 * 1e18);

        EnforcingV3SwapRouter impl = new EnforcingV3SwapRouter();
        vm.etch(HYPERSWAP_ROUTER, address(impl).code);
        EnforcingV3SwapRouter enforcingRouter = EnforcingV3SwapRouter(HYPERSWAP_ROUTER);

        uint256 daiAmount = stata.convertToAssets(196 ether);
        uint256 collateralPrice = _collateralPrice18();
        uint256 fairOut = (daiAmount * collateralPrice * 1e8) / (XMR_PRICE * 1e18);
        enforcingRouter.setAmountOut(fairOut);
        deal(address(wsxmr), HYPERSWAP_ROUTER, fairOut);

        vm.prank(keeper);
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);

        uint256 expectedMin =
            (enforcingRouter.lastAmountIn() * collateralPrice * 1e8 * 9900) / (XMR_PRICE * 1e18 * 10000);
        assertApproxEqRel(enforcingRouter.lastAmountOutMinimum(), expectedMin, 0.005e18);
    }

    // ========== HELPERS ==========

    function _getYieldWarChest() internal returns (uint256) {
        bytes memory result = _hubView(abi.encodeWithSelector(YieldFacet.getYieldWarChest.selector));
        return abi.decode(result, (uint256));
    }

    function _getLastBuyTimestamp() internal returns (uint256) {
        bytes memory result = _hubView(abi.encodeWithSelector(YieldFacet.getLastBuyTimestamp.selector));
        return abi.decode(result, (uint256));
    }

    function _getPendingReturns(address who, address token) internal returns (uint256) {
        bytes memory result = _hubView(abi.encodeWithSelector(VaultFacet.getPendingReturns.selector, who, token));
        return abi.decode(result, (uint256));
    }

    function _getUserMintRequests(address u) internal returns (bytes32[] memory) {
        (bool success, bytes memory result) = address(hub).call(abi.encodeWithSignature("getUserMintRequests(address)", u));
        require(success, "hub view call failed");
        return abi.decode(result, (bytes32[]));
    }

    function _hubView(bytes memory data) internal returns (bytes memory) {
        (bool success, bytes memory result) = address(hub).call(data);
        require(success, "hub view call failed");
        return result;
    }

    function _mockEmaPrice(uint256 emaPrice) internal {
        // Mock getXmrEmaPrice on the hub (delegates to oracle facet)
        vm.mockCall(
            address(hub),
            abi.encodeWithSelector(HyperCoreOracleFacet.getXmrEmaPrice.selector),
            abi.encode(emaPrice)
        );
    }

    function _mockSwapRouter(uint256 wsxmrOut) internal {
        // Mock exactInputSingle on the PCS V3 router to return wsXMR
        vm.mockCall(
            HYPERSWAP_ROUTER,
            abi.encodeWithSelector(ISwapRouter.exactInputSingle.selector),
            abi.encode(wsxmrOut)
        );
    }

    function _updatePrices() internal {
        // Refresh oracle prices to prevent StalePrice revert
        _setXmrPrice8dec(TEST_XMR_PRICE_8DEC);
    }

    // Inject real aToken-backed shares so triggerBuyAndBurn can redeem them.
    // deal() on the adapter only fakes the ERC20 balance — redeem needs real backing.
    function _injectWarChestYield(uint256 shares) internal {
        uint256 usdeNeeded = stata.convertToAssets(shares);
        deal(USDE, address(this), usdeNeeded);
        IERC20(USDE).approve(address(stata), usdeNeeded);
        stata.deposit(usdeNeeded, address(hub));
        // yieldWarChest is at slot 15 in wsXmrStorage
        vm.store(address(hub), bytes32(uint256(15)), bytes32(shares));
    }
}
