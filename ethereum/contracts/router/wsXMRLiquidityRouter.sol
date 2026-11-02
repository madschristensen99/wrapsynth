// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IwsXmrLiquidityRouter} from "../interfaces/router/IwsXmrLiquidityRouter.sol";
import {INonfungiblePositionManager} from "../interfaces/external/INonfungiblePositionManager.sol";
import {IUniswapV3Pool} from "../interfaces/external/IUniswapV3Pool.sol";
import {IUniswapV3Factory} from "../interfaces/external/IUniswapV3Factory.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
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
    address public immutable collateral;
    address public immutable wsXMR;
    address public immutable pool;
    bool public immutable collateralIsToken0;

    /// @dev sqrt of the raw-unit decimal scale factor between the quote token
    ///      ("collateral"/collateral) and wsXMR (8 decimals). For an 18-dec quote
    ///      token the factor is 1e10 → SQRT_DEC_DEN = 1e5; for an 8-dec quote
    ///      (cbBTC) both are 1; for a sub-8-dec quote the inverse lands on the
    ///      numerator side (SQRT_DEC_NUM = sqrt(10^(8-dec))).
    uint256 private immutable SQRT_DEC_NUM;
    uint256 private immutable SQRT_DEC_DEN;

    // ========== CONSTANTS ==========

    /// @notice V3 pool fee tier and tick spacing — set per deployment
    ///         (UniV3 0.3% = 3000/60; PancakeSwap V3 0.05% = 500/10)
    uint24 public immutable POOL_FEE;
    int24 public immutable TICK_SPACING;
    int24 private constant MIN_TICK = -887272;
    int24 private constant MAX_TICK = 887272;
    uint256 private constant BPS_DENOMINATOR = 10000;

    // ========== CONSTRUCTOR ==========

    constructor(
        address _hub,
        address _positionManager,
        address _collateral,
        address _wsXMR,
        address _pool
    ) {
        if (_hub == address(0) || _positionManager == address(0) ||
            _collateral == address(0) || _wsXMR == address(0) || _pool == address(0)) {
            revert ZeroAddress();
        }

        hub = _hub;
        positionManager = _positionManager;
        collateral = _collateral;
        wsXMR = _wsXMR;
        pool = _pool;
        collateralIsToken0 = _collateral < _wsXMR;

        // Self-derive fee tier, tick spacing, and the quote token's decimals
        // from the pool so one codebase serves UniV3 (3000/60), PancakeSwap
        // V3 (500/10, 2500/50, ...) and collateral of any decimal width.
        POOL_FEE = IUniswapV3Pool(_pool).fee();
        TICK_SPACING = IUniswapV3Pool(_pool).tickSpacing();

        uint8 collateralDec;
        try IERC20Metadata(_collateral).decimals() returns (uint8 d) {
            collateralDec = d;
        } catch {
            collateralDec = 18;
        }
        if (collateralDec >= 8) {
            SQRT_DEC_DEN = _sqrt(10 ** (collateralDec - 8));
            SQRT_DEC_NUM = 1;
        } else {
            SQRT_DEC_NUM = _sqrt(10 ** (8 - collateralDec));
            SQRT_DEC_DEN = 1;
        }
    }

    // ========== MODIFIERS ==========

    modifier onlyDiamond() {
        if (msg.sender != hub) revert Unauthorized();
        _;
    }

    // ========== INITIALIZATION ==========

    function initializePool(uint256 initialXmrPrice) external onlyDiamond {
        initializePoolWithPrice(initialXmrPrice, 1e18); // collateral/USDe ≈ $1
    }

    /// @notice Initialize the pool at an explicit collateral price — required on
    ///         chains where the collateral asset isn't ~$1 (QQQB on BNB).
    /// @param initialXmrPrice XMR price in USD (18 decimals)
    /// @param collateralPrice Collateral asset price in USD (18 decimals)
    function initializePoolWithPrice(uint256 initialXmrPrice, uint256 collateralPrice) public onlyDiamond {
        uint160 sqrtPriceX96 = _priceToSqrtPriceX96(initialXmrPrice, collateralPrice);

        IUniswapV3Pool(pool).initialize(sqrtPriceX96);

        emit PoolInitialized(pool, sqrtPriceX96, collateralPrice, initialXmrPrice);
    }

    // ========== POSITION MANAGEMENT ==========

    /// @notice Mint a concentrated position centered on the pool's own slot0
    ///         tick. No oracle input — the caller (CoLPFacet) supplies both leg
    ///         amounts and slippage bounds; the range is pool-native.
    function mintConcentratedPosition(
        uint256 collateralAmount,
        uint256 wsxmrAmount,
        uint16 rangeBps,
        uint256 deadline,
        uint16 slippageBps
    ) external onlyDiamond returns (
        uint256 tokenId,
        uint128 liquidity,
        int24 tickLower,
        int24 tickUpper,
        uint256 collateralConsumed,
        uint256 wsxmrConsumed
    ) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (slippageBps >= BPS_DENOMINATOR) revert SlippageExceeded();

        // Center position on the pool's actual price so it always starts in-range
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
        int24 centerTick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);

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
            // Price below range - only need token0 (wsXMR if wsXMR is token0, else collateral)
            amount0Desired = collateralIsToken0 ? collateralAmount : wsxmrAmount;
            amount1Desired = 0;
        } else if (sqrtPriceX96 >= sqrtUpper) {
            // Price above range - only need token1 (collateral if wsXMR is token0, else wsXMR)
            amount0Desired = 0;
            amount1Desired = collateralIsToken0 ? wsxmrAmount : collateralAmount;
        } else {
            // Price in range - calculate ratio needed
            // For a given liquidity L, amounts are:
            // amount0 = L * (sqrt(upper) - sqrt(price)) / (sqrt(upper) * sqrt(price))
            // amount1 = L * (sqrt(price) - sqrt(lower))
            
            // Calculate liquidity from each token and use the smaller one
            uint256 amount0Avail = collateralIsToken0 ? collateralAmount : wsxmrAmount;
            uint256 amount1Avail = collateralIsToken0 ? wsxmrAmount : collateralAmount;
            
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
                // Use FullMath to avoid overflow: amount0 = L * (1 << 96) * sqrtDiff0 / (sqrtUpper * sqrtPrice)
                uint256 numerator = FullMath.mulDiv(uint256(targetLiq), 1 << 96, uint256(sqrtUpper));
                amount0Desired = FullMath.mulDiv(numerator, sqrtDiff0, uint256(sqrtPriceX96));
            } else {
                amount0Desired = 0;
            }
            
            if (sqrtDiff1 > 0) {
                // Use FullMath to avoid overflow: amount1 = L * sqrtDiff1 / (1 << 96)
                amount1Desired = FullMath.mulDiv(uint256(targetLiq), sqrtDiff1, 1 << 96);
            } else {
                amount1Desired = 0;
            }
        }
        
        // Approve position manager with the exact amounts we'll use
        IERC20(collateral).forceApprove(positionManager, collateralIsToken0 ? amount0Desired : amount1Desired);
        IERC20(wsXMR).forceApprove(positionManager, collateralIsToken0 ? amount1Desired : amount0Desired);

        (address _token0, address _token1) = collateralIsToken0 ? (collateral, wsXMR) : (wsXMR, collateral);

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
        uint256 leftoverCollateral = IERC20(collateral).balanceOf(address(this));
        uint256 leftoverWSXMR = IERC20(wsXMR).balanceOf(address(this));
        if (leftoverCollateral > 0) {
            IERC20(collateral).safeTransfer(hub, leftoverCollateral);
        }
        if (leftoverWSXMR > 0) {
            IERC20(wsXMR).safeTransfer(hub, leftoverWSXMR);
        }

        // Map token0/token1 consumed back to collateral/wsXMR for caller accounting
        (collateralConsumed, wsxmrConsumed) = collateralIsToken0
            ? (amount0, amount1)
            : (amount1, amount0);
    }

    /// @notice Drain a position entirely — remove all liquidity, collect all
    ///         tokens to the hub, burn the NFT.
    /// @dev Post-collect slippage check uses the pool's own spot price: the
    ///      returned amounts are compared to what current slot0 predicts for
    ///      the position's liquidity. No oracle input.
    function drainPosition(uint256 tokenId, uint16 slippageBps)
        external onlyDiamond
        returns (uint256 collOut, uint256 wsxmrOut)
    {
        if (slippageBps >= BPS_DENOMINATOR) revert SlippageExceeded();

        (, , , , , , , uint128 liq, , , , ) =
            INonfungiblePositionManager(positionManager).positions(tokenId);

        if (liq > 0) {
            // D1: For a full drain of our own liquidity, Uniswap's internal slippage check
            // on decreaseLiquidity is not needed — no MEV can steal liquidity we own.
            // We verify the final collected amounts against the pool's spot price AFTER collect().
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

        (collOut, wsxmrOut) = collateralIsToken0
            ? (amount0, amount1)
            : (amount1, amount0);

        // D2: Post-collect spot sanity check — verify returned amounts are within
        // slippage tolerance of what the pool's current price predicts.
        {
            (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
            (uint256 expectedCollateral, uint256 expectedWsxmr) = _getAmountsAtSqrtPrice(tokenId, sqrtPriceX96);

            if (expectedCollateral > 0 && collOut < (expectedCollateral * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR) {
                revert SlippageExceeded();
            }
            if (expectedWsxmr > 0 && wsxmrOut < (expectedWsxmr * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR) {
                revert SlippageExceeded();
            }
        }

        INonfungiblePositionManager(positionManager).burn(tokenId);
    }

    function collectFees(uint256 tokenId)
        external onlyDiamond
        returns (uint256 collFees, uint256 wsxmrFees)
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

        (collFees, wsxmrFees) = collateralIsToken0
            ? (amount0, amount1)
            : (amount1, amount0);
    }

    // ========== VIEW FUNCTIONS ==========

    function getPositionAmountsAtSpot(uint256 tokenId)
        external view
        returns (uint256 collateralAmount, uint256 wsxmrAmount)
    {
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
        return _getAmountsAtSqrtPrice(tokenId, sqrtPriceX96);
    }

    /// @notice Out-of-range check against the pool's own slot0 price.
    ///         No oracle input — a position is "out of range" iff the pool's
    ///         current tick sits outside its [tickLower, tickUpper] window.
    function isPositionOutOfRange(uint256 tokenId) external view returns (bool) {
        (, , , , , int24 tickLower, int24 tickUpper, , , , , ) =
            INonfungiblePositionManager(positionManager).positions(tokenId);

        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();

        uint160 sqrtLower = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtRatioAtTick(tickUpper);
        return sqrtPriceX96 <= sqrtLower || sqrtPriceX96 >= sqrtUpper;
    }

    function poolInitialized() external view returns (bool) {
        return pool != address(0);
    }

    function token0() external view returns (address) {
        return collateralIsToken0 ? collateral : wsXMR;
    }

    function token1() external view returns (address) {
        return collateralIsToken0 ? wsXMR : collateral;
    }

    // ========== INTERNAL: TICK MATH ==========

    /// @dev Convert oracle XMR price (USD, 18 decimals) to sqrtPriceX96 for the collateral/wsXMR pool.
    ///      Calculates: sqrtPriceX96 = sqrt(price) * 2^96
    ///      where price = token1/token0 in raw units, accounting for decimal difference.
    ///      When collateral is token0: price = wsXMR/collateral = collateralPrice / (xmrPrice * 1e10)
    ///      When wsXMR is token0: price = collateral/wsXMR = (xmrPrice * 1e10) / collateralPrice
    function _priceToSqrtPriceX96(uint256 xmrPrice, uint256 collateralPrice)
        private view returns (uint160)
    {
        uint256 sqrtXmrPrice = _sqrt(xmrPrice);
        uint256 sqrtCollateralPrice = _sqrt(collateralPrice);
        uint256 sqrtPriceX96;

        if (collateralIsToken0) {
            // price = wsXMR/collateral = collateralPrice / (xmrPrice * decScale)
            // sqrtPriceX96 = sqrtCollateralPrice * SQRT_DEC_NUM * 2^96
            //              / (sqrtXmrPrice * SQRT_DEC_DEN)
            sqrtPriceX96 = (sqrtCollateralPrice * SQRT_DEC_NUM * (1 << 96)) / (sqrtXmrPrice * SQRT_DEC_DEN);
        } else {
            // price = collateral/wsXMR = (xmrPrice * decScale) / collateralPrice
            sqrtPriceX96 = (sqrtXmrPrice * SQRT_DEC_DEN * (1 << 96)) / (sqrtCollateralPrice * SQRT_DEC_NUM);
        }

        return uint160(sqrtPriceX96);
    }

    function _getAmountsAtSqrtPrice(uint256 tokenId, uint160 sqrtPriceX96)
        private view
        returns (uint256 collateralAmount, uint256 wsxmrAmount)
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

        // Use FullMath.mulDiv to prevent arithmetic overflow with large liquidity values.
        // amount0 = L * 2^96 * (sqrtUpper - sqrtPrice) / (sqrtUpper * sqrtPrice)
        uint256 amount0 = FullMath.mulDiv(
            uint256(liq) << 96,
            diff0,
            sqrtUpper
        ) / sqrtPrice;

        // amount1 = L * (sqrtPrice - sqrtLower) / 2^96
        uint256 amount1 = FullMath.mulDiv(uint256(liq), diff1, 1 << 96);

        (collateralAmount, wsxmrAmount) = collateralIsToken0
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
