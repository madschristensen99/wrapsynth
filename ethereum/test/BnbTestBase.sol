// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";
import {BnbOracleFacet} from "../contracts/facets/BnbOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
import {BnbYieldFacet} from "../contracts/facets/BnbYieldFacet.sol";
import {CoLPFacet} from "../contracts/facets/CoLPFacet.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {StataQQQB} from "../contracts/StataQQQB.sol";
import {MockL1Read} from "../contracts/mocks/MockL1Read.sol";
import {MockTwapPool} from "../contracts/mocks/MockTwapPool.sol";
import {MockVerifierProxy} from "./HyperEVMTestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Factory} from "../contracts/interfaces/external/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../contracts/interfaces/external/IUniswapV3Pool.sol";
import {TickMath} from "../contracts/libraries/TickMath.sol";
import {BnbAddresses} from "../contracts/BnbAddresses.sol";

/**
 * @title BnbTestBase
 * @notice Shared setUp for the BNB Chain fork test suite — mirrors
 *         HyperEVMTestBase so existing tests port with minimal changes.
 * @dev    Forks BSC mainnet and deploys the WrapSynth stack against REAL
 *         mainnet state:
 *
 *           - QQQB collateral (Binance bStocks tokenized QQQ) + StataQQQB
 *             1:1 share adapter
 *           - XMR price leg identical to HyperEVM: MockL1Read etched on the
 *             same precompile addresses + xmrPerpIndex set, so the shared
 *             _tryRefreshXmrFromPrecompile leg drives prices exactly like the
 *             HyperEVM suite (mockOracle/mockMark.setPrice work verbatim)
 *           - collateral price: REAL PancakeSwap V3 TWAP pools by default
 *             (BnbFork suite); ported suites use BnbMockTestBase, which swaps
 *             in MockTwapPool contracts so the collateral price is
 *             controllable while still flowing through the production
 *             observe→tick→quote path and staying fresh across warps
 *           - wsXMR/QQQB PCS V3 pool (fee 500, tick spacing 10) created on the
 *             real PancakeSwap factory; router self-derives fee/spacing
 *
 *         Name aliases (USDE, HYPERSWAP_*, XMR_PERP_INDEX) exist purely so
 *         HyperEVM-ported tests keep their original identifiers.
 */
