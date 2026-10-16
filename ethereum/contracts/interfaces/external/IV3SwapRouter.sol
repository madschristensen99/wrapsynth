// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title IV3SwapRouter
 * @notice Canonical Uniswap V3 / PancakeSwap V3 SwapRouter interface.
 * @dev    Uses the standard 8-field exactInputSingle params struct WITH a
 *         deadline field (selector 0x414bf389). PancakeSwap V3's SwapRouter
 *         on BNB Chain (0x1b81D678ffb9C0263b24A97847620C99d213eB14) only
 *         implements this variant — it does NOT have HyperSwap's non-standard
 *         7-field no-deadline selector used by ISwapRouter.
 */
interface IV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
