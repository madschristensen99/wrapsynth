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

contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

/**
 * @title Burn Solvency Invariant Tests
 * @notice Regression tests for burn settlement accounting (Fix 1 + Fix 2)
 * @dev Forks Gnosis for sDAI interactions
 */
contract BurnSolvencyInvariantTest is Test {
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
    address liquidator = makeAddr("liquidator");

    uint256 constant XMR_PRICE_8DEC = 390_00000000; // $390 in 8 decimals
    uint256 constant DAI_PRICE_8DEC = 1_00000000;   // $1 in 8 decimals

    function setUp() public {
        string memory rpcUrl = vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"));
        vm.createSelectFork(rpcUrl);

        vm.deal(address(this), 1_000_000 ether);
        vm.deal(lp, 1000 ether);
        vm.deal(user, 1000 ether);
        vm.deal(liquidator, 1000 ether);

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
    }

    // ========== FIX 1: SOLVENCY INVARIANTS ==========

    /// @notice After finalizeBurn, collateralShares must decrease by exactly the reward paid out.
    function test_F1_FinalizeBurn_ReducesCollateralShares() public {
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();
        _configureVault(lp);

        uint256 minted = _mintForUser(user, lp);

        // Request burn
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(minted, lp, user, bytes32(uint256(1)));

        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));

        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        wsXmrStorage.Vault memory vaultBefore = _getVault(lp);
        uint256 sharesBefore = vaultBefore.collateralShares;
        uint256 lockedBefore = vaultBefore.lockedCollateral;

        // Finalize
        vm.prank(lp);
        BurnFacet(address(hub)).finalizeBurn(burnId, burnSecret);

        wsXmrStorage.Vault memory vaultAfter = _getVault(lp);
        uint256 sharesAfter = vaultAfter.collateralShares;
        uint256 lockedAfter = vaultAfter.lockedCollateral;

        wsXmrStorage.BurnRequest memory req = _getBurnRequest(burnId);

        // Reward only is paid out (base stays in vault)
        assertEq(sharesBefore - sharesAfter, req.rewardCollateral, "collateralShares must drop by reward");
        assertEq(lockedBefore - lockedAfter, req.lockedCollateral + req.rewardCollateral, "lockedCollateral must drop by total reservation");
        assertEq(uint256(req.status), uint256(wsXmrStorage.BurnStatus.COMPLETED), "Should be COMPLETED");

        // Solvency invariant: total vault shares + pending + war chest == hub sDAI balance
        _assertSolvencyInvariant();
    }

    /// @notice After claimSlashedCollateral, collateralShares must decrease by exactly userPayout (par + reward).
    function test_F1_ClaimSlashedCollateral_ReducesCollateralShares() public {
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();
        _configureVault(lp);

        uint256 minted = _mintForUser(user, lp);

        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(minted, lp, user, bytes32(uint256(1)));

        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));

        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        wsXmrStorage.Vault memory vaultBefore = _getVault(lp);
        uint256 sharesBefore = vaultBefore.collateralShares;
        uint256 lockedBefore = vaultBefore.lockedCollateral;

        // Warp past deadline
        vm.roll(block.number + 34561);

        vm.prank(user);
        BurnFacet(address(hub)).claimSlashedCollateral(burnId);

        wsXmrStorage.Vault memory vaultAfter = _getVault(lp);
        uint256 sharesAfter = vaultAfter.collateralShares;
        uint256 lockedAfter = vaultAfter.lockedCollateral;

        wsXmrStorage.BurnRequest memory req = _getBurnRequest(burnId);
        uint256 userPayout = _getPendingReturns(user, GnosisAddresses.SDAI);

        assertEq(sharesBefore - sharesAfter, userPayout, "collateralShares must drop by userPayout");
        assertEq(lockedBefore - lockedAfter, req.lockedCollateral + req.rewardCollateral, "lockedCollateral must drop by total reservation");
        assertEq(uint256(req.status), uint256(wsXmrStorage.BurnStatus.SLASHED), "Should be SLASHED");

        _assertSolvencyInvariant();
    }

    /// @notice After forceSettleBurn, collateralShares must decrease by exactly userBase (par, no reward).
    function test_F1_ForceSettleBurn_ReducesCollateralShares() public {
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();
        _configureVault(lp);

        uint256 minted = _mintForUser(user, lp);

        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(minted, lp, user, bytes32(uint256(1)));

        wsXmrStorage.Vault memory vaultBefore = _getVault(lp);
        uint256 sharesBefore = vaultBefore.collateralShares;
        uint256 lockedBefore = vaultBefore.lockedCollateral;

        // Warp past request timeout
        vm.roll(block.number + 34561);

        vm.prank(user);
        BurnFacet(address(hub)).forceSettleBurn(burnId);

        wsXmrStorage.Vault memory vaultAfter = _getVault(lp);
        uint256 sharesAfter = vaultAfter.collateralShares;
        uint256 lockedAfter = vaultAfter.lockedCollateral;

        wsXmrStorage.BurnRequest memory req = _getBurnRequest(burnId);
        uint256 userBase = _getPendingReturns(user, GnosisAddresses.SDAI);

        assertEq(sharesBefore - sharesAfter, userBase, "collateralShares must drop by userBase");
        assertEq(lockedBefore - lockedAfter, req.lockedCollateral + req.rewardCollateral, "lockedCollateral must drop by total reservation");
        assertEq(uint256(req.status), uint256(wsXmrStorage.BurnStatus.SLASHED), "Should be SLASHED");

        _assertSolvencyInvariant();
    }

    /// @notice abortBurn must leave collateralShares untouched (only releases lock).
    function test_F1_AbortBurn_LeavesCollateralShares() public {
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();
        _configureVault(lp);

        uint256 minted = _mintForUser(user, lp);

        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(minted, lp, user, bytes32(uint256(1)));

        wsXmrStorage.Vault memory vaultBefore = _getVault(lp);
        uint256 sharesBefore = vaultBefore.collateralShares;
        uint256 lockedBefore = vaultBefore.lockedCollateral;

        // Warp past request timeout
        vm.roll(block.number + 34561);

        vm.prank(user);
        BurnFacet(address(hub)).abortBurn(burnId);

        wsXmrStorage.Vault memory vaultAfter = _getVault(lp);
        uint256 sharesAfter = vaultAfter.collateralShares;
        uint256 lockedAfter = vaultAfter.lockedCollateral;

        wsXmrStorage.BurnRequest memory req = _getBurnRequest(burnId);

        assertEq(sharesBefore, sharesAfter, "collateralShares must NOT change on abort");
        assertEq(lockedBefore - lockedAfter, req.lockedCollateral + req.rewardCollateral, "lockedCollateral must drop by total reservation");
        assertEq(uint256(req.status), uint256(wsXmrStorage.BurnStatus.CANCELLED), "Should be CANCELLED");
        assertEq(wsxmr.balanceOf(user), minted, "wsXMR must be restored to user");

        _assertSolvencyInvariant();
    }

    /// @notice resolveDeclinedProposal must leave collateralShares untouched.
    function test_F1_ResolveDeclinedProposal_LeavesCollateralShares() public {
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();
        _configureVault(lp);

        uint256 minted = _mintForUser(user, lp);

        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(minted, lp, user, bytes32(uint256(1)));

        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));

        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);

        wsXmrStorage.Vault memory vaultBefore = _getVault(lp);
        uint256 sharesBefore = vaultBefore.collateralShares;
        uint256 lockedBefore = vaultBefore.lockedCollateral;

        // Warp past proposal timeout
        vm.roll(block.number + 34561);

        vm.prank(lp);
        BurnFacet(address(hub)).resolveDeclinedProposal(burnId);

        wsXmrStorage.Vault memory vaultAfter = _getVault(lp);
        uint256 sharesAfter = vaultAfter.collateralShares;
        uint256 lockedAfter = vaultAfter.lockedCollateral;

        wsXmrStorage.BurnRequest memory req = _getBurnRequest(burnId);

        assertEq(sharesBefore, sharesAfter, "collateralShares must NOT change on resolve");
        assertEq(lockedBefore - lockedAfter, req.lockedCollateral + req.rewardCollateral, "lockedCollateral must drop by total reservation");
        assertEq(uint256(req.status), uint256(wsXmrStorage.BurnStatus.CANCELLED), "Should be CANCELLED");
        assertEq(wsxmr.balanceOf(user), minted, "wsXMR must be restored to user");

        _assertSolvencyInvariant();
    }

    /// @notice Double-spend regression: after slash payout, LP cannot withdraw the par amount paid to redeemer.
    function test_F1_DoubleSpendRegression_LPWithdrawAfterSlash() public {
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();
        _configureVault(lp);

        uint256 minted = _mintForUser(user, lp);

        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(minted, lp, user, bytes32(uint256(1)));

        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));

        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        // Warp past deadline
        vm.roll(block.number + 34561);

        wsXmrStorage.Vault memory vaultBeforeSlash = _getVault(lp);
        uint256 availableBeforeSlash = vaultBeforeSlash.collateralShares - vaultBeforeSlash.lockedCollateral;

        vm.prank(user);
        BurnFacet(address(hub)).claimSlashedCollateral(burnId);

        uint256 userPayout = _getPendingReturns(user, GnosisAddresses.SDAI);
        assertGt(userPayout, 0, "User should have received payout");

        wsXmrStorage.Vault memory vaultAfterSlash = _getVault(lp);
        uint256 availableAfterSlash = vaultAfterSlash.collateralShares - vaultAfterSlash.lockedCollateral;

        // Available increases by the unspent buffer (lock - payout) because the lock
        // is released and only part of it is paid out to the user.
        wsXmrStorage.BurnRequest memory req = _getBurnRequest(burnId);
        uint256 totalLock = req.lockedCollateral + req.rewardCollateral;
        assertEq(
            availableAfterSlash,
            availableBeforeSlash + (totalLock - userPayout),
            "Available collateral should increase by unspent buffer"
        );

        // Without Fix 1, available would be availableBeforeSlash + totalLock (collateralShares not reduced).
        // With Fix 1, available is availableBeforeSlash + totalLock - userPayout.
        // Verify the paid-out amount is excluded from collateralShares.
        assertLt(
            availableAfterSlash,
            availableBeforeSlash + totalLock,
            "available must exclude the paid-out userPayout from collateralShares"
        );

        // LP should NOT be able to withdraw more than available (bounded by collateralShares - lockedCollateral)
        vm.prank(lp);
        vm.expectRevert();
        VaultFacet(address(hub)).withdrawCollateral(availableAfterSlash + 1);

        // LP can withdraw a small amount that leaves the vault above 150% CR
        // (withdrawing ALL available would leave 0 for debt coverage, which reverts)
        uint256 smallWithdraw = availableAfterSlash > 1 ether ? 1 ether : availableAfterSlash / 2;
        if (smallWithdraw > 0) {
            vm.prank(lp);
            VaultFacet(address(hub)).withdrawCollateral(smallWithdraw);
        }
    }

    /// @notice Liquidation of a vault with a COMMITTED burn must settle it and reduce collateralShares.
    function test_F1_Liquidation_SettlesCommittedBurn_ReducesCollateralShares() public {
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();
        _configureVault(lp);

        // Mint a larger amount so the vault can become liquidatable after price manipulation
        uint256 largeXmrAmount = 100_000000000; // 1000 XMR -> 10M wsXMR
        uint256 minted = _performMint(lp, user, largeXmrAmount);

        // Create a burn request and commit it
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(minted / 2, lp, user, bytes32(uint256(1)));

        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));

        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        // Liquidator needs wsXMR - mint BEFORE depegging so initiateMint sees normal prices
        // Must be enough to cover the debt being liquidated (~3.6M+ wsXMR after burn settles)
        _performMint(lp, liquidator, 50_000000000);

        // Depeg DAI to $0.20 to make vault liquidatable (burn reduced debt but collateral still matters)
        SimpleOracleFacet(address(hub)).updatePrices(XMR_PRICE_8DEC, 20000000); // $0.20 DAI (8 decimals)

        wsXmrStorage.Vault memory vaultBefore = _getVault(lp);
        uint256 sharesBefore = vaultBefore.collateralShares;

        vm.startPrank(liquidator);
        uint256 debtToClear = hub.getVaultDebt(lp);
        LiquidationFacet(address(hub)).liquidate(lp, debtToClear);
        vm.stopPrank();

        wsXmrStorage.Vault memory vaultAfter = _getVault(lp);
        uint256 sharesAfter = vaultAfter.collateralShares;

        wsXmrStorage.BurnRequest memory req = _getBurnRequest(burnId);
        assertEq(uint256(req.status), uint256(wsXmrStorage.BurnStatus.SLASHED), "Burn should be settled as SLASHED");

        uint256 userPayout = _getPendingReturns(user, GnosisAddresses.SDAI);
        assertGt(userPayout, 0, "User should have received payout from settled burn");

        // collateralShares should have decreased by at least userPayout (plus any seizure)
        assertLe(sharesAfter, sharesBefore - userPayout, "collateralShares must drop by at least userPayout");

        _assertSolvencyInvariant();
    }

    /// @notice proposeHash must revert if the request deadline has expired.
    ///         This prevents LP front-running after timeout to block holder's forceSettleBurn.
    function test_ProposeHash_AfterDeadline_Reverts() public {
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();
        _configureVault(lp);

        uint256 minted = _mintForUser(user, lp);

        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(minted, lp, user, bytes32(uint256(1)));

        // Roll past the request timeout
        vm.roll(block.number + 34561);

        // LP should NOT be able to propose after deadline
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));

        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        vm.expectRevert(IErrors.DeadlineExpired.selector);
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);

        // Holder can now force-settle and receive par
        vm.prank(user);
        BurnFacet(address(hub)).forceSettleBurn(burnId);

        wsXmrStorage.BurnRequest memory req = _getBurnRequest(burnId);
        assertEq(uint256(req.status), uint256(wsXmrStorage.BurnStatus.SLASHED), "Should be SLASHED after force settle");

        uint256 userBase = _getPendingReturns(user, GnosisAddresses.SDAI);
        assertGt(userBase, 0, "User should receive par value");
    }

    // ========== FIX 2: LOCK RATIO ==========

    /// @notice calculateBurnCollateral must reserve ~110% of par (not ~195%).
    function test_F2_BurnLockRatio_Is110PercentOfPar() public {
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();
        _configureVault(lp);

        uint256 wsxmrAmount = 1e8; // 1 wsXMR

        (uint256 baseLock, uint256 rewardLock) = _calculateBurnCollateral(lp, wsxmrAmount);

        // Compute expected par in shares
        uint256 xmrPrice = uint256(uint192(hub.lastXmrPrice())) * 1e10;
        uint256 collateralPrice = uint256(uint192(hub.lastCollateralPrice())) * 1e10;

        uint256 parUsd = (wsxmrAmount * xmrPrice) / 1e8;
        uint256 parDai = (parUsd * 1e18) / collateralPrice;
        uint256 parShares = _daiToShares(parDai);

        // baseLock should be ~110% of par shares
        assertApproxEqRel(baseLock, (parShares * 110) / 100, 0.01e18, "baseLock should be ~110% of par");

        // With 100 bps burn reward, rewardLock should be ~1% of par shares
        uint256 expectedReward = (parShares * 100) / 10000;
        assertApproxEqRel(rewardLock, expectedReward, 0.01e18, "rewardLock should be burnRewardBps% of par");
    }

    /// @notice Slash-side (claimSlashedCollateral) and lock-side (calculateBurnCollateral)
    ///         must use consistent conversion inputs so par round-trips.
    function test_F2_LockAndSlashSide_ParRoundTrip() public {
        _createVaultAndDeposit(lp, 100 ether);
        _updatePrices();
        _configureVault(lp);

        uint256 minted = _mintForUser(user, lp);

        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(minted, lp, user, bytes32(uint256(1)));

        wsXmrStorage.BurnRequest memory req = _getBurnRequest(burnId);

        // Warp and slash
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));

        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        vm.roll(block.number + 34561);

        wsXmrStorage.Vault memory vaultBefore = _getVault(lp);

        vm.prank(user);
        BurnFacet(address(hub)).claimSlashedCollateral(burnId);

        uint256 userPayout = _getPendingReturns(user, GnosisAddresses.SDAI);

        // The userBase portion of payout should not exceed the locked base (it was computed from same par)
        assertLe(userPayout, req.lockedCollateral + req.rewardCollateral, "Payout must not exceed total lock");

        // The vault's available collateral should have decreased by exactly the payout
        wsXmrStorage.Vault memory vaultAfter = _getVault(lp);
        uint256 availableBefore = vaultBefore.collateralShares - vaultBefore.lockedCollateral;
        uint256 availableAfter = vaultAfter.collateralShares - vaultAfter.lockedCollateral;
        // Available increases by the unspent buffer (lock - payout)
        assertEq(
            availableAfter,
            availableBefore + (req.lockedCollateral + req.rewardCollateral - userPayout),
            "Unspent buffer should return to available"
        );
    }

    // ========== INVARIANT HELPERS ==========

    function _assertSolvencyInvariant() internal {
        uint256 totalVaultShares = 0;
        uint256 vaultCount = hub.getVaultCount();
        for (uint256 i = 0; i < vaultCount; i++) {
            address vaultAddr = hub.vaultList(i);
            wsXmrStorage.Vault memory v = _getVault(vaultAddr);
            totalVaultShares += v.collateralShares;
        }

        uint256 pendingSDAI = hub.globalPendingSDAI();
        uint256 warChest = hub.yieldWarChest();
        uint256 hubBalance = IERC20(GnosisAddresses.SDAI).balanceOf(address(hub));

        assertEq(
            totalVaultShares + pendingSDAI + warChest,
            hubBalance,
            "Solvency invariant: vault shares + pending + war chest == hub sDAI balance"
        );
    }

    // ========== HELPERS ==========

    function _updatePrices() internal {
        SimpleOracleFacet(address(hub)).updatePrices(XMR_PRICE_8DEC, DAI_PRICE_8DEC);
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
        VaultFacet(address(hub)).setMintReadyBond(0.001 ether);
        VaultFacet(address(hub)).setVaultMarketMetrics(100, 100); // 1% fees / 1% reward
        vm.stopPrank();
    }

    function _mintForUser(address _user, address _lp) internal returns (uint256) {
        uint256 xmrAmount = 20000000000; // 0.2 XMR
        return _performMint(_lp, _user, xmrAmount);
    }

    function _performMint(address _lp, address _user, uint256 xmrAmount) internal returns (uint256) {
        bytes32 secret = bytes32(uint256(uint160(_user)));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));

        vm.prank(_user);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(_lp, _user, xmrAmount, commitment, bytes32(uint256(0xdeadbeef)));

        bytes32 lpPublicKey = bytes32(uint256(0xdeadbeef));
        vm.prank(_lp);
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey, lpPublicKey);

        vm.prank(_lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(requestId);

        vm.prank(_user);
        MintFacet(address(hub)).finalizeMint(requestId, secret);

        return wsxmr.balanceOf(_user);
    }

    function _getPendingReturns(address who, address token) internal returns (uint256) {
        (bool success, bytes memory result) = address(hub).call(
            abi.encodeWithSelector(VaultFacet.getPendingReturns.selector, who, token)
        );
        require(success, "hub view call failed");
        return abi.decode(result, (uint256));
    }

    function _getVault(address vaultAddr) internal returns (wsXmrStorage.Vault memory) {
        (bool success, bytes memory result) = address(hub).call(
            abi.encodeWithSelector(VaultFacet.getVault.selector, vaultAddr)
        );
        require(success, "hub view call failed");
        return abi.decode(result, (wsXmrStorage.Vault));
    }

    function _getBurnRequest(bytes32 burnId) internal returns (wsXmrStorage.BurnRequest memory) {
        (bool success, bytes memory result) = address(hub).call(
            abi.encodeWithSelector(BurnFacet.getBurnRequest.selector, burnId)
        );
        require(success, "hub view call failed");
        return abi.decode(result, (wsXmrStorage.BurnRequest));
    }

    function _calculateBurnCollateral(address lpVault, uint256 wsxmrAmount) internal returns (uint256 baseLock, uint256 rewardLock) {
        (bool success, bytes memory result) = address(hub).call(
            abi.encodeWithSelector(BurnFacet.calculateBurnCollateral.selector, lpVault, wsxmrAmount)
        );
        require(success, "hub view call failed");
        (baseLock, rewardLock) = abi.decode(result, (uint256, uint256));
    }

    function _daiToShares(uint256 daiAmount) internal view returns (uint256) {
        (bool success, bytes memory data) = GnosisAddresses.SDAI.staticcall(
            abi.encodeWithSignature("convertToShares(uint256)", daiAmount)
        );
        require(success && data.length >= 32, "convertToShares failed");
        return abi.decode(data, (uint256));
    }
}
