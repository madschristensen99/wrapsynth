// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MockTwapPool
 * @notice Test-only stand-in for a UniV3-style pool's `observe()` oracle.
 *         Stores a single configurable tick and fabricates tick cumulatives
 *         that are linear in time (cumulative(t) = tick * t), so the arithmetic
 *         mean over any queried window equals `tick` exactly.
 * @dev    Lets BNB fork tests drive the collateral TWAP leg
 *         (_twapQuote18 → _quoteAtTick) through the real production math while
 *         keeping the price controllable and permanently "fresh" — unlike a
 *         raw storage poke, timestamps keep updating on every refresh.
 */
contract MockTwapPool {
    int56 public tick;

    constructor(int24 _tick) {
        tick = _tick;
    }

    function setTick(int24 _tick) external {
        tick = _tick;
    }

    /// @dev UniV3-compatible observe: cumulative(now - ago) = tick * (K - ago)
    ///      for a fixed large K, so deltas between any two ages equal
    ///      tick * (agoA - agoB) — i.e. mean tick == tick.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            // K=1e9 keeps tick*K within int56 range (|tick| ≤ 887272 → ≤8.9e14)
            tickCumulatives[i] = tick * int56(uint56(uint256(1e9) - secondsAgos[i]));
        }
    }
}
