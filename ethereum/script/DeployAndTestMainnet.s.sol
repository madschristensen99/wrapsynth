// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../contracts/core/wsXmrHub.sol";
import "../contracts/core/wsXmrStorage.sol";
import "../contracts/facets/RedStoneOracleFacet.sol";
import "../contracts/facets/VaultFacet.sol";
import "../contracts/facets/MintFacet.sol";
import "../contracts/facets/BurnFacet.sol";
import "../contracts/facets/LiquidationFacet.sol";
import "../contracts/facets/YieldFacet.sol";
import "../contracts/wsXMR.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployAndTestMainnet is Script {
    address constant VERIFIER = address(0);
    address constant SDAI = 0xaf204776c7245bF4147c2612BF6e5972Ee483701;
    address constant XDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    
    uint256 constant TEST_AMOUNT = 0.1e18; // 0.1 xDAI
    
    wsXMR wsxmr;
    wsXmrHub hub;
    RedStoneOracleFacet oracleFacet;
    VaultFacet vaultFacet;
    MintFacet mintFacet;
    BurnFacet burnFacet;
    LiquidationFacet liquidationFacet;
    YieldFacet yieldFacet;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("============================================================");
        console.log("Gnosis Mainnet Deployment & Test (0.1 DAI)");
        console.log("============================================================");
        console.log("Deployer:", deployer);
        console.log("Native Balance:", deployer.balance / 1e18, "xDAI");
        
        // Check wxDAI balance
        IERC20 wxdai = IERC20(XDAI);
        uint256 wxdaiBalance = wxdai.balanceOf(deployer);
        console.log("wxDAI Balance:", wxdaiBalance / 1e18, "wxDAI");
        console.log("");

        vm.startBroadcast(deployerPrivateKey);
        
        if (wxdaiBalance < TEST_AMOUNT) {
            console.log("Insufficient wxDAI, wrapping", TEST_AMOUNT / 1e18, "xDAI...");
            // Wrap xDAI by sending to WXDAI contract
            (bool success,) = XDAI.call{value: TEST_AMOUNT}("");
            require(success, "Failed to wrap xDAI");
            console.log("Wrapped", TEST_AMOUNT / 1e18, "xDAI to wxDAI");
            console.log("");
        }

        // Deploy all contracts
        _deployContracts();
        
        // Test with 0.1 DAI
        _testWithSmallAmount(deployer);

        vm.stopBroadcast();

        _printSummary(deployer);
    }

    function _deployContracts() internal {
        console.log("============================================================");
        console.log("STEP 1: Deploying wsXMR Token");
        console.log("============================================================");
        wsxmr = new wsXMR();
        console.log("wsXMR deployed to:", address(wsxmr));
        console.log("");

        console.log("============================================================");
        console.log("STEP 2: Deploying wsXmrHub");
        console.log("============================================================");
        hub = new wsXmrHub(address(wsxmr), VERIFIER);
        console.log("wsXmrHub deployed to:", address(hub));
        console.log("");

        console.log("============================================================");
        console.log("STEP 3: Deploying Facets");
        console.log("============================================================");
        
        oracleFacet = new RedStoneOracleFacet(address(wsxmr), VERIFIER);
        console.log("RedStoneOracleFacet deployed to:", address(oracleFacet));
        
        vaultFacet = new VaultFacet(address(wsxmr), VERIFIER);
        console.log("VaultFacet deployed to:", address(vaultFacet));
        
        mintFacet = new MintFacet(address(wsxmr), VERIFIER);
        console.log("MintFacet deployed to:", address(mintFacet));
        
        burnFacet = new BurnFacet(address(wsxmr), VERIFIER);
        console.log("BurnFacet deployed to:", address(burnFacet));
        
        liquidationFacet = new LiquidationFacet(address(wsxmr), VERIFIER);
        console.log("LiquidationFacet deployed to:", address(liquidationFacet));
        
        yieldFacet = new YieldFacet(address(wsxmr), VERIFIER);
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
    }

    function _testWithSmallAmount(address deployer) internal {
        console.log("============================================================");
        console.log("STEP 6: Testing with 0.1 wxDAI");
        console.log("============================================================");
        
        IERC20 wxdai = IERC20(XDAI);
        
        // Create vault first
        console.log("Creating LP vault...");
        VaultFacet(address(hub)).createVault();
        console.log("Vault created");
        
        // Approve hub to spend wxDAI
        console.log("Approving hub to spend 0.1 wxDAI...");
        wxdai.approve(address(hub), TEST_AMOUNT);
        console.log("Approved");
        
        // Deposit collateral via VaultFacet (it will convert wxDAI to sDAI)
        console.log("Depositing 0.1 wxDAI as collateral (auto-converts to sDAI)...");
        VaultFacet(address(hub)).depositCollateral(TEST_AMOUNT);
        console.log("Deposited successfully");
        console.log("");
        
        console.log("Test completed successfully!");
        console.log("   - Vault created");
        console.log("   - 0.1 wxDAI deposited and converted to sDAI");
        console.log("");
    }

    function _printSummary(address deployer) internal view {
        console.log("============================================================");
        console.log("DEPLOYMENT & TEST SUMMARY");
        console.log("============================================================");
        console.log("Network: Gnosis Chain (ChainID: 100)");
        console.log("Deployer:", deployer);
        console.log("");
        console.log("Core Contracts:");
        console.log("  wsXMR:            ", address(wsxmr));
        console.log("  wsXmrHub:         ", address(hub));
        console.log("");
        console.log("Facets:");
        console.log("  OracleFacet:      ", address(oracleFacet));
        console.log("  VaultFacet:       ", address(vaultFacet));
        console.log("  MintFacet:        ", address(mintFacet));
        console.log("  BurnFacet:        ", address(burnFacet));
        console.log("  LiquidationFacet: ", address(liquidationFacet));
        console.log("  YieldFacet:       ", address(yieldFacet));
        console.log("");
        console.log("External Contracts:");
        console.log("  wxDAI:            ", XDAI);
        console.log("  sDAI:             ", SDAI);
        console.log("============================================================");
        console.log("");
        console.log("Test Result: 0.1 wxDAI deposited and converted to sDAI successfully");
        console.log("");
        console.log("Next steps:");
        console.log("1. Verify contracts on Gnosisscan");
        console.log("2. Configure LP node with deployed addresses");
        console.log("3. Test mint/burn flows with LP");
    }
}
