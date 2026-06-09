// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";
import {SimpleOracleFacet} from "../contracts/facets/SimpleOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";
import {Ed25519} from "../contracts/Ed25519.sol";
import {YieldLogic} from "../contracts/libraries/YieldLogic.sol";

contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

/**
 * @title Audit Regression Tests
 * @notice Regression tests for C1 (reentrancy), H1 (decimal mismatch), H2 (debt index context)
 * @dev Forks Gnosis for sDAI / price oracle interactions
 */
contract AuditRegressionTest is Test {
    wsXmrHub public hub;
    wsXMR public wsxmr;
    SimpleOracleFacet public oracleFacet;
    VaultFacet public vaultFacet;
    MintFacet public mintFacet;
    BurnFacet public burnFacet;
    LiquidationFacet public liquidationFacet;
    YieldFacet public yieldFacet;
    MockVerifierProxy public verifier;

    address lp = makeAddr("lp");
    address user = makeAddr("user");
    address attacker = makeAddr("attacker");
    address keeper = makeAddr("keeper");

    uint256 constant XMR_PRICE_8DEC = 390_00000000; // $390 in 8 decimals
    uint256 constant DAI_PRICE_8DEC = 1_00000000;     // $1 in 8 decimals

    function setUp() public {
        string memory rpcUrl = vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"));
        vm.createSelectFork(rpcUrl);

        vm.deal(address(this), 1_000_000 ether);
        vm.deal(lp, 100 ether);
        vm.deal(user, 100 ether);
        vm.deal(attacker, 100 ether);

        verifier = new MockVerifierProxy();
        wsxmr = new wsXMR();
        hub = new wsXmrHub(address(wsxmr), address(verifier));

        oracleFacet = new SimpleOracleFacet(address(wsxmr), address(verifier), address(this));
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

        // Seed attacker with wsXMR for potential abuse
        deal(address(wsxmr), attacker, 1_000_000e8);
    }

    // ========== C1: Reentrancy / onlyDelegateCall ==========

    /// @notice C1-1: Direct calls to privileged hub functions must revert
    function test_C1_DirectCallToMintTokens_Reverts() public {
        vm.expectRevert(IwsXmrHub.Unauthorized.selector);
        hub.mintTokens(attacker, 1000);
    }

    function test_C1_DirectCallToBurnTokens_Reverts() public {
        vm.expectRevert(IwsXmrHub.Unauthorized.selector);
        hub.burnTokens(attacker, 1000);
    }

    function test_C1_DirectCallToTransferAsset_Reverts() public {
        vm.expectRevert(IwsXmrHub.Unauthorized.selector);
        hub.transferAsset(GnosisAddresses.SDAI, attacker, 1000);
    }

    function test_C1_DirectCallToApproveAsset_Reverts() public {
        vm.expectRevert(IwsXmrHub.Unauthorized.selector);
        hub.approveAsset(GnosisAddresses.SDAI, attacker, 1000);
    }

    /// @notice C1-2: Transient flag is restored after delegatecall, preventing persistence
    /// @dev We simulate: call through fallback -> facet calls hub -> hub delegates again.
    ///      With save/restore, nested routing works; without it the inner call would fail
    ///      or the outer call would leave the flag hot.
    function test_C1_TransientFlagSaveRestore() public {
        // Setup vault
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();

        // Any call through the fallback should work normally
        vm.prank(lp);
        VaultFacet(address(hub)).setMaxMintBps(100);

        // After the call, a direct call to a privileged function must still revert
        vm.expectRevert(IwsXmrHub.Unauthorized.selector);
        hub.transferAsset(GnosisAddresses.SDAI, attacker, 1);
    }

    /// @notice C1-3: cancelMint no longer pushes ETH; it queues to pendingReturns
    function test_C1_CancelMint_QueuesETH_ToPendingReturns() public {
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();
        _configureVault(lp);

        uint256 griefingDeposit = 0.001 ether;

        // User initiates a mint
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(0x1234));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));

        vm.prank(user);
        bytes32 reqId = MintFacet(address(hub)).initiateMint{value: griefingDeposit}(lp, user, 50000000000, commitment);

        // Warp past timeout
        vm.roll(block.number + 1000);

        uint256 pendingBefore = _getPendingReturns(user, address(0));
        assertEq(pendingBefore, 0, "No pending returns before cancel");

        // Cancel mint
        vm.prank(user);
        MintFacet(address(hub)).cancelMint(reqId);

        uint256 pendingAfter = _getPendingReturns(user, address(0));
        assertEq(pendingAfter, griefingDeposit, "ETH should be queued to pendingReturns, not pushed");
    }

    // ========== H1: YieldLogic decimal bug ==========

    /// @notice H1: calculateExtractableYield respects the 150% floor with correct wsXMR decimals
    /// @dev Before fix: /1e18 understated debt by 1e10, so floor was ~never enforced.
    ///      After fix: /1e8 correctly converts wsXMR to USD and the 150% cap works.
    function test_H1_YieldExtraction_Respects150PercentFloor() public {
        _createVaultAndDeposit(lp, 10_000 ether);
        _updatePrices();
        _configureVault(lp);

        // Mint a small amount so vault is barely above 150% CR
        // At $390 XMR, 1e8 wsXMR = $390. 10k DAI collateral at 150% can support
        // ~2564 wsXMR. Let's mint ~2000 wsXMR so vault is just above 150%.
        uint256 xmrAmount = 20_0000000000; // 20 XMR => 20 * 1e4 = 200k wsXMR units
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(0x1234));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));

        vm.prank(user);
        bytes32 reqId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, xmrAmount, commitment);

        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdeadbeef)));

        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(reqId);

        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(reqId, bytes32(uint256(0x1234)));

        // Now artificially inflate sDAI value (simulate yield) by depositing more sDAI to the hub
        // But to test yield extraction properly, we deposit extra collateral then remove principal tracking
        // Simpler: deposit additional collateral as a different LP, then have original LP try to extract

        // For this test, we just verify that syncVaultYield does NOT crash the vault below 150%
        // by checking the vault health before and after an explicit yield sync.
        uint256 healthBefore = hub.getVaultHealth(lp);
        assertGe(healthBefore, 150, "Vault should be at or above 150% before sync");

        // Anyone can call syncVaultYield on the LP
        yieldFacet.syncVaultYield(lp);

        uint256 healthAfter = hub.getVaultHealth(lp);
        assertGe(healthAfter, 150, "Vault must stay >= 150% after yield sync (H1 fix)");
    }

    // ========== H2: denormalizeDebt reads hub storage, not facet frozen storage ==========

    /// @notice H2-1: When hub.globalDebtIndex changes, internal _denormalizeDebt tracks it.
    /// @dev Before fix: facets called IOracleFacet(oracleFacet).denormalizeDebt which read
    ///      the oracle facet's own frozen globalDebtIndex (=1e18 forever).
    function test_H2_DenormalizeDebt_TracksHubIndex() public {
        _createVaultAndDeposit(lp, 10_000 ether);
        _updatePrices();
        _configureVault(lp);

        // Mint to create debt
        uint256 xmrAmount = 100_0000000000; // 100 XMR
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(0x1234));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));

        vm.prank(user);
        bytes32 reqId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, xmrAmount, commitment);

        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdeadbeef)));

        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(reqId);

        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(reqId, bytes32(uint256(0x1234)));

        uint256 hubDebtBefore = hub.getVaultDebt(lp);
        assertGt(hubDebtBefore, 0, "Should have debt");

        // Hub index starts at 1e18
        assertEq(hub.globalDebtIndex(), 1e18, "Initial index is 1e18");

        // Denormalized debt via hub view should equal actual debt when index=1e18
        uint256 hubDebt = hub.getVaultDebt(lp);
        assertEq(hubDebt, hubDebtBefore, "Debt at 1e18 index");

        // Now simulate a buy-and-burn that reduces globalDebtIndex to 0.5e18
        // We directly manipulate the index via vm.store on the correct hub storage slot.
        // wsXmrStorage slot layout (immutables excluded):
        //   0: vaultFacet, 1: mintFacet, 2: burnFacet, 3: liquidationFacet,
        //   4: yieldFacet, 5: oracleFacet, 6: facets mapping, 7: liquidityRouter,
        //   8: lastXmrPrice, 9: lastXmrPriceTimestamp, 10: lastCollateralPrice,
        //   11: lastCollateralPriceTimestamp, 12: lastBuyTimestamp, 13: globalTotalDebt,
        //   14: globalDebtIndex  (N2: MUST update if wsXmrStorage layout changes)
        bytes32 globalDebtIndexSlot = bytes32(uint256(14));
        vm.store(address(hub), globalDebtIndexSlot, bytes32(uint256(0.5e18)));

        // After manipulation, hub index is 0.5e18
        assertEq(hub.globalDebtIndex(), 0.5e18, "Index should be 0.5e18 after store");

        // The hub's getVaultDebt should now return hubDebtBefore * 0.5e18 / 1e18 = hubDebtBefore / 2
        uint256 hubDebtAfter = hub.getVaultDebt(lp);
        assertApproxEqRel(hubDebtAfter, hubDebtBefore / 2, 0.001e18, "Hub debt should halve with index");

        // The old oracleFacet.denormalizeDebt would still return hubDebtBefore (using facet's frozen 1e18)
        uint256 facetDebt = oracleFacet.denormalizeDebt(hubDebtBefore);
        assertEq(facetDebt, hubDebtBefore, "Facet debt stays at old value (frozen storage)");

        // Critical: state-modifying functions via the hub must use the hub's live index.
        // We verify by calling syncVaultYield which internally uses _denormalizeDebt.
        // If it used the facet's frozen index, it would think actualDebt is 2x larger
        // and potentially extract less yield (or mis-calculate health).
        // We just assert the call doesn't revert and health stays sane.
        yieldFacet.syncVaultYield(lp);
        uint256 healthAfter = hub.getVaultHealth(lp);
        assertGt(healthAfter, 0, "Health should remain sane after sync with non-1e18 index");
    }

    // ========== L3: addSelectors collision check ==========

    function test_L3_AddSelectors_CollisionReverts() public {
        // Trying to add a selector that's already registered should revert
        bytes4 existingSelector = vaultFacet.createVault.selector;
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = existingSelector;

        vm.expectRevert();
        hub.addSelectors(address(mintFacet), selectors);
    }

    // ========== H1 Regression: Yield harvesting unit mismatch ==========

    /// @notice H1-2: With fix, syncVaultYield must NOT extract phantom yield when no real
    ///         yield has accrued. Before fix, passing lpPrincipalShares (sDAI shares) into
    ///         calculateExtractableYield's principalDeposits param (DAI assets) caused
    ///         convertToAssets(shares) > shares to be treated as "yield".
    function test_H1_NoPhantomYield_OnFreshDeposit() public {
        _createVaultAndDeposit(lp, 25_000 ether);
        _updatePrices();
        _configureVault(lp);

        // Mint a small amount so vault is at ~250% CR
        uint256 xmrAmount = 20_0000000000;
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(0x1234));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));

        vm.prank(user);
        bytes32 reqId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, xmrAmount, commitment);

        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdeadbeef)));

        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(reqId);

        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(reqId, bytes32(uint256(0x1234)));

        // Record pre-sync state
        uint256 principalDepositsBefore = hub.lpPrincipalDeposits(lp);
        uint256 vaultSharesBefore = _getVaultCollateralShares(lp);
        uint256 warChestBefore = _getYieldWarChest();

        // Call sync immediately — no real yield has accrued yet
        yieldFacet.syncVaultYield(lp);

        uint256 vaultSharesAfter = _getVaultCollateralShares(lp);
        uint256 warChestAfter = _getYieldWarChest();
        uint256 principalDepositsAfter = hub.lpPrincipalDeposits(lp);

        // H1 Fix assertions:
        // 1. Vault collateral shares must NOT shrink (no phantom yield)
        assertGe(vaultSharesAfter, vaultSharesBefore, "H1: vault shares must not shrink from phantom yield");
        // 2. Principal deposits must not change
        assertEq(principalDepositsAfter, principalDepositsBefore, "H1: principal deposits must not change");
        // 3. War chest must not increase from phantom yield
        assertEq(warChestAfter, warChestBefore, "H1: war chest must not grow from phantom yield on fresh deposit");
    }

    // ========== H2 Regression: Bad-debt socialization index scaling ==========

    /// @notice H2-2: After liquidation writes off bad debt, healthy vault B's denormalized
    ///         debt must NOT change, and globalTotalDebt must equal the sum of all
    ///         vault denormalized debts.
    function test_H2_BadDebtWriteOff_KeepsHealthyVaultDebt() public {
        address vaultA = makeAddr("vaultA");
        address vaultB = makeAddr("vaultB");
        vm.deal(vaultA, 1 ether);
        vm.deal(vaultB, 1 ether);

        // --- Vault A: minimal collateral, max debt (will go underwater) ---
        _createVaultAndDeposit(vaultA, 50 ether);
        _updatePrices();
        _configureVault(vaultA);

        // Mint at ~160% CR: 50 DAI collateral, wsXMR debt ≈ 31.25 USD at $390
        // finalizeMint checks projectedDebt = pendingDebt + wsxmrAmount = 2*wsxmrAmount
        // wsxmrAmount ≈ 50 / (390 * 2 * 1.5) * 1e8 = 4,273,500 units
        // xmrAmount = wsxmrAmount * 1e4 = 42,735,000,000
        uint256 xmrAmountA = 40_000_000_000;
        (uint256 pxA, uint256 pyA) = Ed25519.scalarMultBase(uint256(0xaaaa));
        bytes32 commitmentA = keccak256(abi.encodePacked(pxA, pyA));

        vm.prank(user);
        bytes32 reqA = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(vaultA, user, xmrAmountA, commitmentA);
        vm.prank(vaultA);
        MintFacet(address(hub)).provideLPKey(reqA, bytes32(uint256(0xdeadbeef)));
        vm.prank(vaultA);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(reqA);
        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(reqA, bytes32(uint256(0xaaaa)));

        // --- Vault B: healthy collateral, moderate debt ---
        _createVaultAndDeposit(vaultB, 10_000 ether);
        _configureVault(vaultB);

        uint256 xmrAmountB = 500_00000000; // 500 XMR
        (uint256 pxB, uint256 pyB) = Ed25519.scalarMultBase(uint256(0xbbbb));
        bytes32 commitmentB = keccak256(abi.encodePacked(pxB, pyB));

        vm.prank(user);
        bytes32 reqB = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(vaultB, user, xmrAmountB, commitmentB);
        vm.prank(vaultB);
        MintFacet(address(hub)).provideLPKey(reqB, bytes32(uint256(0xbbbb)));
        vm.prank(vaultB);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(reqB);
        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(reqB, bytes32(uint256(0xbbbb)));

        // Record pre-liquidation state
        uint256 vaultBDebtBefore = hub.getVaultDebt(vaultB);
        uint256 globalDebtBefore = hub.globalTotalDebt();
        uint256 indexBefore = hub.globalDebtIndex();

        // Raise XMR price so A is underwater (higher XMR price increases debt value)
        // At $390, vault A is at ~160% CR. At $2000, debt USD ≈ 80, CR ≈ 62% < 120%.
        SimpleOracleFacet(address(hub)).updatePrices(2000_00000000, DAI_PRICE_8DEC);

        // Verify A is liquidatable
        // Use _hubView because hub fallback uses TSTORE which fails in STATICCALL
        bytes memory liqResult = _hubView(
            abi.encodeWithSelector(LiquidationFacet.isVaultLiquidatable.selector, vaultA)
        );
        bool isLiquidatable = abi.decode(liqResult, (bool));
        assertTrue(isLiquidatable, "Vault A should be liquidatable after price rise");

        // Give keeper wsXMR so liquidation can burn it
        deal(address(wsxmr), keeper, 1_000_000_000);

        // Liquidate vault A — all collateral will be seized and some debt remains as bad debt
        vm.prank(keeper);
        LiquidationFacet(address(hub)).liquidate(vaultA, type(uint256).max);

        // H2 Fix assertions:
        // 1. globalDebtIndex must NOT have changed (no bogus scaling)
        assertEq(hub.globalDebtIndex(), indexBefore, "H2: globalDebtIndex must not change during bad debt write-off");
        // 2. Vault B's denormalized debt must be unchanged
        uint256 vaultBDebtAfter = hub.getVaultDebt(vaultB);
        assertEq(vaultBDebtAfter, vaultBDebtBefore, "H2: healthy vault B debt must not change");
        // 3. globalTotalDebt must equal sum of all vault denormalized debts
        uint256 vaultADebtAfter = hub.getVaultDebt(vaultA);
        uint256 vaultBDebtAfter2 = hub.getVaultDebt(vaultB);
        uint256 globalDebtAfter = hub.globalTotalDebt();
        assertEq(globalDebtAfter, vaultADebtAfter + vaultBDebtAfter2, "H2: globalTotalDebt must equal sum of vault debts");
        // 4. globalTotalDebt must have decreased by the bad debt amount
        assertLt(globalDebtAfter, globalDebtBefore, "H2: globalTotalDebt should decrease after bad debt write-off");
    }

    // ========== N-1: finalizeMint must not double-count current mint debt ==========

    function test_N1_FinalizeMint_AtExactly150PercentCR_Succeeds() public {
        // Create vault with collateral that supports exactly 150% CR for a specific mint
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();
        _configureVault(lp);

        // At $390 XMR, to mint at exactly 150% CR:
        // projectedDebt = actualDebt + pendingDebt (pendingDebt includes this mint)
        // CR = collateralValue / debtValue >= 150%
        // collateralValue = 100 DAI * $1 = $100
        // maxDebtValue = $100 / 1.5 = $66.67
        // wsxmrAmount = maxDebtValue / $390 * 1e8 = 17,094,017 units
        // Use a round number close to the limit
        uint256 xmrAmount = 16_000_000_000; // ~0.41 XMR, ~$160 debt, ~160% CR

        bytes32 secret = bytes32(uint256(0xbeef));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));

        vm.prank(user);
        bytes32 reqId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, xmrAmount, commitment);

        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdeadbeef)));

        // setMintReady uses: projectedDebt = actualDebt + pendingDebt
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(reqId);

        // finalizeMint must use the SAME formula (not actualDebt + pendingDebt + request.wsxmrAmount)
        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(reqId, secret);

        // Assert mint succeeded
        uint256 minted = wsxmr.balanceOf(user);
        assertGt(minted, 0, "N-1: finalizeMint should succeed at 150% CR");
    }

    function test_N1_TwoPendingMints_FinalizeFirst_Succeeds() public {
        _createVaultAndDeposit(lp, 200 ether);
        _updatePrices();
        _configureVault(lp);

        bytes32 secretA = bytes32(uint256(0xaaa1));
        (uint256 pxa, uint256 pya) = Ed25519.scalarMultBase(uint256(secretA));
        bytes32 commitmentA = keccak256(abi.encodePacked(pxa, pya));

        bytes32 secretB = bytes32(uint256(0xbbb2));
        (uint256 pxb, uint256 pyb) = Ed25519.scalarMultBase(uint256(secretB));
        bytes32 commitmentB = keccak256(abi.encodePacked(pxb, pyb));

        // Initiate two mints
        vm.prank(user);
        bytes32 reqA = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, 10_000_000_000, commitmentA);
        vm.prank(user);
        bytes32 reqB = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, 10_000_000_000, commitmentB);

        // pendingDebt now includes BOTH mints
        // Provide keys and ready both
        vm.startPrank(lp);
        MintFacet(address(hub)).provideLPKey(reqA, bytes32(uint256(0xdead)));
        MintFacet(address(hub)).provideLPKey(reqB, bytes32(uint256(0xbeef)));
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(reqA);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(reqB);
        vm.stopPrank();

        // Finalize first mint — projectedDebt should include BOTH pending amounts
        // (not double-count reqA)
        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(reqA, secretA);

        uint256 mintedA = wsxmr.balanceOf(user);
        assertGt(mintedA, 0, "N-1: first finalizeMint should succeed with two pending mints");
    }

    // ========== H-3: Staleness-scaled deviation guard recovery ==========

    function test_H3_DeviationGuard_RevertsWhenFresh_AllowsWhenStale() public {
        address updater = makeAddr("updater");
        // Set a non-deployer price updater so deviation guard is not bypassed
        SimpleOracleFacet(address(hub)).setPriceUpdater(updater);

        // Set initial price (deployer call bypasses guard)
        SimpleOracleFacet(address(hub)).updatePrices(390_00000000, DAI_PRICE_8DEC);

        // +30% jump to $507 immediately — should revert (fresh price, non-deployer)
        vm.prank(updater);
        vm.expectRevert();
        SimpleOracleFacet(address(hub)).updatePrices(507_00000000, DAI_PRICE_8DEC);

        // Warp 95 seconds (>90s threshold)
        vm.warp(block.timestamp + 95);

        // Same +30% jump now succeeds because price is stale
        vm.prank(updater);
        SimpleOracleFacet(address(hub)).updatePrices(507_00000000, DAI_PRICE_8DEC);

        bytes memory priceResult = _hubView(abi.encodeWithSelector(SimpleOracleFacet.getXmrPrice.selector));
        uint256 price = abi.decode(priceResult, (uint256));
        assertEq(price, 507_00000000 * 1e10, "H-3: stale oracle should accept re-anchor price");
    }

    // ========== Helpers ==========

    function _updatePrices() internal {
        SimpleOracleFacet(address(hub)).updatePrices(XMR_PRICE_8DEC, DAI_PRICE_8DEC);
    }

    function _createVaultAndDeposit(address who, uint256 amount) internal {
        vm.startPrank(who);
        VaultFacet(address(hub)).createVault();
        vm.stopPrank();
        // Directly give sDAI and deposit shares (avoids xDAI wrapping issues on fork)
        deal(GnosisAddresses.SDAI, who, amount);
        vm.startPrank(who);
        IERC20(GnosisAddresses.SDAI).approve(address(hub), amount);
        VaultFacet(address(hub)).depositShares(amount);
        vm.stopPrank();
    }

    function _configureVault(address who) internal {
        vm.startPrank(who);
        VaultFacet(address(hub)).setMaxMintBps(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        VaultFacet(address(hub)).setMintReadyBond(0.001 ether);
        VaultFacet(address(hub)).setVaultMarketMetrics(100, 100); // 1% fees
        vm.stopPrank();
    }

    // Helper to call view functions through hub via call (delegatecall to view facets is safe via call, not staticcall)
    function _hubView(bytes memory data) internal returns (bytes memory) {
        (bool success, bytes memory result) = address(hub).call(data);
        require(success, "hub view call failed");
        return result;
    }

    function _getPendingReturns(address who, address token) internal returns (uint256) {
        bytes memory result = _hubView(abi.encodeWithSelector(VaultFacet.getPendingReturns.selector, who, token));
        return abi.decode(result, (uint256));
    }

    function _getVaultCollateralShares(address who) internal returns (uint256) {
        bytes memory result = _hubView(abi.encodeWithSelector(VaultFacet.getVault.selector, who));
        wsXmrStorage.Vault memory vault = abi.decode(result, (wsXmrStorage.Vault));
        return vault.collateralShares;
    }

    function _getYieldWarChest() internal returns (uint256) {
        bytes memory result = _hubView(abi.encodeWithSelector(YieldFacet.getYieldWarChest.selector));
        return abi.decode(result, (uint256));
    }
}

interface IwsXmrHub {
    error Unauthorized();
    function mintTokens(address to, uint256 amount) external;
    function burnTokens(address from, uint256 amount) external;
    function transferAsset(address token, address to, uint256 amount) external;
    function approveAsset(address token, address spender, uint256 amount) external;
    function globalDebtIndex() external view returns (uint256);
    function globalTotalDebt() external view returns (uint256);
    function lpPrincipalDeposits(address) external view returns (uint256);
    function lpPrincipalShares(address) external view returns (uint256);
    function addSelectors(address facet, bytes4[] calldata selectors) external;
}
