// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../contracts/core/wsXmrHub.sol";
import "../contracts/facets/RedStoneOracleFacet.sol";
import "../contracts/facets/VaultFacet.sol";
import "../contracts/facets/MintFacet.sol";
import "../contracts/facets/BurnFacet.sol";
import "../contracts/facets/LiquidationFacet.sol";
import "../contracts/facets/YieldFacet.sol";
import "../contracts/wsXMR.sol";
import "../contracts/router/wsXMRLiquidityRouter.sol";
import "../contracts/interfaces/external/IUniswapV3Factory.sol";
import "../contracts/GnosisAddresses.sol";
import {TickMath} from "../contracts/libraries/TickMath.sol";

contract DeployGnosis is Script {
    // No verifier needed for RedStone (uses off-chain signed data)
    address constant VERIFIER = address(0);
    address constant SDAI = 0xaf204776c7245bF4147c2612BF6e5972Ee483701;
    uint256 constant XMR_PRICE = 390 * 1e18; // Initial XMR price for pool initialization

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        console.log("============================================================");
        console.log("Starting Gnosis Chain Deployment");
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
        
        // RedStoneOracleFacet - uses off-chain signed price data
        RedStoneOracleFacet oracleFacet = new RedStoneOracleFacet(address(wsxmr), VERIFIER);
        console.log("RedStoneOracleFacet deployed to:", address(oracleFacet));
        
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

        console.log("============================================================");
        console.log("STEP 6: Creating/Checking Uniswap V3 Pool");
        console.log("============================================================");
        address token0 = SDAI < address(wsxmr) ? SDAI : address(wsxmr);
        address token1 = SDAI < address(wsxmr) ? address(wsxmr) : SDAI;
        address factory = GnosisAddresses.UNI_V3_FACTORY;
        address pool = IUniswapV3Factory(factory).getPool(token0, token1, 3000);

        if (pool == address(0)) {
            console.log("Creating Uniswap V3 pool...");
            pool = IUniswapV3Factory(factory).createPool(token0, token1, 3000);
            console.log("Pool created:", pool);
        } else {
            console.log("Pool already exists:", pool);
        }

        // Initialize pool if needed
        (bool success, bytes memory data) = pool.call(abi.encodeWithSignature("slot0()"));
        if (success && data.length >= 32) {
            uint160 sqrtPriceX96 = abi.decode(data, (uint160));
            if (sqrtPriceX96 == 0) {
                console.log("Initializing pool at $390 XMR...");
                bool sDAIIsToken0 = SDAI < address(wsxmr);
                console.log("sDAI is token0:", sDAIIsToken0);
                console.log("XMR_PRICE:", XMR_PRICE);
                uint160 targetSqrtPriceX96 = _priceToSqrtPriceX96(XMR_PRICE, sDAIIsToken0);
                console.log("Calculated sqrtPriceX96:", targetSqrtPriceX96);
                (bool ok,) = pool.call(abi.encodeWithSignature("initialize(uint160)", targetSqrtPriceX96));
                require(ok, "Pool initialization failed");
                console.log("Pool initialized");
            } else {
                console.log("Pool already initialized");
            }
        }
        console.log("");

        console.log("============================================================");
        console.log("STEP 7: Deploying Liquidity Router");
        console.log("============================================================");
        wsXMRLiquidityRouter router = new wsXMRLiquidityRouter(
            address(hub),
            GnosisAddresses.UNI_V3_POSITION_MANAGER,
            SDAI,
            address(wsxmr),
            pool
        );
        console.log("Router deployed to:", address(router));
        console.log("");

        console.log("============================================================");
        console.log("STEP 8: Registering Router with Hub");
        console.log("============================================================");
        hub.setLiquidityRouter(address(router));
        console.log("Router registered with hub");
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
        console.log("  LiquidityRouter:  ", address(router));
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
        console.log("  sDAI:             ", SDAI);
        console.log("  Uniswap V3 Pool:  ", pool);
        console.log("============================================================");
        console.log("");
        console.log("Next steps:");
        console.log("1. Verify contracts on Gnosisscan");
        console.log("2. Update frontend configuration with new addresses");
        console.log("3. Configure LP node with deployed addresses");
        console.log("4. Test full cycle with testFullCycleNow.js");
        console.log("5. Test co-LP with testCoLPNow.js");
    }

    function _priceToSqrtPriceX96(uint256 xmrPrice, bool sDAIIsToken0) internal pure returns (uint160) {
        // Uniswap V3 price = token1/token0
        // sDAI has 18 decimals, wsXMR has 8 decimals
        // If sDAI is token0: price = wsXMR/sDAI, need to account for decimal difference
        // If wsXMR is token0: price = sDAI/wsXMR, need to account for decimal difference
        
        // xmrPrice is in 1e18 (e.g., 390e18 for $390)
        // We want: 1 wsXMR (1e8) = xmrPrice sDAI (in 1e18 units)
        // So: 1e8 wsXMR = xmrPrice * 1e18 / 1e18 sDAI = xmrPrice sDAI
        // Price ratio = xmrPrice * 1e18 / 1e8 = xmrPrice * 1e10
        
        // At $390/XMR: 1 wsXMR (10^8 units) = 390 sDAI (390 * 10^18 units)
        // Uniswap price = token1/token0 in raw units
        // When wsXMR is token0: price = sDAI/wsXMR = (390 * 10^18) / 10^8 = 390 * 10^10
        // tick = log(390 * 10^10) / log(1.0001) ≈ 280000
        
        int24 targetTick;
        if (sDAIIsToken0) {
            // price = wsXMR/sDAI = 10^8 / (390 * 10^18) = 1/(390 * 10^10)
            targetTick = -280000;
        } else {
            // price = sDAI/wsXMR = (390 * 10^18) / 10^8 = 390 * 10^10
            targetTick = 280000;
        }
        
        return TickMath.getSqrtRatioAtTick(targetTick);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
