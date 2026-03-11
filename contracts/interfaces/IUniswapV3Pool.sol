// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

interface IUniswapV3Pool {
    function liquidity() external view returns (uint128);
    
    function initialize(uint160 sqrtPriceX96) external;
}
