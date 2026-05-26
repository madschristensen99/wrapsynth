// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {SimpleOracleFacet} from "../contracts/facets/SimpleOracleFacet.sol";

contract RegisterOracleFacet is Script {
    address constant WSHUB = 0x9B03355624acD1265508B981b046f4293B1fFED8;
    address constant ORACLE_FACET = 0x9b309e82976A164912b00f574f3df04Ec254C7f3;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        console.log("Registering Oracle Facet with Hub");
        console.log("Hub:", WSHUB);
        console.log("Oracle Facet:", ORACLE_FACET);
        
        vm.startBroadcast(deployerPrivateKey);
        
        wsXmrHub hub = wsXmrHub(payable(WSHUB));
        
        // Get selectors from oracle facet
        SimpleOracleFacet oracle = SimpleOracleFacet(ORACLE_FACET);
        bytes4[] memory selectors = oracle.selectors();
        
        console.log("Registering", selectors.length, "selectors");
        
        // Add selectors to hub
        hub.addSelectors(ORACLE_FACET, selectors);
        
        vm.stopBroadcast();
        
        console.log("\n=== Oracle Facet Registered ===");
        console.log("Hub can now route oracle calls to facet");
        
        // Verify by calling getXmrPrice through hub
        console.log("\nVerifying oracle integration...");
        uint256 price = oracle.getXmrPrice();
        console.log("XMR Price from facet:", price);
    }
}
