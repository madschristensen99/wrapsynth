// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationAuctionFacet} from "../contracts/facets/LiquidationAuctionFacet.sol";
import {CoLPFacet} from "../contracts/facets/CoLPFacet.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {MockVerifierProxy} from "../contracts/mocks/MockVerifierProxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Factory} from "../contracts/interfaces/external/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../contracts/interfaces/external/IUniswapV3Pool.sol";
import {RobinhoodAddresses} from "../contracts/RobinhoodAddresses.sol";

/**
 * @title RobinhoodTestBase
 * @notice Shared setUp for the Robinhood Chain fork test suite — oracle-free protocol.
 * @dev    Forks Robinhood Chain mainnet and deploys the WrapSynth stack
 *         against REAL mainnet state:
 *
 *           - SPY collateral (Robinhood tokenized S&P 500, 18 decimals) held
 *             RAW by the hub — no share adapter, no yield layer
 *           - NO oracle of any kind: no RedStone, no Pyth, no precompiles,
 *             no TWAP. Vaults declare thresholdSharesPerWsxmr (normalized
 *             collateral per 1e8 wsXMR) which is the mint bound, the
 *             self-declared solvency line, and the par-settlement rate.
 *           - wsXMR/SPY UniV3 pool (fee 500, tick spacing 10) created on the
 *             real Uniswap V3 factory; router self-derives fee/spacing
 *
 *         RobinhoodMockTestBase swaps SPY for an 18-decimal MockERC20 so
 *         ported tests keep exact-integer collateral math.
 *
 *         Name aliases (USDE, HYPERSWAP_*) exist purely so ported tests keep
 *         their original identifiers.
 */
