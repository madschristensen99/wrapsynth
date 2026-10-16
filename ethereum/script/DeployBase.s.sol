// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../contracts/core/wsXmrHub.sol";
import "../contracts/facets/BaseOracleFacet.sol";
import "../contracts/facets/VaultFacet.sol";
import "../contracts/facets/MintFacet.sol";
import "../contracts/facets/BurnFacet.sol";
import "../contracts/facets/LiquidationFacet.sol";
import "../contracts/facets/YieldFacet.sol";
import "../contracts/facets/CoLPFacet.sol";
import "../contracts/wsXMR.sol";
import "../contracts/StataCbBTC.sol";
import "../contracts/router/wsXMRLiquidityRouter.sol";
import "../contracts/interfaces/external/IUniswapV3Factory.sol";
import "../contracts/interfaces/external/IUniswapV3Pool.sol";
import "../contracts/BaseAddresses.sol";

/**
 * @title DeployBase
 * @notice Deploys the WrapSynth stack on Base with cbBTC (Coinbase Wrapped
 *         BTC) as vault collateral.
 *
 * Oracle model:
 *   - XMR/USD: RedStone pull oracle (only external price input)
 *   - cbBTC/USD: fully on-chain — single-leg TWAP on the UniV3 cbBTC/USDC
 *     fee-500 pool, refreshed inside every state-changing hub call via
 *     _tryRefreshCollateralTwap()
 */
