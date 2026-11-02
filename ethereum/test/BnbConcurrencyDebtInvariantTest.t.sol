// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {BnbMockTestBase} from "./BnbTestBase.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ed25519} from "../contracts/Ed25519.sol";
import {IErrors} from "../contracts/interfaces/IErrors.sol";
import {IBurnOperations} from "../contracts/interfaces/swap/IBurnOperations.sol";
import {ISwapRouter} from "../contracts/interfaces/external/ISwapRouter.sol";

/**
 * @title Concurrency & Debt Invariant Tests
 * @notice Tests PendingMintLock guards, burn debt deferral, and debt index invariants
 */
contract ConcurrencyDebtInvariantTestBnb is BnbMockTestBase {
    address lp2 = makeAddr("lp2");
    address user2 = makeAddr("user2");
    address keeper = makeAddr("keeper");

    uint256 constant TEST_XMR_PRICE_8DEC = 300_00000000; // $300

    function setUp() public override {
        super.setUp();
        vm.deal(lp2, 1000 ether);
        vm.deal(user2, 1000 ether);
        vm.deal(keeper, 1000 ether);

        // Initialize the HyperSwap pool at a deploy-time display price ($300)
        vm.prank(address(hub));
        router.initializePool(TEST_XMR_PRICE_8DEC * 1e10);

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

    /// @notice Burn succeeds mid-mint (READY state) when vault has sufficient collateral
    function test_BurnSucceedsMidMint_WithSufficientCollateral() public {
        // First, mint some wsXMR to user so they have tokens to burn
        _mintForUser(user, lp);

        // Now start a second mint and advance to READY
        bytes32 reqId = _initiateMint(user2, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        // User requests burn while mint is READY — should succeed with enough collateral
        vm.startPrank(user);
        wsxmr.approve(address(hub), 100_000);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(100_000, lp, user, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        vm.stopPrank();

        // Verify burn was created
        assertEq(uint256(burnId) != 0, true, "Burn should be created successfully");
    }

    /// @notice kick() mid-mint is permissionless — the auction settles the in-flight
    ///         mint at open, so kicks must NOT be blocked by PendingMintLock.
    function test_PendingMintLock_KickMidMint_Allowed() public {
        // Real debt is required to kick — mint first
        _mintForUser(user, lp);

        // Start a second mint and advance to READY (pending-mint lock engaged)
        bytes32 reqId = _initiateMint(user2, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        // Keeper can still kick while a mint is READY (settlement handles it)
        _kickVault(keeper, lp);
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
        MintFacet(address(hub)).revealSecret(reqId, bytes32(uint256(0x1234)));
        MintFacet(address(hub)).finalizeMint(reqId);

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
        vm.roll(block.number + 50000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        // Should still be locked (EXPIRED_READY, not yet claimed/swept)
        assertEq(_getTotalPendingMints(), 1, "EXPIRED_READY should still hold lock");

        // Warp past LP claim window, then sweep (no secret needed)
        vm.roll(block.number + hub.LP_CLAIM_WINDOW_BLOCKS() + 5);
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
        vm.roll(block.number + 50000);

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
        vm.roll(block.number + 50000);

        // User resolves declined proposal
        vm.prank(user);
        BurnFacet(address(hub)).resolveDeclinedProposal(burnId, TEST_USER_SECRET);

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

    // ========== Fix 2 & 3: repayDebt debt-clearance invariants ==========

    /// @notice Full repayDebt zeroes the vault's debt — the oracle-free analogue of
    ///         the old buy-and-burn full wipe.
    function test_RepayDebt_FullWipe_ZerosVaultDebt() public {
        // Mint debt on both vaults
        _mintForUser(user, lp);
        _mintForUser(user2, lp2);

        // Verify both vaults have debt
        assertGt(_getVaultNormalizedDebt(lp), 0, "LP1 should have debt");
        assertGt(_getVaultNormalizedDebt(lp2), 0, "LP2 should have debt");

        // LP1 fully repays: give it wsXMR equal to its actual debt and burn it
        uint256 lpDebt = _getActualDebt(lp);
        deal(address(wsxmr), lp, lpDebt);
        vm.startPrank(lp);
        wsxmr.approve(address(hub), lpDebt);
        VaultFacet(address(hub)).repayDebt(lpDebt);
        vm.stopPrank();

        // LP1's debt is zeroed; LP2's is untouched
        assertEq(_getVaultNormalizedDebt(lp), 0, "LP1 debt should be zeroed after full repay");
        assertGt(_getVaultNormalizedDebt(lp2), 0, "LP2 debt must remain");
        assertEq(_getGlobalTotalDebt(), _getActualDebt(lp2), "global debt = LP2 debt only");
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

        vm.roll(block.number + 50000);
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

    /// @notice After partial repayDebt, invariant holds
    function test_Invariant_RepayDebtPartialSumActualDebts() public {
        _mintForUser(user, lp);
        _mintForUser(user2, lp2);

        uint256 lpDebt = _getActualDebt(lp);
        uint256 repay = lpDebt / 3;
        deal(address(wsxmr), lp, repay);
        vm.startPrank(lp);
        wsxmr.approve(address(hub), repay);
        VaultFacet(address(hub)).repayDebt(repay);
        vm.stopPrank();

        uint256 sum = _getActualDebt(lp) + _getActualDebt(lp2);
        // Allow 2 unit rounding tolerance from integer division
        assertApproxEqAbs(sum, _getGlobalTotalDebt(), 2, "Sum of actualDebts should equal globalTotalDebt after partial repay");
    }

    // ========== Issue #68: claimSlashedCollateral uncapped debt reduction ==========

    /// @notice Two committed burns can oversubscribe a vault's debt — requestBurn
    ///         checks each burn against vaultActualDebt individually and reserves
    ///         no debt, so B1+B2 > normalizedDebt is reachable. After B1 settles,
    ///         B2's normalizedBurnAmount exceeds the remaining normalizedDebt;
    ///         claimSlashedCollateral must cap (like _settleBurn/forceSettleBurn),
    ///         not underflow-revert and lock the defaulted user's par collateral.
    function test_ClaimSlashed_OversubscribedBurns_DoesNotRevert() public {
        // lp vault debt: 2,000,000 wsXMR. The second mint on lp2 only exists to
        // give `user` enough wsXMR to oversubscribe the lp vault's debt.
        _mintForUser(user, lp);
        _mintForUser(user, lp2);

        uint256 vaultDebt = _getVaultNormalizedDebt(lp);
        uint256 burnAmount = (vaultDebt * 3) / 4; // each burn = 75% of vault debt

        bytes32 burnId1 = _requestBurn(user, lp, burnAmount);
        bytes32 burnId2 = _requestBurn(user, lp, burnAmount);

        _proposeHash(lp, burnId1);
        _proposeHash(lp, burnId2);

        vm.startPrank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId1);
        BurnFacet(address(hub)).confirmMoneroLock(burnId2);

        // LP finalizes the first burn — vault debt drops to ~25% of original,
        // below the second burn's wsxmrAmount.
        BurnFacet(address(hub)).finalizeBurn(burnId1, bytes32(uint256(0xcafebabe)));
        vm.stopPrank();

        assertLt(_getVaultNormalizedDebt(lp), burnAmount, "Remaining debt must be below the second burn");

        // LP defaults on the second burn — deadline + finalize grace lapse.
        vm.roll(block.number + 7200 + 600 + 1);

        vm.prank(user);
        BurnFacet(address(hub)).claimSlashedCollateral(burnId2, TEST_USER_SECRET);

        wsXmrStorage.BurnRequest memory req = _getBurnRequest(burnId2);
        assertEq(uint8(req.status), uint8(wsXmrStorage.BurnStatus.SLASHED), "Burn must be SLASHED");
        assertEq(_getVaultNormalizedDebt(lp), 0, "Capped reduction must zero remaining vault debt");
        assertGt(
            wsXmrStorage(address(hub)).pendingReturns(user, address(stata)),
            0,
            "User must receive par collateral"
        );
    }

    /// @notice A full repayDebt zeroes normalizedDebt while a committed burn is in
    ///         flight — claimSlashedCollateral must still succeed (cap to 0).
    function test_ClaimSlashed_AfterDebtWipe_DoesNotRevert() public {
        _mintForUser(user, lp);

        // Burn half the user's minted balance (the 1.3x proportional lock caps
        // single burns at ~77% of vault debt).
        uint256 burnAmount = wsxmr.balanceOf(user) / 2;
        bytes32 burnId = _requestBurn(user, lp, burnAmount);
        _proposeHash(lp, burnId);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        // LP fully repays the vault's actual (non-pending) debt → normalizedDebt = 0.
        uint256 actualDebt = _getActualDebt(lp);
        deal(address(wsxmr), lp, actualDebt);
        vm.startPrank(lp);
        wsxmr.approve(address(hub), actualDebt);
        VaultFacet(address(hub)).repayDebt(actualDebt);
        vm.stopPrank();

        assertEq(_getVaultNormalizedDebt(lp), 0, "Wipe must zero the vault's debt");

        // LP never reveals — slash deadline lapses.
        vm.roll(block.number + 7200 + 600 + 1);

        vm.prank(user);
        BurnFacet(address(hub)).claimSlashedCollateral(burnId, TEST_USER_SECRET);

        wsXmrStorage.BurnRequest memory req = _getBurnRequest(burnId);
        assertEq(uint8(req.status), uint8(wsXmrStorage.BurnStatus.SLASHED), "Burn must be SLASHED");
        assertGt(
            wsXmrStorage(address(hub)).pendingReturns(user, address(stata)),
            0,
            "User must receive par collateral"
        );
    }

    // ========== Refactor B: LP Bond Removed ==========

    /// @notice setMintReady works without sending ETH (no bond required)
    function test_LPBondRemoved_SetMintReadyNoETH() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        // LP balance should be unchanged (no bond posted)
        uint256 lpBalanceBefore = lp.balance;

        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(reqId);

        assertEq(lp.balance, lpBalanceBefore, "LP should not spend ETH on setMintReady");

        // Finalize should work
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(reqId, bytes32(uint256(0x1234)));
        MintFacet(address(hub)).finalizeMint(reqId);
    }

    /// @notice setMintReadyBond function no longer exists
    function test_LPBondRemoved_SetMintReadyBondDoesNotExist() public {
        // This should revert because the function was removed from the facet
        vm.prank(lp);
        vm.expectRevert();
        address(hub).call(abi.encodeWithSignature("setMintReadyBond(uint256)", 0.001 ether));
    }

    // ========== HELPERS ==========

    function _createVaultAndDeposit(address who, uint256 amount) internal {
        vm.startPrank(who);
        VaultFacet(address(hub)).createVault();
        vm.stopPrank();
        deal(USDE, who, amount);
        vm.startPrank(who);
        IERC20(USDE).approve(address(hub), amount);
        VaultFacet(address(hub)).depositCollateral(amount);
        vm.stopPrank();
    }

    function _configureVault(address who) internal {
        vm.startPrank(who);
        VaultFacet(address(hub)).setMaxMintWsxmr(0);
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
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)));
    }

    function _setMintReady(address _lp, bytes32 reqId) internal {
        vm.prank(_lp);
        MintFacet(address(hub)).setMintReady(reqId);
    }

    function _mintForUser(address _user, address _lp) internal returns (uint256) {
        bytes32 reqId = _initiateMint(_user, _lp);
        _provideLPKey(_lp, reqId);
        _setMintReady(_lp, reqId);

        vm.prank(_user);
        MintFacet(address(hub)).revealSecret(reqId, bytes32(uint256(0x1234)));
        MintFacet(address(hub)).finalizeMint(reqId);

        return wsxmr.balanceOf(_user);
    }

    bytes32 constant TEST_USER_SECRET = bytes32(uint256(0xdeadbeef));

    function _requestBurn(address _user, address _lp, uint256 amount) internal returns (bytes32) {
        (uint256 upkx, uint256 upky) = Ed25519.scalarMultBase(uint256(TEST_USER_SECRET));
        // Compressed point — matches the frontend's publicSpendKey.toRawBytes()
        bytes32 userPubKey = bytes32(Ed25519.compressPoint(upkx, upky));
        vm.startPrank(_user);
        wsxmr.approve(address(hub), amount);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(amount, _lp, _user, bytes32(uint256(1)), userPubKey, bytes32(uint256(3)));
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

    /// @dev getBurnRequest traverses the hub fallback — must use a non-static
    ///      call (TSTORE reentrancy tracking fails under STATICCALL).
    function _getBurnRequest(bytes32 requestId) internal returns (wsXmrStorage.BurnRequest memory) {
        (bool ok, bytes memory data) = address(hub).call(
            abi.encodeWithSignature("getBurnRequest(bytes32)", requestId)
        );
        require(ok, "getBurnRequest failed");
        return abi.decode(data, (wsXmrStorage.BurnRequest));
    }

    // ========== MOCK HELPERS ==========

    function _updatePrices() internal {}
}
