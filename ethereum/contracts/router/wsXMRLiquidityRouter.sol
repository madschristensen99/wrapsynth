// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IwsXmrLiquidityRouter} from "../interfaces/router/IwsXmrLiquidityRouter.sol";
import {INonfungiblePositionManager} from "../interfaces/external/INonfungiblePositionManager.sol";
import {IUniswapV3Pool} from "../interfaces/external/IUniswapV3Pool.sol";
import {IUniswapV3Factory} from "../interfaces/external/IUniswapV3Factory.sol";
import {GnosisAddresses} from "../GnosisAddresses.sol";
import {TickMath} from "../libraries/TickMath.sol";

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
        int24 centerTick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);

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

        uint160 sqrtLower = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtRatioAtTick(tickUpper);
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

    function _getAmountsAtSqrtPrice(uint256 tokenId, uint160 sqrtPriceX96)
        private view
        returns (uint256 daiAmount, uint256 wsxmrAmount)
    {
        (, , , , , int24 tickLower, int24 tickUpper, uint128 liq, , , , ) =
            INonfungiblePositionManager(positionManager).positions(tokenId);

        if (liq == 0) return (0, 0);

        uint160 sqrtLower = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtRatioAtTick(tickUpper);

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
