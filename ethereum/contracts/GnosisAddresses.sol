// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

/**
 * @title GnosisAddresses
 * @notice Gnosis Chain mainnet contract addresses
 */
library GnosisAddresses {
    // Stablecoins
    address public constant XDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d; // Wrapped xDAI (wxDAI)
    address public constant SDAI = 0xaf204776c7245bF4147c2612BF6e5972Ee483701; // Savings DAI (sDAI)
    
    // Uniswap V3
    address public constant UNISWAP_V3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address public constant UNISWAP_V3_POSITION_MANAGER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address public constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    
    // Pyth Oracle (already in VaultManager)
    address public constant PYTH_ORACLE = 0x2880aB155794e7179c9eE2e38200202908C17B43;
    
    // Price Feed IDs (Pyth)
    bytes32 public constant XMR_USD_FEED_ID = 0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d;
    bytes32 public constant DAI_USD_FEED_ID = 0xb0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd;
}
