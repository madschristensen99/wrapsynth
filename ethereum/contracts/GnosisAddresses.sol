// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

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

    // Uniswap V3
    address public constant UNISWAP_V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address public constant UNISWAP_V3_POSITION_MANAGER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address public constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

    // Chainlink Data Feeds (Gnosis Chain — verify at https://docs.chain.link/data-feeds/price-feeds/addresses)
    // NOTE: XMR/USD is not natively available on Gnosis Chain. Use a custom aggregator
    //       or deploy on a chain where the feed exists (e.g., Ethereum mainnet).
    address public constant XMR_USD_FEED = address(0); // TODO: configure before deployment
    address public constant DAI_USD_FEED = 0x678df3415BB319E5E94Dc79B7c9ca72338C201C7; // DAI/USD on Gnosis Chain
}
