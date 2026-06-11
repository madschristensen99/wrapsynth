// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {IUniswapV3Factory} from "../contracts/interfaces/external/IUniswapV3Factory.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";

/**
 * @title DeployCoLPRouter
 * @notice Deploys Co-LP liquidity router, creates Uniswap V3 pool, initializes it, and registers router on hub
 */
contract DeployCoLPRouter is Script {
    address constant HUB = 0x1fb8E7593B01bCdAE13e5b63e529f0e30a3ebD50;
    address constant WSXMR = 0x30Aeb2A142744430fFD7D698D5C7C41769CE1279;
    address constant DEPLOYER = 0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB;

    uint256 constant XMR_PRICE = 390 * 1e18;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        require(deployer == DEPLOYER, "Wrong private key");

        console.log("========================================");
        console.log("Deploying Co-LP Router on Gnosis Mainnet");
        console.log("Deployer:", deployer);
        console.log("========================================");

        vm.startBroadcast(deployerKey);

        // Create pool if needed
        address token0 = GnosisAddresses.SDAI < WSXMR ? GnosisAddresses.SDAI : WSXMR;
        address token1 = GnosisAddresses.SDAI < WSXMR ? WSXMR : GnosisAddresses.SDAI;
        address factory = GnosisAddresses.UNI_V3_FACTORY;
        address pool = IUniswapV3Factory(factory).getPool(token0, token1, 3000);

        if (pool == address(0)) {
            console.log("Creating Uniswap V3 pool...");
            pool = IUniswapV3Factory(factory).createPool(token0, token1, 3000);
            console.log("Pool created:", pool);
        } else {
            console.log("Pool exists:", pool);
        }

        // Initialize pool if needed (anyone can call once)
        (bool success, bytes memory data) = pool.call(abi.encodeWithSignature("slot0()"));
        if (success && data.length >= 32) {
            uint160 sqrtPriceX96 = abi.decode(data, (uint160));
            if (sqrtPriceX96 == 0) {
                console.log("Initializing pool...");
                uint160 targetSqrtPriceX96 = _priceToSqrtPriceX96(XMR_PRICE, 1e18);
                (bool ok,) = pool.call(abi.encodeWithSignature("initialize(uint160)", targetSqrtPriceX96));
                require(ok, "Pool init failed");
                console.log("Pool initialized at $390 XMR");
            } else {
                console.log("Pool already initialized");
            }
        }

        // Deploy router
        console.log("Deploying router...");
        wsXMRLiquidityRouter router = new wsXMRLiquidityRouter(
            HUB,
            GnosisAddresses.UNI_V3_POSITION_MANAGER,
            GnosisAddresses.SDAI,
            WSXMR,
            pool
        );
        console.log("Router:", address(router));

        // Register on hub (only deployer can do this)
        wsXmrHub(payable(HUB)).setLiquidityRouter(address(router));
        console.log("Router registered on hub");

        vm.stopBroadcast();

        console.log("========================================");
        console.log("Done! Check transactions on Gnosisscan:");
        console.log("https://gnosisscan.io/address/", deployer);
        console.log("========================================");
    }

    function _priceToSqrtPriceX96(uint256 xmrPrice, uint256 collateralPrice) internal pure returns (uint160) {
        // wsXMR is token1 (address 0xD1ee... > 0xaf20...)
        // priceRatio = sDAI/wsXMR = (collateralPrice * 1e18) / (xmrPrice * 1e8)
        uint256 priceRatio = (collateralPrice * 1e18) / (xmrPrice * 1e8);
        uint256 sqrtPrice = _sqrt(priceRatio * 1e18);
        return uint160((sqrtPrice * (1 << 96)) / 1e9);
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
