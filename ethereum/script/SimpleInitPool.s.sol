// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {IOracleFacet} from "../contracts/interfaces/facets/IOracleFacet.sol";

contract SimpleInitPool is Script {
    address constant WSHUB = 0x9B03355624acD1265508B981b046f4293B1fFED8;
    address constant ROUTER = 0xAc0EF983bA5c0A053468e2a8FB32733fBa26eC3E;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        console.log("=== Initializing Pool ===\n");
        console.log("Router:", ROUTER);
        console.log("Hub:", WSHUB);
        
        vm.startBroadcast(deployerPrivateKey);
        
        // Try to call updateOraclePrices with empty data (RedStone style)
        IOracleFacet oracle = IOracleFacet(WSHUB);
        bytes[] memory emptyData = new bytes[](0);
        
        try oracle.updateOraclePrices{value: 0}(emptyData) {
            console.log("Oracle prices updated (or already current)");
        } catch {
            console.log("Oracle update skipped (may already have prices)");
        }
        
        // Try to get prices
        uint256 xmrPrice;
        try oracle.getXmrPrice() returns (uint256 _xmrPrice) {
            xmrPrice = _xmrPrice;
            console.log("XMR Price:", xmrPrice);
            uint256 daiPrice = oracle.getCollateralPrice();
            console.log("DAI Price:", daiPrice);
        } catch {
            console.log("WARNING: No oracle prices set - pool init may fail");
            xmrPrice = 160 * 1e18; // fallback: $160
        }
        
        // Initialize pool
        console.log("\nInitializing Uniswap V3 pool...");
        wsXMRLiquidityRouter router = wsXMRLiquidityRouter(payable(ROUTER));
        router.initializePool(xmrPrice);
        
        console.log("\n=== SUCCESS ===");
        console.log("Pool:", router.pool());
        console.log("Token0:", router.token0());
        console.log("Token1:", router.token1());
        
        vm.stopBroadcast();
        
        console.log("\nView on Gnosisscan:");
        console.log("https://gnosisscan.io/address/", router.pool());
    }
}
