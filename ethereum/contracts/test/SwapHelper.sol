// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool} from "../interfaces/external/IUniswapV3Pool.sol";

/**
 * @title SwapHelper
 * @notice Helper contract for executing Uniswap V3 swaps with callback
 */
contract SwapHelper {
    address private payer;

    function swap(
        address pool,
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96
    ) external returns (int256 amount0, int256 amount1) {
        // Store the caller for the callback
        payer = msg.sender;
        
        // Use extreme price limits if 0 is passed (allow any price movement)
        if (sqrtPriceLimitX96 == 0) {
            sqrtPriceLimitX96 = zeroForOne
                ? 4295128740  // MIN_SQRT_RATIO + 1 (slightly above minimum)
                : 1461446703485210103287273052203988822378723970341; // MAX_SQRT_RATIO - 1 (slightly below maximum)
        }
        
        (amount0, amount1) = IUniswapV3Pool(pool).swap(
            recipient,
            zeroForOne,
            amountSpecified,
            sqrtPriceLimitX96,
            ""
        );
        
        // Clear payer
        payer = address(0);
    }

    // Uniswap V3 callback - pool calls this to collect tokens
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external {
        if (amount0Delta > 0) {
            address token0 = IUniswapV3Pool(msg.sender).token0();
            IERC20(token0).transferFrom(payer, msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            address token1 = IUniswapV3Pool(msg.sender).token1();
            IERC20(token1).transferFrom(payer, msg.sender, uint256(amount1Delta));
        }
    }
}
