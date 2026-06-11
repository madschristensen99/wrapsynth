// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";

contract DeployFixedRouter is Script {
    address constant HUB = 0x1fb8E7593B01bCdAE13e5b63e529f0e30a3ebD50;
    address constant WSXMR = 0x30Aeb2A142744430fFD7D698D5C7C41769CE1279;
    address constant DEPLOYER = 0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        require(deployer == DEPLOYER, "Wrong private key");

        console.log("========================================");
        console.log("Deploying Fixed Co-LP Router on Gnosis Mainnet");
        console.log("Deployer:", deployer);
        console.log("========================================");

        vm.startBroadcast(deployerKey);

        // Get existing pool
        address token0 = GnosisAddresses.SDAI < WSXMR ? GnosisAddresses.SDAI : WSXMR;
        address token1 = GnosisAddresses.SDAI < WSXMR ? WSXMR : GnosisAddresses.SDAI;
        address factory = GnosisAddresses.UNI_V3_FACTORY;
        address pool = IUniswapV3Factory(factory).getPool(token0, token1, 3000);
        console.log("Pool:", pool);

        // Deploy new router with fixed TickMath
        wsXMRLiquidityRouter router = new wsXMRLiquidityRouter(
            HUB,
            GnosisAddresses.UNI_V3_POSITION_MANAGER,
            GnosisAddresses.SDAI,
            WSXMR,
            pool
        );
        console.log("New Router:", address(router));

        vm.stopBroadcast();

        console.log("========================================");
        console.log("Done! Next step: call hub.setLiquidityRouter() to activate");
        console.log("========================================");
    }
}

interface IUniswapV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}
