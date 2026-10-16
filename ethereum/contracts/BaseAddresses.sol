// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title BaseAddresses
 * @notice Base (ChainID 8453) mainnet contract addresses
 */
library BaseAddresses {
    // ========== COLLATERAL ==========

    /// @notice Coinbase Wrapped BTC — 1:1 BTC held in Coinbase custody.
    ///         8 decimals. Upgradeable proxy; issuer can freeze/blacklist.
    address public constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;

    /// @notice Native USDC on Base (6 decimals) — the USD quote leg
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @notice WETH on Base
    address public constant WETH = 0x4200000000000000000000000000000000000006;

    // ========== UNISWAP V3 (canonical deployment on Base) ==========

    /// @notice Uniswap V3 factory
    address public constant UNI_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;

    /// @notice Uniswap V3 NonfungiblePositionManager
    address public constant UNI_V3_POSITION_MANAGER = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;

    /// @notice Uniswap SwapRouter02 — exactInputSingle uses the 7-field
    ///         no-deadline struct (deadline rides in multicall), matching
    ///         the repo's ISwapRouter interface.
    address public constant UNI_SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    /// @notice Uniswap V3 QuoterV2
    address public constant UNI_V3_QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;

    // ========== TWAP ORACLE POOLS ==========

    /// @notice cbBTC/USDC UniV3 pool, fee 500 — single-leg USD quote for the
    ///         collateral price (observationCardinality 1075 at time of
    ///         writing). quoteTwapPool is left unset: USDC ≈ USD.
    address public constant CBBTC_USDC_POOL = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef;

    // ========== PROTOCOL PARAMS ==========

    /// @notice UniV3 fee tier for the wsXMR/cbBTC co-LP pool (0.05%, spacing 10)
    uint24 public constant WSXMR_POOL_FEE = 500;
    int24 public constant WSXMR_TICK_SPACING = 10;

    /// @notice TWAP window for the collateral price (30 minutes)
    uint32 public constant COLLATERAL_TWAP_WINDOW = 1800;
}
