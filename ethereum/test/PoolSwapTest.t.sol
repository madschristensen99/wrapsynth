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
import {IUniswapV3Pool} from "../contracts/interfaces/external/IUniswapV3Pool.sol";
import {INonfungiblePositionManager} from "../contracts/interfaces/external/INonfungiblePositionManager.sol";
import {ISwapRouter} from "../contracts/interfaces/external/ISwapRouter.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";
import {Ed25519} from "../contracts/Ed25519.sol";

contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

/**
 * @title PoolSwapTest
 * @notice Validates that the Uniswap V3 pool is initialized at the correct price
 *         and that swaps in both directions execute successfully.
 * @dev This catches the inverted-price bug where _priceToSqrtPriceX96
 *      computed sDAI/wsXMR instead of wsXMR/sDAI.
 */
interface IUniswapV3SwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

contract PoolSwapTest is Test, IUniswapV3SwapCallback {
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

    address public lp;
    address public user;
    address public swapper;
    address public poolAddr;

    uint256 constant XMR_PRICE = 300 * 1e18;      // ~$300 XMR
    uint256 constant COLLATERAL_PRICE = 118 * 1e16; // ~$1.18 sDAI

    // The known-buggy tick from the inverted-price deploy.
    // If the pool is initialized at this tick, the price formula is wrong.
    int24 constant BUGGY_TICK = 170_605;

    uint24 constant POOL_FEE = 3000; // Must match router's hardcoded POOL_FEE

    function setUp() public {
        string memory rpcUrl = vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"));
        vm.createSelectFork(rpcUrl);

        lp = makeAddr("lp");
        user = makeAddr("user");
        swapper = makeAddr("swapper");
        vm.deal(lp, 1000 ether);
        vm.deal(user, 1000 ether);
        vm.deal(swapper, 1000 ether);

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

        // Create or get Uniswap V3 pool (use 0.05% tier to avoid mainnet collision)
        (address token0, address token1) = GnosisAddresses.SDAI < address(wsxmr)
            ? (GnosisAddresses.SDAI, address(wsxmr))
            : (address(wsxmr), GnosisAddresses.SDAI);

        address pool = IUniswapV3Factory(GnosisAddresses.UNI_V3_FACTORY).getPool(token0, token1, POOL_FEE);
        if (pool == address(0)) {
            pool = IUniswapV3Factory(GnosisAddresses.UNI_V3_FACTORY).createPool(token0, token1, POOL_FEE);
        }

        poolAddr = pool;
        console.log("Pool address:", poolAddr);

        router = new wsXMRLiquidityRouter(
            address(hub),
            GnosisAddresses.UNI_V3_POSITION_MANAGER,
            GnosisAddresses.SDAI,
            address(wsxmr),
            poolAddr
        );

        hub.setLiquidityRouter(address(router));

        // Set oracle prices (8 decimals)
        SimpleOracleFacet(address(hub)).updatePrices(300_00000000, 118_00000000);

        // Initialize pool at oracle price (must be called as hub)
        vm.prank(address(hub));
        router.initializePool(XMR_PRICE);

        // Fund swapper with sDAI and wsXMR
        deal(GnosisAddresses.SDAI, swapper, 10_000 * 1e18); // 10,000 sDAI
        deal(address(wsxmr), swapper, 100 * 1e8);            // 100 wsXMR

        vm.prank(swapper);
        IERC20(GnosisAddresses.SDAI).approve(GnosisAddresses.UNI_V3_SWAP_ROUTER_02, type(uint256).max);
        vm.prank(swapper);
        wsxmr.approve(GnosisAddresses.UNI_V3_SWAP_ROUTER_02, type(uint256).max);
    }

    function test_PoolInitializedAtReasonableTick() public {
        console.log("Pool address in test:", poolAddr);
        (uint160 sqrtPriceX96, int24 tick,,,,,) = IUniswapV3Pool(poolAddr).slot0();
        uint128 liquidity = IUniswapV3Pool(poolAddr).liquidity();

        console.log("Pool tick:", tick);
        console.log("Pool liquidity:", liquidity);
        console.log("sqrtPriceX96:", sqrtPriceX96);

        // Pool must be initialized (sqrtPriceX96 != 0)
        assertGt(sqrtPriceX96, 0, "Pool not initialized");

        // Anti-regression: the buggy inverted-price formula always produces tick ~170,605
        assertTrue(tick != BUGGY_TICK, "Pool has the known-buggy tick (170605) from inverted price formula");
        
        // Validate price is reasonable for XMR (~$300-390)
        // sDAI has 18 decimals, wsXMR has 8 decimals
        // When sDAI is token0: price = wsXMR/sDAI = 1e8 / (xmrPrice * 1e18 / 1e18) = 1/(xmrPrice*1e10)
        //   tick = log_1.0001(1/(xmrPrice*1e10)) ≈ -287000 for $300 XMR
        // When wsXMR is token0: price = sDAI/wsXMR = (xmrPrice * 1e18 / 1e18) / 1e8 = xmrPrice*1e10
        //   tick = log_1.0001(xmrPrice*1e10) ≈ +287000 for $300 XMR
        bool sDAIIsToken0 = GnosisAddresses.SDAI < address(wsxmr);
        
        if (sDAIIsToken0) {
            // sDAI is token0, wsXMR is token1
            // Pool price = token1/token0 = wsXMR/sDAI
            // For $300-400 XMR, tick should be approximately -284000 to -290000
            assertGt(tick, -295000, "Tick too low for $300-400 XMR (sDAI is token0)");
            assertLt(tick, -280000, "Tick too high for $300-400 XMR (sDAI is token0)");
        } else {
            // wsXMR is token0, sDAI is token1
            // Pool price = token1/token0 = sDAI/wsXMR (in raw units)
            // 1 wsXMR (1e8) = 300 sDAI (300e18), so price = 300e18/1e8 = 300*1e10
            // tick = log_1.0001(300*1e10) ≈ 287000
            // For $300-400 XMR range, tick should be ~280000-295000
            assertGt(tick, 280000, "Tick too low for $300-400 XMR (wsXMR is token0)");
            assertLt(tick, 295000, "Tick too high for $300-400 XMR (wsXMR is token0)");
        }
        
        console.log("Price validation passed - tick is in expected range for $390 XMR");
    }

    function test_AddLiquidityAndSwapBothDirections() public {
        console.log("Pool address in test:", poolAddr);
        (uint160 sqrtPriceX96, int24 tick,,,,,) = IUniswapV3Pool(poolAddr).slot0();

        (address token0, address token1) = GnosisAddresses.SDAI < address(wsxmr)
            ? (GnosisAddresses.SDAI, address(wsxmr))
            : (address(wsxmr), GnosisAddresses.SDAI);

        // Add a wide in-range liquidity position as swapper
        int24 tickSpacing = 60; // fee 3000 uses tick spacing of 60
        int24 tickLower = ((tick - 300) / tickSpacing) * tickSpacing;
        int24 tickUpper = ((tick + 300) / tickSpacing) * tickSpacing;

        uint256 daiAmount = 50_000 * 1e18; // 50,000 sDAI
        uint256 wsxmrAmount = 100 * 1e8;   // 100 wsXMR

        deal(GnosisAddresses.SDAI, swapper, daiAmount);
        deal(address(wsxmr), swapper, wsxmrAmount);

        vm.startPrank(swapper);
        IERC20(GnosisAddresses.SDAI).approve(GnosisAddresses.UNI_V3_POSITION_MANAGER, daiAmount);
        wsxmr.approve(GnosisAddresses.UNI_V3_POSITION_MANAGER, wsxmrAmount);

        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: POOL_FEE,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: token0 == GnosisAddresses.SDAI ? daiAmount : wsxmrAmount,
            amount1Desired: token0 == GnosisAddresses.SDAI ? wsxmrAmount : daiAmount,
            amount0Min: 0,
            amount1Min: 0,
            recipient: swapper,
            deadline: block.timestamp + 1 hours
        });

        (uint256 tokenId, uint128 liquidity,,) = INonfungiblePositionManager(GnosisAddresses.UNI_V3_POSITION_MANAGER).mint(params);
        vm.stopPrank();

        assertGt(liquidity, 0, "No liquidity minted");
        console.log("Minted liquidity:", liquidity);

        uint256 daiBefore = IERC20(GnosisAddresses.SDAI).balanceOf(swapper);
        uint256 wsxmrBefore = wsxmr.balanceOf(swapper);

        // ---- Swap 1: wsXMR -> sDAI (direct via test contract callback) ----
        bool wsxmrIsToken0 = address(wsxmr) < GnosisAddresses.SDAI;
        int256 amountSpecified1 = 0.1 * 1e8; // exact input of 0.1 wsXMR

        uint160 minSqrt = 4295128739 + 1;
        uint160 maxSqrt = 1461446703485210103287273052203988822378723970342 - 1;

        // Ensure test contract has tokens and approvals to pool
        deal(address(wsxmr), address(this), 1 * 1e8);
        deal(GnosisAddresses.SDAI, address(this), 1000 * 1e18);
        wsxmr.approve(poolAddr, type(uint256).max);
        IERC20(GnosisAddresses.SDAI).approve(poolAddr, type(uint256).max);

        (int256 amount0_1, int256 amount1_1) = IUniswapV3Pool(poolAddr).swap(
            address(this),
            wsxmrIsToken0, // zeroForOne = true means token0 -> token1
            amountSpecified1,
            wsxmrIsToken0 ? minSqrt : maxSqrt,
            ""
        );

        uint256 sdaiReceived1 = wsxmrIsToken0 ? uint256(-amount1_1) : uint256(-amount0_1);
        assertGt(sdaiReceived1, 0, "Swap 1 received zero sDAI");
        console.log("Swap 1: 0.1 wsXMR ->", sdaiReceived1 / 1e18, "sDAI");

        // ---- Swap 2: sDAI -> wsXMR (direct via test contract callback) ----
        int256 amountSpecified2 = 20 * 1e18; // exact input of 20 sDAI

        (int256 amount0_2, int256 amount1_2) = IUniswapV3Pool(poolAddr).swap(
            address(this),
            !wsxmrIsToken0, // zeroForOne = false means token1 -> token0
            amountSpecified2,
            wsxmrIsToken0 ? maxSqrt : minSqrt,
            ""
        );

        uint256 wsxmrReceived = wsxmrIsToken0 ? uint256(-amount0_2) : uint256(-amount1_2);
        assertGt(wsxmrReceived, 0, "Swap 2 received zero wsXMR");
        console.log("Swap 2: 20 sDAI ->", wsxmrReceived / 1e8, "wsXMR");

        // Sanity check: both swaps received non-trivial amounts
        assertGt(sdaiReceived1, 0, "Swap 1 received zero sDAI");
        assertGt(wsxmrReceived, 0, "Swap 2 received zero wsXMR");
    }

    // ========== TEST 3: Co-LP creation + trading (end-to-end) ==========

    function test_CoLPCreationAndTrading() public {
        // 1. Setup LP vault with collateral
        vm.startPrank(lp);
        VaultFacet(address(hub)).createVault();
        VaultFacet(address(hub)).setMaxMintBps(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        VaultFacet(address(hub)).setMintReadyBond(0.001 ether);

        deal(GnosisAddresses.SDAI, lp, 1000 ether);
        IERC20(GnosisAddresses.SDAI).approve(address(hub), 1000 ether);
        VaultFacet(address(hub)).depositShares(100 ether);
        vm.stopPrank();

        // 2. Mint wsXMR to user
        vm.startPrank(user);
        bytes32 testSecret = bytes32(uint256(0xabcdef));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, 20000000000, commitment, bytes32(uint256(0xdeadbeef)));
        vm.stopPrank();

        // Get the actual mint request ID from hub
        bytes32 mintRequestId = _getUserMintRequests(user)[0];

        // LP provides key and sets ready
        bytes32 lpPublicKey = bytes32(uint256(0xdeadbeef));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(mintRequestId, lpPublicKey);

        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(mintRequestId);

        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(mintRequestId, testSecret);

        // 3. User opens Co-LP position
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        wsxmr.approve(address(hub), type(uint256).max);

        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);
        assertTrue(tokenId > 0, "Co-LP should return valid tokenId");

        console.log("Co-LP created, tokenId:", tokenId);
        console.log("Pool liquidity after Co-LP:", IUniswapV3Pool(poolAddr).liquidity());

        // 4. Trade against the Co-LP position on both sides
        uint160 minSqrt = 4295128739 + 1;
        uint160 maxSqrt = 1461446703485210103287273052203988822378723970342 - 1;
        bool wsxmrIsToken0 = address(wsxmr) < GnosisAddresses.SDAI;

        // Ensure test contract has tokens for swaps
        deal(address(wsxmr), address(this), 1 * 1e8);
        deal(GnosisAddresses.SDAI, address(this), 1000 * 1e18);
        wsxmr.approve(poolAddr, type(uint256).max);
        IERC20(GnosisAddresses.SDAI).approve(poolAddr, type(uint256).max);

        // Swap 1: wsXMR -> sDAI
        (int256 amount0_1, int256 amount1_1) = IUniswapV3Pool(poolAddr).swap(
            address(this),
            wsxmrIsToken0,
            0.1 * 1e8,
            wsxmrIsToken0 ? minSqrt : maxSqrt,
            ""
        );
        uint256 sdaiReceived = wsxmrIsToken0 ? uint256(-amount1_1) : uint256(-amount0_1);
        console.log("Swap 1: 0.1 wsXMR ->", sdaiReceived / 1e18, "sDAI");
        assertGt(sdaiReceived, 0, "Swap 1 received zero sDAI");

        // Swap 2: sDAI -> wsXMR
        (int256 amount0_2, int256 amount1_2) = IUniswapV3Pool(poolAddr).swap(
            address(this),
            !wsxmrIsToken0,
            20 * 1e18,
            wsxmrIsToken0 ? maxSqrt : minSqrt,
            ""
        );
        uint256 wsxmrReceived = wsxmrIsToken0 ? uint256(-amount0_2) : uint256(-amount1_2);
        console.log("Swap 2: 20 sDAI ->", wsxmrReceived / 1e8, "wsXMR");
        assertGt(wsxmrReceived, 0, "Swap 2 received zero wsXMR");

        // Sanity check: both swaps received non-trivial amounts
        assertGt(sdaiReceived, 0, "Swap 1 received zero sDAI");
        assertGt(wsxmrReceived, 0, "Swap 2 received zero wsXMR");
    }

    // ========== TEST 4: Collect fees after swaps ==========

    function test_CollectFeesAfterSwaps() public {
        // 1. Setup LP vault with collateral
        vm.startPrank(lp);
        VaultFacet(address(hub)).createVault();
        VaultFacet(address(hub)).setMaxMintBps(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        VaultFacet(address(hub)).setMintReadyBond(0.001 ether);

        deal(GnosisAddresses.SDAI, lp, 1000 ether);
        IERC20(GnosisAddresses.SDAI).approve(address(hub), 1000 ether);
        VaultFacet(address(hub)).depositShares(100 ether);
        vm.stopPrank();

        // 2. Give user wsXMR directly (skip expensive mint cycle)
        deal(address(wsxmr), user, 2 * 1e8);

        // 3. Open Co-LP (smaller amount for higher tick range)
        uint256 wsxmrToDeposit = 1 * 1e8;
        vm.prank(user);
        wsxmr.approve(address(hub), type(uint256).max);
        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);
        assertTrue(tokenId > 0, "Co-LP should return valid tokenId");

        // 4. Trade against the position to generate fees
        uint160 minSqrt = 4295128739 + 1;
        uint160 maxSqrt = 1461446703485210103287273052203988822378723970342 - 1;
        bool wsxmrIsToken0 = address(wsxmr) < GnosisAddresses.SDAI;

        deal(address(wsxmr), address(this), 1 * 1e8);
        deal(GnosisAddresses.SDAI, address(this), 1000 * 1e18);
        wsxmr.approve(poolAddr, type(uint256).max);
        IERC20(GnosisAddresses.SDAI).approve(poolAddr, type(uint256).max);

        IUniswapV3Pool(poolAddr).swap(address(this), wsxmrIsToken0, 0.2 * 1e8, wsxmrIsToken0 ? minSqrt : maxSqrt, "");
        IUniswapV3Pool(poolAddr).swap(address(this), !wsxmrIsToken0, 40 * 1e18, wsxmrIsToken0 ? maxSqrt : minSqrt, "");

        // 5. Collect fees (use .call() not staticcall for hub view functions due to EIP-1153 TSTORE)
        uint256 daiPendingBefore = _getPendingReturns(lp, GnosisAddresses.SDAI);
        uint256 wsxmrPendingBefore = _getPendingReturns(user, address(wsxmr));

        vm.prank(user);
        VaultFacet(address(hub)).collectCoLPFees(tokenId);

        uint256 daiPendingAfter = _getPendingReturns(lp, GnosisAddresses.SDAI);
        uint256 wsxmrPendingAfter = _getPendingReturns(user, address(wsxmr));

        console.log("sDAI fees collected:", (daiPendingAfter - daiPendingBefore) / 1e18);
        console.log("wsXMR fees collected:", (wsxmrPendingAfter - wsxmrPendingBefore) / 1e8);

        assertGt(daiPendingAfter, daiPendingBefore, "LP should have earned sDAI fees");
        assertGt(wsxmrPendingAfter, wsxmrPendingBefore, "User should have earned wsXMR fees");
    }

    // ========== TEST 5: Regression - Co-LP large liquidity does not overflow router math ==========
    function test_CoLPLargeLiquidityNoOverflow() public {
        // 1. Setup LP vault with significant collateral
        vm.startPrank(lp);
        VaultFacet(address(hub)).createVault();
        VaultFacet(address(hub)).setMaxMintBps(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        VaultFacet(address(hub)).setMintReadyBond(0.001 ether);

        deal(GnosisAddresses.SDAI, lp, 1000 ether);
        IERC20(GnosisAddresses.SDAI).approve(address(hub), 1000 ether);
        VaultFacet(address(hub)).depositShares(100 ether);
        vm.stopPrank();

        // 2. Give user wsXMR directly (skip mint cycle)
        deal(address(wsxmr), user, 10 * 1e8); // 10 wsXMR

        // 3. Open Co-LP with large amount to create substantial liquidity
        uint256 wsxmrToDeposit = 5 * 1e8; // 5 wsXMR
        vm.prank(user);
        wsxmr.approve(address(hub), type(uint256).max);
        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);
        assertTrue(tokenId > 0, "Co-LP should return valid tokenId");

        console.log("Co-LP tokenId:", tokenId);
        console.log("Pool liquidity after Co-LP:", IUniswapV3Pool(poolAddr).liquidity());

        // 4. Regression: router.getPositionAmountsAtPrice must NOT overflow with large liquidity
        // The on-chain bug was: uint256(liq) * (1 << 96) * diff0 overflowed uint256
        // when liquidity was ~3.4e23. This test creates a position and verifies
        // the router can compute its value without reverting.
        (uint256 daiAmt, uint256 wsxmrAmt) = router.getPositionAmountsAtPrice(tokenId, XMR_PRICE);
        console.log("Position sDAI value:", daiAmt);
        console.log("Position wsXMR value:", wsxmrAmt);
        // Values should be non-zero for an in-range position
        assertGt(daiAmt + wsxmrAmt, 0, "Position amounts should be non-zero");

        // 5. Regression: withdrawCollateral must work after Co-LP creation
        // The contract calls _getVaultPositionTotalsAtOracle which delegates to
        // the router's _getAmountsAtSqrtPrice. Prior to the fix this overflowed.
        uint256 withdrawShares = 1e15; // very small withdrawal
        vm.prank(lp);
        VaultFacet(address(hub)).withdrawCollateral(withdrawShares);
        console.log("Small collateral withdrawal succeeded after Co-LP");
    }

    // Helper to get user's mint requests
    function _getUserMintRequests(address u) internal returns (bytes32[] memory) {
        (bool success, bytes memory result) = address(hub).call(abi.encodeWithSignature("getUserMintRequests(address)", u));
        require(success, "hub view call failed");
        return abi.decode(result, (bytes32[]));
    }

    function _getPendingReturns(address who, address token) internal returns (uint256) {
        (bool success, bytes memory result) = address(hub).call(
            abi.encodeWithSignature("getPendingReturns(address,address)", who, token)
        );
        require(success, "hub view call failed");
        return abi.decode(result, (uint256));
    }

    // Uniswap V3 swap callback - pool calls this during swap to settle tokens
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (amount0Delta > 0) {
            address token0 = IUniswapV3Pool(msg.sender).token0();
            IERC20(token0).transfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            address token1 = IUniswapV3Pool(msg.sender).token1();
            IERC20(token1).transfer(msg.sender, uint256(amount1Delta));
        }
    }
}
