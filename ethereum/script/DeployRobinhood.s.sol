// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../contracts/core/wsXmrHub.sol";
import "../contracts/facets/RobinhoodOracleFacet.sol";
import "../contracts/facets/VaultFacet.sol";
import "../contracts/facets/MintFacet.sol";
import "../contracts/facets/BurnFacet.sol";
import "../contracts/facets/LiquidationFacet.sol";
import "../contracts/facets/YieldFacet.sol";
import "../contracts/wsXMR.sol";
import "../contracts/StataSPY.sol";
import "../contracts/router/wsXMRLiquidityRouter.sol";
import "../contracts/test/SwapHelper.sol";
import "../contracts/interfaces/external/IUniswapV3Factory.sol";
import "../contracts/interfaces/external/IUniswapV3Pool.sol";
import "../contracts/libraries/FullMath.sol";
import "../contracts/libraries/TickMath.sol";
import "../contracts/RobinhoodAddresses.sol";

/**
 * @title DeployRobinhood
 * @notice Deploys the WrapSynth stack on Robinhood Chain with SPY (Robinhood
 *         tokenized S&P 500) as vault collateral.
 *
 * Oracle model:
 *   - XMR/USD: RedStone pull oracle (only external price input)
 *   - SPY/USD: fully on-chain — single-leg TWAP on the UniV3 SPY/USDG
 *     fee-500 pool, refreshed inside every state-changing hub call via
 *     _tryRefreshCollateralTwap()
 */
