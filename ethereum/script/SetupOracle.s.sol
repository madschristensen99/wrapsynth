// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {SimpleOracleFacet} from "../contracts/facets/SimpleOracleFacet.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";

contract SetupOracle is Script {
    address constant WSHUB = 0x9B03355624acD1265508B981b046f4293B1fFED8;
    address constant WSXMR = 0x4206580496249266945A5aED42E41b6CE9cd8DAD;
    address constant ROUTER = 0xAc0EF983bA5c0A053468e2a8FB32733fBa26eC3E;
    
    uint256 constant XMR_PRICE = 16000000000; // $160 in 8 decimals
    uint256 constant DAI_PRICE = 100000000;   // $1.00 in 8 decimals

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("Setting up oracle and router on Gnosis Chain");
        console.log("Deployer:", deployer);
        
        vm.startBroadcast(deployerPrivateKey);
        
        // 1. Deploy SimpleOracleFacet
        console.log("\n=== Deploying SimpleOracleFacet ===");
        SimpleOracleFacet oracle = new SimpleOracleFacet(
            WSXMR,
            address(0), // No verifier needed for oracle
            deployer
        );
        console.log("Oracle deployed at:", address(oracle));
        
        // 2. Set initial prices
        console.log("\n=== Setting Initial Prices ===");
        oracle.updatePrices(XMR_PRICE, DAI_PRICE);
        console.log("XMR Price:", XMR_PRICE, "(8 decimals)");
        console.log("DAI Price:", DAI_PRICE, "(8 decimals)");
        
        // 3. Register router with hub
        console.log("\n=== Registering Router with Hub ===");
        wsXmrHub hub = wsXmrHub(payable(WSHUB));
        hub.setLiquidityRouter(ROUTER);
        console.log("Router registered:", ROUTER);
        
        vm.stopBroadcast();
        
        console.log("\n=== Setup Complete ===");
        console.log("Oracle Facet:", address(oracle));
        console.log("Router:", ROUTER);
        console.log("Hub:", WSHUB);
        
        console.log("\n=== Next: Initialize Pool ===");
        console.log("Run: cast send", ROUTER, '"initializePool(bytes[])" "[]" --rpc-url gnosis');
    }
}
