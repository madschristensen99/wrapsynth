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
import {wsXMRLiquidityRouter} from "../contracts/router/wsXMRLiquidityRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Factory} from "../contracts/interfaces/external/IUniswapV3Factory.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";
import {Ed25519} from "../contracts/Ed25519.sol";
import {IErrors} from "../contracts/interfaces/IErrors.sol";
import {IBurnOperations} from "../contracts/interfaces/swap/IBurnOperations.sol";
import {ISwapRouter} from "../contracts/interfaces/external/ISwapRouter.sol";

contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

/**
 * @title Concurrency & Debt Invariant Tests
 * @notice Tests PendingMintLock guards, burn debt deferral, and debt index invariants
 */
contract ConcurrencyDebtInvariantTest is Test {
    wsXmrHub public hub;
    wsXMR public wsxmr;
    SimpleOracleFacet public oracleFacet;
    VaultFacet public vaultFacet;
    MintFacet public mintFacet;
    BurnFacet public burnFacet;
    LiquidationFacet public liquidationFacet;
    YieldFacet public yieldFacet;
    wsXMRLiquidityRouter public router;
    MockVerifierProxy public verifier;

    address lp = makeAddr("lp");
    address lp2 = makeAddr("lp2");
    address user = makeAddr("user");
    address user2 = makeAddr("user2");
    address keeper = makeAddr("keeper");
    address priceUpdater = makeAddr("priceUpdater");

    uint256 constant XMR_PRICE_8DEC = 300_00000000;
    uint256 constant DAI_PRICE_8DEC = 118_00000000;

    function setUp() public {
        string memory rpcUrl = vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"));
        vm.createSelectFork(rpcUrl);

        vm.deal(address(this), 1_000_000 ether);
        vm.deal(lp, 1000 ether);
        vm.deal(lp2, 1000 ether);
        vm.deal(user, 1000 ether);
        vm.deal(user2, 1000 ether);
        vm.deal(keeper, 1000 ether);

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

        // Set up Uniswap pool for buy-and-burn tests
        _setupUniswapPool();

        SimpleOracleFacet(address(hub)).setPriceUpdater(priceUpdater);
        _updatePrices();

        // Standard vault setup for LP
        _createVaultAndDeposit(lp, 5000 ether);
        _configureVault(lp);

        // Second LP vault
        _createVaultAndDeposit(lp2, 5000 ether);
        _configureVault(lp2);
    }

    // ========== FIX 1: PendingMintLock Guards ==========

    /// @notice LP withdraws collateral mid-mint (READY state) → must revert with PendingMintLock
    function test_PendingMintLock_WithdrawCollateralMidMint_Reverts() public {
        // Create a mint and advance to READY
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        // LP tries to withdraw collateral while mint is READY
        vm.prank(lp);
        vm.expectRevert(wsXmrStorage.PendingMintLock.selector);
        VaultFacet(address(hub)).withdrawCollateral(1 ether);
    }

    /// @notice LP requests burn mid-mint (READY state) → must revert with PendingMintLock
    function test_PendingMintLock_RequestBurnMidMint_Reverts() public {
        // First, mint some wsXMR to user so they have tokens to burn
        _mintForUser(user, lp);

        // Now start a second mint and advance to READY
        bytes32 reqId = _initiateMint(user2, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        // User tries to request burn while mint is READY
        vm.startPrank(user);
        wsxmr.approve(address(hub), 100_000);
        vm.expectRevert(wsXmrStorage.PendingMintLock.selector);
        BurnFacet(address(hub)).requestBurn(100_000, lp, user, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        vm.stopPrank();
    }

    /// @notice triggerBuyAndBurn mid-mint → must revert with PendingMintLock
    function test_PendingMintLock_TriggerBuyAndBurnMidMint_Reverts() public {
        // Inject yield so war chest is non-empty
        _injectWarChestYield(1000 ether);
        _mockEmaPrice(400 * 1e18);
        vm.warp(block.timestamp + 25 hours);
        _updatePrices();

        // Start a mint and advance to READY
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        // Keeper tries to trigger buy-and-burn while mint is READY
        vm.prank(keeper);
        vm.expectRevert(wsXmrStorage.PendingMintLock.selector);
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);
    }

    /// @notice After finalizeMint, pendingMintCount returns to 0 and ops are unblocked
    function test_PendingMintLock_FinalizeMintUnblocksOps() public {
        // Create mint, advance to READY
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        // Verify lock is active
        assertEq(_getTotalPendingMints(), 1, "Should have 1 pending mint");

        // Finalize the mint
        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(reqId, bytes32(uint256(0x1234)));

        // Lock should be released
        assertEq(_getTotalPendingMints(), 0, "Should have 0 pending mints after finalize");

        // Withdraw should now work (LP has plenty of collateral)
        vm.prank(lp);
        VaultFacet(address(hub)).withdrawCollateral(1 ether);
    }

    /// @notice After cancelMint on EXPIRED_READY, pendingMintCount returns to 0
    function test_PendingMintLock_CancelExpiredMintUnblocksOps() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        assertEq(_getTotalPendingMints(), 1, "Should have 1 pending mint");

        // Warp past timeout
        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId);

        // Should still be locked (EXPIRED_READY, not yet claimed/swept)
        assertEq(_getTotalPendingMints(), 1, "EXPIRED_READY should still hold lock");

        // Warp past LP claim window, then sweep (no secret needed)
        vm.roll(block.number + 360);
        MintFacet(address(hub)).sweepUnclaimedExpiredMint(reqId);

        assertEq(_getTotalPendingMints(), 0, "Should have 0 pending mints after sweep");
    }

    // ========== Refactor A: Burn Debt Deferral ==========

    /// @notice requestBurn does not reduce vault normalizedDebt or globalTotalDebt
    function test_BurnDebtDeferral_RequestBurnDoesNotReduceDebt() public {
        // Mint wsXMR to user
        _mintForUser(user, lp);

        uint256 vaultDebtBefore = _getVaultNormalizedDebt(lp);
        uint256 globalDebtBefore = _getGlobalTotalDebt();
        uint256 pendingBurnBefore = _getGlobalPendingBurnDebt();

        // Request burn
        uint256 burnAmount = 100_000;
        _requestBurn(user, lp, burnAmount);

        // Debt should NOT have changed
        assertEq(_getVaultNormalizedDebt(lp), vaultDebtBefore, "Vault normalizedDebt must not change on requestBurn");
        assertEq(_getGlobalTotalDebt(), globalDebtBefore, "globalTotalDebt must not change on requestBurn");

        // But pending burn debt should increase
        assertEq(_getGlobalPendingBurnDebt(), pendingBurnBefore + burnAmount, "globalPendingBurnDebt should increase");
    }

    /// @notice abortBurn does not change vault debt (was never reduced)
    function test_BurnDebtDeferral_AbortBurnDoesNotChangeDebt() public {
        _mintForUser(user, lp);

        uint256 burnAmount = 100_000;
        bytes32 burnId = _requestBurn(user, lp, burnAmount);

        uint256 vaultDebtBefore = _getVaultNormalizedDebt(lp);
        uint256 globalDebtBefore = _getGlobalTotalDebt();

        // Warp past burn deadline
        vm.roll(block.number + 10000);

        // User aborts the burn
        vm.prank(user);
        BurnFacet(address(hub)).abortBurn(burnId);

        // Debt should be unchanged
        assertEq(_getVaultNormalizedDebt(lp), vaultDebtBefore, "Vault debt must not change on abortBurn");
        assertEq(_getGlobalTotalDebt(), globalDebtBefore, "globalTotalDebt must not change on abortBurn");

        // Pending burn debt should be cleared
        assertEq(_getGlobalPendingBurnDebt(), 0, "globalPendingBurnDebt should be 0 after abort");

        // User should get wsXMR back
        assertGe(wsxmr.balanceOf(user), burnAmount, "User should have wsXMR restored");
    }

    /// @notice resolveDeclinedProposal does not change vault debt
    function test_BurnDebtDeferral_ResolveDeclinedDoesNotChangeDebt() public {
        _mintForUser(user, lp);

        uint256 burnAmount = 100_000;
        bytes32 burnId = _requestBurn(user, lp, burnAmount);
        _proposeHash(lp, burnId);

        uint256 vaultDebtBefore = _getVaultNormalizedDebt(lp);
        uint256 globalDebtBefore = _getGlobalTotalDebt();

        // Warp past proposal deadline
        vm.roll(block.number + 10000);

        // User resolves declined proposal
        vm.prank(user);
        BurnFacet(address(hub)).resolveDeclinedProposal(burnId);

        assertEq(_getVaultNormalizedDebt(lp), vaultDebtBefore, "Vault debt must not change on resolveDeclined");
        assertEq(_getGlobalTotalDebt(), globalDebtBefore, "globalTotalDebt must not change on resolveDeclined");
        assertEq(_getGlobalPendingBurnDebt(), 0, "globalPendingBurnDebt should be 0 after resolve");
    }

    /// @notice finalizeBurn reduces debt at settlement
    function test_BurnDebtDeferral_FinalizeBurnReducesDebt() public {
        _mintForUser(user, lp);

        uint256 burnAmount = 100_000;
        bytes32 burnId = _requestBurn(user, lp, burnAmount);
        _proposeHash(lp, burnId);

        // User confirms Monero lock
        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        uint256 vaultDebtBefore = _getVaultNormalizedDebt(lp);
        uint256 globalDebtBefore = _getGlobalTotalDebt();
        uint256 pendingBurnBefore = _getGlobalPendingBurnDebt();

        // Finalize burn with the secret
        vm.prank(user);
        BurnFacet(address(hub)).finalizeBurn(burnId, bytes32(uint256(0xcafebabe)));

        // Debt should now be reduced
        assertLt(_getVaultNormalizedDebt(lp), vaultDebtBefore, "Vault debt should decrease on finalizeBurn");
        assertLt(_getGlobalTotalDebt(), globalDebtBefore, "globalTotalDebt should decrease on finalizeBurn");
        assertEq(_getGlobalPendingBurnDebt(), pendingBurnBefore - burnAmount, "pendingBurnDebt should decrease");
    }

    // ========== Fix 2 & 3: triggerBuyAndBurn Invariants ==========

    /// @notice triggerBuyAndBurn full-wipe zeros all vault normalizedDebts and resets index
    function test_BuyAndBurn_FullWipe_ZerosVaultDebt() public {
        // Mint debt on both vaults
        _mintForUser(user, lp);
        _mintForUser(user2, lp2);

        // Verify both vaults have debt
        assertGt(_getVaultNormalizedDebt(lp), 0, "LP1 should have debt");
        assertGt(_getVaultNormalizedDebt(lp2), 0, "LP2 should have debt");

        uint256 totalDebt = _getGlobalTotalDebt();

        // Inject yield and mock a full-wipe swap (buy >= totalDebt)
        _injectWarChestYield(100000 ether);
        _mockEmaPrice(400 * 1e18);
        _mockSwapRouter(totalDebt + 1); // Buy more than total debt → full wipe
        deal(address(wsxmr), address(hub), totalDebt + 1);
        vm.warp(block.timestamp + 25 hours);
        _updatePrices();

        vm.prank(keeper);
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);

        // Complete the batch debt wipe
        YieldFacet(address(hub)).continueDebtWipe(10000);

        // All vault debts should be zeroed
        assertEq(_getVaultNormalizedDebt(lp), 0, "LP1 debt should be zeroed after full wipe");
        assertEq(_getVaultNormalizedDebt(lp2), 0, "LP2 debt should be zeroed after full wipe");

        // Index should be reset to 1e18
        assertEq(_getGlobalDebtIndex(), 1e18, "globalDebtIndex should be 1e18 after full wipe");
    }

    /// @notice triggerBuyAndBurn proportional path excludes globalPendingBurnDebt
    function test_BuyAndBurn_ProportionalExcludesPendingBurnDebt() public {
        _mintForUser(user, lp);

        uint256 burnAmount = 100_000;
        _requestBurn(user, lp, burnAmount);

        uint256 globalDebt = _getGlobalTotalDebt();
        uint256 pendingBurn = _getGlobalPendingBurnDebt();
        uint256 effectiveDebt = globalDebt - pendingBurn;
        uint256 actualDebtBefore = _getActualDebt(lp);

        // Buy exactly half of effective debt
        uint256 buyAmount = effectiveDebt / 2;

        _injectWarChestYield(100000 ether);
        _mockEmaPrice(400 * 1e18);
        _mockSwapRouter(buyAmount);
        deal(address(wsxmr), address(hub), buyAmount);
        vm.warp(block.timestamp + 25 hours);
        _updatePrices();

        vm.prank(keeper);
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);

        // globalTotalDebt should decrease by buyAmount (not including pending burn)
        assertEq(_getGlobalTotalDebt(), globalDebt - buyAmount, "globalTotalDebt should decrease by buyAmount");

        // Actual debt should be halved (proportional reduction on effective debt)
        // After migration, index is 1e18 and normalizedDebt is rescaled, so actualDebt is preserved
        uint256 actualDebtAfter = _getActualDebt(lp);
        uint256 expectedAfter = actualDebtBefore / 2;
        // Allow 1 unit rounding tolerance
        assertApproxEqAbs(actualDebtAfter, expectedAfter, 1, "Actual debt should be halved after proportional buy");
    }

    // ========== Debt Invariant: sum of actualDebts == globalTotalDebt ==========

    /// @notice After mint, sum of vault actualDebts equals globalTotalDebt
    function test_Invariant_MintSumActualDebts() public {
        _mintForUser(user, lp);
        _mintForUser(user2, lp2);

        uint256 sum = _getActualDebt(lp) + _getActualDebt(lp2);
        assertEq(sum, _getGlobalTotalDebt(), "Sum of actualDebts should equal globalTotalDebt after mint");
    }

    /// @notice After burn request + abort, invariant holds (debt unchanged)
    function test_Invariant_AbortBurnSumActualDebts() public {
        _mintForUser(user, lp);
        _mintForUser(user2, lp2);

        uint256 burnAmount = 100_000;
        bytes32 burnId = _requestBurn(user, lp, burnAmount);

        vm.roll(block.number + 10000);
        vm.prank(user);
        BurnFacet(address(hub)).abortBurn(burnId);

        uint256 sum = _getActualDebt(lp) + _getActualDebt(lp2);
        assertEq(sum, _getGlobalTotalDebt(), "Sum of actualDebts should equal globalTotalDebt after abort");
    }

    /// @notice After burn finalize, invariant holds
    function test_Invariant_FinalizeBurnSumActualDebts() public {
        _mintForUser(user, lp);
        _mintForUser(user2, lp2);

        uint256 burnAmount = 100_000;
        bytes32 burnId = _requestBurn(user, lp, burnAmount);
        _proposeHash(lp, burnId);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        vm.prank(user);
        BurnFacet(address(hub)).finalizeBurn(burnId, bytes32(uint256(0xcafebabe)));

        uint256 sum = _getActualDebt(lp) + _getActualDebt(lp2);
        assertEq(sum, _getGlobalTotalDebt(), "Sum of actualDebts should equal globalTotalDebt after finalizeBurn");
    }

    /// @notice After buy-and-burn proportional path, invariant holds
    function test_Invariant_BuyAndBurnProportionalSumActualDebts() public {
        _mintForUser(user, lp);
        _mintForUser(user2, lp2);

        uint256 globalDebt = _getGlobalTotalDebt();
        uint256 buyAmount = globalDebt / 3; // Buy 1/3 of debt

        _injectWarChestYield(100000 ether);
        _mockEmaPrice(400 * 1e18);
        _mockSwapRouter(buyAmount);
        deal(address(wsxmr), address(hub), buyAmount);
        vm.warp(block.timestamp + 25 hours);
        _updatePrices();

        vm.prank(keeper);
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);

        uint256 sum = _getActualDebt(lp) + _getActualDebt(lp2);
        // Allow 2 unit rounding tolerance from integer division
        assertApproxEqAbs(sum, _getGlobalTotalDebt(), 2, "Sum of actualDebts should equal globalTotalDebt after buy-and-burn");
    }

    /// @notice After buy-and-burn full wipe, invariant holds (both zero)
    function test_Invariant_BuyAndBurnFullWipeSumActualDebts() public {
        _mintForUser(user, lp);
        _mintForUser(user2, lp2);

        uint256 totalDebt = _getGlobalTotalDebt();

        _injectWarChestYield(100000 ether);
        _mockEmaPrice(400 * 1e18);
        _mockSwapRouter(totalDebt + 1);
        deal(address(wsxmr), address(hub), totalDebt + 1);
        vm.warp(block.timestamp + 25 hours);
        _updatePrices();

        vm.prank(keeper);
        YieldFacet(address(hub)).triggerBuyAndBurn(3000);

        // Complete the batch debt wipe
        YieldFacet(address(hub)).continueDebtWipe(10000);

        uint256 sum = _getActualDebt(lp) + _getActualDebt(lp2);
        assertEq(sum, _getGlobalTotalDebt(), "Sum of actualDebts should equal globalTotalDebt after full wipe");
        assertEq(sum, 0, "All debt should be zero after full wipe");
    }

    // ========== Refactor B: LP Bond Removed ==========

    /// @notice setMintReady works without sending ETH (no bond required)
    function test_LPBondRemoved_SetMintReadyNoETH() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        // LP balance should be unchanged (no bond posted)
        uint256 lpBalanceBefore = lp.balance;

        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(reqId, bytes32(uint256(0xdeadbeef)));

        assertEq(lp.balance, lpBalanceBefore, "LP should not spend ETH on setMintReady");

        // Finalize should work
        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(reqId, bytes32(uint256(0x1234)));
    }

    /// @notice setMintReadyBond function no longer exists
    function test_LPBondRemoved_SetMintReadyBondDoesNotExist() public {
        // This should revert because the function was removed from the facet
        vm.prank(lp);
        vm.expectRevert();
        address(hub).call(abi.encodeWithSignature("setMintReadyBond(uint256)", 0.001 ether));
    }

    // ========== HELPERS ==========

    function _setupUniswapPool() internal {
        (address token0, address token1) = GnosisAddresses.SDAI < address(wsxmr)
            ? (GnosisAddresses.SDAI, address(wsxmr))
            : (address(wsxmr), GnosisAddresses.SDAI);

        address pool = IUniswapV3Factory(GnosisAddresses.UNI_V3_FACTORY).getPool(token0, token1, 3000);
        if (pool == address(0)) {
            pool = IUniswapV3Factory(GnosisAddresses.UNI_V3_FACTORY).createPool(token0, token1, 3000);
        }

        router = new wsXMRLiquidityRouter(
            address(hub),
            GnosisAddresses.UNI_V3_POSITION_MANAGER,
            GnosisAddresses.SDAI,
            address(wsxmr),
            pool
        );

        hub.setLiquidityRouter(address(router));

        vm.prank(address(hub));
        router.initializePool(300 * 1e18);
    }

    function _createVaultAndDeposit(address who, uint256 amount) internal {
        vm.startPrank(who);
        VaultFacet(address(hub)).createVault();
        vm.stopPrank();
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
        VaultFacet(address(hub)).setVaultMarketMetrics(100, 100);
        vm.stopPrank();
    }

    function _initiateMint(address _user, address _lp) internal returns (bytes32) {
        uint256 xmrAmount = 20000000000; // 0.2 XMR
        bytes32 secret = bytes32(uint256(0x1234));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));

        vm.prank(_user);
        return MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            _lp, _user, xmrAmount, commitment, bytes32(uint256(0xdeadbeef))
        );
    }

    function _provideLPKey(address _lp, bytes32 reqId) internal {
        vm.prank(_lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)));
    }

    function _setMintReady(address _lp, bytes32 reqId) internal {
        vm.prank(_lp);
        MintFacet(address(hub)).setMintReady(reqId, bytes32(uint256(0xdeadbeef)));
    }

    function _mintForUser(address _user, address _lp) internal returns (uint256) {
        bytes32 reqId = _initiateMint(_user, _lp);
        _provideLPKey(_lp, reqId);
        _setMintReady(_lp, reqId);

        vm.prank(_user);
        MintFacet(address(hub)).finalizeMint(reqId, bytes32(uint256(0x1234)));

        return wsxmr.balanceOf(_user);
    }

    function _requestBurn(address _user, address _lp, uint256 amount) internal returns (bytes32) {
        vm.startPrank(_user);
        wsxmr.approve(address(hub), amount);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(amount, _lp, _user, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        vm.stopPrank();
        return burnId;
    }

    function _proposeHash(address _lp, bytes32 burnId) internal {
        bytes32 secret = bytes32(uint256(0xcafebabe));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        bytes32 secretHash = keccak256(abi.encodePacked(px, py));

        vm.prank(_lp);
        BurnFacet(address(hub)).proposeHash(
            burnId, secretHash,
            bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)),
            bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222))
        );
    }

    // ========== STORAGE READERS ==========

    function _getVaultNormalizedDebt(address vaultOwner) internal returns (uint256) {
        (bool ok, bytes memory data) = address(hub).call(
            abi.encodeWithSignature("getVault(address)", vaultOwner)
        );
        require(ok, "getVault failed");
        wsXmrStorage.Vault memory v = abi.decode(data, (wsXmrStorage.Vault));
        return v.normalizedDebt;
    }

    function _getActualDebt(address vaultOwner) internal returns (uint256) {
        (bool ok, bytes memory data) = address(hub).call(
            abi.encodeWithSignature("getVaultDebt(address)", vaultOwner)
        );
        require(ok, "getVaultDebt failed");
        return abi.decode(data, (uint256));
    }

    function _getGlobalTotalDebt() internal returns (uint256) {
        return wsXmrStorage(address(hub)).globalTotalDebt();
    }

    function _getGlobalDebtIndex() internal returns (uint256) {
        return wsXmrStorage(address(hub)).globalDebtIndex();
    }

    function _getGlobalPendingBurnDebt() internal returns (uint256) {
        return wsXmrStorage(address(hub)).globalPendingBurnDebt();
    }

    function _getTotalPendingMints() internal returns (uint256) {
        return wsXmrStorage(address(hub)).totalPendingMints();
    }

    // ========== MOCK HELPERS ==========

    function _mockEmaPrice(uint256 emaPrice) internal {
        vm.mockCall(
            address(hub),
            abi.encodeWithSelector(oracleFacet.getXmrEmaPrice.selector),
            abi.encode(emaPrice)
        );
    }

    function _mockSwapRouter(uint256 wsxmrOut) internal {
        vm.mockCall(
            GnosisAddresses.UNISWAP_V3_ROUTER,
            abi.encodeWithSelector(ISwapRouter.exactInputSingle.selector),
            abi.encode(wsxmrOut)
        );
    }

    function _updatePrices() internal {
        vm.prank(priceUpdater);
        SimpleOracleFacet(address(hub)).updatePrices(XMR_PRICE_8DEC, DAI_PRICE_8DEC);
    }

    function _injectWarChestYield(uint256 shares) internal {
        deal(GnosisAddresses.SDAI, address(hub), shares);
        vm.store(address(hub), bytes32(uint256(15)), bytes32(shares));
    }
}
