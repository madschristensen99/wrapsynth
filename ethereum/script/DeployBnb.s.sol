// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../contracts/core/wsXmrHub.sol";
import "../contracts/facets/BnbOracleFacet.sol";
import "../contracts/facets/VaultFacet.sol";
import "../contracts/facets/MintFacet.sol";
import "../contracts/facets/BurnFacet.sol";
import "../contracts/facets/LiquidationFacet.sol";
import "../contracts/facets/YieldFacet.sol";
import "../contracts/facets/BnbYieldFacet.sol";
import "../contracts/facets/CoLPFacet.sol";
import "../contracts/wsXMR.sol";
import "../contracts/StataQQQB.sol";
import "../contracts/router/wsXMRLiquidityRouter.sol";
import "../contracts/interfaces/external/IUniswapV3Factory.sol";
import "../contracts/interfaces/external/IUniswapV3Pool.sol";
import "../contracts/BnbAddresses.sol";

/**
 * @title DeployBnb
 * @notice Deploys the WrapSynth stack on BNB Chain with QQQB (tokenized
 *         Invesco QQQ) as vault collateral.
 *
 * Oracle model:
 *   - XMR/USD: RedStone pull oracle (only external price input)
 *   - QQQB/USD: fully on-chain — TWAP(QQQB/WBNB) x TWAP(WBNB/USDT), refreshed
 *     inside every state-changing hub call via _tryRefreshCollateralTwap()
 */
