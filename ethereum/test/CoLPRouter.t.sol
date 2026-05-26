// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {SimpleOracleFacet} from "../contracts/facets/SimpleOracleFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";
import {ICoLPMatching} from "../contracts/interfaces/router/ICoLPMatching.sol";

/**
 * @title CoLPRouterTest
 * @notice Foundry tests for permissionless Co-LP router
 * @dev Forks Gnosis mainnet to test against real contracts
 */
contract CoLPRouterTest is Test {
    wsXMRLiquidityRouter public router;
    wsXmrHub public hub;
    wsXMR public wsxmrToken;
    IERC20 public sDAI;
    SimpleOracleFacet public oracleFacet;

    address constant WSHUB_DEPLOYED = 0xB00fed5E2F06187369f5bbF2fcFF065FA188D1a5;
    address constant WSXMR_DEPLOYED = 0x4206580496249266945A5aED42E41b6CE9cd8DAD;
    address constant SDAI_WHALE = 0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016;

    address lp1;
    address lp2;
    address user1;
    address user2;

    uint256 constant XMR_PRICE = 16000000000; // $160 in 8 decimals
    uint256 constant DAI_PRICE = 100000000;   // $1.00 in 8 decimals

    function setUp() public {
        // Fork Gnosis mainnet
        vm.createSelectFork(vm.envString("GNOSIS_RPC_URL"));

        lp1 = makeAddr("lp1");
        lp2 = makeAddr("lp2");
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");

        hub = wsXmrHub(payable(WSHUB_DEPLOYED));
        wsxmrToken = wsXMR(WSXMR_DEPLOYED);
        sDAI = IERC20(GnosisAddresses.SDAI);

        // Deploy oracle for testing
        oracleFacet = new SimpleOracleFacet(
            WSXMR_DEPLOYED,
            address(0),
            address(this)
        );
        oracleFacet.updatePrices(XMR_PRICE, DAI_PRICE);

        // Deploy router
        router = new wsXMRLiquidityRouter(
            WSHUB_DEPLOYED,
            WSXMR_DEPLOYED,
            GnosisAddresses.SDAI,
            GnosisAddresses.UNI_V3_FACTORY,
            GnosisAddresses.UNI_V3_POSITION_MANAGER
        );

        console.log("Router deployed at:", address(router));

        // Fund test accounts with sDAI
        getSDAI(lp1, 100_000 ether);
        getSDAI(lp2, 50_000 ether);
    }

    function getSDAI(address recipient, uint256 amount) internal {
        deal(address(sDAI), recipient, amount);
    }

    function mintWsxmr(address recipient, uint256 amount) internal {
        vm.prank(WSHUB_DEPLOYED);
        wsxmrToken.mint(recipient, amount);
    }

    function test_LPAllocateLiquidity() public {
        uint256 amount = 10_000 ether;

        vm.startPrank(lp1);
        sDAI.approve(address(router), amount);
        router.allocateLiquidity(amount);
        vm.stopPrank();

        assertEq(router.lpSDAIBalance(lp1), amount);
    }

    function test_LPWithdrawSDAI() public {
        uint256 allocateAmount = 10_000 ether;
        uint256 withdrawAmount = 1_000 ether;

        vm.startPrank(lp1);
        sDAI.approve(address(router), allocateAmount);
        router.allocateLiquidity(allocateAmount);

        uint256 balanceBefore = sDAI.balanceOf(lp1);
        router.withdrawSDAI(withdrawAmount);
        uint256 balanceAfter = sDAI.balanceOf(lp1);
        vm.stopPrank();

        assertEq(balanceAfter - balanceBefore, withdrawAmount);
    }

    function test_UserDepositWsxmr() public {
        uint256 amount = 10e8; // 10 wsXMR

        mintWsxmr(user1, amount);

        vm.startPrank(user1);
        wsxmrToken.approve(address(router), amount);
        router.depositWsxmr(amount);
        vm.stopPrank();

        assertEq(router.userWsxmrBalance(user1), amount);
    }

    function test_UserWithdrawWsxmr() public {
        uint256 depositAmount = 10e8;
        uint256 withdrawAmount = 1e8;

        mintWsxmr(user1, depositAmount);

        vm.startPrank(user1);
        wsxmrToken.approve(address(router), depositAmount);
        router.depositWsxmr(depositAmount);

        uint256 balanceBefore = wsxmrToken.balanceOf(user1);
        router.withdrawWsXMR(withdrawAmount);
        uint256 balanceAfter = wsxmrToken.balanceOf(user1);
        vm.stopPrank();

        assertEq(balanceAfter - balanceBefore, withdrawAmount);
    }

    function test_LPSetConfig() public {
        uint256 maxPositionSize = 5_000 ether;
        uint256 maxTotalExposure = 20_000 ether;
        uint16 minCollateralRatioBps = 15000; // 150%
        bool acceptingPositions = true;

        vm.prank(lp1);
        router.setLPConfig(
            maxPositionSize,
            maxTotalExposure,
            minCollateralRatioBps,
            acceptingPositions
        );

        ICoLPMatching.LPConfig memory config = router.getLPConfig(lp1);
        assertEq(config.maxPositionSize, maxPositionSize);
        assertEq(config.maxTotalExposure, maxTotalExposure);
        assertEq(config.minCollateralRatioBps, minCollateralRatioBps);
        assertTrue(config.acceptingPositions);
    }

    function test_RevertWhen_InvalidConfigRatioTooLow() public {
        vm.prank(lp1);
        vm.expectRevert();
        router.setLPConfig(
            1_000 ether,
            10_000 ether,
            5000, // 50% - too low
            true
        );
    }

    function test_RevertWhen_InvalidConfigAcceptingWithoutMax() public {
        vm.prank(lp1);
        vm.expectRevert();
        router.setLPConfig(
            0, // No max position
            10_000 ether,
            15000,
            true // But accepting
        );
    }

    function test_InitializePool() public {
        bytes[] memory emptyData = new bytes[](0);
        router.initializePool(emptyData);

        assertTrue(router.poolInitialized());
        assertTrue(router.pool() != address(0));
    }

    function test_PermissionlessPositionCreation() public {
        // Setup
        uint256 sDAIAmount = 1_000 ether;
        uint256 wsxmrAmount = 2e8; // 2 wsXMR @ $160 = $320, ratio = 160%

        // LP allocates and sets config
        vm.startPrank(lp1);
        sDAI.approve(address(router), sDAIAmount);
        router.allocateLiquidity(sDAIAmount);
        router.setLPConfig(
            5_000 ether,
            20_000 ether,
            15000, // 150%
            true
        );
        vm.stopPrank();

        // User deposits wsXMR
        mintWsxmr(user1, wsxmrAmount);
        vm.startPrank(user1);
        wsxmrToken.approve(address(router), wsxmrAmount);
        router.depositWsxmr(wsxmrAmount);
        vm.stopPrank();

        // Initialize pool
        bytes[] memory emptyData = new bytes[](0);
        router.initializePool(emptyData);

        // User creates position permissionlessly (no approval needed!)
        vm.prank(user1);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 positionIndex = router.createPosition(
            lp1,
            user1,
            sDAIAmount,
            wsxmrAmount,
            deadline
        );

        // Verify position created
        assertTrue(positionIndex == 0);
        assertEq(router.getLpTotalExposure(lp1), sDAIAmount);
    }

    function test_RevertWhen_PositionWhenLPNotAccepting() public {
        uint256 sDAIAmount = 1_000 ether;
        uint256 wsxmrAmount = 2e8;

        vm.startPrank(lp1);
        sDAI.approve(address(router), sDAIAmount);
        router.allocateLiquidity(sDAIAmount);
        router.setLPConfig(
            5_000 ether,
            20_000 ether,
            15000,
            false // Not accepting
        );
        vm.stopPrank();

        mintWsxmr(user1, wsxmrAmount);
        vm.startPrank(user1);
        wsxmrToken.approve(address(router), wsxmrAmount);
        router.depositWsxmr(wsxmrAmount);
        vm.stopPrank();

        bytes[] memory emptyData = new bytes[](0);
        router.initializePool(emptyData);

        vm.prank(user1);
        vm.expectRevert();
        router.createPosition(
            lp1,
            user1,
            sDAIAmount,
            wsxmrAmount,
            block.timestamp + 1 hours
        );
    }

    function test_RevertWhen_PositionExceedsMaxSize() public {
        uint256 tooLarge = 6_000 ether; // Exceeds 5000 max
        uint256 wsxmrAmount = 10e8;

        vm.startPrank(lp1);
        sDAI.approve(address(router), tooLarge);
        router.allocateLiquidity(tooLarge);
        router.setLPConfig(
            5_000 ether,
            20_000 ether,
            15000,
            true
        );
        vm.stopPrank();

        mintWsxmr(user1, wsxmrAmount);
        vm.startPrank(user1);
        wsxmrToken.approve(address(router), wsxmrAmount);
        router.depositWsxmr(wsxmrAmount);
        vm.stopPrank();

        bytes[] memory emptyData = new bytes[](0);
        router.initializePool(emptyData);

        vm.prank(user1);
        vm.expectRevert();
        router.createPosition(
            lp1,
            user1,
            tooLarge,
            wsxmrAmount,
            block.timestamp + 1 hours
        );
    }

    function test_RevertWhen_PositionInsufficientCollateralRatio() public {
        uint256 sDAIAmount = 2_000 ether;
        uint256 lowWsxmr = 1e8; // Only $160, ratio = 80%

        vm.startPrank(lp1);
        sDAI.approve(address(router), sDAIAmount);
        router.allocateLiquidity(sDAIAmount);
        router.setLPConfig(
            5_000 ether,
            20_000 ether,
            15000, // Requires 150%
            true
        );
        vm.stopPrank();

        mintWsxmr(user1, lowWsxmr);
        vm.startPrank(user1);
        wsxmrToken.approve(address(router), lowWsxmr);
        router.depositWsxmr(lowWsxmr);
        vm.stopPrank();

        bytes[] memory emptyData = new bytes[](0);
        router.initializePool(emptyData);

        vm.prank(user1);
        vm.expectRevert();
        router.createPosition(
            lp1,
            user1,
            sDAIAmount,
            lowWsxmr,
            block.timestamp + 1 hours
        );
    }

    function test_ViewFunctions() public {
        assertEq(router.POOL_FEE(), 3000);
        assertEq(router.TICK_SPACING(), 60);
        assertEq(router.MIN_DEPOSIT_AMOUNT(), 1e6);
        assertEq(router.MIN_POSITION_DURATION(), 1 hours);
        assertEq(router.MAX_ACTIVE_POSITIONS_PER_USER(), 50);
        assertEq(router.BPS_DENOMINATOR(), 10000);
    }
}
