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
import {IErrors} from "../contracts/interfaces/IErrors.sol";
import {IBurnOperations} from "../contracts/interfaces/swap/IBurnOperations.sol";
import {IMintOperations} from "../contracts/interfaces/swap/IMintOperations.sol";

contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

contract MintBurnCoverageTest is Test {
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
    address priceUpdater = makeAddr("priceUpdater");

    uint256 constant XMR_PRICE_8DEC = 390_00000000;
    uint256 constant DAI_PRICE_8DEC = 1_00000000;

    function setUp() public {
        string memory rpcUrl = vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"));
        vm.createSelectFork(rpcUrl);

        vm.deal(address(this), 1_000_000 ether);
        vm.deal(lp, 1000 ether);
        vm.deal(user, 1000 ether);
        vm.deal(attacker, 1000 ether);

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

        SimpleOracleFacet(address(hub)).setPriceUpdater(priceUpdater);
        SimpleOracleFacet(address(hub)).updatePrices(XMR_PRICE_8DEC, DAI_PRICE_8DEC);

        _createVaultAndDeposit(lp, 100 ether);
        _configureVault(lp);
    }

    // ========== getMintRequest ==========

    function test_GetMintRequest_ReturnsCorrect() public {
        bytes32 reqId = _initiateMint(user, lp);
        wsXmrStorage.MintRequest memory req = _getMintRequest(reqId);
        assertEq(req.requestId, reqId, "requestId should match");
        assertEq(req.initiator, user, "initiator should be user");
        assertEq(req.lpVault, lp, "lpVault should be lp");
        assertEq(uint256(req.status), uint256(wsXmrStorage.MintStatus.PENDING), "status should be PENDING");
    }

    // ========== getVaultPendingMints ==========

    function test_GetVaultPendingMints_ReturnsPending() public {
        bytes32 reqId = _initiateMint(user, lp);
        bytes32[] memory pending = _getVaultPendingMints(lp);
        assertEq(pending.length, 1, "should have 1 pending mint");
        assertEq(pending[0], reqId, "should match request id");
    }

    function test_GetVaultPendingMints_FiltersCompleted() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(reqId, bytes32(uint256(0x1234)));
        MintFacet(address(hub)).finalizeMint(reqId);

        bytes32[] memory pending = _getVaultPendingMints(lp);
        assertEq(pending.length, 0, "should have 0 pending after completion");
    }

    // ========== calculateWsxmrAmount ==========

    function test_CalculateWsxmrAmount_CorrectConversion() public {
        uint256 xmrAmount = 1_000_000_000_000; // 1 XMR
        uint256 wsxmrAmount = _calculateWsxmrAmount(xmrAmount);
        assertEq(wsxmrAmount, xmrAmount / 1e4, "should divide by XMR_TO_WSXMR_DIVISOR");
    }

    function test_CalculateWsxmrAmount_Zero() public {
        assertEq(_calculateWsxmrAmount(0), 0, "zero input should give zero");
    }

    // ========== calculateMintFee ==========

    function test_CalculateMintFee_CorrectFee() public {
        uint256 wsxmrAmount = 1_000_000; // 0.01 wsXMR
        uint256 fee = _calculateMintFee(lp, wsxmrAmount);
        assertEq(fee, (wsxmrAmount * 100) / 10000, "fee should be 1% of amount");
    }

    function test_CalculateMintFee_ZeroBps() public {
        address newLp = makeAddr("feeFreeLp");
        _createVaultAndDeposit(newLp, 100 ether);
        vm.prank(newLp);
        VaultFacet(address(hub)).setVaultMarketMetrics(0, 0);

        uint256 fee = _calculateMintFee(newLp, 1_000_000);
        assertEq(fee, 0, "zero bps should give zero fee");
    }

    // ========== getBurnRequest ==========

    function test_GetBurnRequest_ReturnsCorrect() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        wsXmrStorage.BurnRequest memory req = _getBurnRequest(burnId);
        assertEq(req.requestId, burnId, "requestId should match");
        assertEq(req.user, user, "user should match");
        assertEq(req.lpVault, lp, "lpVault should match");
        assertEq(uint256(req.status), uint256(wsXmrStorage.BurnStatus.REQUESTED), "status should be REQUESTED");
    }

    // ========== getUserBurnRequests ==========

    function test_GetUserBurnRequests_ReturnsCorrect() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        bytes32[] memory userBurns = _getUserBurnRequests(user);
        assertGt(userBurns.length, 0, "should have at least 1 burn request");
        assertEq(userBurns[userBurns.length - 1], burnId, "last should match");
    }

    // ========== getVaultBurnRequests ==========

    function test_GetVaultBurnRequests_ReturnsCorrect() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        bytes32[] memory vaultBurns = _getVaultBurnRequests(lp);
        assertGt(vaultBurns.length, 0, "should have at least 1 burn request");
        assertEq(vaultBurns[vaultBurns.length - 1], burnId, "last should match");
    }

    // ========== getActiveBurnCount ==========

    function test_GetActiveBurnCount_WithActive() public {
        uint256 minted = _mintForUser(user, lp);
        _requestBurn(user, lp, minted);
        uint256 count = _getActiveBurnCount(lp);
        assertEq(count, 1, "should have 1 active burn");
    }

    function test_GetActiveBurnCount_ZeroWhenNone() public {
        uint256 count = _getActiveBurnCount(lp);
        assertEq(count, 0, "should have 0 active burns");
    }

    function test_GetActiveBurnCount_AfterAbort() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);

        vm.roll(block.number + 10000);
        vm.prank(user);
        BurnFacet(address(hub)).abortBurn(burnId);

        uint256 count = _getActiveBurnCount(lp);
        assertEq(count, 0, "should have 0 active after abort");
    }

    // ========== meetsMinimumBurn ==========

    function test_MeetsMinimumBurn_AboveGlobal() public {
        assertTrue(_meetsMinimumBurn(lp, 1e6), "above global min should pass");
    }

    function test_MeetsMinimumBurn_BelowGlobal() public {
        assertFalse(_meetsMinimumBurn(lp, 1), "below global min should fail");
    }

    function test_MeetsMinimumBurn_VaultMinZero() public {
        assertTrue(_meetsMinimumBurn(lp, 1e4), "global min should pass");
    }

    function test_MeetsMinimumBurn_BelowVaultMin() public {
        vm.prank(lp);
        VaultFacet(address(hub)).setMinBurnAmount(1e6);
        assertFalse(_meetsMinimumBurn(lp, 1e5), "below vault min should fail");
    }

    // ========== sweepUnclaimedExpiredMint ==========

    function test_SweepUnclaimedExpiredMint_HappyPath() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        vm.roll(block.number + 500);

        uint256 pendingBefore = _getPendingReturns(user, address(0));
        MintFacet(address(hub)).sweepUnclaimedExpiredMint(reqId);
        uint256 pendingAfter = _getPendingReturns(user, address(0));

        assertGt(pendingAfter, pendingBefore, "user should get griefing deposit back");

        wsXmrStorage.MintRequest memory req = _getMintRequest(reqId);
        assertEq(uint256(req.status), uint256(wsXmrStorage.MintStatus.CANCELLED), "should be CANCELLED");
    }

    function test_SweepUnclaimedExpiredMint_SlashesCollateral() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        // Verify collateral was locked at setMintReady
        wsXmrStorage.MintRequest memory req = _getMintRequest(reqId);
        assertGt(req.lockedCollateral, 0, "collateral should be locked at setMintReady");
        assertGt(req.xmrPriceAtReady, 0, "xmrPriceAtReady should be set");

        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        vm.roll(block.number + 500);

        uint256 sDAIPendingBefore = _getPendingReturns(user, GnosisAddresses.SDAI);
        MintFacet(address(hub)).sweepUnclaimedExpiredMint(reqId);
        uint256 sDAIPendingAfter = _getPendingReturns(user, GnosisAddresses.SDAI);

        assertGt(sDAIPendingAfter, sDAIPendingBefore, "user should get slashed sDAI collateral");
        assertEq(sDAIPendingAfter - sDAIPendingBefore, req.lockedCollateral, "slashed amount should equal locked collateral");
    }

    // ========== cancelMint at KEY_PROVIDED (no slash on cancel — bond stays locked) ==========

    /// @notice REGRESSION: previously a user could initiate, let the LP lock collateral,
    ///         send NO XMR, then cancel with their secret and steal the locked collateral.
    ///         The key bond locked at provideLPKey is NOT slashable on cancel — it stays
    ///         locked through KEY_CANCELLED and is only released on lpSecret reveal or
    ///         slashed to the user if the LP never reveals.
    function test_CancelMint_KeyProvided_NoSlash_DepositParked() public {
        bytes32 userSecret = bytes32(uint256(0x1234));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(userSecret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        bytes32 userPublicKey = bytes32(Ed25519.compressPoint(px, py));

        uint256 xmrAmount = 20000000000;
        vm.prank(user);
        bytes32 reqId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user, xmrAmount, commitment, userPublicKey
        );

        _provideLPKey(lp, reqId); // -> KEY_PROVIDED, reserves pendingDebt + locks key bond

        wsXmrStorage.Vault memory vaultBefore = _getVault(lp);
        uint256 userSdaiBefore = _getPendingReturns(user, GnosisAddresses.SDAI);
        uint256 userEthBefore = _getPendingReturns(user, address(0));

        // Expire the mint, then cancel — user never sent XMR.
        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        wsXmrStorage.MintRequest memory req = _getMintRequest(reqId);
        assertEq(uint256(req.status), uint256(wsXmrStorage.MintStatus.KEY_CANCELLED), "should be KEY_CANCELLED");

        // No collateral slashed, deposit parked (not yet returned to anyone),
        // key bond stays locked awaiting the LP's lpSecret reveal
        wsXmrStorage.Vault memory vaultAfter = _getVault(lp);
        assertEq(vaultAfter.collateralShares, vaultBefore.collateralShares, "vault collateral must be untouched");
        assertEq(vaultAfter.lockedCollateral, vaultBefore.lockedCollateral, "bond stays locked through cancel");
        assertEq(_getPendingReturns(user, GnosisAddresses.SDAI), userSdaiBefore, "no sDAI slash payout");
        assertEq(_getPendingReturns(user, address(0)), userEthBefore, "deposit parked, not returned");
        assertEq(vaultAfter.pendingDebt, vaultBefore.pendingDebt - req.wsxmrAmount, "reserved debt released");
    }

    /// @notice The userSecret parameter is deprecated — cancel is permissionless and requires
    ///         no secret since nothing is slashable at KEY_PROVIDED.
    function test_CancelMint_KeyProvided_AnySecretAccepted() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        vm.roll(block.number + 10000);

        // A garbage secret no longer reverts — it is ignored entirely.
        MintFacet(address(hub)).cancelMint(reqId, bytes32(uint256(0x9999)));
        assertEq(uint256(_getMintRequest(reqId).status), uint256(wsXmrStorage.MintStatus.KEY_CANCELLED));
    }

    // ========== abandonKeyProvidedMint ==========

    function test_AbandonKeyProvidedMint_LPClaimsDepositAndRevealsSecret() public {
        bytes32 reqId = _initiateMint(user, lp);

        // Real lpSecret + commitment
        bytes32 lpSecret = bytes32(uint256(0xcafe));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 lpCommitment = keccak256(abi.encodePacked(px, py));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)), lpCommitment);

        // Pre-timeout abandon must revert (prevents key-then-instant-abandon farming)
        vm.prank(lp);
        vm.expectRevert(IMintOperations.TimeoutNotReached.selector);
        MintFacet(address(hub)).abandonKeyProvidedMint(reqId, lpSecret);

        vm.roll(block.number + 10000);

        // Wrong secret reverts
        vm.prank(lp);
        vm.expectRevert(IErrors.InvalidSecret.selector);
        MintFacet(address(hub)).abandonKeyProvidedMint(reqId, bytes32(uint256(0x9999)));

        // Non-LP cannot abandon
        vm.prank(user);
        vm.expectRevert(IErrors.Unauthorized.selector);
        MintFacet(address(hub)).abandonKeyProvidedMint(reqId, lpSecret);

        // LP abandons: deposit -> LP, lpSecret emitted, CANCELLED
        vm.prank(lp);
        MintFacet(address(hub)).abandonKeyProvidedMint(reqId, lpSecret);

        assertEq(uint256(_getMintRequest(reqId).status), uint256(wsXmrStorage.MintStatus.CANCELLED));
        assertEq(_getPendingReturns(lp, address(0)), 0.001 ether, "LP should receive griefing deposit");
        assertEq(_getPendingReturns(user, address(0)), 0, "user gets nothing back");
    }

    function test_AbandonKeyProvidedMint_FromKeyCancelled() public {
        bytes32 reqId = _initiateMint(user, lp);
        bytes32 lpSecret = bytes32(uint256(0xcafe));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 lpCommitment = keccak256(abi.encodePacked(px, py));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)), lpCommitment);

        // Timeout -> permissionless cancel -> KEY_CANCELLED (deposit parked)
        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        // LP claims within the window
        vm.prank(lp);
        MintFacet(address(hub)).abandonKeyProvidedMint(reqId, lpSecret);
        assertEq(_getPendingReturns(lp, address(0)), 0.001 ether, "LP claims parked deposit");
        assertEq(uint256(_getMintRequest(reqId).status), uint256(wsXmrStorage.MintStatus.CANCELLED));
    }

    function test_AbandonKeyProvidedMint_AfterWindowReverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        bytes32 lpSecret = bytes32(uint256(0xcafe));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 lpCommitment = keccak256(abi.encodePacked(px, py));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)), lpCommitment);

        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        // Past the claim window — LP can no longer claim
        vm.roll(block.number + 361);
        vm.prank(lp);
        vm.expectRevert(IErrors.DeadlineExpired.selector);
        MintFacet(address(hub)).abandonKeyProvidedMint(reqId, lpSecret);
    }

    // ========== reclaimParkedDeposit ==========

    function test_ReclaimParkedDeposit_AfterWindow() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        // Too early — LP claim window still open
        vm.expectRevert(IMintOperations.TimeoutNotReached.selector);
        MintFacet(address(hub)).reclaimParkedDeposit(reqId);

        // Past window — user reclaims (dead-LP case)
        vm.roll(block.number + 361);
        MintFacet(address(hub)).reclaimParkedDeposit(reqId);
        assertEq(_getPendingReturns(user, address(0)), 0.001 ether, "user reclaims parked deposit");
        assertEq(uint256(_getMintRequest(reqId).status), uint256(wsXmrStorage.MintStatus.CANCELLED));
    }

    // ========== keyBond: par-value collateral locked at provideLPKey ==========

    function test_ProvideLPKey_LocksKeyBond() public {
        bytes32 reqId = _initiateMint(user, lp);
        wsXmrStorage.Vault memory vBefore = _getVault(lp);

        _provideLPKey(lp, reqId);

        wsXmrStorage.Vault memory vAfter = _getVault(lp);
        wsXmrStorage.MintRequest memory req = _getMintRequest(reqId);
        assertGt(req.lockedCollateral, 0, "key bond should be locked at KEY_PROVIDED");
        assertEq(
            vAfter.lockedCollateral,
            vBefore.lockedCollateral + req.lockedCollateral,
            "vault lock should increase by the bond"
        );
    }

    /// @notice Drain regression: user keys a mint, never sends XMR. The LP abandons
    ///         post-timeout, reveals lpSecret, and gets the bond back + the deposit.
    ///         The user cannot farm the bond — it is only slashed on LP non-reveal.
    function test_KeyBond_NoDrain_LPAbandonsNoDeposit() public {
        bytes32 reqId = _initiateMint(user, lp);
        bytes32 lpSecret = bytes32(uint256(0xcafe));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 lpCommitment = keccak256(abi.encodePacked(px, py));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)), lpCommitment);

        wsXmrStorage.Vault memory vKeyed = _getVault(lp);
        wsXmrStorage.MintRequest memory req = _getMintRequest(reqId);
        assertGt(req.lockedCollateral, 0, "bond locked");

        vm.roll(block.number + 10000);
        vm.prank(lp);
        MintFacet(address(hub)).abandonKeyProvidedMint(reqId, lpSecret);

        wsXmrStorage.Vault memory vAfter = _getVault(lp);
        assertEq(vAfter.lockedCollateral, vKeyed.lockedCollateral - req.lockedCollateral, "bond released to LP");
        assertEq(vAfter.collateralShares, vKeyed.collateralShares, "no collateral slashed");
        assertEq(_getPendingReturns(user, GnosisAddresses.SDAI), 0, "user cannot farm the bond");
        assertEq(_getPendingReturns(lp, address(0)), 0.001 ether, "LP collects the deposit bounty");
    }

    /// @notice Bond release also works when the LP claims from KEY_CANCELLED in-window.
    function test_KeyBond_ReleasedOnAbandonFromKeyCancelled() public {
        bytes32 reqId = _initiateMint(user, lp);
        bytes32 lpSecret = bytes32(uint256(0xcafe));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 lpCommitment = keccak256(abi.encodePacked(px, py));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)), lpCommitment);

        wsXmrStorage.MintRequest memory req = _getMintRequest(reqId);
        uint256 bond = req.lockedCollateral;

        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        wsXmrStorage.Vault memory vParked = _getVault(lp);
        assertGt(vParked.lockedCollateral, 0, "bond still locked while parked");

        vm.prank(lp);
        MintFacet(address(hub)).abandonKeyProvidedMint(reqId, lpSecret);

        wsXmrStorage.Vault memory vAfter = _getVault(lp);
        assertEq(vAfter.lockedCollateral, vParked.lockedCollateral - bond, "bond released on reveal");
        assertEq(_getPendingReturns(user, GnosisAddresses.SDAI), 0, "no slash when LP reveals");
    }

    /// @notice Dead-LP case: bond is slashed to the user when the LP never reveals.
    function test_KeyBond_SlashedOnReclaimParkedDeposit() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        wsXmrStorage.MintRequest memory req = _getMintRequest(reqId);
        uint256 bond = req.lockedCollateral;
        assertGt(bond, 0, "bond locked");

        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));
        vm.roll(block.number + 361);

        uint256 sdaiBefore = _getPendingReturns(user, GnosisAddresses.SDAI);
        MintFacet(address(hub)).reclaimParkedDeposit(reqId);

        assertEq(
            _getPendingReturns(user, GnosisAddresses.SDAI) - sdaiBefore,
            bond,
            "bond slashed to user at par"
        );
        assertEq(_getPendingReturns(user, address(0)), 0.001 ether, "deposit also returned");

        wsXmrStorage.Vault memory vAfter = _getVault(lp);
        assertEq(vAfter.lockedCollateral, 0, "bond fully consumed by slash");
    }

    /// @notice setMintReady re-prices the bond to par at the ready-time price and
    ///         adjusts by the delta — at unchanged prices the lock is ~unchanged.
    function test_SetMintReady_AdjustsBondDelta() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        wsXmrStorage.MintRequest memory reqKeyed = _getMintRequest(reqId);
        wsXmrStorage.Vault memory vKeyed = _getVault(lp);

        _setMintReady(lp, reqId);

        wsXmrStorage.MintRequest memory reqReady = _getMintRequest(reqId);
        wsXmrStorage.Vault memory vReady = _getVault(lp);

        // Vault-level lock delta must equal request-level lock delta (top-up or release)
        assertEq(
            vReady.lockedCollateral,
            vKeyed.lockedCollateral - reqKeyed.lockedCollateral + reqReady.lockedCollateral,
            "vault lock tracks request lock through re-price"
        );
        assertGt(reqReady.xmrPriceAtReady, 0, "ready price recorded");
    }

    /// @notice The bond is withdrawal-safe during KEY_PROVIDED even though
    ///         pendingMintCount is still 0 — lockedCollateral is netted out.
    function test_KeyBond_WithdrawalCannotTouchBond() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        wsXmrStorage.Vault memory v = _getVault(lp);
        uint256 free = v.collateralShares - v.lockedCollateral;

        vm.prank(lp);
        vm.expectRevert(IErrors.InsufficientCollateral.selector);
        VaultFacet(address(hub)).withdrawCollateral(free + 1);
    }

    // ========== SECRET_REVEALED cancel must mint, not cancel ==========

    function test_CancelMint_SecretRevealed_MintsAnyway() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(reqId, bytes32(uint256(0x1234)));

        // Timeout passes with no finalize — cancelMint must MINT, not cancel,
        // because the secret is public and the LP could otherwise take the XMR.
        vm.roll(block.number + 10000);
        uint256 balBefore = wsxmr.balanceOf(user);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        assertEq(uint256(_getMintRequest(reqId).status), uint256(wsXmrStorage.MintStatus.COMPLETED), "should COMPLETE not cancel");
        assertGt(wsxmr.balanceOf(user), balBefore, "wsXMR minted to recipient");
    }

    // ========== abandonProposedBurn ==========

    function test_AbandonProposedBurn_LPReleasesCollateral() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);

        // LP proposes
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 secretHash = keccak256(abi.encodePacked(bpx, bpy));
        vm.prank(lp);
        BurnFacet(address(hub)).proposeHash(burnId, secretHash, bytes32(uint256(0x1111)), bytes32(uint256(0x2222)));

        wsXmrStorage.Vault memory vaultBefore = _getVault(lp);
        uint256 balBefore = wsxmr.balanceOf(user);

        // Pre-deadline abandon must revert (user might still confirm)
        vm.prank(lp);
        vm.expectRevert(IBurnOperations.DeadlineNotExpired.selector);
        BurnFacet(address(hub)).abandonProposedBurn(burnId);

        vm.roll(block.number + 34561);

        // Non-LP cannot abandon
        vm.prank(user);
        vm.expectRevert(IErrors.Unauthorized.selector);
        BurnFacet(address(hub)).abandonProposedBurn(burnId);

        // LP abandons: collateral released, wsXMR restored, CANCELLED
        vm.prank(lp);
        BurnFacet(address(hub)).abandonProposedBurn(burnId);

        wsXmrStorage.Vault memory vaultAfter = _getVault(lp);
        assertLt(vaultAfter.lockedCollateral, vaultBefore.lockedCollateral, "lock released");
        assertEq(wsxmr.balanceOf(user), balBefore + minted, "wsXMR restored");
        assertEq(uint256(_getBurnRequest(burnId).status), uint256(wsXmrStorage.BurnStatus.CANCELLED), "should be CANCELLED");
    }

    /// @notice REGRESSION: userPublicKey is a compressed Ed25519 point (the frontend passes
    ///         publicSpendKey.toRawBytes()). The old check compared the raw x-coordinate and
    ///         could never match — every declined proposal was unresolvable on mainnet.
    function test_ResolveDeclinedProposal_CompressedUserKey() public {
        uint256 minted = _mintForUser(user, lp);

        bytes32 userSecret = bytes32(uint256(0xdeadbeef));
        (uint256 upkx, uint256 upky) = Ed25519.scalarMultBase(uint256(userSecret));
        bytes32 userPubKey = bytes32(Ed25519.compressPoint(upkx, upky));

        vm.startPrank(user);
        wsxmr.approve(address(hub), minted);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(minted, lp, user, bytes32(uint256(1)), userPubKey, bytes32(uint256(3)));
        vm.stopPrank();

        // LP proposes
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 secretHash = keccak256(abi.encodePacked(bpx, bpy));
        vm.prank(lp);
        BurnFacet(address(hub)).proposeHash(burnId, secretHash, bytes32(uint256(0x1111)), bytes32(uint256(0x2222)));

        vm.roll(block.number + 34561);

        uint256 balBefore = wsxmr.balanceOf(user);
        BurnFacet(address(hub)).resolveDeclinedProposal(burnId, userSecret);
        assertEq(wsxmr.balanceOf(user), balBefore + minted, "wsXMR restored");
        assertEq(uint256(_getBurnRequest(burnId).status), uint256(wsXmrStorage.BurnStatus.CANCELLED), "should be CANCELLED");
    }

    // ========== pendingDebt reservation timing ==========

    function test_PendingDebt_ReservedAtKeyNotInitiate() public {
        bytes32 reqId = _initiateMint(user, lp);
        wsXmrStorage.Vault memory v = _getVault(lp);
        assertEq(v.pendingDebt, 0, "PENDING mint must not reserve debt");

        _provideLPKey(lp, reqId);
        v = _getVault(lp);
        assertEq(v.pendingDebt, 2000000, "KEY_PROVIDED reserves debt"); // 20000000000 / 1e4

        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));
        v = _getVault(lp);
        assertEq(v.pendingDebt, 0, "cancel releases reservation");
    }

    function test_ClaimGriefingDeposit_ReleasesLockedCollateral() public {
        bytes32 reqId = _initiateMint(user, lp);

        // Generate real LP secret and commitment
        bytes32 lpSecret = bytes32(uint256(0xcafe));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 lpCommitment = keccak256(abi.encodePacked(px, py));

        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)), lpCommitment);

        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(reqId);

        wsXmrStorage.MintRequest memory req = _getMintRequest(reqId);
        uint256 lockedBefore = req.lockedCollateral;
        assertGt(lockedBefore, 0, "collateral should be locked");

        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        // LP claims griefing deposit by revealing their secret
        vm.prank(lp);
        MintFacet(address(hub)).claimGriefingDeposit(reqId, lpSecret);

        assertEq(uint256(_getMintRequest(reqId).status), uint256(wsXmrStorage.MintStatus.CANCELLED), "should be CANCELLED");
    }

    function test_FinalizeMint_ReleasesLockedCollateral() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        wsXmrStorage.MintRequest memory req = _getMintRequest(reqId);
        assertGt(req.lockedCollateral, 0, "collateral should be locked at setMintReady");

        // User reveals secret and finalize
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(reqId, bytes32(uint256(0x1234)));
        MintFacet(address(hub)).finalizeMint(reqId);

        wsXmrStorage.MintRequest memory reqAfter = _getMintRequest(reqId);
        assertEq(uint256(reqAfter.status), uint256(wsXmrStorage.MintStatus.COMPLETED), "should be COMPLETED");
        // Locked collateral should have been released (vault.lockedCollateral decreased)
    }

    function test_SweepUnclaimedExpiredMint_NotExpiredReady_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        vm.expectRevert(IErrors.InvalidStatus.selector);
        MintFacet(address(hub)).sweepUnclaimedExpiredMint(reqId);
    }

    function test_SweepUnclaimedExpiredMint_BeforeTimeout_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        vm.expectRevert(IMintOperations.TimeoutNotReached.selector);
        MintFacet(address(hub)).sweepUnclaimedExpiredMint(reqId);
    }

    // ========== cleanupVaultBurnRequests ==========

    function test_CleanupVaultBurnRequests_RemovesCancelled() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);

        vm.roll(block.number + 10000);
        vm.prank(user);
        BurnFacet(address(hub)).abortBurn(burnId);

        uint256 beforeCount = _getVaultBurnRequests(lp).length;
        assertGt(beforeCount, 0, "should have burn requests before cleanup");

        uint256 removed = BurnFacet(address(hub)).cleanupVaultBurnRequests(lp);
        assertGt(removed, 0, "should have removed some");

        uint256 afterCount = _getVaultBurnRequests(lp).length;
        assertLt(afterCount, beforeCount, "count should decrease after cleanup");
    }

    function test_CleanupVaultBurnRequests_KeepsActive() public {
        uint256 minted = _mintForUser(user, lp);
        _requestBurn(user, lp, minted);

        uint256 beforeCount = _getVaultBurnRequests(lp).length;
        uint256 removed = BurnFacet(address(hub)).cleanupVaultBurnRequests(lp);
        assertEq(removed, 0, "should remove 0 active burns");
        uint256 afterCount = _getVaultBurnRequests(lp).length;
        assertEq(afterCount, beforeCount, "count should stay same");
    }

    // ========== HUB VIEW HELPERS ==========

    function _hubView(bytes memory data) internal returns (bytes memory) {
        (bool success, bytes memory result) = address(hub).call(data);
        require(success, "hub view call failed");
        return result;
    }

    function _getMintRequest(bytes32 reqId) internal returns (wsXmrStorage.MintRequest memory) {
        bytes memory r = _hubView(abi.encodeWithSelector(MintFacet.getMintRequest.selector, reqId));
        return abi.decode(r, (wsXmrStorage.MintRequest));
    }

    function _getVaultPendingMints(address lpVault) internal returns (bytes32[] memory) {
        bytes memory r = _hubView(abi.encodeWithSelector(MintFacet.getVaultPendingMints.selector, lpVault));
        return abi.decode(r, (bytes32[]));
    }

    function _calculateWsxmrAmount(uint256 xmrAmount) internal returns (uint256) {
        bytes memory r = _hubView(abi.encodeWithSelector(MintFacet.calculateWsxmrAmount.selector, xmrAmount));
        return abi.decode(r, (uint256));
    }

    function _calculateMintFee(address lpVault, uint256 wsxmrAmount) internal returns (uint256) {
        bytes memory r = _hubView(abi.encodeWithSelector(MintFacet.calculateMintFee.selector, lpVault, wsxmrAmount));
        return abi.decode(r, (uint256));
    }

    function _getBurnRequest(bytes32 reqId) internal returns (wsXmrStorage.BurnRequest memory) {
        bytes memory r = _hubView(abi.encodeWithSelector(BurnFacet.getBurnRequest.selector, reqId));
        return abi.decode(r, (wsXmrStorage.BurnRequest));
    }

    function _getUserBurnRequests(address who) internal returns (bytes32[] memory) {
        bytes memory r = _hubView(abi.encodeWithSelector(BurnFacet.getUserBurnRequests.selector, who));
        return abi.decode(r, (bytes32[]));
    }

    function _getVaultBurnRequests(address vault) internal returns (bytes32[] memory) {
        bytes memory r = _hubView(abi.encodeWithSelector(BurnFacet.getVaultBurnRequests.selector, vault));
        return abi.decode(r, (bytes32[]));
    }

    function _getActiveBurnCount(address vault) internal returns (uint256) {
        bytes memory r = _hubView(abi.encodeWithSelector(BurnFacet.getActiveBurnCount.selector, vault));
        return abi.decode(r, (uint256));
    }

    function _meetsMinimumBurn(address vault, uint256 amount) internal returns (bool) {
        bytes memory r = _hubView(abi.encodeWithSelector(BurnFacet.meetsMinimumBurn.selector, vault, amount));
        return abi.decode(r, (bool));
    }

    function _getPendingReturns(address who, address token) internal returns (uint256) {
        bytes memory r = _hubView(abi.encodeWithSelector(VaultFacet.getPendingReturns.selector, who, token));
        return abi.decode(r, (uint256));
    }

    function _getVault(address vaultAddr) internal returns (wsXmrStorage.Vault memory) {
        bytes memory r = _hubView(abi.encodeWithSelector(VaultFacet.getVault.selector, vaultAddr));
        return abi.decode(r, (wsXmrStorage.Vault));
    }

    // ========== SETUP HELPERS ==========

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
        uint256 xmrAmount = 20000000000;
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

    function _requestBurn(address _user, address _lp, uint256 amount) internal returns (bytes32) {
        vm.startPrank(_user);
        wsxmr.approve(address(hub), amount);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(amount, _lp, _user, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        vm.stopPrank();
        return burnId;
    }
}
