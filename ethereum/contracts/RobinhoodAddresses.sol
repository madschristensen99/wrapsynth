// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title RobinhoodAddresses
 * @notice Robinhood Chain (ChainID 4663) mainnet contract addresses.
 *         Robinhood Chain is an Arbitrum Orbit L2 — ETH gas token,
 *         Uniswap v2/v3/v4 deployed at non-canonical addresses.
 */
library RobinhoodAddresses {
    // ========== COLLATERAL ==========

    /// @notice SPDR S&P 500 ETF Trust — Robinhood Token (tokenized S&P 500).
    ///         18 decimals, BeaconProxy — issuer (Robinhood) can upgrade the
    ///         implementation and freeze/claw back. Tracks total return via
    ///         uiMultiplier() (dividends reinvested). Trades 24/5 on-venue;
    ///         on-chain pools can drift on weekends.
    address public constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;

    /// @notice Global Dollar (Paxos USDG) — the USD quote token on
    ///         Robinhood Chain (6 decimals)
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// @notice WETH on Robinhood Chain (canonical bridged WETH)
    address public constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    // ========== UNISWAP V3 ==========

    /// @notice Uniswap V3 factory (verified via feeAmountTickSpacing)
    address public constant UNI_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;

    /// @notice Uniswap V3 NonfungiblePositionManager
    address public constant UNI_V3_POSITION_MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;

    /// @notice Uniswap SwapRouter02 — exactInputSingle uses the 7-field
    ///         no-deadline struct (deadline rides in multicall), matching
    ///         the repo's ISwapRouter interface. Verified on-chain:
    ///         7-field decodes (STF on missing allowance), 8-field is a
    ///         selector miss.
    address public constant UNI_SWAP_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;

    // ========== TWAP ORACLE POOLS ==========

    /// @notice SPY/USDG UniV3 pool, fee 500 — single-leg USD quote for the
    ///         collateral price (observationCardinality 7200 at time of
    ///         writing). quoteTwapPool is left unset: USDG ≈ USD.
    address public constant SPY_USDG_POOL = 0xa7Bb1AC63BBaB0C44316E6c8C455213441689167;

    /// @notice SPY/WETH UniV3 pool, fee 500 — alternate venue (cardinality 68)
    address public constant SPY_WETH_POOL = 0xDDCBBa3666f578E3F09516f21Ff85BFee859AB5e;

    /// @notice WETH/USDG UniV3 pool, fee 500 — USD anchor if a two-leg path
    ///         through WETH is ever needed (cardinality 2847)
    address public constant WETH_USDG_POOL = 0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a;

    // ========== PROTOCOL PARAMS ==========

    /// @notice UniV3 fee tier for the wsXMR/SPY co-LP pool (0.05%, spacing 10)
    uint24 public constant WSXMR_POOL_FEE = 500;
    int24 public constant WSXMR_TICK_SPACING = 10;

    /// @notice TWAP window for the collateral price (30 minutes)
    uint32 public constant COLLATERAL_TWAP_WINDOW = 1800;
}