contract DeployBase is Script {
    // No verifier needed for RedStone (uses off-chain signed data)
    address constant VERIFIER = address(0);

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("============================================================");
        console.log("Starting Base Deployment (cbBTC collateral)");
        console.log("============================================================");
        console.log("Deployer:", deployer);
        console.log("Balance:", deployer.balance / 1e18, "ETH");
        console.log("");

        // Fetch current XMR and BTC prices from Coingecko
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = "curl -s 'https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd' | jq -r '.monero.usd | floor | tostring'";
        bytes memory res = vm.ffi(inputs);
        uint256 xmrPrice = vm.parseUint(_trim(string(res))) * 1e18;
        console.log("Fetched XMR price:", xmrPrice / 1e18, "USD");

        inputs[2] = "curl -s 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd' | jq -r '.bitcoin.usd | floor | tostring'";
        res = vm.ffi(inputs);
        uint256 cbbtcPrice = vm.parseUint(_trim(string(res))) * 1e18;
        console.log("Fetched cbBTC price:", cbbtcPrice / 1e18, "USD");
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

        // BaseOracleFacet - RedStone XMR + on-chain collateral TWAP
        BaseOracleFacet oracleFacet = new BaseOracleFacet(address(wsxmr), VERIFIER);
        console.log("BaseOracleFacet deployed to:", address(oracleFacet));

        VaultFacet vaultFacet = new VaultFacet(address(wsxmr), VERIFIER);
        console.log("VaultFacet deployed to:", address(vaultFacet));

        MintFacet mintFacet = new MintFacet(address(wsxmr), VERIFIER);
        console.log("MintFacet deployed to:", address(mintFacet));

        BurnFacet burnFacet = new BurnFacet(address(wsxmr), VERIFIER);
        console.log("BurnFacet deployed to:", address(burnFacet));

        LiquidationFacet liquidationFacet = new LiquidationFacet(address(wsxmr), VERIFIER);
        console.log("LiquidationFacet deployed to:", address(liquidationFacet));

        // UniV3 SwapRouter02 on Base uses the no-deadline exactInputSingle
        // (deadline rides in the multicall wrapper) — identical to HyperSwap's
        // signature, so the plain YieldFacet works unmodified.
        YieldFacet yieldFacet = new YieldFacet(address(wsxmr), VERIFIER);
        console.log("YieldFacet deployed to:", address(yieldFacet));
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
        console.log("STEP 4b: Deploying StataCbBTC collateral adapter");
        console.log("============================================================");
        StataCbBTC stata = new StataCbBTC(BaseAddresses.CBBTC);
        console.log("StataCbBTC deployed to:", address(stata));
        console.log("");

        console.log("============================================================");
        console.log("STEP 5: Setting Hub as wsXMR Minter + external addresses");
        console.log("============================================================");
        wsxmr.setHub(address(hub));
        console.log("Hub set as wsXMR minter");

        // collateralToken = stataCbBTC shares, underlyingToken = cbBTC,
        // swapRouter = UniV3 SwapRouter02 (buy-and-burn),
        // xmrPerpIndex = 0 (no HyperCore precompile on Base — the precompile
        // staticcall fails and the leg no-ops cleanly)
        hub.setExternalAddresses(
            address(stata),
            BaseAddresses.CBBTC,
            BaseAddresses.UNI_SWAP_ROUTER,
            0
        );
        console.log("External addresses set (stataCbBTC / cbBTC / UniV3 router)");

        // On-chain collateral TWAP: single-leg cbBTC/USDC (quote pool = 0)
        hub.setCollateralTwapConfig(
            BaseAddresses.CBBTC_USDC_POOL,
            address(0),
            BaseAddresses.USDC,
            BaseAddresses.USDC,
            BaseAddresses.COLLATERAL_TWAP_WINDOW
        );
        console.log("Collateral TWAP config set (window:", BaseAddresses.COLLATERAL_TWAP_WINDOW, "s)");
        console.log("");

        console.log("============================================================");
        console.log("STEP 6: Creating/Checking wsXMR/cbBTC Uniswap V3 Pool");
        console.log("============================================================");
        address token0 = BaseAddresses.CBBTC < address(wsxmr) ? BaseAddresses.CBBTC : address(wsxmr);
        address token1 = BaseAddresses.CBBTC < address(wsxmr) ? address(wsxmr) : BaseAddresses.CBBTC;
        address pool = IUniswapV3Factory(BaseAddresses.UNI_V3_FACTORY)
            .getPool(token0, token1, BaseAddresses.WSXMR_POOL_FEE);

        if (pool == address(0)) {
            console.log("Creating Uniswap V3 pool (fee 500)...");
            pool = IUniswapV3Factory(BaseAddresses.UNI_V3_FACTORY)
                .createPool(token0, token1, BaseAddresses.WSXMR_POOL_FEE);
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
            BaseAddresses.UNI_V3_POSITION_MANAGER,
            BaseAddresses.CBBTC, // router's "sDAI" quote token is cbBTC on Base
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
                bool cbbtcIsToken0 = BaseAddresses.CBBTC < address(wsxmr);
                uint160 targetSqrtPriceX96 = _priceToSqrtPriceX96(xmrPrice, cbbtcPrice, cbbtcIsToken0);
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
        console.log("Network: Base (ChainID: 8453)");
        console.log("Deployer:", deployer);
        console.log("");
        console.log("Core Contracts:");
        console.log("  wsXMR:            ", address(wsxmr));
        console.log("  wsXmrHub:         ", address(hub));
        console.log("  StataCbBTC:       ", address(stata));
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
        console.log("  cbBTC:            ", BaseAddresses.CBBTC);
        console.log("  cbBTC/USDC pool:  ", BaseAddresses.CBBTC_USDC_POOL);
        console.log("  wsXMR/cbBTC pool: ", pool);
        console.log("============================================================");
        console.log("");
        console.log("Next steps:");
        console.log("1. Verify contracts on BaseScan");
        console.log("2. Update frontend configuration with deployment.base.json");
        console.log("3. Configure LP server with deployed addresses + RedStone XMR");
        console.log("4. Seed the wsXMR/cbBTC pool");
    }

    /// @dev sqrtPriceX96 for token1/token0 where the pair is cbBTC/wsXMR.
    ///      Both tokens are 8-decimal so the raw price ratio equals the
    ///      whole-token ratio: 1 wsXMR = xmrPrice/cbbtcPrice cbBTC.
    function _priceToSqrtPriceX96(uint256 xmrPrice, uint256 cbbtcPrice, bool cbbtcIsToken0)
        internal pure returns (uint160)
    {
        uint256 sqrtXmrPrice = _sqrt(xmrPrice);
        uint256 sqrtCbbtcPrice = _sqrt(cbbtcPrice);
        uint256 sqrtPriceX96;

        if (cbbtcIsToken0) {
            // price = wsXMR/cbBTC = cbbtcPrice / xmrPrice
            sqrtPriceX96 = (sqrtCbbtcPrice * (1 << 96)) / sqrtXmrPrice;
        } else {
            // price = cbBTC/wsXMR = xmrPrice / cbbtcPrice
            sqrtPriceX96 = (sqrtXmrPrice * (1 << 96)) / sqrtCbbtcPrice;
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