abstract contract BnbTestBase is Test {
    using stdStorage for StdStorage;

    // ========== BNB MAINNET ADDRESSES / PORTING ALIASES ==========
    // USDE name kept so ported tests' deal()/IERC20() references resolve to QQQB.
    address constant USDE = BnbAddresses.QQQB;
    address constant HYPERSWAP_ROUTER = BnbAddresses.PCS_SMART_ROUTER;
    address constant HYPERSWAP_NFPM = BnbAddresses.PCS_V3_POSITION_MANAGER;
    address constant HYPERSWAP_FACTORY = BnbAddresses.PCS_V3_FACTORY;

    uint32 constant XMR_PERP_INDEX = 224; // reuse the XMR perp index — drives the etched mocks

    // L1-read precompile addresses (etched with MockL1Read, as on HyperEVM)
    address constant MARK_PX_PRECOMPILE = 0x0000000000000000000000000000000000000806;
    address constant ORACLE_PX_PRECOMPILE = 0x0000000000000000000000000000000000000807;
    address constant SPOT_PX_PRECOMPILE = 0x0000000000000000000000000000000000000808;

    // ========== PRICE CONVENTION ==========
    // Tests express XMR price in the 8-decimal storage format ($390 -> 390e8).
    uint256 constant XMR_PRICE_8DEC = 390_00000000; // $390

    address public deployer;
    address public lp;
    address public user;

    // ========== DEPLOYED CONTRACTS ==========
    wsXMR public wsxmr;
    wsXmrHub public hub;
    StataQQQB public stata; // collateral share token (the sDAI analogue)
    MockVerifierProxy public verifier;
    wsXMRLiquidityRouter public router;
    address public pool;

    BnbOracleFacet public oracleFacet;
    VaultFacet public vaultFacet;
    MintFacet public mintFacet;
    BurnFacet public burnFacet;
    LiquidationFacet public liquidationFacet;
    YieldFacet public yieldFacet;
    CoLPFacet public coLPFacet;

    // Mock precompiles (etched at the real precompile addresses)
    MockL1Read public mockMark;
    MockL1Read public mockOracle;
    MockL1Read public mockSpot;

    // Mock TWAP pools (only wired into the hub by _useMockTwapPools)
    MockTwapPool public collateralTwapMock; // QQQB/WBNB leg
    MockTwapPool public quoteTwapMock;      // WBNB/USDT leg (fixed $500)
    uint256 internal constant MOCK_WBNB_USD_E18 = 500e18;

    function setUp() public virtual {
        string memory rpcUrl = vm.envOr("BSC_RPC_URL", string("https://bsc-dataseed.binance.org"));
        uint256 forkBlock = vm.envOr("BSC_FORK_BLOCK", uint256(0));
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
        _refreshCollateral();
    }

    // ========== SETUP INTERNALS ==========

    /// @dev Etch MockL1Read runtime code onto the three L1-read precompile
    ///      addresses — identical trick to HyperEVMTestBase so the shared
    ///      precompile oracle leg works on the BSC fork.
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

        stata = new StataQQQB(BnbAddresses.QQQB);

        oracleFacet = new BnbOracleFacet(address(wsxmr), address(verifier));
        vaultFacet = new VaultFacet(address(wsxmr), address(verifier));
        mintFacet = new MintFacet(address(wsxmr), address(verifier));
        burnFacet = new BurnFacet(address(wsxmr), address(verifier));
        liquidationFacet = new LiquidationFacet(address(wsxmr), address(verifier));
        yieldFacet = new BnbYieldFacet(address(wsxmr), address(verifier));

        hub.registerFacets(
            address(vaultFacet),
            address(mintFacet),
            address(burnFacet),
            address(liquidationFacet),
            address(yieldFacet),
            address(oracleFacet)
        );
        coLPFacet = new CoLPFacet(address(wsxmr), address(verifier));
        hub.addFacet(address(coLPFacet));
        wsxmr.setHub(address(hub));

        // collateralToken = stataQQQB shares, underlying = QQQB,
        // swapRouter = PCS Smart Router, xmrPerpIndex set so the shared
        // precompile leg reads the etched mocks (production BNB uses
        // RedStone calldata instead — see DeployBnb.s.sol which passes 0).
        hub.setExternalAddresses(
            address(stata),
            BnbAddresses.QQQB,
            BnbAddresses.PCS_SMART_ROUTER,
            XMR_PERP_INDEX // hub stores index+1 internally
        );

        hub.setCollateralTwapConfig(
            BnbAddresses.QQQB_WBNB_POOL,
            BnbAddresses.WBNB_USDT_POOL,
            BnbAddresses.WBNB,
            BnbAddresses.USDT,
            BnbAddresses.COLLATERAL_TWAP_WINDOW
        );

        // Create the wsXMR/QQQB fee-500 pool on the real PCS V3 factory
        address token0 = BnbAddresses.QQQB < address(wsxmr) ? BnbAddresses.QQQB : address(wsxmr);
        address token1 = BnbAddresses.QQQB < address(wsxmr) ? address(wsxmr) : BnbAddresses.QQQB;
        pool = IUniswapV3Factory(BnbAddresses.PCS_V3_FACTORY)
            .getPool(token0, token1, BnbAddresses.WSXMR_POOL_FEE);
        if (pool == address(0)) {
            pool = IUniswapV3Factory(BnbAddresses.PCS_V3_FACTORY)
                .createPool(token0, token1, BnbAddresses.WSXMR_POOL_FEE);
        }

        router = new wsXMRLiquidityRouter(
            address(hub),
            BnbAddresses.PCS_V3_POSITION_MANAGER,
            BnbAddresses.QQQB, // router's "sDAI" quote token is QQQB on BNB
            address(wsxmr),
            pool
        );
        hub.setLiquidityRouter(address(router));
    }

    /// @dev Initialize the pool at the oracle prices. initializePoolWithPrice
    ///      is onlyDiamond → prank as hub.
    function _initializePool() internal {
        uint256 collateralPrice = _collateralPrice18();
        vm.prank(address(hub));
        router.initializePoolWithPrice(XMR_PRICE_8DEC * 1e10, collateralPrice);
    }

    // ========== MOCK TWAP POOLS (controllable collateral price) ==========

    /// @dev Swap the collateral TWAP legs from the real PCS pools to
    ///      MockTwapPool instances at tick 0 each — both legs quote exactly
    ///      1e18, so the pinned collateral price is EXACTLY $1.00 (wei-exact,
    ///      unlike tick-approximated values). Reproduces the HyperEVM suite's
    ///      USDe unit-of-account semantics; crank via _setCollateralPrice8dec.
    function _useMockTwapPools() internal {
        collateralTwapMock = new MockTwapPool(0);
        quoteTwapMock = new MockTwapPool(0);
        hub.setCollateralTwapConfig(
            address(collateralTwapMock),
            address(quoteTwapMock),
            BnbAddresses.WBNB,
            BnbAddresses.USDT,
            BnbAddresses.COLLATERAL_TWAP_WINDOW
        );
    }

    /// @dev Set the mocked collateral USD price (8-decimal storage format).
    ///      Requires _useMockTwapPools() to have run; the price keeps
    ///      refreshing (fresh timestamp) on every protocol entry point.
    ///      With the quote leg at tick 0 (pxB = 1e18), collateral_8dec =
    ///      pxA × 1e18 / 1e28 → pxA target = price8dec × 1e10. Tick
    ///      granularity makes non-$1 targets approximate (~1bp steps).
    function _setCollateralPrice8dec(uint256 price8dec) internal {
        if (price8dec == 1e8) {
            collateralTwapMock.setTick(0); // exact $1: pxA = 1e18
        } else {
            uint256 pxA = price8dec * 1e10; // QQQB-in-WBNB, 1e18 scale
            collateralTwapMock.setTick(_tickForQuoteE18(pxA, BnbAddresses.QQQB, BnbAddresses.WBNB));
        }
        _refreshCollateral();
    }

    /// @dev Tick whose getQuoteAtTick returns `quoteE18` units (1e18-scaled) of
    ///      `quoteToken` per 1e18 of `baseToken`. Mirrors _quoteAtTick ordering.
    function _tickForQuoteE18(uint256 quoteE18, address baseToken, address quoteToken)
        internal
        pure
        returns (int24)
    {
        // quoteE18 = price*1e18 when base<quote (price = 1.0001^tick), else
        // quoteE18 = 1e18/price → sqrtX96 = sqrt(price) * 2^96
        uint256 sqrtX96 = baseToken < quoteToken
            ? Math.sqrt(quoteE18) * (uint256(1) << 96) / 1e9
            : 1e9 * (uint256(1) << 96) / Math.sqrt(quoteE18);
        return TickMath.getTickAtSqrtRatio(uint160(sqrtX96));
    }

    // ========== HELPERS (HyperEVMTestBase parity) ==========

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
        BnbOracleFacet(address(hub)).refreshPrices();
    }

    /// @dev Refresh collateral price from the configured TWAP legs.
    function _refreshCollateral() internal {
        BnbOracleFacet(address(hub)).refreshCollateralPrice();
    }

    /// @dev Current collateral price (18-dec) as the hub would read it.
    ///      Reads storage directly — view calls can't traverse the hub
    ///      fallback (TSTORE fails in STATICCALL, by design).
    function _collateralPrice18() internal view returns (uint256) {
        return uint256(uint192(hub.lastCollateralPrice())) * 1e10;
    }

    /// @dev Give an address QQQB (the deposit/underlying asset). stdstore
    ///      deal() works on the beacon proxy — verified on the BSC fork.
    function _dealUSDe(address to, uint256 amount) internal {
        deal(USDE, to, amount);
    }

    /// @dev Same helper under a BNB-accurate name.
    function _dealQQQB(address to, uint256 amount) internal {
        deal(BnbAddresses.QQQB, to, amount);
    }

    /// @dev Give an address stataQQQB shares by dealing QQQB and depositing
    ///      through the adapter. Returns shares received.
    function _dealShares(address to, uint256 qqqbAmount) internal returns (uint256 shares) {
        deal(BnbAddresses.QQQB, to, qqqbAmount);
        vm.startPrank(to);
        IERC20(BnbAddresses.QQQB).approve(address(stata), qqqbAmount);
        shares = stata.deposit(qqqbAmount, to);
        vm.stopPrank();
    }

    /// @dev LP creates a vault and deposits `qqqbAmount` QQQB as collateral.
    function _lpVaultWithCollateral(address lpAddr, uint256 qqqbAmount) internal {
        deal(BnbAddresses.QQQB, lpAddr, qqqbAmount);
        vm.startPrank(lpAddr);
        VaultFacet(address(hub)).createVault();
        IERC20(BnbAddresses.QQQB).approve(address(hub), qqqbAmount);
        VaultFacet(address(hub)).depositCollateral(qqqbAmount);
        vm.stopPrank();
    }
}

/**
 * @title BnbMockTestBase
 * @notice BnbTestBase with the collateral TWAP legs pointed at MockTwapPool
 *         instances pinned at $1 — reproduces the $1-collateral semantics the
 *         HyperEVM-ported suites assume. Crank via _setCollateralPrice8dec.
 */
abstract contract BnbMockTestBase is BnbTestBase {
    function setUp() public virtual override {
        super.setUp();
        _useMockTwapPools();
        _setCollateralPrice8dec(1e8); // $1.00 collateral, matching USDe semantics
    }
}
