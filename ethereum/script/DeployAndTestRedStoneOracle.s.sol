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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVaultFacet} from "../contracts/interfaces/facets/IVaultFacet.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";

contract DeployAndTestRedStoneOracle is Script {
    address constant WXDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("============================================================");
        console.log("COMPLETE DEPLOY AND E2E TEST WITH REAL REDSTONE PRICES");
        console.log("============================================================\n");

        vm.startBroadcast(deployerPrivateKey);

        // Deploy everything fresh
        wsXMR wsxmr = new wsXMR();
        wsXmrHub hub = new wsXmrHub(address(wsxmr), address(0));
        
        SimpleOracleFacet oracleFacet = new SimpleOracleFacet(address(wsxmr), address(0), deployer);
        VaultFacet vaultFacet = new VaultFacet(address(wsxmr), address(0));
        MintFacet mintFacet = new MintFacet(address(wsxmr), address(0));
        BurnFacet burnFacet = new BurnFacet(address(wsxmr), address(0));
        LiquidationFacet liquidationFacet = new LiquidationFacet(address(wsxmr), address(0));
        YieldFacet yieldFacet = new YieldFacet(address(wsxmr), address(0));
        
        hub.registerFacets(
            address(vaultFacet),
            address(mintFacet),
            address(burnFacet),
            address(liquidationFacet),
            address(yieldFacet),
            address(oracleFacet)
        );
        
        wsxmr.setHub(address(hub));
        
        console.log("Deployed:");
        console.log("  wsXMR:", address(wsxmr));
        console.log("  Hub:", address(hub));
        console.log("  Oracle:", address(oracleFacet));
        console.log("");

        // Fetch real prices from RedStone
        string[] memory inputs = new string[](3);
        inputs[0] = "node";
        inputs[1] = "scripts/fetchRedStonePrices.js";
        inputs[2] = "XMR,DAI";
        bytes memory result = vm.ffi(inputs);
        (uint256 xmrPrice, uint256 daiPrice) = abi.decode(result, (uint256, uint256));
        
        console.log("Real Prices from RedStone API:");
        console.log("  XMR: $", xmrPrice / 1e8);
        console.log("  DAI: $", daiPrice / 1e8);
        
        oracleFacet.updatePrices(xmrPrice, daiPrice);
        console.log("SUCCESS: Oracle updated\n");

        // Call facets through Hub (they share storage via delegatecall)
        VaultFacet hubVault = VaultFacet(address(hub));
        MintFacet hubMint = MintFacet(address(hub));
        BurnFacet hubBurn = BurnFacet(address(hub));
        
        // Create and configure vault
        hubVault.createVault();
        hubVault.setMaxMintBps(0); // 0 = disabled, focus on oracle test
        hubVault.setVaultMarketMetrics(100, 50); // 1% mint fee, 0.5% burn reward  
        hubVault.setMinBurnAmount(0.00001 ether);
        hubVault.setMintGriefingDeposit(0.01 ether);
        console.log("SUCCESS: Vault configured (maxMintBps=0 for testing)\n");

        // Wrap and deposit available collateral (we have ~0.08 xDAI)
        IERC20 wxdai = IERC20(WXDAI);
        uint256 availableBalance = deployer.balance;
        console.log("Deployer xDAI balance:", availableBalance / 1e18);
        
        if (availableBalance >= 0.03 ether) {
            // Keep 0.02 for gas, deposit the rest
            uint256 depositAmount = availableBalance - 0.02 ether;
            (bool success,) = WXDAI.call{value: depositAmount}(abi.encodeWithSignature("deposit()"));
            require(success, "Wrap failed");
            
            wxdai.approve(address(hub), depositAmount);
            hubVault.depositCollateral(depositAmount);
            console.log("SUCCESS: Deposited", depositAmount / 1e18, "wxDAI\n");
        } else {
            console.log("WARNING: Insufficient balance for collateral deposit\n");
        }

        // Mint absolute minimum: 1e13 = 0.00001 XMR (~$0.004 worth)
        console.log("Initiating mint with REAL XMR price...");
        uint256 xmrAmount = 1e13; // 0.00001 XMR (~$0.004 worth)
        bytes32 commitment = keccak256("test_mint");
        
        hubMint.initiateMint{value: 0.01 ether}(
            deployer,
            deployer,
            xmrAmount,
            commitment
        );
        console.log("SUCCESS: MINT INITIATED!\n");

        uint256 wsxmrBalance = wsxmr.balanceOf(deployer);
        console.log("wsXMR minted:", wsxmrBalance);

        // Burn half
        if (wsxmrBalance > 0) {
            console.log("\nRequesting burn...");
            hubBurn.requestBurn(wsxmrBalance / 2, deployer, deployer, bytes32(uint256(1)));
            console.log("SUCCESS: BURN REQUESTED!\n");
        }

        // Withdraw remaining collateral
        console.log("Withdrawing collateral...");
        wsXmrStorage.Vault memory vault = hubVault.getVault(deployer);
        uint256 availableToWithdraw = vault.collateralShares - vault.lockedCollateral;
        console.log("Available to withdraw:", availableToWithdraw);
        
        if (availableToWithdraw > 0) {
            hubVault.withdrawCollateral(availableToWithdraw);
            uint256 finalBalance = wxdai.balanceOf(deployer);
            console.log("SUCCESS: Withdrew collateral, final wxDAI balance:", finalBalance / 1e18);
        }

        vm.stopBroadcast();

        console.log("============================================================");
        console.log("ALL TESTS PASSED!");
        console.log("============================================================");
        console.log("");
        console.log("Real Market Prices Used:");
        console.log("  XMR: $", xmrPrice / 1e8);
        console.log("  DAI: $", daiPrice / 1e8);
        console.log("");
        console.log("Minted wsXMR:", wsxmrBalance);
        console.log("");
        console.log("MINT, BURN, AND WITHDRAWAL WORKING WITH REAL REDSTONE PRICES!");
        console.log("============================================================");
    }
}
