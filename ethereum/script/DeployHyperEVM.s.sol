// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../contracts/core/wsXmrHub.sol";
import "../contracts/facets/HyperCoreOracleFacet.sol";
import "../contracts/facets/VaultFacet.sol";
import "../contracts/facets/MintFacet.sol";
import "../contracts/facets/BurnFacet.sol";
import "../contracts/facets/LiquidationFacet.sol";
import "../contracts/facets/YieldFacet.sol";
import "../contracts/wsXMR.sol";
import "../contracts/StataUSDe.sol";
import "../contracts/Ed25519Helper.sol";
import "../contracts/test/SwapHelper.sol";
import "../contracts/router/wsXMRLiquidityRouter.sol";
import "../contracts/interfaces/external/IUniswapV3Factory.sol";
import "../contracts/interfaces/external/IUniswapV3Pool.sol";

/**
 * @title DeployHyperEVM
 * @notice Deploys the full wsXMR diamond stack on HyperEVM mainnet.
 * @dev    Mirrors the HyperEVMTestBase._deployStack() topology exactly:
 *
 *           wsXMR -> wsXmrHub -> 6 facets (HyperCoreOracle/Vault/Mint/Burn/
 *           Liquidation/Yield) -> StataUSDe collateral adapter -> registerFacets
 *           -> setHub -> setExternalAddresses -> create wsXMR/USDe pool ->
 *           wsXMRLiquidityRouter -> setLiquidityRouter.
 *
 *         Venue: HyperSwap V3 (factory/NFPM/router). Collateral: USDe wrapped
 *         to stataUSDe shares via the HyperLend adapter. Oracle: HyperCore
 *         native XMR perp read via L1 precompiles (no external oracle).
 *
 *         Env:
 *           PRIVATE_KEY          deployer key (needs HYPE for gas)
 *           LOCK_DEPLOYER=true   optionally lock wsXMR.lockHub + hub.lockDeployer
 *                                (IRREVERSIBLE — only after verification)
 *
 *         Dry-run on a fork (no real HYPE spent):
 *           forge script script/DeployHyperEVM.s.sol --fork-url $HYPEREVM_RPC_URL --ffi -vvv
 *         Broadcast for real:
 *           forge script script/DeployHyperEVM.s.sol --rpc-url $HYPEREVM_RPC_URL \
 *             --broadcast --ffi -vvv
 */
