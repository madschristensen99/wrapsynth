// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title BnbAddresses
 * @notice BNB Smart Chain (ChainID 56) mainnet contract addresses
 */
library BnbAddresses {
    // ========== COLLATERAL ==========

    /// @notice Invesco QQQ Trust Tokenized bStocks (Binance bStocks / BTech
    ///         Holdings, 1:1 backed by QQQ at Alpaca Securities). Beacon proxy —
    ///         issuer can upgrade the implementation and freeze/blacklist.
    address public constant QQQB = 0x205812CdBed920aFf76C6580abD681a46D11efc7;

    /// @notice Wrapped BNB
    address public constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    /// @notice BSC-USD (Tether, 18 decimals on BSC)
    address public constant USDT = 0x55d398326f99059fF775485246999027B3197955;

    // ========== PANCAKESWAP V3 ==========

    /// @notice PancakeSwap V3 factory (verified via pool.factory())
    address public constant PCS_V3_FACTORY = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865;

    /// @notice PancakeSwap V3 NonfungiblePositionManager (UniV3-compatible ABI)
    address public constant PCS_V3_POSITION_MANAGER = 0x46A15B0b27311cedF172AB29E4f4766fbE7F4364;

    /// @notice PancakeSwap Smart Router (SwapRouter, for buy-and-burn swaps)
    address public constant PCS_SMART_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;

    /// @notice PancakeSwap V3 QuoterV2
    address public constant PCS_V3_QUOTER_V2 = 0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997;

    // ========== TWAP ORACLE POOLS ==========

    /// @notice QQQB/WBNB PCS V3 pool, fee 500 — deepest QQQB venue on-chain
    ///         (~$1.3M TVL at time of writing, observationCardinality 250)
    address public constant QQQB_WBNB_POOL = 0x47BC06722295AC316A569EEF87aC32FAA455F441;

    /// @notice WBNB/USDT PCS V3 pool, fee 500 — canonical BNB/USD anchor
    address public constant WBNB_USDT_POOL = 0x36696169C63e42cd08ce11f5deeBbCeBae652050;

    /// @notice QQQB/USDT PCS V3 pool, fee 500 — thinner, usable as a sanity cross-check
    address public constant QQQB_USDT_POOL = 0xe531fcb1F5a195de7608B9F4f9518544C2cdB693;

    // ========== PROTOCOL PARAMS ==========

    /// @notice PCS V3 fee tier for the wsXMR/QQQB co-LP pool (0.05%, spacing 10).
    ///         NB: PancakeSwap V3 fee tiers are 100/500/2500/10000 — UniV3's
    ///         3000 does not exist here.
    uint24 public constant WSXMR_POOL_FEE = 500;
    int24 public constant WSXMR_TICK_SPACING = 10;

    /// @notice TWAP window for the collateral price (30 minutes)
    uint32 public constant COLLATERAL_TWAP_WINDOW = 1800;
}
