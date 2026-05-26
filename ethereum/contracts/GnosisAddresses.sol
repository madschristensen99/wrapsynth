// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title GnosisAddresses
 * @notice Gnosis Chain mainnet contract addresses
 * @dev Chainlink feed addresses must be configured for the target deployment chain.
 *      Gnosis Chain has limited Chainlink feeds; verify availability at docs.chain.link.
 */
library GnosisAddresses {
    // Stablecoins
    address public constant XDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d; // Wrapped xDAI (wxDAI)
    address public constant SDAI = 0xaf204776c7245bF4147c2612BF6e5972Ee483701; // Savings DAI (sDAI)

    // Uniswap V3 on Gnosis Chain (ChainID 100)
    // Official deployment by Gnosis team (April 2023, proposal #20)
    // Verified against Uniswap Accountability Committee deployments (July 2024)
    address public constant UNI_V3_FACTORY = 0xe32F7dD7e3f098D518ff19A22d5f028e076489B1;
    address public constant UNI_V3_POSITION_MANAGER = 0xAE8fbE656a77519a7490054274910129c9244FA3;
    address public constant UNI_V3_SWAP_ROUTER_02 = 0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be;
    address public constant UNI_V3_QUOTER_V2 = 0x7E9cB3499A6cee3baBe5c8a3D328EA7FD36578f4;
    address public constant UNI_V3_TICK_LENS = 0x8fe3D346B53dCA838B228e0e53aCdBED5DEC70Dc;
    address public constant UNI_V3_STAKER = 0x8b5a954Fba566B157798C413d95028F4aB87F5E0;
    address public constant UNI_V3_MULTICALL = 0x4dfa9a980efE4802E969AC33968E3d6E59B8a19e;
    
    // Backward compatibility alias
    address public constant UNISWAP_V3_ROUTER = UNI_V3_SWAP_ROUTER_02;

    // Chainlink Data Feeds (Gnosis Chain — verify at https://docs.chain.link/data-feeds/price-feeds/addresses)
    // NOTE: XMR/USD is not natively available on Gnosis Chain. Use a custom aggregator
    //       or deploy on a chain where the feed exists (e.g., Ethereum mainnet).
    address public constant XMR_USD_FEED = address(0); // TODO: configure before deployment
    address public constant DAI_USD_FEED = 0x678df3415BB319E5E94Dc79B7c9ca72338C201C7; // DAI/USD on Gnosis Chain
}
