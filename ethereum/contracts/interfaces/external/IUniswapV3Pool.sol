// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

interface IUniswapV3Pool {
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint32 feeProtocol, // uint8 on UniV3, uint32 on PancakeSwap V3 — uint32 decodes both
        bool unlocked
    );

    function liquidity() external view returns (uint128);

    function token0() external view returns (address);
    function token1() external view returns (address);

    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    function initialize(uint160 sqrtPriceX96) external;

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}
