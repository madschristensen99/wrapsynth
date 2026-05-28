// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {IOracleFacet} from "../contracts/interfaces/facets/IOracleFacet.sol";

contract UpdateAndInitPool is Script {
    address constant WSHUB = 0x9B03355624acD1265508B981b046f4293B1fFED8;
    address constant ROUTER = 0xAc0EF983bA5c0A053468e2a8FB32733fBa26eC3E;
    
    uint256 constant XMR_PRICE = 16000000000; // $160 in 8 decimals
    uint256 constant DAI_PRICE = 100000000;   // $1.00 in 8 decimals

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        console.log("=== Updating Oracle Prices and Initializing Pool ===\n");
        
        vm.startBroadcast(deployerPrivateKey);
        
        // Get oracle facet from hub
        wsXmrHub hub = wsXmrHub(payable(WSHUB));
        address oracleFacetAddress = hub.oracleFacet();
        console.log("Hub:", WSHUB);
        console.log("Oracle Facet:", oracleFacetAddress);
        
        // Call updatePrices directly on the oracle facet
        // Using low-level call since we don't know the exact interface
        (bool success, ) = oracleFacetAddress.call(
            abi.encodeWithSignature("updatePrices(uint256,uint256)", XMR_PRICE, DAI_PRICE)
        );
        require(success, "Failed to update prices");
        
        console.log("\nPrices updated:");
        console.log("  XMR: $160.00 (16000000000 in 8 decimals)");
        console.log("  DAI: $1.00 (100000000 in 8 decimals)");
        
        // Verify prices through hub
        IOracleFacet oracleViaHub = IOracleFacet(WSHUB);
        uint256 xmrPrice = oracleViaHub.getXmrPrice();
        uint256 daiPrice = oracleViaHub.getCollateralPrice();
        console.log("\nVerified prices:");
        console.log("  XMR:", xmrPrice);
        console.log("  DAI:", daiPrice);
        
        // Initialize Uniswap V3 pool
        console.log("\n=== Initializing Uniswap V3 Pool ===");
        wsXMRLiquidityRouter router = wsXMRLiquidityRouter(payable(ROUTER));
        router.initializePool(xmrPrice);
        
        console.log("\n=== SUCCESS! Pool Initialized ===");
        console.log("Pool Address:", router.pool());
        console.log("Token0:", router.token0());
        console.log("Token1:", router.token1());
        console.log("sDAI is Token0:", router.sDAIIsToken0());
        console.log("Pool Fee: 0.3%");
        
        vm.stopBroadcast();
        
        console.log("\n=== Router Ready for Use ===");
        console.log("Router:", ROUTER);
        console.log("Pool:", router.pool());
        console.log("\nView on Gnosisscan:");
        console.log("  Router: https://gnosisscan.io/address/", ROUTER);
        console.log("  Pool: https://gnosisscan.io/address/", router.pool());
        
        console.log("\n=== How to Use ===");
        console.log("Co-LP is vault-integrated. Users call userOpenCoLP on the diamond.");
        console.log("LPs set their range preference via setMaxCoLPRange.");
    }
}