contract DeployRobinhood is Script {
    // No verifier needed for RedStone (uses off-chain signed data)
    address constant VERIFIER = address(0);

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("============================================================");
        console.log("Starting Robinhood Chain Deployment (SPY collateral)");
        console.log("============================================================");
        console.log("Deployer:", deployer);
        console.log("Balance:", deployer.balance / 1e18, "ETH");
        console.log("");

        // Fetch current XMR price from Coingecko
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = "curl -s 'https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd' | jq -r '.monero.usd | floor | tostring'";
        bytes memory res = vm.ffi(inputs);
        uint256 xmrPrice = vm.parseUint(_trim(string(res))) * 1e18;
        console.log("Fetched XMR price:", xmrPrice / 1e18, "USD");

        // SPY price from the on-chain SPY/USDG pool's current tick — the
        // deployment's own oracle source, no external API needed.
        // (slot0 → tick → raw USDG per 1e18 raw SPY → ×1e12 for 18-dec)
        (, int24 spyTick,,,,,) = IUniswapV3Pool(RobinhoodAddresses.SPY_USDG_POOL).slot0();
        uint256 usdgRawPerSpy = _quoteAtTick(spyTick, 1e18, RobinhoodAddresses.SPY, RobinhoodAddresses.USDG);
        uint256 spyPrice = usdgRawPerSpy * 1e12; // USDG is 6-dec
        console.log("On-chain SPY price (SPY/USDG spot):", spyPrice / 1e18, "USD");
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

        // RobinhoodOracleFacet - RedStone XMR + on-chain collateral TWAP
        RobinhoodOracleFacet oracleFacet = new RobinhoodOracleFacet(address(wsxmr), VERIFIER);
        console.log("RobinhoodOracleFacet deployed to:", address(oracleFacet));

        VaultFacet vaultFacet = new VaultFacet(address(wsxmr), VERIFIER);
        console.log("VaultFacet deployed to:", address(vaultFacet));

        MintFacet mintFacet = new MintFacet(address(wsxmr), VERIFIER);
        console.log("MintFacet deployed to:", address(mintFacet));

        BurnFacet burnFacet = new BurnFacet(address(wsxmr), VERIFIER);
        console.log("BurnFacet deployed to:", address(burnFacet));

        LiquidationFacet liquidationFacet = new LiquidationFacet(address(wsxmr), VERIFIER);
        console.log("LiquidationFacet deployed to:", address(liquidationFacet));

        // UniV3 SwapRouter02 on Robinhood Chain uses the no-deadline exactInputSingle
        // (deadline rides in the multicall wrapper) — identical to HyperSwap's
        // signature, so the plain YieldFacet works unmodified.
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
        console.log("STEP 4b: Deploying StataSPY collateral adapter");
        console.log("============================================================");
        StataSPY stata = new StataSPY(RobinhoodAddresses.SPY);
        console.log("StataSPY deployed to:", address(stata));
        console.log("");

        console.log("============================================================");
        console.log("STEP 5: Setting Hub as wsXMR Minter + external addresses");
        console.log("============================================================");
        wsxmr.setHub(address(hub));
        console.log("Hub set as wsXMR minter");

        // collateralToken = stataSPY shares, underlyingToken = SPY,
        // swapRouter = UniV3 SwapRouter02 (buy-and-burn),
        // xmrPerpIndex = 0 (no HyperCore precompile on Robinhood Chain — the precompile
        // staticcall fails and the leg no-ops cleanly)
        hub.setExternalAddresses(
            address(stata),
            RobinhoodAddresses.SPY,
            RobinhoodAddresses.UNI_SWAP_ROUTER,
            0
        );
        console.log("External addresses set (stataSPY / SPY / UniV3 router)");

        // On-chain collateral TWAP: single-leg SPY/USDG (quote pool = 0)
        hub.setCollateralTwapConfig(
            RobinhoodAddresses.SPY_USDG_POOL,
            address(0),
            RobinhoodAddresses.USDG,
            RobinhoodAddresses.USDG,
            RobinhoodAddresses.COLLATERAL_TWAP_WINDOW
        );
        console.log("Collateral TWAP config set (window:", RobinhoodAddresses.COLLATERAL_TWAP_WINDOW, "s)");
        console.log("");

        console.log("============================================================");
        console.log("STEP 6: Creating/Checking wsXMR/SPY Uniswap V3 Pool");
        console.log("============================================================");
        address token0 = RobinhoodAddresses.SPY < address(wsxmr) ? RobinhoodAddresses.SPY : address(wsxmr);
        address token1 = RobinhoodAddresses.SPY < address(wsxmr) ? address(wsxmr) : RobinhoodAddresses.SPY;
        address pool = IUniswapV3Factory(RobinhoodAddresses.UNI_V3_FACTORY)
            .getPool(token0, token1, RobinhoodAddresses.WSXMR_POOL_FEE);

        if (pool == address(0)) {
            console.log("Creating Uniswap V3 pool (fee 500)...");
            pool = IUniswapV3Factory(RobinhoodAddresses.UNI_V3_FACTORY)
                .createPool(token0, token1, RobinhoodAddresses.WSXMR_POOL_FEE);
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
            RobinhoodAddresses.UNI_V3_POSITION_MANAGER,
            RobinhoodAddresses.SPY, // router's "sDAI" quote token is SPY on Robinhood Chain
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
                bool spyIsToken0 = RobinhoodAddresses.SPY < address(wsxmr);
                uint160 targetSqrtPriceX96 = _priceToSqrtPriceX96(xmrPrice, spyPrice, spyIsToken0);
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
        console.log("STEP 9: Deploying SwapHelper");
        console.log("============================================================");
        SwapHelper swapHelper = new SwapHelper();
        console.log("SwapHelper deployed to:", address(swapHelper));
        console.log("");

        console.log("============================================================");
        console.log("STEP 10: Locking Deployer Powers (IRREVERSIBLE)");
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
        console.log("Network: Robinhood Chain (ChainID: 4663)");
        console.log("Deployer:", deployer);
        console.log("");
        console.log("Core Contracts:");
        console.log("  wsXMR:            ", address(wsxmr));
        console.log("  wsXmrHub:         ", address(hub));
        console.log("  StataSPY:           ", address(stata));
        console.log("  LiquidityRouter:  ", address(router));
        console.log("  SwapHelper:       ", address(swapHelper));
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
        console.log("  SPY:              ", RobinhoodAddresses.SPY);
        console.log("  SPY/USDG pool:   ", RobinhoodAddresses.SPY_USDG_POOL);
        console.log("  wsXMR/SPY pool:  ", pool);
        console.log("============================================================");
        console.log("");
        console.log("Next steps:");
        console.log("1. Verify contracts on RobinScan");
        console.log("2. Update frontend configuration with deployment.robinhood.json");
        console.log("3. Configure LP server with deployed addresses + RedStone XMR");
        console.log("4. Seed the wsXMR/SPY pool");
    }

    /// @dev sqrtPriceX96 for token1/token0 where token0/token1 = SPY/wsXMR in
    ///      either order. 1 wsXMR (1e8) = xmrPrice/spyPrice SPY (1e18).
    function _priceToSqrtPriceX96(uint256 xmrPrice, uint256 spyPrice, bool spyIsToken0)
        internal pure returns (uint160)
    {
        uint256 sqrtXmrPrice = _sqrt(xmrPrice);
        uint256 sqrtSpyPrice = _sqrt(spyPrice);
        uint256 sqrt1e10 = 100000; // sqrt(1e10) = 1e5 — 18-dec vs 8-dec correction
        uint256 sqrtPriceX96;

        if (spyIsToken0) {
            // price = wsXMR/SPY = spyPrice / (xmrPrice * 1e10)
            sqrtPriceX96 = (sqrtSpyPrice * (1 << 96)) / (sqrtXmrPrice * sqrt1e10);
        } else {
            // price = SPY/wsXMR = (xmrPrice * 1e10) / spyPrice
            sqrtPriceX96 = (sqrtXmrPrice * sqrt1e10 * (1 << 96)) / sqrtSpyPrice;
        }

        return uint160(sqrtPriceX96);
    }

    /// @dev Port of Uniswap OracleLibrary.getQuoteAtTick — returns raw
    ///      quoteToken units per `baseAmount` raw baseToken units.
    function _quoteAtTick(int24 tick, uint128 baseAmount, address baseToken, address quoteToken)
        internal pure returns (uint256 quoteAmount)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
                : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
        }
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
