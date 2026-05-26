// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {SimpleOracleFacet} from "../contracts/facets/SimpleOracleFacet.sol";
import {IOracleFacet} from "../contracts/interfaces/facets/IOracleFacet.sol";

contract SwapOracleAndInit is Script {
    address constant WSHUB = 0x9B03355624acD1265508B981b046f4293B1fFED8;
    address constant ROUTER = 0xAc0EF983bA5c0A053468e2a8FB32733fBa26eC3E;
    address constant NEW_ORACLE = 0x9b309e82976A164912b00f574f3df04Ec254C7f3; // Our SimpleOracleFacet with prices

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        console.log("=== Swapping Oracle Facet and Initializing Pool ===\n");
        
        vm.startBroadcast(deployerPrivateKey);
        
        wsXmrHub hub = wsXmrHub(payable(WSHUB));
        
        // Get current oracle
        address oldOracle = hub.oracleFacet();
        console.log("Old Oracle:", oldOracle);
        console.log("New Oracle:", NEW_ORACLE);
        
        // Swap oracle facet
        hub.setOracleFacet(NEW_ORACLE);
        console.log("\nOracle facet swapped!");
        
        // Verify prices work through hub now
        IOracleFacet oracleViaHub = IOracleFacet(WSHUB);
        uint256 xmrPrice = oracleViaHub.getXmrPrice();
        uint256 daiPrice = oracleViaHub.getCollateralPrice();
        console.log("\nVerified prices through hub:");
        console.log("  XMR:", xmrPrice, "($160.00)");
        console.log("  DAI:", daiPrice, "($1.00)");
        
        // Initialize Uniswap V3 pool
        console.log("\n=== Initializing Uniswap V3 Pool ===");
        wsXMRLiquidityRouter router = wsXMRLiquidityRouter(payable(ROUTER));
        bytes[] memory emptyData = new bytes[](0);
        address pool = router.initializePool(emptyData);
        
        console.log("\n=== SUCCESS! Pool Initialized ===");
        console.log("Pool Address:", pool);
        console.log("Token0:", router.token0());
        console.log("Token1:", router.token1());
        console.log("sDAI is Token0:", router.sDAIIsToken0());
        
        vm.stopBroadcast();
        
        console.log("\n=== Deployment Complete ===");
        console.log("Router:", ROUTER);
        console.log("Pool:", pool);
        console.log("Oracle:", NEW_ORACLE);
        console.log("\nGnosisscan:");
        console.log("  https://gnosisscan.io/address/", ROUTER);
        console.log("  https://gnosisscan.io/address/", pool);
        
        console.log("\n=== Ready to Use! ===");
        console.log("LPs can now allocate liquidity and set configs");
        console.log("Users can create positions permissionlessly");
    }
}
