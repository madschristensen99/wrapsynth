// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title ISwapRouter
 * @notice Interface for the HyperSwap V3 SwapRouter02 on HyperEVM.
 * @dev    HyperSwap's router uses a NON-STANDARD exactInputSingle signature:
 *         a 7-field params struct with NO deadline field (selector 0x04e45aaf),
 *         unlike canonical Uniswap V3's 8-field struct (selector 0x414bf389).
 *         Field order: tokenIn, tokenOut, fee, recipient, amountIn,
 *         amountOutMinimum, sqrtPriceLimitX96.
 */
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
