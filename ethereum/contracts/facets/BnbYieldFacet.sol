// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {YieldFacet} from "./YieldFacet.sol";
import {IV3SwapRouter} from "../interfaces/external/IV3SwapRouter.sol";

/**
 * @title BnbYieldFacet
 * @notice BNB Chain variant of YieldFacet. PancakeSwap V3's SwapRouter implements the
 *         canonical 8-field exactInputSingle (with deadline), not HyperSwap's 7-field
 *         no-deadline variant — so only the swap call differs.
 */
contract BnbYieldFacet is YieldFacet {
    constructor(address _wsxmrToken, address _verifierProxy)
        YieldFacet(_wsxmrToken, _verifierProxy)
    {}

    function _swapUnderlyingForWsxmr(uint24 poolFeeTier, uint256 amountIn, uint256 minWsxmr)
        internal override returns (uint256)
    {
        IV3SwapRouter.ExactInputSingleParams memory params = IV3SwapRouter.ExactInputSingleParams({
            tokenIn: underlyingToken,
            tokenOut: wsxmrToken,
            fee: poolFeeTier,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: minWsxmr,
            sqrtPriceLimitX96: 0
        });
        return IV3SwapRouter(swapRouter).exactInputSingle(params);
    }
}
