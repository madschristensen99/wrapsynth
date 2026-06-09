// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title ILiquidityPosition
 * @notice Interface for concentrated liquidity position operations on the router.
 * @dev All mutating functions are onlyDiamond. Views are public.
 */
interface ILiquidityPosition {
    // ========== ERRORS ==========

    error PositionNotFound();
    error InvalidRange();
    error DeadlineExpired();
    error SlippageExceeded();

    // ========== MUTATING (onlyDiamond) ==========

    /// @notice Mint a concentrated V3 position. Caller (diamond) must have transferred
    ///         daiAmount of DAI and wsxmrAmount of wsXMR to this contract before calling.
    /// @param daiAmount DAI amount (1e18)
    /// @param wsxmrAmount wsXMR amount (1e8)
    /// @param rangeBps Full width in bps (e.g. 2000 = ±10% around center)
    /// @param centerXmrPrice Oracle XMR price used to compute the center tick
    /// @param deadline Transaction deadline
    /// @param slippageBps Max acceptable slippage in bps (e.g. 50 = 0.5%)
    /// @return tokenId V3 NFT id (owned by the diamond)
    /// @return liquidity Amount of liquidity minted
    /// @return tickLower Lower tick (snapped to tick spacing)
    /// @return tickUpper Upper tick (snapped to tick spacing)
    /// @return daiConsumed Actual sDAI amount consumed by the mint
    /// @return wsxmrConsumed Actual wsXMR amount consumed by the mint
    function mintConcentratedPosition(
        uint256 daiAmount,
        uint256 wsxmrAmount,
        uint16 rangeBps,
        uint256 centerXmrPrice,
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
    ///         Burns the NFT after draining.
    /// @param tokenId V3 NFT id (diamond must own it)
    /// @param slippageBps Max acceptable slippage in bps (e.g. 50 = 0.5%)
    /// @param oracleXmrPrice Oracle XMR price (18 decimals) for slippage bounds
    /// @return daiOut DAI recovered
    /// @return wsxmrOut wsXMR recovered
    function drainPosition(uint256 tokenId, uint16 slippageBps, uint256 oracleXmrPrice)
        external returns (uint256 daiOut, uint256 wsxmrOut);

    /// @notice Collect accumulated fees on a position to the diamond.
    function collectFees(uint256 tokenId)
        external returns (uint256 daiFees, uint256 wsxmrFees);

    // ========== VIEW ==========

    /// @notice Return current token amounts in a position at pool spot price.
    /// @dev For fee accounting reference only. Do NOT use for CR calculations.
    function getPositionAmountsAtSpot(uint256 tokenId)
        external view returns (uint256 daiAmount, uint256 wsxmrAmount);

    /// @notice Return token amounts a position would yield if priced at given XMR price.
    /// @dev This is the function to use for CR calculations. Pass oracle xmrPrice.
    /// @param tokenId V3 NFT id
    /// @param xmrPriceUSD18 XMR price in USD (18 decimals)
    function getPositionAmountsAtPrice(uint256 tokenId, uint256 xmrPriceUSD18)
        external view returns (uint256 daiAmount, uint256 wsxmrAmount);

    /// @notice Check if the position is out of range at the given oracle XMR price.
    /// @param tokenId V3 NFT id
    /// @param xmrPrice XMR price in USD (18 decimals)
    function isPositionOutOfRange(uint256 tokenId, uint256 xmrPrice) external view returns (bool);
}
