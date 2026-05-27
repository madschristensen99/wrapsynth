// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {IUniswapV3Factory} from "../contracts/interfaces/external/IUniswapV3Factory.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";

/**
 * @title DeployRouter
 * @notice Foundry script to deploy wsXMRLiquidityRouter to Gnosis Chain
 * @dev Run with: forge script script/DeployRouter.s.sol:DeployRouter --rpc-url $GNOSIS_RPC_URL --broadcast
 */
contract DeployRouter is Script {
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
        
        (address token0, address token1) = GnosisAddresses.SDAI < WSXMR
            ? (GnosisAddresses.SDAI, WSXMR)
            : (WSXMR, GnosisAddresses.SDAI);
        
        address pool = IUniswapV3Factory(GnosisAddresses.UNI_V3_FACTORY).getPool(token0, token1, 3000);
        if (pool == address(0)) {
            pool = IUniswapV3Factory(GnosisAddresses.UNI_V3_FACTORY).createPool(token0, token1, 3000);
            console.log("Pool created at:", pool);
        } else {
            console.log("Pool already exists at:", pool);
        }
        
        wsXMRLiquidityRouter router = new wsXMRLiquidityRouter(
            WSHUB,
            GnosisAddresses.UNI_V3_POSITION_MANAGER,
            GnosisAddresses.SDAI,
            WSXMR,
            pool
        );
        
        console.log("Router deployed at:", address(router));
        
        vm.stopBroadcast();
        
        console.log("\n=== Deployment Summary ===");
        console.log("Router:", address(router));
        console.log("Pool:", pool);
        console.log("Pool Fee:", router.POOL_FEE());
        console.log("Tick Spacing:", router.TICK_SPACING());
        console.log("sDAI is token0:", router.sDAIIsToken0());
        
        console.log("\n=== Next Steps ===");
        console.log("1. Initialize pool via router.initializePool(xmrPrice)");
        console.log("2. Register router with hub via hub.migrateLiquidityRouter(router)");
        console.log("3. Diamond cut to add new selectors");
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
        uint256 xmrPrice = vm.envUint("XMR_PRICE");
        
        console.log("Initializing pool for router:", ROUTER);
        console.log("XMR Price:", xmrPrice);
        
        vm.startBroadcast(deployerPrivateKey);
        
        wsXMRLiquidityRouter router = wsXMRLiquidityRouter(ROUTER);
        router.initializePool(xmrPrice);
        
        console.log("Pool initialized");
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
        
        wsXMRLiquidityRouter router = wsXMRLiquidityRouter(routerAddress);
        
        console.log("\n=== Configuration ===");
        console.log("Hub:", router.hub());
        console.log("sDAI:", router.sDAI());
        console.log("wsXMR:", router.wsXMR());
        console.log("Position Manager:", router.positionManager());
        console.log("Pool:", router.pool());
        
        console.log("\n=== Pool Status ===");
        console.log("Pool Initialized:", router.poolInitialized());
        console.log("Token0:", router.token0());
        console.log("Token1:", router.token1());
        console.log("sDAI is token0:", router.sDAIIsToken0());
        
        console.log("\n=== Constants ===");
        console.log("Pool Fee:", router.POOL_FEE());
        console.log("Tick Spacing:", router.TICK_SPACING());
        
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