abstract contract RobinhoodTestBase is Test {

    // ========== ROBINHOOD MAINNET ADDRESSES / PORTING ALIASES ==========
    address constant HYPERSWAP_ROUTER = RobinhoodAddresses.UNI_SWAP_ROUTER;
    address constant HYPERSWAP_NFPM = RobinhoodAddresses.UNI_V3_POSITION_MANAGER;
    address constant HYPERSWAP_FACTORY = RobinhoodAddresses.UNI_V3_FACTORY;

    // ========== THRESHOLD / POOL-PRICE CONVENTION ==========
    // Thresholds are NORMALIZED collateral units (18-dec) per 1e8 wsXMR.
    // XMR_PRICE_8DEC survives only as a pool-initialization price input —
    // it never reaches consensus.
    uint256 constant XMR_PRICE_8DEC = 390_00000000; // $390 display/pool-init convention

    /// @notice Deployment floors passed to every facet/storage constructor.
    uint256 constant MIN_THRESHOLD = 1e18;     // 1 normalized collateral unit per 1e8 wsXMR
    uint256 constant KICK_BOND_MIN = 1e15;     // absolute kick bond floor (normalized)

    /// @notice Convenience threshold for the mock base: collateral treated as
    ///         ~$1 and XMR as ~$390 → 150% coverage ≈ 585 units per wsXMR.
    uint256 constant THRESHOLD_150 = 585e18;
    uint256 constant THRESHOLD_120 = 468e18;
    uint256 constant THRESHOLD_200 = 780e18;

    address public deployer;
    address public lp;
    address public user;

    /// @notice Collateral token — real SPY on the fork base, an 18-dec
    ///         MockERC20 under RobinhoodMockTestBase. Named USDE so ported
    ///         tests keep their deal()/IERC20() references.
    address public USDE;

    // ========== DEPLOYED CONTRACTS ==========
    wsXMR public wsxmr;
    wsXmrHub public hub;
    MockVerifierProxy public verifier;
    wsXMRLiquidityRouter public router;
    address public pool;

    VaultFacet public vaultFacet;
    MintFacet public mintFacet;
    BurnFacet public burnFacet;
    LiquidationAuctionFacet public liquidationAuctionFacet;
    CoLPFacet public coLPFacet;

    function setUp() public virtual {
        string memory rpcUrl = vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        uint256 forkBlock = vm.envOr("ROBINHOOD_FORK_BLOCK", uint256(0));
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

        _deployStack();
    }

    /// @dev Underlying collateral token for this deployment. Mock bases
    ///      override to return a fresh 18-decimal MockERC20.
    function _resolveUnderlying() internal virtual returns (address) {
        return RobinhoodAddresses.SPY;
    }

    // ========== SETUP INTERNALS ==========

    function _deployStack() internal {
        verifier = new MockVerifierProxy();
        wsxmr = new wsXMR();
        hub = new wsXmrHub(address(wsxmr), address(verifier), MIN_THRESHOLD, KICK_BOND_MIN);

        USDE = _resolveUnderlying();

        vaultFacet = new VaultFacet(address(wsxmr), address(verifier), MIN_THRESHOLD, KICK_BOND_MIN);
        mintFacet = new MintFacet(address(wsxmr), address(verifier), MIN_THRESHOLD, KICK_BOND_MIN);
        burnFacet = new BurnFacet(address(wsxmr), address(verifier), MIN_THRESHOLD, KICK_BOND_MIN);
        liquidationAuctionFacet = new LiquidationAuctionFacet(address(wsxmr), address(verifier), MIN_THRESHOLD, KICK_BOND_MIN);
        coLPFacet = new CoLPFacet(address(wsxmr), address(verifier), MIN_THRESHOLD, KICK_BOND_MIN);

        hub.registerFacets(
            address(vaultFacet),
            address(mintFacet),
            address(burnFacet),
            address(liquidationAuctionFacet),
            address(coLPFacet)
        );
        wsxmr.setHub(address(hub));

        // Collateral is the raw underlying ERC-20 — no share adapter, no
        // underlying indirection. collateralScale normalizes to 18-dec.
        hub.setExternalAddresses(USDE);

        // Create the wsXMR/SPY fee-500 pool on the real UniV3 factory
        address token0 = USDE < address(wsxmr) ? USDE : address(wsxmr);
        address token1 = USDE < address(wsxmr) ? address(wsxmr) : USDE;
        pool = IUniswapV3Factory(RobinhoodAddresses.UNI_V3_FACTORY)
            .getPool(token0, token1, RobinhoodAddresses.WSXMR_POOL_FEE);
        if (pool == address(0)) {
            pool = IUniswapV3Factory(RobinhoodAddresses.UNI_V3_FACTORY)
                .createPool(token0, token1, RobinhoodAddresses.WSXMR_POOL_FEE);
        }

        router = new wsXMRLiquidityRouter(
            address(hub),
            RobinhoodAddresses.UNI_V3_POSITION_MANAGER,
            USDE, // router's "sDAI" quote token is the collateral token
            address(wsxmr),
            pool
        );
        hub.setLiquidityRouter(address(router));
    }

    /// @dev Initialize the pool at a caller-supplied price (deploy-time input,
    ///      not consensus). initializePoolWithPrice is onlyDiamond → prank hub.
    function _initializePool() internal {
        _initializePoolAt(XMR_PRICE_8DEC * 1e10, 1e18);
    }

    function _initializePoolAt(uint256 xmrPriceE18, uint256 collateralPriceE18) internal {
        vm.prank(address(hub));
        router.initializePoolWithPrice(xmrPriceE18, collateralPriceE18);
    }

    // ========== HELPERS (shared parity) ==========

    /// @dev Give an address collateral tokens (raw underlying).
    function _dealUSDe(address to, uint256 amount) internal {
        deal(USDE, to, amount);
    }

    /// @dev Same helper under a Robinhood-accurate name.
    function _dealSPY(address to, uint256 amount) internal {
        deal(USDE, to, amount);
    }

    /// @dev LP creates a vault, deposits `amount` raw collateral, and leaves
    ///      the threshold at the deployment default (minThreshold).
    function _lpVaultWithCollateral(address lpAddr, uint256 amount) internal {
        _lpVaultWithThreshold(lpAddr, amount, MIN_THRESHOLD);
    }

    /// @dev LP creates a vault, deposits `amount` raw collateral, and sets a
    ///      declared threshold (normalized collateral per 1e8 wsXMR).
    function _lpVaultWithThreshold(address lpAddr, uint256 amount, uint256 threshold) internal {
        deal(USDE, lpAddr, amount);
        vm.startPrank(lpAddr);
        VaultFacet(address(hub)).createVault();
        IERC20(USDE).approve(address(hub), amount);
        VaultFacet(address(hub)).depositCollateral(amount);
        VaultFacet(address(hub)).setThreshold(threshold);
        vm.stopPrank();
    }

    /// @dev Set a vault's threshold as the LP.
    function _setThreshold(address lpAddr, uint256 threshold) internal {
        vm.prank(lpAddr);
        VaultFacet(address(hub)).setThreshold(threshold);
    }

    /// @dev Threshold-derived mint capacity bound: normalized collateral
    ///      required for `wsxmr` debt at `threshold`.
    function _requiredFor(uint256 wsxmrAmount, uint256 threshold) internal pure returns (uint256) {
        return (wsxmrAmount * threshold) / 1e8;
    }

    /// @dev Par-value lock = wsxmr × threshold × 1.1 (MINT_LOCK_RATIO).
    function _parLock(uint256 wsxmrAmount, uint256 threshold) internal pure returns (uint256) {
        return (wsxmrAmount * threshold * 110) / (1e8 * 100);
    }

    // ========== KICK / AUCTION HELPERS ==========

    /// @dev Post a kick bond for `kicker` (deals + approves + kicks).
    ///      getKickBond rides the hub fallback (TSTORE) so it must go through
    ///      a non-static low-level call.
    function _kickVault(address kicker, address lpVault) internal returns (uint256 bond) {
        (bool ok, bytes memory res) = address(hub).call(
            abi.encodeWithSelector(LiquidationAuctionFacet.getKickBond.selector, lpVault)
        );
        require(ok, "getKickBond failed");
        bond = abi.decode(res, (uint256));
        uint256 bondRaw = bond / hub.collateralScale();
        deal(USDE, kicker, bondRaw);
        vm.startPrank(kicker);
        IERC20(USDE).approve(address(hub), bondRaw);
        LiquidationAuctionFacet(address(hub)).kick(lpVault);
        vm.stopPrank();
    }

    /// @dev Advance `n` blocks (kick phases are block-based, not timestamp).
    function _advanceBlocks(uint256 n) internal {
        vm.roll(block.number + n);
    }
}

/**
 * @title RobinhoodMockTestBase
 * @notice RobinhoodTestBase with an 18-decimal MockERC20 collateral so ported
 *         tests keep exact-integer math (collateralScale = 1 → raw == norm).
 */
abstract contract RobinhoodMockTestBase is RobinhoodTestBase {
    /// @dev Ported tests reference `stata` (the old share adapter). With raw
    ///      18-dec collateral, shares are identity → alias USDE so
    ///      balanceOf/approve/totalSupply call sites work verbatim.
    IERC20 public stata;

    function setUp() public virtual override {
        super.setUp();
        stata = IERC20(USDE);
    }

    function _resolveUnderlying() internal override returns (address) {
        return address(new MockERC20("Mock Collateral", "mCOLL", 18));
    }

    /// @dev shares == raw on the 18-dec mock collateral.
    function _dealShares(address to, uint256 amount) internal returns (uint256) {
        deal(USDE, to, amount);
        return amount;
    }
}