contract DeployHyperEVM is Script {
    // ---- HyperEVM mainnet externals ----
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant HYPERLEND_POOL = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;
    address constant HYPERLEND_ATOKEN = 0x333819c04975554260AaC119948562a0E24C2bd6;

    address constant HYPERSWAP_FACTORY = 0xB1c0fa0B789320044A6F623cFe5eBda9562602E3;
    address constant HYPERSWAP_NFPM = 0x6eDA206207c09e5428F281761DdC0D300851fBC8;
    address constant HYPERSWAP_ROUTER = 0x6D99e7f6747AF2cDbB5164b6DD50e40D4fDe1e77;

    uint32 constant XMR_PERP_INDEX = 224; // HyperCore mainnet XMR perp
    uint24 constant POOL_FEE = 3000;      // 0.3% wsXMR/USDe pool

    // No on-chain verifier for the HyperCore oracle path (precompile reads).
    // The Monero deposit-proof verifier is wired separately if/when needed.
    address constant VERIFIER = address(0);

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        bool lockDeployer = vm.envOr("LOCK_DEPLOYER", false);

        console.log("============================================================");
        console.log("Starting HyperEVM Deployment");
        console.log("============================================================");
        console.log("Deployer:", deployer);
        console.log("Balance (HYPE):", deployer.balance);
        console.log("");

        // Fetch current XMR price for pool initialization (18-dec USD).
        uint256 xmrPrice = _fetchXmrPrice();
        console.log("XMR price for pool init (1e18):", xmrPrice);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        // ---- STEP 1: wsXMR token ----
        wsXMR wsxmr = new wsXMR();
        console.log("wsXMR:", address(wsxmr));

        // ---- STEP 2: hub (diamond) ----
        wsXmrHub hub = new wsXmrHub(address(wsxmr), VERIFIER);
        console.log("wsXmrHub:", address(hub));

        // ---- STEP 3: collateral adapter over the real HyperLend USDe market ----
        StataUSDe stata = new StataUSDe(HYPERLEND_POOL, HYPERLEND_ATOKEN, USDE);
        console.log("StataUSDe:", address(stata));

        // ---- STEP 4: facets ----
        HyperCoreOracleFacet oracleFacet = new HyperCoreOracleFacet(address(wsxmr), VERIFIER);
        VaultFacet vaultFacet = new VaultFacet(address(wsxmr), VERIFIER);
        MintFacet mintFacet = new MintFacet(address(wsxmr), VERIFIER);
        BurnFacet burnFacet = new BurnFacet(address(wsxmr), VERIFIER);
        LiquidationFacet liquidationFacet = new LiquidationFacet(address(wsxmr), VERIFIER);
        YieldFacet yieldFacet = new YieldFacet(address(wsxmr), VERIFIER);
        console.log("HyperCoreOracleFacet:", address(oracleFacet));
        console.log("VaultFacet:", address(vaultFacet));
        console.log("MintFacet:", address(mintFacet));
        console.log("BurnFacet:", address(burnFacet));
        console.log("LiquidationFacet:", address(liquidationFacet));
        console.log("YieldFacet:", address(yieldFacet));

        // ---- STEP 5: register facets + set hub as minter ----
        hub.registerFacets(
            address(vaultFacet),
            address(mintFacet),
            address(burnFacet),
            address(liquidationFacet),
            address(yieldFacet),
            address(oracleFacet)
        );
        wsxmr.setHub(address(hub));
        console.log("Facets registered; hub set as wsXMR minter");

        // ---- STEP 6: external addresses ----
        // collateralToken = stataUSDe shares, underlyingToken = USDe,
        // swapRouter = HyperSwap SwapRouter02, xmrPerpIndex = HyperCore perp.
        hub.setExternalAddresses(address(stata), USDE, HYPERSWAP_ROUTER, XMR_PERP_INDEX);
        console.log("External addresses set");

        // ---- STEP 7: create + initialize the wsXMR/USDe pool ----
        address token0 = USDE < address(wsxmr) ? USDE : address(wsxmr);
        address token1 = USDE < address(wsxmr) ? address(wsxmr) : USDE;
        address pool = IUniswapV3Factory(HYPERSWAP_FACTORY).getPool(token0, token1, POOL_FEE);
        if (pool == address(0)) {
            pool = IUniswapV3Factory(HYPERSWAP_FACTORY).createPool(token0, token1, POOL_FEE);
            console.log("Pool created:", pool);
        } else {
            console.log("Pool exists:", pool);
        }

        (bool s0ok, bytes memory s0) = pool.call(abi.encodeWithSignature("slot0()"));
        if (s0ok && s0.length >= 32) {
            uint160 sqrtPriceX96 = abi.decode(s0, (uint160));
            if (sqrtPriceX96 == 0) {
                bool usdeIsToken0 = USDE < address(wsxmr);
                uint160 target = _priceToSqrtPriceX96(xmrPrice, usdeIsToken0);
                (bool initOk,) = pool.call(abi.encodeWithSignature("initialize(uint160)", target));
                require(initOk, "pool initialize failed");
                console.log("Pool initialized, sqrtPriceX96:", target);
            } else {
                console.log("Pool already initialized");
            }
        }

        // ---- STEP 8: liquidity router ----
        wsXMRLiquidityRouter router = new wsXMRLiquidityRouter(
            address(hub),
            HYPERSWAP_NFPM,
            USDE, // router's quote token is USDe on HyperEVM
            address(wsxmr),
            pool
        );
        hub.setLiquidityRouter(address(router));
        console.log("wsXMRLiquidityRouter:", address(router));

        // ---- STEP 8b: helper contracts used by the mainnet test scripts ----
        Ed25519Helper ed25519Helper = new Ed25519Helper();
        SwapHelper swapHelper = new SwapHelper();
        console.log("Ed25519Helper:", address(ed25519Helper));
        console.log("SwapHelper:", address(swapHelper));

        // ---- STEP 9 (optional, IRREVERSIBLE): lock deployer powers ----
        if (lockDeployer) {
            wsxmr.lockHub();
            hub.lockDeployer();
            console.log("Deployer powers LOCKED (irreversible)");
        } else {
            console.log("Deployer powers NOT locked (set LOCK_DEPLOYER=true to lock)");
        }

        vm.stopBroadcast();

        // ---- manifest ----
        console.log("");
        console.log("============================================================");
        console.log("DEPLOYMENT SUMMARY (HyperEVM)");
        console.log("============================================================");
        console.log("wsXMR:            ", address(wsxmr));
        console.log("wsXmrHub:         ", address(hub));
        console.log("StataUSDe:        ", address(stata));
        console.log("LiquidityRouter:  ", address(router));
        console.log("Pool:             ", pool);
        console.log("OracleFacet:      ", address(oracleFacet));
        console.log("VaultFacet:       ", address(vaultFacet));
        console.log("MintFacet:        ", address(mintFacet));
        console.log("BurnFacet:        ", address(burnFacet));
        console.log("LiquidationFacet: ", address(liquidationFacet));
        console.log("YieldFacet:       ", address(yieldFacet));
        console.log("============================================================");

        _writeManifest(deployer, wsxmr, hub, stata, router, pool,
            oracleFacet, vaultFacet, mintFacet, burnFacet, liquidationFacet, yieldFacet,
            ed25519Helper, swapHelper);
    }

    /// @dev Fetch XMR/USD via Coingecko (18-dec). Falls back to $390 on failure.
    function _fetchXmrPrice() internal returns (uint256) {
        string[] memory inputs = new string[](3);
        inputs[0] = "bash";
        inputs[1] = "-c";
        inputs[2] = "curl -s 'https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd' | jq -r '.monero.usd | floor | tostring'";
        try vm.ffi(inputs) returns (bytes memory res) {
            uint256 p = vm.parseUint(string(res));
            if (p > 0) return p * 1e18;
        } catch {}
        return 390e18; // fallback
    }

    function _writeManifest(
        address deployer,
        wsXMR wsxmr,
        wsXmrHub hub,
        StataUSDe stata,
        wsXMRLiquidityRouter router,
        address pool,
        HyperCoreOracleFacet oracleFacet,
        VaultFacet vaultFacet,
        MintFacet mintFacet,
        BurnFacet burnFacet,
        LiquidationFacet liquidationFacet,
        YieldFacet yieldFacet,
        Ed25519Helper ed25519Helper,
        SwapHelper swapHelper
    ) internal {
        string memory json = "hyperevm";
        vm.serializeAddress(json, "wsXMR", address(wsxmr));
        vm.serializeAddress(json, "wsXmrHub", address(hub));
        vm.serializeAddress(json, "stataUSDe", address(stata));
        vm.serializeAddress(json, "liquidityRouter", address(router));
        vm.serializeAddress(json, "ed25519Helper", address(ed25519Helper));
        vm.serializeAddress(json, "swapHelper", address(swapHelper));
        vm.serializeAddress(json, "pool", pool);
        vm.serializeAddress(json, "oracleFacet", address(oracleFacet));
        vm.serializeAddress(json, "vaultFacet", address(vaultFacet));
        vm.serializeAddress(json, "mintFacet", address(mintFacet));
        vm.serializeAddress(json, "burnFacet", address(burnFacet));
        vm.serializeAddress(json, "liquidationFacet", address(liquidationFacet));
        vm.serializeAddress(json, "yieldFacet", address(yieldFacet));
        vm.serializeAddress(json, "usde", USDE);
        vm.serializeAddress(json, "hyperlendPool", HYPERLEND_POOL);
        vm.serializeAddress(json, "hyperlendAToken", HYPERLEND_ATOKEN);
        vm.serializeAddress(json, "hyperswapFactory", HYPERSWAP_FACTORY);
        vm.serializeAddress(json, "hyperswapRouter", HYPERSWAP_ROUTER);
        vm.serializeAddress(json, "hyperswapNFPM", HYPERSWAP_NFPM);
        vm.serializeUint(json, "xmrPerpIndex", XMR_PERP_INDEX);
        string memory out = vm.serializeAddress(json, "deployer", deployer);
        vm.writeJson(out, "./deployments/hyperevm-deployment.json");
        console.log("Manifest written to deployments/hyperevm-deployment.json");
    }

    function _priceToSqrtPriceX96(uint256 xmrPrice, bool usdeIsToken0) internal pure returns (uint160) {
        // xmrPrice in 1e18; collateral (USDe) ~ $1 -> 1e18.
        // 1 wsXMR (1e8) = xmrPrice USDe (1e18).
        uint256 sqrtXmrPrice = _sqrt(xmrPrice);
        uint256 sqrtCollateralPrice = _sqrt(1e18);
        uint256 sqrt1e10 = 100000; // sqrt(1e10) = 1e5
        uint256 sqrtPriceX96;
        if (usdeIsToken0) {
            // price = wsXMR/USDe = collateralPrice / (xmrPrice * 1e10)
            sqrtPriceX96 = (sqrtCollateralPrice * (1 << 96)) / (sqrtXmrPrice * sqrt1e10);
        } else {
            // price = USDe/wsXMR = (xmrPrice * 1e10) / collateralPrice
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
