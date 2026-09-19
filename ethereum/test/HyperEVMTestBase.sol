// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";
import {HyperCoreOracleFacet} from "../contracts/facets/HyperCoreOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {StataUSDe} from "../contracts/StataUSDe.sol";
import {MockL1Read} from "../contracts/mocks/MockL1Read.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Factory} from "../contracts/interfaces/external/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../contracts/interfaces/external/IUniswapV3Pool.sol";

/// @notice Trivial verifier that accepts everything — same as the inline mocks
///         the Gnosis suite used.
contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

/**
 * @title HyperEVMTestBase
 * @notice Shared setUp for the HyperEVM fork test suite.
 * @dev    Replicates the Gnosis deployment topology on a HyperEVM mainnet fork:
 *
 *           - forks HyperEVM (HYPEREVM_RPC_URL, default rpc.hyperliquid.xyz/evm)
 *           - etches MockL1Read onto the L1-read precompile addresses so the
 *             HyperCore oracle works on anvil (which lacks the precompiles)
 *           - deploys StataUSDe over the REAL HyperLend pool + USDe + aToken
 *           - deploys wsXMR + hub + all facets (HyperCoreOracleFacet) + router
 *           - wires setExternalAddresses / setLiquidityRouter / setHub
 *           - creates + initializes the HyperSwap wsXMR/USDe 0.3% pool
 *
 *         Collateral model: users deposit USDe → adapter wraps to stataUSDe
 *         shares → vault collateralShares are stataUSDe (the sDAI analogue).
 */
