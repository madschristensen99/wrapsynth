// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {SimpleOracleFacet} from "../contracts/facets/SimpleOracleFacet.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";

contract UpdatePrices is Script {
    address constant WSHUB = 0x9B03355624acD1265508B981b046f4293B1fFED8;
    address constant ROUTER = 0xAc0EF983bA5c0A053468e2a8FB32733fBa26eC3E;
    
    uint256 constant XMR_PRICE = 16000000000; // $160 in 8 decimals
    uint256 constant DAI_PRICE = 100000000;   // $1.00 in 8 decimals

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        console.log("Updating oracle prices and initializing pool");
        
        vm.startBroadcast(deployerPrivateKey);
        
        // Get oracle facet address from hub
        wsXmrHub hub = wsXmrHub(payable(WSHUB));
        address oracleFacetAddress = hub.oracleFacet();
        console.log("Oracle Facet:", oracleFacetAddress);
        
        // Update prices on oracle facet
        SimpleOracleFacet oracle = SimpleOracleFacet(oracleFacetAddress);
        oracle.updatePrices(XMR_PRICE, DAI_PRICE);
        console.log("Prices updated - XMR:", XMR_PRICE, "DAI:", DAI_PRICE);
        
        // Initialize pool
        console.log("\nInitializing Uniswap V3 pool...");
        wsXMRLiquidityRouter router = wsXMRLiquidityRouter(payable(ROUTER));
        router.initializePool(XMR_PRICE * 1e10);
        
        console.log("\n=== Pool Initialized ===");
        console.log("Pool Address:", router.pool());
        console.log("Token0:", router.token0());
        console.log("Token1:", router.token1());
        console.log("sDAI is token0:", router.sDAIIsToken0());
        
        vm.stopBroadcast();
        
        console.log("\n=== Ready for Trading ===");
        console.log("Router:", ROUTER);
        console.log("Pool:", router.pool());
        console.log("\nCo-LP is vault-integrated via the diamond.");
    }
}
