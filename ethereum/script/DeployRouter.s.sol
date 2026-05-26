// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";

/**
 * @title DeployRouter
 * @notice Foundry script to deploy wsXMRLiquidityRouter to Gnosis Chain
 * @dev Run with: forge script script/DeployRouter.s.sol:DeployRouter --rpc-url $GNOSIS_RPC_URL --broadcast --verify
 */
contract DeployRouter is Script {
    // Gnosis Chain deployed addresses
    address constant WSHUB = 0x9B03355624acD1265508B981b046f4293B1fFED8;
    address constant WSXMR = 0x4206580496249266945A5aED42E41b6CE9cd8DAD;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("Deploying wsXMRLiquidityRouter to Gnosis Chain");
        console.log("Deployer:", deployer);
        console.log("Hub:", WSHUB);
        console.log("wsXMR:", WSXMR);
        console.log("sDAI:", GnosisAddresses.SDAI);
        console.log("Uniswap V3 Factory:", GnosisAddresses.UNI_V3_FACTORY);
        console.log("Uniswap V3 Position Manager:", GnosisAddresses.UNI_V3_POSITION_MANAGER);
        
        vm.startBroadcast(deployerPrivateKey);
        
        // Deploy router
        wsXMRLiquidityRouter router = new wsXMRLiquidityRouter(
            WSHUB,
            WSXMR,
            GnosisAddresses.SDAI,
            GnosisAddresses.UNI_V3_FACTORY,
            GnosisAddresses.UNI_V3_POSITION_MANAGER
        );
        
        console.log("Router deployed at:", address(router));
        
        vm.stopBroadcast();
        
        // Try to register with hub (optional - may fail if hub doesn't exist or caller not owner)
        console.log("\n=== Hub Registration ===");
        console.log("To register router with hub, call setLiquidityRouter on hub:");
        console.log("Hub address:", WSHUB);
        console.log("Router address:", address(router));
        
        console.log("\n=== Deployment Summary ===");
        console.log("Router:", address(router));
        console.log("Pool Fee:", router.POOL_FEE());
        console.log("Tick Spacing:", router.TICK_SPACING());
        console.log("Min Deposit:", router.MIN_DEPOSIT_AMOUNT());
        console.log("Min Position Duration:", router.MIN_POSITION_DURATION());
        console.log("Max Positions Per User:", router.MAX_ACTIVE_POSITIONS_PER_USER());
        
        console.log("\n=== Next Steps ===");
        console.log("1. Verify contract on Gnosisscan:");
        console.log("   forge verify-contract", address(router));
        console.log("   wsXMRLiquidityRouter --chain gnosis --watch");
        console.log("\n2. Initialize pool:");
        console.log("   cast send", address(router), '"initializePool(bytes[])" "[]" --rpc-url $GNOSIS_RPC_URL');
        console.log("\n3. Test with small amounts before production use");
    }
}

/**
 * @title InitializePool
 * @notice Helper script to initialize the Uniswap V3 pool
 * @dev Run with: forge script script/DeployRouter.s.sol:InitializePool --rpc-url $GNOSIS_RPC_URL --broadcast
 */
contract InitializePool is Script {
    address constant ROUTER = 0xAc0EF983bA5c0A053468e2a8FB32733fBa26eC3E;
    
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address routerAddress = ROUTER;
        
        console.log("Initializing pool for router:", routerAddress);
        
        vm.startBroadcast(deployerPrivateKey);
        
        wsXMRLiquidityRouter router = wsXMRLiquidityRouter(payable(routerAddress));
        
        bytes[] memory emptyUpdateData = new bytes[](0);
        address pool = router.initializePool(emptyUpdateData);
        
        console.log("Pool initialized at:", pool);
        console.log("Token0:", router.token0());
        console.log("Token1:", router.token1());
        console.log("sDAI is token0:", router.sDAIIsToken0());
        
        vm.stopBroadcast();
    }
}

/**
 * @title VerifyDeployment
 * @notice Helper script to verify router deployment and configuration
 * @dev Run with: forge script script/DeployRouter.s.sol:VerifyDeployment --rpc-url $GNOSIS_RPC_URL
 */
contract VerifyDeployment is Script {
    function run() external view {
        address routerAddress = vm.envAddress("ROUTER_ADDRESS");
        
        console.log("Verifying router at:", routerAddress);
        
        wsXMRLiquidityRouter router = wsXMRLiquidityRouter(payable(routerAddress));
        
        console.log("\n=== Configuration ===");
        console.log("Hub:", router.hub());
        console.log("wsXMR Token:", router.wsxmrToken());
        console.log("sDAI:", router.sDAI());
        console.log("DEX Factory:", router.dexFactory());
        console.log("DEX Position Manager:", router.dexPositionManager());
        
        console.log("\n=== Pool Status ===");
        console.log("Pool Initialized:", router.poolInitialized());
        if (router.poolInitialized()) {
            console.log("Pool Address:", router.pool());
            console.log("Token0:", router.token0());
            console.log("Token1:", router.token1());
        }
        
        console.log("\n=== Constants ===");
        console.log("Pool Fee:", router.POOL_FEE());
        console.log("Tick Spacing:", router.TICK_SPACING());
        console.log("Min Deposit Amount:", router.MIN_DEPOSIT_AMOUNT());
        console.log("Min Position Duration:", router.MIN_POSITION_DURATION());
        console.log("Max Active Positions Per User:", router.MAX_ACTIVE_POSITIONS_PER_USER());
        
        console.log("\n=== Hub Integration ===");
        wsXmrHub hub = wsXmrHub(payable(router.hub()));
        address registeredRouter = hub.liquidityRouter();
        console.log("Router registered in hub:", registeredRouter == routerAddress);
        if (registeredRouter != routerAddress) {
            console.log("WARNING: Router not registered in hub!");
            console.log("Expected:", routerAddress);
            console.log("Got:", registeredRouter);
        }
    }
}
