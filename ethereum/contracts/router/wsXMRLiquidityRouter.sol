// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IwsXmrLiquidityRouter} from "../interfaces/router/IwsXmrLiquidityRouter.sol";
import {INonfungiblePositionManager} from "../interfaces/external/INonfungiblePositionManager.sol";
import {IUniswapV3Pool} from "../interfaces/external/IUniswapV3Pool.sol";
import {IUniswapV3Factory} from "../interfaces/external/IUniswapV3Factory.sol";
import {GnosisAddresses} from "../GnosisAddresses.sol";

/**
 * @title wsXMRLiquidityRouter
 * @notice Thin wrapper around Uniswap V3 NonfungiblePositionManager for concentrated co-LP.
 * @dev Called only by the diamond (via onlyDiamond modifier). Holds no balances and no user state.
 *      All accounting lives in the diamond's storage. The diamond owns all V3 NFTs.
 */
contract wsXMRLiquidityRouter is IwsXmrLiquidityRouter {
    using SafeERC20 for IERC20;

    // ========== IMMUTABLES ==========

    address public immutable hub;
    address public immutable positionManager;
    address public immutable sDAI;
    address public immutable wsXMR;
    address public immutable pool;
    bool public immutable sDAIIsToken0;

    // ========== CONSTANTS ==========

    uint24 public constant POOL_FEE = 3000;
    int24 public constant TICK_SPACING = 60;
    int24 private constant MIN_TICK = -887272;
    int24 private constant MAX_TICK = 887272;

    // ========== CONSTRUCTOR ==========

    constructor(
        address _hub,
        address _positionManager,
        address _sDAI,
        address _wsXMR,
        address _pool
    ) {
        if (_hub == address(0) || _positionManager == address(0) ||
            _sDAI == address(0) || _wsXMR == address(0) || _pool == address(0)) {
            revert ZeroAddress();
        }

        hub = _hub;
        positionManager = _positionManager;
        sDAI = _sDAI;
        wsXMR = _wsXMR;
        pool = _pool;
        sDAIIsToken0 = _sDAI < _wsXMR;
    }

    // ========== MODIFIERS ==========

    modifier onlyDiamond() {
        if (msg.sender != hub) revert Unauthorized();
        _;
    }

    // ========== INITIALIZATION ==========

    function initializePool(uint256 initialXmrPrice) external onlyDiamond {
        uint256 collateralPrice = 1e18; // sDAI ≈ $1
        uint160 sqrtPriceX96 = _priceToSqrtPriceX96(initialXmrPrice, collateralPrice);

        IUniswapV3Pool(pool).initialize(sqrtPriceX96);

        emit PoolInitialized(pool, sqrtPriceX96, collateralPrice, initialXmrPrice);
    }

    // ========== POSITION MANAGEMENT ==========

    function mintConcentratedPosition(
        uint256 daiAmount,
        uint256 wsxmrAmount,
        uint16 rangeBps,
        uint256 centerXmrPrice,
        uint256 deadline
    ) external onlyDiamond returns (
        uint256 tokenId,
        uint128 liquidity,
        int24 tickLower,
        int24 tickUpper
    ) {
        if (block.timestamp > deadline) revert DeadlineExpired();

        uint256 collateralPrice = 1e18;
        uint160 sqrtPriceX96 = _priceToSqrtPriceX96(centerXmrPrice, collateralPrice);
        int24 centerTick = _getTickAtSqrtRatio(sqrtPriceX96);

        int24 halfWidth = int24(int256(uint256(rangeBps) / 2));
        tickLower = centerTick - halfWidth;
        tickUpper = centerTick + halfWidth;

        // Snap to tick spacing
        tickLower = (tickLower / TICK_SPACING) * TICK_SPACING;
        tickUpper = (tickUpper / TICK_SPACING) * TICK_SPACING;

        if (tickLower < MIN_TICK) tickLower = (MIN_TICK / TICK_SPACING) * TICK_SPACING;
        if (tickUpper > MAX_TICK) tickUpper = (MAX_TICK / TICK_SPACING) * TICK_SPACING;
        if (tickLower >= tickUpper) revert InvalidRange();

        // Approve position manager
        IERC20(sDAI).forceApprove(positionManager, daiAmount);
        IERC20(wsXMR).forceApprove(positionManager, wsxmrAmount);

        (address _token0, address _token1) = sDAIIsToken0 ? (sDAI, wsXMR) : (wsXMR, sDAI);
        (uint256 amount0Desired, uint256 amount1Desired) = sDAIIsToken0
            ? (daiAmount, wsxmrAmount)
            : (wsxmrAmount, daiAmount);

        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager.MintParams({
            token0: _token0,
            token1: _token1,
            fee: POOL_FEE,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: 0,
            amount1Min: 0,
            recipient: address(this),
            deadline: deadline
        });

        (tokenId, liquidity, , ) = INonfungiblePositionManager(positionManager).mint(params);
    }

    function drainPosition(uint256 tokenId)
        external onlyDiamond
        returns (uint256 daiOut, uint256 wsxmrOut)
    {
        (, , , , , , , uint128 liq, , , , ) =
            INonfungiblePositionManager(positionManager).positions(tokenId);

        if (liq > 0) {
            INonfungiblePositionManager.DecreaseLiquidityParams memory decParams =
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: tokenId,
                    liquidity: liq,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp
                });
            INonfungiblePositionManager(positionManager).decreaseLiquidity(decParams);
        }

        INonfungiblePositionManager.CollectParams memory colParams =
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: hub,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });

        (uint256 amount0, uint256 amount1) =
            INonfungiblePositionManager(positionManager).collect(colParams);

        (daiOut, wsxmrOut) = sDAIIsToken0
            ? (amount0, amount1)
            : (amount1, amount0);

        INonfungiblePositionManager(positionManager).burn(tokenId);
    }

    function collectFees(uint256 tokenId)
        external onlyDiamond
        returns (uint256 daiFees, uint256 wsxmrFees)
    {
        INonfungiblePositionManager.CollectParams memory colParams =
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: hub,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });

        (uint256 amount0, uint256 amount1) =
            INonfungiblePositionManager(positionManager).collect(colParams);

        (daiFees, wsxmrFees) = sDAIIsToken0
            ? (amount0, amount1)
            : (amount1, amount0);
    }

    // ========== VIEW FUNCTIONS ==========

    function getPositionAmountsAtSpot(uint256 tokenId)
        external view
        returns (uint256 daiAmount, uint256 wsxmrAmount)
    {
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
        return _getAmountsAtSqrtPrice(tokenId, sqrtPriceX96);
    }

    function getPositionAmountsAtPrice(uint256 tokenId, uint256 xmrPriceUSD18)
        external view
        returns (uint256 daiAmount, uint256 wsxmrAmount)
    {
        uint256 collateralPrice = 1e18;
        uint160 sqrtPriceX96 = _priceToSqrtPriceX96(xmrPriceUSD18, collateralPrice);
        return _getAmountsAtSqrtPrice(tokenId, sqrtPriceX96);
    }

    function isPositionOutOfRange(uint256 tokenId, uint256 xmrPrice) external view returns (bool) {
        (, , , , , int24 tickLower, int24 tickUpper, , , , , ) =
            INonfungiblePositionManager(positionManager).positions(tokenId);

        uint160 sqrtPriceX96 = _priceToSqrtPriceX96(xmrPrice, 1e18);

        uint160 sqrtLower = _getSqrtRatioAtTick(tickLower);
        uint160 sqrtUpper = _getSqrtRatioAtTick(tickUpper);
        return sqrtPriceX96 <= sqrtLower || sqrtPriceX96 >= sqrtUpper;
    }

    function poolInitialized() external view returns (bool) {
        return pool != address(0);
    }

    function token0() external view returns (address) {
        return sDAIIsToken0 ? sDAI : wsXMR;
    }

    function token1() external view returns (address) {
        return sDAIIsToken0 ? wsXMR : sDAI;
    }

    // ========== INTERNAL: TICK MATH ==========

    /// @dev Convert oracle XMR price (USD, 18 decimals) to sqrtPriceX96 for the sDAI/wsXMR pool.
    ///      sDAI is pegged ~$1 so collateralPrice ≈ 1e18.
    function _priceToSqrtPriceX96(uint256 xmrPrice, uint256 collateralPrice)
        private view returns (uint160)
    {
        // Pool price = token1/token0
        // If sDAI is token0: price = wsXMR/sDAI = (xmrPrice * 1e18) / (collateralPrice * 1e8)
        // If wsXMR is token0: price = sDAI/wsXMR = (collateralPrice * 1e8) / (xmrPrice * 1e18)
        uint256 priceRatio;
        if (sDAIIsToken0) {
            priceRatio = (xmrPrice * 1e18) / (collateralPrice * 1e8);
        } else {
            priceRatio = (collateralPrice * 1e18) / (xmrPrice * 1e8);
        }

        uint256 sqrtPrice = _sqrt(priceRatio * 1e18);
        return uint160((sqrtPrice * (1 << 96)) / 1e9);
    }

    function _getTickAtSqrtRatio(uint160 sqrtPriceX96) private pure returns (int24 tick) {
        uint256 ratio = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        ratio = (ratio << 32) / 1e18; // scale to Q128.128-ish

        // Binary search for tick
        int24 lo = MIN_TICK;
        int24 hi = MAX_TICK;
        while (lo <= hi) {
            int24 mid = (lo + hi) / 2;
            uint160 midSqrt = _getSqrtRatioAtTick(mid);
            if (midSqrt <= sqrtPriceX96) {
                tick = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
    }

    function _getSqrtRatioAtTick(int24 tick) private pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        if (absTick > uint256(int256(MAX_TICK))) absTick = uint256(int256(MAX_TICK));

        uint256 ratio = (absTick & 0x1) != 0
            ? 0xfffcb933bd6fad37aa2d162d1a594001
            : 0x100000000000000000000000000000000;
        if ((absTick & 0x2) != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if ((absTick & 0x4) != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if ((absTick & 0x8) != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if ((absTick & 0x10) != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if ((absTick & 0x20) != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if ((absTick & 0x40) != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if ((absTick & 0x80) != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if ((absTick & 0x100) != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if ((absTick & 0x200) != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if ((absTick & 0x400) != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if ((absTick & 0x800) != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if ((absTick & 0x1000) != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if ((absTick & 0x2000) != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if ((absTick & 0x4000) != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if ((absTick & 0x8000) != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if ((absTick & 0x10000) != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if ((absTick & 0x20000) != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if ((absTick & 0x40000) != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if ((absTick & 0x80000) != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

        if (tick > 0) ratio = type(uint256).max / ratio;

        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }

    function _getAmountsAtSqrtPrice(uint256 tokenId, uint160 sqrtPriceX96)
        private view
        returns (uint256 daiAmount, uint256 wsxmrAmount)
    {
        (, , , , , int24 tickLower, int24 tickUpper, uint128 liq, , , , ) =
            INonfungiblePositionManager(positionManager).positions(tokenId);

        if (liq == 0) return (0, 0);

        uint160 sqrtLower = _getSqrtRatioAtTick(tickLower);
        uint160 sqrtUpper = _getSqrtRatioAtTick(tickUpper);

        uint160 sqrtPrice = sqrtPriceX96;
        if (sqrtPrice < sqrtLower) sqrtPrice = sqrtLower;
        if (sqrtPrice > sqrtUpper) sqrtPrice = sqrtUpper;

        uint256 diff0 = sqrtUpper - sqrtPrice;
        uint256 diff1 = sqrtPrice - sqrtLower;

        uint256 amount0 = (uint256(liq) * (1 << 96) * diff0)
            / (uint256(sqrtUpper) * uint256(sqrtPrice));
        uint256 amount1 = (uint256(liq) * diff1) / (1 << 96);

        (daiAmount, wsxmrAmount) = sDAIIsToken0
            ? (amount0, amount1)
            : (amount1, amount0);
    }

    function _sqrt(uint256 x) private pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}
