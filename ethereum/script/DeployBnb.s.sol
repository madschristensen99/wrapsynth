// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../contracts/core/wsXmrHub.sol";
import "../contracts/facets/VaultFacet.sol";
import "../contracts/facets/MintFacet.sol";
import "../contracts/facets/BurnFacet.sol";
import "../contracts/facets/LiquidationAuctionFacet.sol";
import "../contracts/facets/CoLPFacet.sol";
import "../contracts/wsXMR.sol";
import "../contracts/router/wsXMRLiquidityRouter.sol";
import "../contracts/interfaces/external/IUniswapV3Factory.sol";
import "../contracts/interfaces/external/IUniswapV3Pool.sol";
import "../contracts/BnbAddresses.sol";

/**
 * @title DeployBnb
 * @notice Deploys the oracle-free WrapSynth stack on BNB Chain with QQQB
 *         (Binance bStocks tokenized QQQ) held raw as vault collateral.
 *
 * Oracle-free model:
 *   - No external price feeds anywhere in the protocol. No RedStone, no
 *     Pyth, no precompiles, no TWAP. Nothing in consensus path reads a
 *     price.
 *   - Vaults declare `thresholdSharesPerWsxmr` (normalized collateral per
 *     1e8 wsXMR). It is the mint bound, the self-declared solvency line,
 *     and the par-settlement rate for burns and auctions.
 *   - Liquidation is a bonded kick → Dutch haircut auction, fully
 *     market-discovered.
 *   - The only prices in this script are the pool-initialization prices —
 *     deploy-time inputs for the AMM, never consensus.
 */
