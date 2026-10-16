// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";
import {BaseOracleFacet} from "../contracts/facets/BaseOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
import {CoLPFacet} from "../contracts/facets/CoLPFacet.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {StataQQQB} from "../contracts/StataQQQB.sol";
import {StataCbBTC} from "../contracts/StataCbBTC.sol";
import {MockL1Read} from "../contracts/mocks/MockL1Read.sol";
import {MockTwapPool} from "../contracts/mocks/MockTwapPool.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockVerifierProxy} from "./HyperEVMTestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Factory} from "../contracts/interfaces/external/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../contracts/interfaces/external/IUniswapV3Pool.sol";
import {TickMath} from "../contracts/libraries/TickMath.sol";
import {BaseAddresses} from "../contracts/BaseAddresses.sol";

/// @notice Common surface of the collateral share adapters (StataCbBTC on the
///         real fork, StataQQQB over an 18-dec mock in mock mode).
interface IStataAdapter is IERC20 {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function convertToShares(uint256 assets) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

/**
 * @title BaseTestBase
 * @notice Shared setUp for the Base fork test suite — mirrors
 *         HyperEVMTestBase/BnbTestBase so tests port with minimal changes.
 * @dev    Forks Base mainnet and deploys the WrapSynth stack against REAL
 *         mainnet state:
 *
 *           - cbBTC collateral (Coinbase Wrapped BTC, 8 decimals) +
 *             StataCbBTC adapter scaling shares to 18 decimals
 *           - XMR price leg identical to HyperEVM: MockL1Read etched on the
 *             same precompile addresses + xmrPerpIndex set (mockOracle/
 *             mockMark.setPrice work verbatim)
 *           - collateral price: REAL UniV3 cbBTC/USDC TWAP by default
 *             (BaseFork suite); ported suites use BaseMockTestBase, which
 *             uses an 18-decimal MockERC20 underlying + a 1:1 adapter and
 *             disables the TWAP leg — the precompile XMR leg then pins
 *             collateral to EXACTLY $1 with a fresh timestamp on every call
 *             (identical semantics to HyperEVM's USDe pin)
 *           - wsXMR/collateral UniV3 pool (fee 500, tick spacing 10) created
 *             on the real Uniswap V3 factory; router self-derives fee/spacing
 *
 *         Aliases (USDE, HYPERSWAP_*, XMR_PERP_INDEX) exist purely so ported
 *         tests keep their original identifiers. USDE is an instance var (not
 *         constant) because the mock underlying is deployed per-test.
 */
abstract contract BaseTestBase is Test {
    using stdStorage for StdStorage;

    // ========== BASE MAINNET ADDRESSES / PORTING ALIASES ==========
    address constant HYPERSWAP_ROUTER = BaseAddresses.UNI_SWAP_ROUTER;
    address constant HYPERSWAP_NFPM = BaseAddresses.UNI_V3_POSITION_MANAGER;
    address constant HYPERSWAP_FACTORY = BaseAddresses.UNI_V3_FACTORY;

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

    /// @notice Collateral underlying — real cbBTC on the fork base, an 18-dec
    ///         MockERC20 under BaseMockTestBase. Named USDE so ported tests
    ///         keep their deal()/IERC20() references.
    address public USDE;

    // ========== DEPLOYED CONTRACTS ==========
    wsXMR public wsxmr;
    wsXmrHub public hub;
    IStataAdapter public stata; // collateral share token (the sDAI analogue)
    MockVerifierProxy public verifier;
    wsXMRLiquidityRouter public router;
    address public pool;

    BaseOracleFacet public oracleFacet;
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

    // Mock TWAP pool (only wired into the hub when cranking collateral price)
    MockTwapPool public collateralTwapMock;

    function setUp() public virtual {
        string memory rpcUrl = vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"));
        uint256 forkBlock = vm.envOr("BASE_FORK_BLOCK", uint256(0));
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

    /// @dev Underlying collateral token for this deployment. Mock bases
    ///      override to return a fresh 18-decimal MockERC20.
    function _resolveUnderlying() internal virtual returns (address) {
        return BaseAddresses.CBBTC;
    }

    // ========== SETUP INTERNALS ==========

    /// @dev Etch MockL1Read runtime code onto the three L1-read precompile
    ///      addresses — identical trick to HyperEVMTestBase so the shared
    ///      precompile oracle leg works on the Base fork.
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

        USDE = _resolveUnderlying();
        uint8 underlyingDec = MockERC20(USDE).decimals();
        stata = IStataAdapter(
            underlyingDec == 8
                ? address(new StataCbBTC(USDE))
                : address(new StataQQQB(USDE))
        );

        oracleFacet = new BaseOracleFacet(address(wsxmr), address(verifier));
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
        coLPFacet = new CoLPFacet(address(wsxmr), address(verifier));
        hub.addFacet(address(coLPFacet));
        wsxmr.setHub(address(hub));

        // collateralToken = stata shares, underlying = USDE (cbBTC or mock),
        // swapRouter = UniV3 SwapRouter02, xmrPerpIndex set so the shared
        // precompile leg reads the etched mocks (production Base uses
        // RedStone calldata instead — see DeployBase.s.sol which passes 0).
        hub.setExternalAddresses(
            address(stata),
            USDE,
            BaseAddresses.UNI_SWAP_ROUTER,
            XMR_PERP_INDEX // hub stores index+1 internally
        );

        // Single-leg TWAP: collateral/USDC pool quotes USD directly → quote
        // pool = 0. Mock bases reconfigure or disable this in setUp.
        hub.setCollateralTwapConfig(
            BaseAddresses.CBBTC_USDC_POOL,
            address(0),
            BaseAddresses.USDC,
            BaseAddresses.USDC,
            BaseAddresses.COLLATERAL_TWAP_WINDOW
        );

        // Create the wsXMR/USDE fee-500 pool on the real UniV3 factory
        address token0 = USDE < address(wsxmr) ? USDE : address(wsxmr);
        address token1 = USDE < address(wsxmr) ? address(wsxmr) : USDE;
        pool = IUniswapV3Factory(BaseAddresses.UNI_V3_FACTORY)
            .getPool(token0, token1, BaseAddresses.WSXMR_POOL_FEE);
        if (pool == address(0)) {
            pool = IUniswapV3Factory(BaseAddresses.UNI_V3_FACTORY)
                .createPool(token0, token1, BaseAddresses.WSXMR_POOL_FEE);
        }

        router = new wsXMRLiquidityRouter(
            address(hub),
            BaseAddresses.UNI_V3_POSITION_MANAGER,
            USDE, // router's "sDAI" quote token is the collateral underlying
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

    // ========== MOCK TWAP / COLLATERAL PRICE CONTROL ==========

    /// @dev Disable the TWAP leg entirely — the precompile XMR leg then pins
    ///      collateralPrice = exactly 1e8 with a fresh timestamp inside every
    ///      _tryRefreshOracle (the HyperEVM suite's exact $1 semantics).
    ///      Collateral cranks re-attach a MockTwapPool; see
    ///      _setCollateralPrice8dec.
    function _useMockTwapPools() internal {
        collateralTwapMock = new MockTwapPool(0);
        hub.setCollateralTwapConfig(address(0), address(0), address(0), address(0), 0);
        _refreshOracle();
    }

    /// @dev Set the collateral USD price (8-decimal storage format).
    ///      $1 (1e8) disables the TWAP leg → the precompile pin is EXACT.
    ///      Other values attach the mock pool: pxA_raw target =
    ///      price8dec × 10^(usdDec − collateralDec) — for the 18-dec mock
    ///      underlying vs 6-dec USDC that's price8dec × 1e-12 × 1e10 =
    ///      price8dec / 100. Tick granularity → ~1bp approximation.
    function _setCollateralPrice8dec(uint256 price8dec) internal {
        if (price8dec == 1e8) {
            hub.setCollateralTwapConfig(address(0), address(0), address(0), address(0), 0);
            _refreshOracle();
            return;
        }
        if (address(collateralTwapMock) == address(0)) {
            collateralTwapMock = new MockTwapPool(0);
        }
        uint8 decU = MockERC20(USDE).decimals();
        // result8dec = legA18 × 1e18 / 1e28 and
        // legA18 = pxA_raw × 10^decU / 10^6 (USDC), so
        // pxA_raw = price8dec × 10^(16 − decU). Written as mul/div to stay
        // valid when the mock underlying has decU > 16 (e.g. 18).
        uint256 pxA = (price8dec * 1e16) / (10 ** decU);
        collateralTwapMock.setTick(_tickForQuoteE18(pxA, USDE, BaseAddresses.USDC));
        hub.setCollateralTwapConfig(
            address(collateralTwapMock),
            address(0),
            BaseAddresses.USDC,
            BaseAddresses.USDC,
            BaseAddresses.COLLATERAL_TWAP_WINDOW
        );
        _refreshOracle();
    }

    /// @dev Tick whose getQuoteAtTick returns `quoteE18` units (1e18-scaled) of
    ///      `quoteToken` per 1e18 of `baseToken`. Mirrors _quoteAtTick ordering.
    function _tickForQuoteE18(uint256 quoteE18, address baseToken, address quoteToken)
        internal
        pure
        returns (int24)
    {
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
        BaseOracleFacet(address(hub)).refreshPrices();
    }

    /// @dev Refresh collateral price from the configured TWAP leg.
    function _refreshCollateral() internal {
        BaseOracleFacet(address(hub)).refreshCollateralPrice();
    }

    /// @dev Current collateral price (18-dec) as the hub would read it.
    ///      Reads storage directly — view calls can't traverse the hub
    ///      fallback (TSTORE fails in STATICCALL, by design).
    function _collateralPrice18() internal view returns (uint256) {
        return uint256(uint192(hub.lastCollateralPrice())) * 1e10;
    }

    /// @dev Give an address collateral underlying.
    function _dealUSDe(address to, uint256 amount) internal {
        deal(USDE, to, amount);
    }

    /// @dev Same helper under a Base-accurate name.
    function _dealCbBTC(address to, uint256 amount) internal {
        deal(USDE, to, amount);
    }

    /// @dev Give an address stata shares by dealing underlying and depositing
    ///      through the adapter. Returns shares received.
    function _dealShares(address to, uint256 underlyingAmount) internal returns (uint256 shares) {
        deal(USDE, to, underlyingAmount);
        vm.startPrank(to);
        IERC20(USDE).approve(address(stata), underlyingAmount);
        shares = stata.deposit(underlyingAmount, to);
        vm.stopPrank();
    }

    /// @dev LP creates a vault and deposits `amount` underlying as collateral.
    function _lpVaultWithCollateral(address lpAddr, uint256 amount) internal {
        deal(USDE, lpAddr, amount);
        vm.startPrank(lpAddr);
        VaultFacet(address(hub)).createVault();
        IERC20(USDE).approve(address(hub), amount);
        VaultFacet(address(hub)).depositCollateral(amount);
        vm.stopPrank();
    }
}

/**
 * @title BaseMockTestBase
 * @notice BaseTestBase with an 18-decimal MockERC20 underlying and the TWAP
 *         leg disabled — the precompile pin then holds collateral at EXACTLY
 *         $1, reproducing the $1-collateral semantics the ported suites
 *         assume. Crank via _setCollateralPrice8dec.
 */
abstract contract BaseMockTestBase is BaseTestBase {
    function _resolveUnderlying() internal override returns (address) {
        return address(new MockERC20("Mock Collateral", "mCOLL", 18));
    }

    function setUp() public virtual override {
        super.setUp();
        _useMockTwapPools();
    }
}
