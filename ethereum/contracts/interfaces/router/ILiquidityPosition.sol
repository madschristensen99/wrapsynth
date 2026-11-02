// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title ILiquidityPosition
 * @notice Interface for concentrated liquidity position operations on the router.
 * @dev All mutating functions are onlyDiamond. Views are public.
 *      Oracle-free: no price inputs anywhere — ranges derive from the pool's
 *      own slot0 tick and slippage protection is caller-supplied bounds.
 */
interface ILiquidityPosition {
    // ========== ERRORS ==========

    error PositionNotFound();
    error InvalidRange();
    error DeadlineExpired();
    error SlippageExceeded();

    // ========== MUTATING (onlyDiamond) ==========

    /// @notice Mint a concentrated V3 position centered on the pool's own slot0
    ///         tick. Caller (diamond) must have transferred collateralAmount of
    ///         collateral and wsxmrAmount of wsXMR to this contract before calling.
    /// @param collateralAmount Collateral amount (raw token units)
    /// @param wsxmrAmount wsXMR amount (1e8)
    /// @param rangeBps Full width in bps (e.g. 2000 = ±10% around center)
    /// @param deadline Transaction deadline
    /// @param slippageBps Max acceptable slippage in bps (e.g. 50 = 0.5%)
    /// @return tokenId V3 NFT id (owned by the diamond)
    /// @return liquidity Amount of liquidity minted
    /// @return tickLower Lower tick (snapped to tick spacing)
    /// @return tickUpper Upper tick (snapped to tick spacing)
    /// @return daiConsumed Actual collateral amount consumed by the mint
    /// @return wsxmrConsumed Actual wsXMR amount consumed by the mint
    function mintConcentratedPosition(
        uint256 collateralAmount,
        uint256 wsxmrAmount,
        uint16 rangeBps,
        uint256 deadline,
        uint16 slippageBps
    ) external returns (
        uint256 tokenId,
        uint128 liquidity,
        int24 tickLower,
        int24 tickUpper,
        uint256 daiConsumed,
        uint256 wsxmrConsumed
    );

    /// @notice Drain all liquidity from a position and collect tokens to diamond.
    ///         Burns the NFT after draining. Post-collect sanity check compares
    ///         returned amounts against what the pool's current slot0 price
    ///         predicts for the position's liquidity — no oracle input.
    /// @param tokenId V3 NFT id (diamond must own it)
    /// @param slippageBps Max acceptable slippage in bps (e.g. 50 = 0.5%)
    /// @return collOut Collateral recovered
    /// @return wsxmrOut wsXMR recovered
    function drainPosition(uint256 tokenId, uint16 slippageBps)
        external returns (uint256 collOut, uint256 wsxmrOut);

    /// @notice Collect accumulated fees on a position to the diamond.
    function collectFees(uint256 tokenId)
        external returns (uint256 collFees, uint256 wsxmrFees);

    // ========== VIEW ==========

    /// @notice Return current token amounts in a position at pool spot price.
    /// @dev For fee accounting / display reference only.
    function getPositionAmountsAtSpot(uint256 tokenId)
        external view returns (uint256 collateralAmount, uint256 wsxmrAmount);

    /// @notice Check if the position is out of range at the pool's own slot0 price.
    /// @param tokenId V3 NFT id
    function isPositionOutOfRange(uint256 tokenId) external view returns (bool);
}
