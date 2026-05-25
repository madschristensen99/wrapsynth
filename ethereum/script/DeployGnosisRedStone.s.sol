// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../contracts/core/wsXmrHub.sol";
import "../contracts/facets/SimpleOracleFacet.sol";
import "../contracts/facets/VaultFacet.sol";
import "../contracts/facets/MintFacet.sol";
import "../contracts/facets/BurnFacet.sol";
import "../contracts/facets/LiquidationFacet.sol";
import "../contracts/facets/YieldFacet.sol";
import "../contracts/wsXMR.sol";

contract DeployGnosisRedStone is Script {
    // No verifier needed for SimpleOracleFacet (uses off-chain RedStone prices)
    address constant VERIFIER = address(0);
    address constant SDAI = 0xaf204776c7245bF4147c2612BF6e5972Ee483701;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("============================================================");
        console.log("Starting Gnosis Chain Deployment (RedStone Oracle)");
        console.log("============================================================");
        console.log("Deployer:", deployer);
        console.log("Balance:", deployer.balance / 1e18, "xDAI");
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        console.log("============================================================");
        console.log("STEP 1: Deploying wsXMR Token");
        console.log("============================================================");
        wsXMR wsxmr = new wsXMR();
        console.log("wsXMR deployed to:", address(wsxmr));
        console.log("");

        console.log("============================================================");
        console.log("STEP 2: Deploying wsXmrHub");
        console.log("============================================================");
        wsXmrHub hub = new wsXmrHub(address(wsxmr), VERIFIER);
        console.log("wsXmrHub deployed to:", address(hub));
        console.log("");

        console.log("============================================================");
        console.log("STEP 3: Deploying Facets");
        console.log("============================================================");
        
        // SimpleOracleFacet needs deployer as price updater
        SimpleOracleFacet oracleFacet = new SimpleOracleFacet(address(wsxmr), VERIFIER, deployer);
        console.log("SimpleOracleFacet deployed to:", address(oracleFacet));
        
        VaultFacet vaultFacet = new VaultFacet(address(wsxmr), VERIFIER);
        console.log("VaultFacet deployed to:", address(vaultFacet));
        
        MintFacet mintFacet = new MintFacet(address(wsxmr), VERIFIER);
        console.log("MintFacet deployed to:", address(mintFacet));
        
        BurnFacet burnFacet = new BurnFacet(address(wsxmr), VERIFIER);
        console.log("BurnFacet deployed to:", address(burnFacet));
        
        LiquidationFacet liquidationFacet = new LiquidationFacet(address(wsxmr), VERIFIER);
        console.log("LiquidationFacet deployed to:", address(liquidationFacet));
        
        YieldFacet yieldFacet = new YieldFacet(address(wsxmr), VERIFIER);
        console.log("YieldFacet deployed to:", address(yieldFacet));
        console.log("");

        console.log("============================================================");
        console.log("STEP 4: Registering Facets with Hub");
        console.log("============================================================");
        hub.registerFacets(
            address(vaultFacet),
            address(mintFacet),
            address(burnFacet),
            address(liquidationFacet),
            address(yieldFacet),
            address(oracleFacet)
        );
        console.log("All facets registered");
        console.log("");

        console.log("============================================================");
        console.log("STEP 5: Setting Hub as wsXMR Minter");
        console.log("============================================================");
        wsxmr.setHub(address(hub));
        console.log("Hub set as wsXMR minter");
        console.log("");

        vm.stopBroadcast();

        console.log("============================================================");
        console.log("DEPLOYMENT SUMMARY");
        console.log("============================================================");
        console.log("Network: Gnosis Chain (ChainID: 100)");
        console.log("Deployer:", deployer);
        console.log("");
        console.log("Core Contracts:");
        console.log("  wsXMR:            ", address(wsxmr));
        console.log("  wsXmrHub:         ", address(hub));
        console.log("");
        console.log("Facets:");
        console.log("  SimpleOracleFacet:", address(oracleFacet));
        console.log("  VaultFacet:       ", address(vaultFacet));
        console.log("  MintFacet:        ", address(mintFacet));
        console.log("  BurnFacet:        ", address(burnFacet));
        console.log("  LiquidationFacet: ", address(liquidationFacet));
        console.log("  YieldFacet:       ", address(yieldFacet));
        console.log("");
        console.log("External Contracts:");
        console.log("  sDAI:             ", SDAI);
        console.log("  Price Updater:    ", deployer);
        console.log("============================================================");
        console.log("");
        console.log("IMPORTANT: Next Steps");
        console.log("1. Set initial prices: SimpleOracleFacet(oracle).updatePrices(xmrPrice, daiPrice)");
        console.log("2. Verify contracts on Gnosisscan");
        console.log("3. Set up automated price updates from RedStone API");
        console.log("4. Configure LP node with deployed addresses");
        console.log("5. Update frontend configuration");
        console.log("");
        console.log("Save these addresses to your .env or config file!");
        console.log("============================================================");
    }
}