abstract contract HyperEVMTestBase is Test {
    // ========== HYPEREVM MAINNET ADDRESSES ==========
    address constant USDE = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
    address constant HYPERLEND_POOL = 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b;
    address constant HYPERLEND_ATOKEN = 0x333819c04975554260AaC119948562a0E24C2bd6;

    address constant HYPERSWAP_FACTORY = 0xB1c0fa0B789320044A6F623cFe5eBda9562602E3;
    address constant HYPERSWAP_NFPM = 0x6eDA206207c09e5428F281761DdC0D300851fBC8;
    address constant HYPERSWAP_ROUTER = 0x6D99e7f6747AF2cDbB5164b6DD50e40D4fDe1e77;

    uint32 constant XMR_PERP_INDEX = 224; // HyperCore mainnet XMR perp

    // L1-read precompiles
    address constant MARK_PX_PRECOMPILE = 0x0000000000000000000000000000000000000806;
    address constant ORACLE_PX_PRECOMPILE = 0x0000000000000000000000000000000000000807;
    address constant SPOT_PX_PRECOMPILE = 0x0000000000000000000000000000000000000808;

    // ========== DEPLOYED CONTRACTS ==========
    wsXMR public wsxmr;
    wsXmrHub public hub;
    StataUSDe public stata; // collateral share token (the sDAI analogue)
    MockVerifierProxy public verifier;
    wsXMRLiquidityRouter public router;
    address public pool;

    HyperCoreOracleFacet public oracleFacet;
    VaultFacet public vaultFacet;
    MintFacet public mintFacet;
    BurnFacet public burnFacet;
    LiquidationFacet public liquidationFacet;
    YieldFacet public yieldFacet;

    // Mock precompiles (etched at the real precompile addresses)
    MockL1Read public mockMark;
    MockL1Read public mockOracle;
    MockL1Read public mockSpot;

    // ========== PRICE CONVENTION ==========
    // Tests express XMR price in the old 8-decimal RedStone format ($390 → 390e8).
    // The precompile returns price*1e3 (szDecimals=3), so raw = price8dec / 1e5.
    uint256 constant XMR_PRICE_8DEC = 390_00000000; // $390

    address public deployer;
    address public lp;
    address public user;

    function setUp() public virtual {
        string memory rpcUrl = vm.envOr("HYPEREVM_RPC_URL", string("https://rpc.hyperliquid.xyz/evm"));
        // Optional pinned block for deterministic runs — the live HyperLend aToken
        // liquidity index drifts between latest-block re-forks, which can flake the
        // exact share-equality solvency invariants. Set HYPEREVM_FORK_BLOCK to pin.
        uint256 forkBlock = vm.envOr("HYPEREVM_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) {
            vm.createSelectFork(rpcUrl);
        } else {
            vm.createSelectFork(rpcUrl, forkBlock);
        }

        deployer = address(this);
        lp = makeAddr("lp");
        user = makeAddr("user");
        vm.deal(lp, 1000 ether);
        vm.deal(user, 1000 ether);

        _etchPrecompiles();
        _deployStack();
        _setXmrPrice8dec(XMR_PRICE_8DEC);
    }

    // ========== SETUP INTERNALS ==========

    /// @dev Etch MockL1Read runtime code onto the three L1-read precompile
    ///      addresses. Each etched address gets independent storage, so prices
    ///      are configured per-precompile.
    function _etchPrecompiles() internal {
        MockL1Read impl = new MockL1Read();
        bytes memory code = address(impl).code;
        vm.etch(MARK_PX_PRECOMPILE, code);
        vm.etch(ORACLE_PX_PRECOMPILE, code);
        vm.etch(SPOT_PX_PRECOMPILE, code);
        mockMark = MockL1Read(MARK_PX_PRECOMPILE);
        mockOracle = MockL1Read(ORACLE_PX_PRECOMPILE);
        mockSpot = MockL1Read(SPOT_PX_PRECOMPILE);
    }

    function _deployStack() internal {
        verifier = new MockVerifierProxy();
        wsxmr = new wsXMR();
        hub = new wsXmrHub(address(wsxmr), address(verifier));

        // Collateral adapter over the REAL HyperLend USDe market
        stata = new StataUSDe(HYPERLEND_POOL, HYPERLEND_ATOKEN, USDE);

        oracleFacet = new HyperCoreOracleFacet(address(wsxmr), address(verifier));
        vaultFacet = new VaultFacet(address(wsxmr), address(verifier));
        mintFacet = new MintFacet(address(wsxmr), address(verifier));
        burnFacet = new BurnFacet(address(wsxmr), address(verifier));
        liquidationFacet = new LiquidationFacet(address(wsxmr), address(verifier));
        yieldFacet = new YieldFacet(address(wsxmr), address(verifier));

        hub.registerFacets(
            address(vaultFacet),
            address(mintFacet),
            address(burnFacet),
            address(liquidationFacet),
            address(yieldFacet),
            address(oracleFacet)
        );
        wsxmr.setHub(address(hub));

        // External dependencies: collateral adapter, USDe underlying,
        // HyperSwap router for buy-and-burn, XMR perp index for the oracle.
        hub.setExternalAddresses(address(stata), USDE, HYPERSWAP_ROUTER, XMR_PERP_INDEX);

        // Create the wsXMR/USDe 0.3% pool on the real HyperSwap factory
        pool = IUniswapV3Factory(HYPERSWAP_FACTORY).getPool(USDE, address(wsxmr), 3000);
        if (pool == address(0)) {
            pool = IUniswapV3Factory(HYPERSWAP_FACTORY).createPool(USDE, address(wsxmr), 3000);
        }

        router = new wsXMRLiquidityRouter(
            address(hub),
            HYPERSWAP_NFPM,
            USDE, // router's "sDAI" quote token is USDe on HyperEVM
            address(wsxmr),
            pool
        );
        hub.setLiquidityRouter(address(router));
    }

    /// @dev Initialize the pool at the oracle price. Call after _setXmrPrice8dec.
    ///      initializePool is onlyDiamond → prank as hub.
    function _initializePool() internal {
        vm.prank(address(hub));
        router.initializePool(XMR_PRICE_8DEC * 1e10); // 8dec → 18dec
    }

    // ========== HELPERS ==========

    /// @dev Set the mock XMR perp price. Takes the old 8-decimal format.
    ///      Writes both oraclePx and markPx (mark = oracle, no divergence).
    function _setXmrPrice8dec(uint256 price8dec) internal {
        uint64 raw = uint64(price8dec / 1e5); // 8dec → price*1e3
        mockOracle.setPrice(XMR_PERP_INDEX, raw);
        mockMark.setPrice(XMR_PERP_INDEX, raw);
        _refreshOracle();
    }

    /// @dev Set oracle and mark independently (for divergence tests).
    function _setXmrPrices8dec(uint256 oracle8dec, uint256 mark8dec) internal {
        mockOracle.setPrice(XMR_PERP_INDEX, uint64(oracle8dec / 1e5));
        mockMark.setPrice(XMR_PERP_INDEX, uint64(mark8dec / 1e5));
        _refreshOracle();
    }

    function _refreshOracle() internal {
        HyperCoreOracleFacet(address(hub)).refreshPrices();
    }

    /// @dev Give an address USDe (the deposit/underlying asset).
    function _dealUSDe(address to, uint256 amount) internal {
        deal(USDE, to, amount);
    }

    /// @dev Give an address stataUSDe shares by dealing USDe and depositing
    ///      through the adapter. Returns shares received.
    function _dealShares(address to, uint256 usdeAmount) internal returns (uint256 shares) {
        deal(USDE, to, usdeAmount);
        vm.startPrank(to);
        IERC20(USDE).approve(address(stata), usdeAmount);
        shares = stata.deposit(usdeAmount, to);
        vm.stopPrank();
    }

    /// @dev LP creates a vault and deposits `usdeAmount` USDe as collateral.
    function _lpVaultWithCollateral(address lpAddr, uint256 usdeAmount) internal {
        deal(USDE, lpAddr, usdeAmount);
        vm.startPrank(lpAddr);
        VaultFacet(address(hub)).createVault();
        IERC20(USDE).approve(address(hub), usdeAmount);
        VaultFacet(address(hub)).depositCollateral(usdeAmount);
        vm.stopPrank();
    }
}
