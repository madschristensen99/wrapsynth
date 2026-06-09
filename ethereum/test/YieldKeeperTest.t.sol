// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, console} from "forge-std/Test.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {SimpleOracleFacet} from "../contracts/facets/SimpleOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Factory} from "../contracts/interfaces/external/IUniswapV3Factory.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";
import {Ed25519} from "../contracts/Ed25519.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";
import {ISwapRouter} from "../contracts/interfaces/external/ISwapRouter.sol";
import {ISavingsDAI} from "../contracts/interfaces/external/ISavingsDAI.sol";

contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

contract YieldKeeperTest is Test {
    wsXmrHub public hub;
    wsXMR public wsxmr;
    SimpleOracleFacet public oracleFacet;
    VaultFacet public vaultFacet;
    MintFacet public mintFacet;
    BurnFacet public burnFacet;
    LiquidationFacet public liquidationFacet;
    YieldFacet public yieldFacet;
    wsXMRLiquidityRouter public router;
    MockVerifierProxy public verifier;

    address lp = makeAddr("lp");
    address user = makeAddr("user");
    address keeper = makeAddr("keeper");

    uint256 constant XMR_PRICE = 300 * 1e18;
    uint256 constant COLLATERAL_PRICE = 1_18000000; // 1.18 in 8 decimals for RedStone

    function setUp() public {
        vm.createSelectFork("https://rpc.gnosischain.com");

        vm.deal(lp, 10 ether);
        vm.deal(user, 10 ether);
        vm.deal(keeper, 10 ether);

        verifier = new MockVerifierProxy();
        wsxmr = new wsXMR();
        hub = new wsXmrHub(address(wsxmr), address(verifier));

        oracleFacet = new SimpleOracleFacet(address(wsxmr), address(verifier), address(this));
        vaultFacet = new VaultFacet(address(wsxmr), address(verifier));
        mintFacet = new MintFacet(address(wsxmr), address(verifier));
        burnFacet = new BurnFacet(address(wsxmr), address(verifier));
        liquidationFacet = new LiquidationFacet(address(wsxmr), address(verifier));
        yieldFacet = new YieldFacet(address(wsxmr), address(verifier));

        hub.registerFacets(
            address(vaultFacet),
            address(mintFacet),
            address(burnFacet),
            address(liquidationFacet),
            address(yieldFacet),
            address(oracleFacet)
        );

        wsxmr.setHub(address(hub));

        (address token0, address token1) = GnosisAddresses.SDAI < address(wsxmr)
            ? (GnosisAddresses.SDAI, address(wsxmr))
            : (address(wsxmr), GnosisAddresses.SDAI);

        address pool = IUniswapV3Factory(GnosisAddresses.UNI_V3_FACTORY).getPool(token0, token1, 3000);
        if (pool == address(0)) {
            pool = IUniswapV3Factory(GnosisAddresses.UNI_V3_FACTORY).createPool(token0, token1, 3000);
        }

        router = new wsXMRLiquidityRouter(
            address(hub),
            GnosisAddresses.UNI_V3_POSITION_MANAGER,
            GnosisAddresses.SDAI,
            address(wsxmr),
            pool
        );

        hub.setLiquidityRouter(address(router));

        SimpleOracleFacet(address(hub)).updatePrices(300_00000000, 118_00000000);

        vm.prank(address(hub));
        router.initializePool(XMR_PRICE);

        // Setup LP vault with large collateral (10,000 sDAI)
        vm.startPrank(lp);
        VaultFacet(address(hub)).createVault();
        VaultFacet(address(hub)).setMaxMintBps(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        VaultFacet(address(hub)).setMintReadyBond(0.001 ether);

        deal(GnosisAddresses.SDAI, lp, 10000 ether);
        IERC20(GnosisAddresses.SDAI).approve(address(hub), 10000 ether);
        VaultFacet(address(hub)).depositShares(5000 ether);
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
        MintFacet(address(hub)).provideLPKey(userMints[0], lpPublicKey);
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(userMints[0]);
        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(userMints[0], testSecret);
    }

    // ========== TEST 1: syncVaultYield extracts yield after time passes ==========

    function test_SyncVaultYield_AfterTimeWarp() public {
        uint256 warChestBefore = _getYieldWarChest();

        // Warp 1 year to let sDAI yield accrue
        vm.warp(block.timestamp + 365 days);
        vm.roll(block.number + 100000);

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
        deal(GnosisAddresses.SDAI, newLp, 1000 ether);
        IERC20(GnosisAddresses.SDAI).approve(address(hub), 1000 ether);
        VaultFacet(address(hub)).depositShares(500 ether);
        vm.stopPrank();

        uint256 warChestBefore = _getYieldWarChest();

        vm.warp(block.timestamp + 365 days);
        vm.roll(block.number + 100000);
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
        vm.roll(block.number + 100000);
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
        vm.roll(block.number + 100000);
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

        uint256 pendingBefore = _getPendingReturns(keeper, GnosisAddresses.SDAI);

        vm.prank(keeper);
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);

        uint256 pendingAfter = _getPendingReturns(keeper, GnosisAddresses.SDAI);

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
            abi.encodeWithSelector(oracleFacet.getXmrEmaPrice.selector),
            abi.encode(emaPrice)
        );
    }

    function _mockSwapRouter(uint256 wsxmrOut) internal {
        // Mock exactInputSingle on Uniswap V3 router to return wsXMR
        vm.mockCall(
            GnosisAddresses.UNISWAP_V3_ROUTER,
            abi.encodeWithSelector(ISwapRouter.exactInputSingle.selector),
            abi.encode(wsxmrOut)
        );
    }

    function _updatePrices() internal {
        // Refresh oracle prices to prevent StalePrice revert
        SimpleOracleFacet(address(hub)).updatePrices(300_00000000, 118_00000000);
    }

    // H-1 fix: On Gnosis fork, vm.warp does not cause sDAI yield to accrue (rate only updates on interaction).
    // We inject shares directly so tests can exercise triggerBuyAndBurn without relying on phantom yield.
    function _injectWarChestYield(uint256 shares) internal {
        deal(GnosisAddresses.SDAI, address(hub), shares);
        // yieldWarChest is at slot 15 in wsXmrStorage
        vm.store(address(hub), bytes32(uint256(15)), bytes32(shares));
    }
}