contract DeployBnb is Script {
    address constant VERIFIER = address(0);

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        // Deployment floors (normalized collateral units, 18-dec).
        uint256 minThreshold = vm.envOr("MIN_THRESHOLD", uint256(1e15));
        uint256 kickBondMin = vm.envOr("KICK_BOND_MIN", uint256(1e15));

        console.log("============================================================");
        console.log("Starting BNB Deployment (oracle-free, QQQB collateral)");
        console.log("============================================================");
        console.log("Deployer:", deployer);
        console.log("Balance:", deployer.balance / 1e18, "BNB");
        console.log("MIN_THRESHOLD:", minThreshold);
        console.log("KICK_BOND_MIN:", kickBondMin);
        console.log("");

        // Fetch XMR + QQQB prices for POOL INIT ONLY — never consensus.
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = "curl -s 'https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd' | jq -r '.monero.usd | floor | tostring'";
        bytes memory res = vm.ffi(inputs);
        uint256 xmrPrice = vm.parseUint(_trim(string(res))) * 1e18;
        console.log("Fetched XMR price (pool init only):", xmrPrice / 1e18, "USD");

        // QQQB is not on Coingecko — deepest PCS pool price via DexScreener.
        inputs[2] = "curl -s 'https://api.dexscreener.com/latest/dex/tokens/0x205812CdBed920aFf76C6580abD681a46D11efc7' | jq -r '(.pairs | sort_by(.liquidity.usd // 0) | reverse | .[0].priceUsd | tonumber | floor | tostring)'";
        res = vm.ffi(inputs);
        uint256 qqqbPrice = vm.parseUint(_trim(string(res))) * 1e18;
        console.log("Fetched QQQB price (pool init only):", qqqbPrice / 1e18, "USD");
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
        wsXmrHub hub = new wsXmrHub(address(wsxmr), VERIFIER, minThreshold, kickBondMin);
        console.log("wsXmrHub deployed to:", address(hub));
        console.log("");

        console.log("============================================================");
        console.log("STEP 3: Deploying Facets");
        console.log("============================================================");

        VaultFacet vaultFacet = new VaultFacet(address(wsxmr), VERIFIER, minThreshold, kickBondMin);
        console.log("VaultFacet deployed to:", address(vaultFacet));

        MintFacet mintFacet = new MintFacet(address(wsxmr), VERIFIER, minThreshold, kickBondMin);
        console.log("MintFacet deployed to:", address(mintFacet));

        BurnFacet burnFacet = new BurnFacet(address(wsxmr), VERIFIER, minThreshold, kickBondMin);
        console.log("BurnFacet deployed to:", address(burnFacet));

        LiquidationAuctionFacet liquidationAuctionFacet =
            new LiquidationAuctionFacet(address(wsxmr), VERIFIER, minThreshold, kickBondMin);
        console.log("LiquidationAuctionFacet deployed to:", address(liquidationAuctionFacet));

        CoLPFacet coLPFacet = new CoLPFacet(address(wsxmr), VERIFIER, minThreshold, kickBondMin);
        console.log("CoLPFacet deployed to:", address(coLPFacet));
        console.log("");

        console.log("============================================================");
        console.log("STEP 4: Registering Facets with Hub");
        console.log("============================================================");
        hub.registerFacets(
            address(vaultFacet),
            address(mintFacet),
            address(burnFacet),
            address(liquidationAuctionFacet),
            address(coLPFacet)
        );
        console.log("All facets registered");
        console.log("");

        console.log("============================================================");
        console.log("STEP 5: Setting Hub as wsXMR Minter + collateral token");
        console.log("============================================================");
        wsxmr.setHub(address(hub));
        console.log("Hub set as wsXMR minter");

        // Collateral is raw QQQB (18-dec) — no share adapter, no yield layer.
        hub.setExternalAddresses(BnbAddresses.QQQB);
        console.log("External addresses set (raw QQQB)");
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

        // Initialize pool at the fetched spot price — pool.initialize is
        // permissionless. Deploy-time AMM seed, not consensus.
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

        IUniswapV3Pool(pool).increaseObservationCardinalityNext(64);
        console.log("Observation cardinality bumped to 64");
        console.log("");

        console.log("============================================================");
        console.log("STEP 9: Locking Deployer Powers (IRREVERSIBLE)");
        console.log("============================================================");
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
        console.log("  LiquidityRouter:  ", address(router));
        console.log("");
        console.log("Facets:");
        console.log("  VaultFacet:       ", address(vaultFacet));
        console.log("  MintFacet:        ", address(mintFacet));
        console.log("  BurnFacet:        ", address(burnFacet));
        console.log("  LiquidationAuction:", address(liquidationAuctionFacet));
        console.log("  CoLPFacet:        ", address(coLPFacet));
        console.log("");
        console.log("External Contracts:");
        console.log("  QQQB:             ", BnbAddresses.QQQB);
        console.log("  wsXMR/QQQB pool:  ", pool);
        console.log("============================================================");
        console.log("");
        console.log("Next steps:");
        console.log("1. Verify contracts on BscScan");
        console.log("2. Update frontend configuration with deployment.bnb.json");
        console.log("3. Configure LP server with deployed addresses");
        console.log("4. Seed the wsXMR/QQQB pool");
    }

    /// @dev sqrtPriceX96 for token1/token0 where the pair is QQQB/wsXMR.
    ///      QQQB is 18-decimal, wsXMR is 8-decimal — the raw-token price
    ///      ratio needs a 1e10 decimal correction.
    function _priceToSqrtPriceX96(uint256 xmrPrice, uint256 qqqbPrice, bool qqqbIsToken0)
        internal pure returns (uint160)
    {
        uint256 sqrtXmrPrice = _sqrt(xmrPrice);
        uint256 sqrtQqqbPrice = _sqrt(qqqbPrice);
        uint256 sqrt1e10 = 100000; // sqrt(1e10) = 1e5 — 18-dec vs 8-dec correction
        uint256 sqrtPriceX96;

        if (qqqbIsToken0) {
            // price = wsXMR/QQQB = qqqbPrice / (xmrPrice * 1e10)
            sqrtPriceX96 = (sqrtQqqbPrice * (1 << 96)) / (sqrtXmrPrice * sqrt1e10);
        } else {
            // price = QQQB/wsXMR = (xmrPrice * 1e10) / qqqbPrice
            sqrtPriceX96 = (sqrtXmrPrice * sqrt1e10 * (1 << 96)) / sqrtQqqbPrice;
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

    function _trim(string memory s) internal pure returns (string memory) {
        bytes memory sb = bytes(s);
        uint256 end = sb.length;
        while (end > 0 && (sb[end - 1] == "\n" || sb[end - 1] == "\r" || sb[end - 1] == " ")) {
            end--;
        }
        bytes memory out = new bytes(end);
        for (uint256 i = 0; i < end; i++) {
            out[i] = sb[i];
        }
        return string(out);
    }
}