contract DeployBnb is Script {
    // No verifier needed for RedStone (uses off-chain signed data)
    address constant VERIFIER = address(0);

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("============================================================");
        console.log("Starting BNB Chain Deployment (QQQB collateral)");
        console.log("============================================================");
        console.log("Deployer:", deployer);
        console.log("Balance:", deployer.balance / 1e18, "BNB");
        console.log("");

        // Fetch current XMR price from Coingecko
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = "curl -s 'https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd' | jq -r '.monero.usd | floor | tostring'";
        bytes memory res = vm.ffi(inputs);
        uint256 xmrPrice = vm.parseUint(string(res)) * 1e18;
        console.log("Fetched XMR price:", xmrPrice / 1e18, "USD");

        // Fetch current QQQB price from DexScreener
        inputs[2] = "curl -s 'https://api.dexscreener.com/latest/dex/tokens/0x205812CdBed920aFf76C6580abD681a46D11efc7' | jq -r '(.pairs | sort_by(.liquidity.usd // 0) | reverse | .[0].priceUsd | tonumber | floor | tostring)'";
        res = vm.ffi(inputs);
        uint256 qqqbPrice = vm.parseUint(string(res)) * 1e18;
        console.log("Fetched QQQB price:", qqqbPrice / 1e18, "USD");
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

        // BnbOracleFacet - RedStone XMR + on-chain collateral TWAP
        BnbOracleFacet oracleFacet = new BnbOracleFacet(address(wsxmr), VERIFIER);
        console.log("BnbOracleFacet deployed to:", address(oracleFacet));

        VaultFacet vaultFacet = new VaultFacet(address(wsxmr), VERIFIER);
        console.log("VaultFacet deployed to:", address(vaultFacet));

        MintFacet mintFacet = new MintFacet(address(wsxmr), VERIFIER);
        console.log("MintFacet deployed to:", address(mintFacet));

        BurnFacet burnFacet = new BurnFacet(address(wsxmr), VERIFIER);
        console.log("BurnFacet deployed to:", address(burnFacet));

        LiquidationFacet liquidationFacet = new LiquidationFacet(address(wsxmr), VERIFIER);
        console.log("LiquidationFacet deployed to:", address(liquidationFacet));

        // PCS V3 router needs the canonical deadline-bearing exactInputSingle —
        // deploy the BNB-specific yield facet, not the HyperSwap-flavoured base.
        YieldFacet yieldFacet = new BnbYieldFacet(address(wsxmr), VERIFIER);
        console.log("YieldFacet deployed to:", address(yieldFacet));

        // CoLPFacet — co-LP lives on its own facet to keep VaultFacet under EIP-170
        CoLPFacet coLPFacet = new CoLPFacet(address(wsxmr), VERIFIER);
        console.log("CoLPFacet deployed to:", address(coLPFacet));
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
        hub.addFacet(address(coLPFacet));
        console.log("All facets registered");
        console.log("");

        console.log("============================================================");
        console.log("STEP 4b: Deploying StataQQQB collateral adapter");
        console.log("============================================================");
        StataQQQB stata = new StataQQQB(BnbAddresses.QQQB);
        console.log("StataQQQB deployed to:", address(stata));
        console.log("");

        console.log("============================================================");
        console.log("STEP 5: Setting Hub as wsXMR Minter + external addresses");
        console.log("============================================================");
        wsxmr.setHub(address(hub));
        console.log("Hub set as wsXMR minter");

        // collateralToken = stataQQQB shares, underlyingToken = QQQB,
        // swapRouter = PancakeSwap Smart Router (buy-and-burn),
        // xmrPerpIndex = 0 (no HyperCore precompile on BNB — stored as 0+1,
        // the precompile staticcall fails and the leg no-ops cleanly)
        hub.setExternalAddresses(
            address(stata),
            BnbAddresses.QQQB,
            BnbAddresses.PCS_SMART_ROUTER,
            0
        );
        console.log("External addresses set (stataQQQB / QQQB / PCS router)");

        // On-chain collateral TWAP: QQQB/WBNB x WBNB/USDT
        hub.setCollateralTwapConfig(
            BnbAddresses.QQQB_WBNB_POOL,
            BnbAddresses.WBNB_USDT_POOL,
            BnbAddresses.WBNB,
            BnbAddresses.USDT,
            BnbAddresses.COLLATERAL_TWAP_WINDOW
        );
        console.log("Collateral TWAP config set (window:", BnbAddresses.COLLATERAL_TWAP_WINDOW, "s)");
        console.log("");

        console.log("============================================================");
        console.log("STEP 6: Creating/Checking wsXMR/QQQB PancakeSwap V3 Pool");
        console.log("============================================================");
        address token0 = BnbAddresses.QQQB < address(wsxmr) ? BnbAddresses.QQQB : address(wsxmr);
        address token1 = BnbAddresses.QQQB < address(wsxmr) ? address(wsxmr) : BnbAddresses.QQQB;
        address pool = IUniswapV3Factory(BnbAddresses.PCS_V3_FACTORY)
            .getPool(token0, token1, BnbAddresses.WSXMR_POOL_FEE);

        if (pool == address(0)) {
            console.log("Creating PancakeSwap V3 pool (fee 500)...");
            pool = IUniswapV3Factory(BnbAddresses.PCS_V3_FACTORY)
                .createPool(token0, token1, BnbAddresses.WSXMR_POOL_FEE);
            console.log("Pool created:", pool);
        } else {
            console.log("Pool already exists:", pool);
        }
        console.log("");

        console.log("============================================================");
        console.log("STEP 7: Deploying Liquidity Router");
        console.log("============================================================");
        wsXMRLiquidityRouter router = new wsXMRLiquidityRouter(
            address(hub),
            BnbAddresses.PCS_V3_POSITION_MANAGER,
            BnbAddresses.QQQB, // router's "sDAI" quote token is QQQB on BNB
            address(wsxmr),
            pool
        );
        console.log("Router deployed to:", address(router));
        console.log("");

        console.log("============================================================");
        console.log("STEP 8: Registering Router + initializing pool");
        console.log("============================================================");
        hub.setLiquidityRouter(address(router));
        console.log("Router registered with hub");

        // Initialize pool at live prices — pool.initialize is permissionless
        (bool success, bytes memory data) = pool.call(abi.encodeWithSignature("slot0()"));
        if (success && data.length >= 32) {
            uint160 sqrtPriceX96 = abi.decode(data, (uint160));
            if (sqrtPriceX96 == 0) {
                console.log("Initializing pool at fetched prices...");
                bool qqqbIsToken0 = BnbAddresses.QQQB < address(wsxmr);
                uint160 targetSqrtPriceX96 = _priceToSqrtPriceX96(xmrPrice, qqqbPrice, qqqbIsToken0);
                (bool ok,) = pool.call(abi.encodeWithSignature("initialize(uint160)", targetSqrtPriceX96));
                require(ok, "Pool initialization failed");
                console.log("Pool initialized");
            } else {
                console.log("Pool already initialized");
            }
        }

        // Grow the pool's observation cardinality for future robustness
        IUniswapV3Pool(pool).increaseObservationCardinalityNext(64);
        console.log("Observation cardinality bumped to 64");
        console.log("");

        console.log("============================================================");
        console.log("STEP 9: Locking Deployer Powers (IRREVERSIBLE)");
        console.log("============================================================");
        // Removes the two admin backdoors from the live system:
        //  - wsXMR.replaceHub(): deployer could repoint the token at an arbitrary
        //    contract which could then mint/burn wsXMR without limit.
        //  - wsXmrHub.addSelectors()/removeSelectors(): deployer could add or brick
        //    facet routes after launch.
        // Both locks are one-way and must be the final configuration action.
        wsxmr.lockHub();
        hub.lockDeployer();
        console.log("wsXMR.hubLocked():", wsxmr.hubLocked());
        console.log("wsXmrHub.deployerOperationsLocked():", hub.deployerOperationsLocked());
        console.log("Deployer powers permanently locked.");
        console.log("");

        vm.stopBroadcast();

        console.log("============================================================");
        console.log("DEPLOYMENT SUMMARY");
        console.log("============================================================");
        console.log("Network: BNB Smart Chain (ChainID: 56)");
        console.log("Deployer:", deployer);
        console.log("");
        console.log("Core Contracts:");
        console.log("  wsXMR:            ", address(wsxmr));
        console.log("  wsXmrHub:         ", address(hub));
        console.log("  StataQQQB:        ", address(stata));
        console.log("  LiquidityRouter:  ", address(router));
        console.log("");
        console.log("Facets:");
        console.log("  OracleFacet:      ", address(oracleFacet));
        console.log("  VaultFacet:       ", address(vaultFacet));
        console.log("  MintFacet:        ", address(mintFacet));
        console.log("  BurnFacet:        ", address(burnFacet));
        console.log("  LiquidationFacet: ", address(liquidationFacet));
        console.log("  YieldFacet:       ", address(yieldFacet));
        console.log("  CoLPFacet:        ", address(coLPFacet));
        console.log("");
        console.log("External Contracts:");
        console.log("  QQQB:             ", BnbAddresses.QQQB);
        console.log("  QQQB/WBNB pool:   ", BnbAddresses.QQQB_WBNB_POOL);
        console.log("  WBNB/USDT pool:   ", BnbAddresses.WBNB_USDT_POOL);
        console.log("  wsXMR/QQQB pool:  ", pool);
        console.log("============================================================");
        console.log("");
        console.log("Next steps:");
        console.log("1. Verify contracts on BscScan");
        console.log("2. Update frontend configuration with deployment.bnb.json");
        console.log("3. Configure LP server with deployed addresses + RedStone XMR");
        console.log("4. Seed the wsXMR/QQQB pool");

        // Persist a machine-readable manifest — same shape the frontend and
        // LP server consume per chain (deployment.bnb.json).
        string memory json = "bnb";
        vm.serializeAddress(json, "wsXMR", address(wsxmr));
        vm.serializeAddress(json, "wsXmrHub", address(hub));
        vm.serializeAddress(json, "stataQQQB", address(stata));
        vm.serializeAddress(json, "liquidityRouter", address(router));
        vm.serializeAddress(json, "pool", pool);
        vm.serializeAddress(json, "oracleFacet", address(oracleFacet));
        vm.serializeAddress(json, "vaultFacet", address(vaultFacet));
        vm.serializeAddress(json, "mintFacet", address(mintFacet));
        vm.serializeAddress(json, "burnFacet", address(burnFacet));
        vm.serializeAddress(json, "liquidationFacet", address(liquidationFacet));
        vm.serializeAddress(json, "yieldFacet", address(yieldFacet));
        vm.serializeAddress(json, "coLPFacet", address(coLPFacet));
        vm.serializeAddress(json, "qqqb", BnbAddresses.QQQB);
        vm.serializeAddress(json, "wbnb", BnbAddresses.WBNB);
        vm.serializeAddress(json, "usdt", BnbAddresses.USDT);
        vm.serializeAddress(json, "pcsV3Factory", BnbAddresses.PCS_V3_FACTORY);
        vm.serializeAddress(json, "pcsSmartRouter", BnbAddresses.PCS_SMART_ROUTER);
        vm.serializeAddress(json, "pcsV3NFPM", BnbAddresses.PCS_V3_POSITION_MANAGER);
        vm.serializeAddress(json, "pcsV3QuoterV2", BnbAddresses.PCS_V3_QUOTER_V2);
        vm.serializeAddress(json, "qqqbWbnbPool", BnbAddresses.QQQB_WBNB_POOL);
        vm.serializeAddress(json, "wbnbUsdtPool", BnbAddresses.WBNB_USDT_POOL);
        vm.serializeUint(json, "collateralTwapWindow", BnbAddresses.COLLATERAL_TWAP_WINDOW);
        vm.serializeUint(json, "chainId", block.chainid);
        // Log-scan lower bound for the frontend/LP server (protocolStats, swapHistory).
        vm.serializeUint(json, "deployedAtBlock", block.number);
        string memory out = vm.serializeAddress(json, "deployer", deployer);
        vm.writeJson(out, "./deployments/bnb-deployment.json");
        console.log("Manifest written to deployments/bnb-deployment.json");
    }

    /// @dev sqrtPriceX96 for token1/token0 where token0/token1 = QQQB/wsXMR in
    ///      either order. 1 wsXMR (1e8) = xmrPrice/collateralPrice QQQB (1e18).
    function _priceToSqrtPriceX96(uint256 xmrPrice, uint256 collateralPrice, bool qqqbIsToken0)
        internal pure returns (uint160)
    {
        uint256 sqrtXmrPrice = _sqrt(xmrPrice);
        uint256 sqrtCollateralPrice = _sqrt(collateralPrice);
        uint256 sqrt1e10 = 100000; // sqrt(1e10) = 1e5
        uint256 sqrtPriceX96;

        if (qqqbIsToken0) {
            // price = wsXMR/QQQB = collateralPrice / (xmrPrice * 1e10)
            sqrtPriceX96 = (sqrtCollateralPrice * (1 << 96)) / (sqrtXmrPrice * sqrt1e10);
        } else {
            // price = QQQB/wsXMR = (xmrPrice * 1e10) / collateralPrice
            sqrtPriceX96 = (sqrtXmrPrice * sqrt1e10 * (1 << 96)) / sqrtCollateralPrice;
        }

        return uint160(sqrtPriceX96);
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
