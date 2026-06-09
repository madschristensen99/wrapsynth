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
import {FullMath} from "../libraries/FullMath.sol";

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
    uint256 private constant BPS_DENOMINATOR = 10000;

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
        uint256 deadline,
        uint16 slippageBps
    ) external onlyDiamond returns (
        uint256 tokenId,
        uint128 liquidity,
        int24 tickLower,
        int24 tickUpper,
        uint256 daiConsumed,
        uint256 wsxmrConsumed
    ) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (slippageBps >= BPS_DENOMINATOR) revert SlippageExceeded();

        // M3: Use oracle price for center tick, not manipulable slot0()
        (uint160 sqrtPriceX96, int24 currentTick, , , , , ) = IUniswapV3Pool(pool).slot0();
        int24 centerTick;
        if (centerXmrPrice > 0) {
            uint160 oracleSqrtPriceX96 = _priceToSqrtPriceX96(centerXmrPrice, 1e18);
            centerTick = TickMath.getTickAtSqrtRatio(oracleSqrtPriceX96);
        } else {
            centerTick = currentTick;
        }

        int24 halfWidth = int24(int256(uint256(rangeBps) / 2));
        
        // Calculate tick bounds, ensuring we don't exceed MAX_TICK or MIN_TICK
        // Use int256 to avoid overflow in intermediate calculations
        int256 lowerCandidate = int256(centerTick) - int256(halfWidth);
        int256 upperCandidate = int256(centerTick) + int256(halfWidth);
        
        tickLower = lowerCandidate < int256(MIN_TICK) ? MIN_TICK : int24(lowerCandidate);
        tickUpper = upperCandidate > int256(MAX_TICK) ? MAX_TICK : int24(upperCandidate);

        // Snap to tick spacing - ensure we stay within bounds
        if (tickLower < MIN_TICK) {
            tickLower = MIN_TICK;
        }
        if (tickUpper > MAX_TICK) {
            tickUpper = MAX_TICK;
        }
        
        tickLower = (tickLower / TICK_SPACING) * TICK_SPACING;
        tickUpper = (tickUpper / TICK_SPACING) * TICK_SPACING;
        
        // Double-check bounds after snapping
        if (tickLower < MIN_TICK) tickLower = MIN_TICK;
        if (tickUpper > MAX_TICK) tickUpper = MAX_TICK;
        if (tickLower >= tickUpper) revert InvalidRange();

        // Final validation: ensure ticks are within absolute bounds
        require(tickLower >= MIN_TICK && tickLower <= MAX_TICK, "tickLower out of bounds");
        require(tickUpper >= MIN_TICK && tickUpper <= MAX_TICK, "tickUpper out of bounds");

        // Calculate optimal token amounts based on current price and position range
        uint160 sqrtLower = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtRatioAtTick(tickUpper);
        
        uint256 amount0Desired;
        uint256 amount1Desired;
        
        if (sqrtPriceX96 <= sqrtLower) {
            // Price below range - only need token0 (wsXMR if wsXMR is token0, else sDAI)
            amount0Desired = sDAIIsToken0 ? daiAmount : wsxmrAmount;
            amount1Desired = 0;
        } else if (sqrtPriceX96 >= sqrtUpper) {
            // Price above range - only need token1 (sDAI if wsXMR is token0, else wsXMR)
            amount0Desired = 0;
            amount1Desired = sDAIIsToken0 ? wsxmrAmount : daiAmount;
        } else {
            // Price in range - calculate ratio needed
            // For a given liquidity L, amounts are:
            // amount0 = L * (sqrt(upper) - sqrt(price)) / (sqrt(upper) * sqrt(price))
            // amount1 = L * (sqrt(price) - sqrt(lower))
            
            // Calculate liquidity from each token and use the smaller one
            uint256 amount0Avail = sDAIIsToken0 ? daiAmount : wsxmrAmount;
            uint256 amount1Avail = sDAIIsToken0 ? wsxmrAmount : daiAmount;
            
            // L from amount0: L = amount0 * sqrt(upper) * sqrt(price) / (sqrt(upper) - sqrt(price)) / 2^96
            uint256 liq0;
            uint256 sqrtDiff0 = sqrtUpper > sqrtPriceX96 ? sqrtUpper - sqrtPriceX96 : 0;
            if (sqrtDiff0 > 0) {
                // Use FullMath for precision: multiply before dividing
                uint256 numerator = FullMath.mulDiv(amount0Avail, uint256(sqrtPriceX96), 1 << 96);
                liq0 = FullMath.mulDiv(numerator, uint256(sqrtUpper), sqrtDiff0);
            } else {
                liq0 = type(uint256).max; // Price at or above upper, token0 not needed
            }
            
            // L from amount1: L = amount1 * 2^96 / (sqrt(price) - sqrt(lower))
            uint256 liq1;
            uint256 sqrtDiff1 = sqrtPriceX96 > sqrtLower ? sqrtPriceX96 - sqrtLower : 0;
            if (sqrtDiff1 > 0) {
                liq1 = FullMath.mulDiv(amount1Avail, 1 << 96, sqrtDiff1);
            } else {
                liq1 = type(uint256).max; // Price at or below lower, token1 not needed
            }
            
            // Use the smaller liquidity and calculate exact amounts
            uint256 minLiq = liq0 < liq1 ? liq0 : liq1;
            if (minLiq > type(uint128).max) minLiq = type(uint128).max;
            uint128 targetLiq = uint128(minLiq);
            
            // Calculate exact amounts for this liquidity using the same sqrtDiff values
            if (sqrtDiff0 > 0) {
                amount0Desired = (uint256(targetLiq) * (1 << 96) * sqrtDiff0)
                    / (uint256(sqrtUpper) * uint256(sqrtPriceX96));
            } else {
                amount0Desired = 0;
            }
            
            if (sqrtDiff1 > 0) {
                amount1Desired = (uint256(targetLiq) * sqrtDiff1) / (1 << 96);
            } else {
                amount1Desired = 0;
            }
        }
        
        // Approve position manager with the exact amounts we'll use
        IERC20(sDAI).forceApprove(positionManager, sDAIIsToken0 ? amount0Desired : amount1Desired);
        IERC20(wsXMR).forceApprove(positionManager, sDAIIsToken0 ? amount1Desired : amount0Desired);

        (address _token0, address _token1) = sDAIIsToken0 ? (sDAI, wsXMR) : (wsXMR, sDAI);

        // Compute slippage floors: at least (100% - slippageBps) of each desired amount must be consumed
        uint256 amount0Min = amount0Desired > 0
            ? (amount0Desired * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR
            : 0;
        uint256 amount1Min = amount1Desired > 0
            ? (amount1Desired * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR
            : 0;

        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager.MintParams({
            token0: _token0,
            token1: _token1,
            fee: POOL_FEE,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            recipient: address(this),
            deadline: deadline
        });

        uint256 amount0;
        uint256 amount1;
        (tokenId, liquidity, amount0, amount1) = INonfungiblePositionManager(positionManager).mint(params);

        // M2: Sweep any leftover tokens back to hub so they don't strand in the router
        uint256 leftoverSDAI = IERC20(sDAI).balanceOf(address(this));
        uint256 leftoverWSXMR = IERC20(wsXMR).balanceOf(address(this));
        if (leftoverSDAI > 0) {
            IERC20(sDAI).safeTransfer(hub, leftoverSDAI);
        }
        if (leftoverWSXMR > 0) {
            IERC20(wsXMR).safeTransfer(hub, leftoverWSXMR);
        }

        // Map token0/token1 consumed back to sDAI/wsXMR for caller accounting
        (daiConsumed, wsxmrConsumed) = sDAIIsToken0
            ? (amount0, amount1)
            : (amount1, amount0);
    }

    function drainPosition(uint256 tokenId, uint16 slippageBps)
        external onlyDiamond
        returns (uint256 daiOut, uint256 wsxmrOut)
    {
        if (slippageBps >= BPS_DENOMINATOR) revert SlippageExceeded();

        (, , , , , , , uint128 liq, , , , ) =
            INonfungiblePositionManager(positionManager).positions(tokenId);

        if (liq > 0) {
            // Query expected amounts for slippage protection on decreaseLiquidity
            (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
            (uint256 expectedDai, uint256 expectedWsxmr) = _getAmountsAtSqrtPrice(tokenId, sqrtPriceX96);

            (uint256 min0, uint256 min1) = sDAIIsToken0
                ? (
                    expectedDai > 0 ? (expectedDai * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR : 0,
                    expectedWsxmr > 0 ? (expectedWsxmr * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR : 0
                  )
                : (
                    expectedWsxmr > 0 ? (expectedWsxmr * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR : 0,
                    expectedDai > 0 ? (expectedDai * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR : 0
                  );

            INonfungiblePositionManager.DecreaseLiquidityParams memory decParams =
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: tokenId,
                    liquidity: liq,
                    amount0Min: min0,
                    amount1Min: min1,
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
    ///      Calculates: sqrtPriceX96 = sqrt(price) * 2^96
    ///      where price = (xmrPrice/collateralPrice) * 10^(decimal_diff)
    function _priceToSqrtPriceX96(uint256 xmrPrice, uint256 collateralPrice)
        private pure returns (uint160)
    {
        // Price ratio in USD terms (both 1e18)
        // 1 wsXMR (1e8) = (xmrPrice/collateralPrice) sDAI (1e18)
        // Uniswap price = sDAI/wsXMR in raw units = (xmrPrice/collateralPrice) * 1e10
        
        // Calculate: sqrt((xmrPrice/collateralPrice) * 1e10) * 2^96
        // = sqrt(xmrPrice * 1e10 / collateralPrice) * 2^96
        // = sqrt(xmrPrice * 1e10) / sqrt(collateralPrice) * 2^96
        
        // To avoid overflow, calculate: sqrt(xmrPrice) * sqrt(1e10) * 2^96 / sqrt(collateralPrice)
        uint256 sqrtXmrPrice = _sqrt(xmrPrice);
        uint256 sqrtCollateralPrice = _sqrt(collateralPrice);
        uint256 sqrt1e10 = 100000; // sqrt(1e10) = 1e5
        
        // sqrtPriceX96 = (sqrtXmrPrice * sqrt1e10 * 2^96) / sqrtCollateralPrice
        // Shift left by 96 bits
        uint256 sqrtPriceX96 = (sqrtXmrPrice * sqrt1e10 * (1 << 96)) / sqrtCollateralPrice;
        
        return uint160(sqrtPriceX96);
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

        uint256 diff0 = sqrtUpper > sqrtPrice ? sqrtUpper - sqrtPrice : 0;
        uint256 diff1 = sqrtPrice > sqrtLower ? sqrtPrice - sqrtLower : 0;

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
