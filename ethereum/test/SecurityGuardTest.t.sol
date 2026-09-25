// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {HyperEVMTestBase} from "./HyperEVMTestBase.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";
import {HyperCoreOracleFacet} from "../contracts/facets/HyperCoreOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ed25519} from "../contracts/Ed25519.sol";
import {IErrors} from "../contracts/interfaces/IErrors.sol";
import {IwsXmrHub} from "../contracts/interfaces/core/IwsXmrHub.sol";
import {IBurnOperations} from "../contracts/interfaces/swap/IBurnOperations.sol";
import {IMintOperations} from "../contracts/interfaces/swap/IMintOperations.sol";

/**
 * @title Security Guard Tests
 * @notice High-value tests for authorization, state ordering, and deadline enforcement
 * @dev These tests target security-critical revert paths, not trivial input validation
 */
contract SecurityGuardTest is HyperEVMTestBase {
    address lp2 = makeAddr("lp2");
    address attacker = makeAddr("attacker");
    address keeper = makeAddr("keeper");

    bytes32 constant TEST_USER_SECRET = bytes32(uint256(0xdeadbeef));

    function setUp() public override {
        super.setUp();
        vm.deal(lp2, 1000 ether);
        vm.deal(attacker, 1000 ether);
        vm.deal(keeper, 1000 ether);

        // Standard vault setup for LP
        _createVaultAndDeposit(lp, 100 ether);
        _configureVault(lp);
    }

    // ========== MINT: AUTHORIZATION ==========

    /// @notice Non-LP cannot call provideLPKey
    function test_Mint_ProvideLPKey_NonLP_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);

        vm.prank(attacker);
        vm.expectRevert(IErrors.Unauthorized.selector);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)), bytes32(uint256(0xdeadbeef)));
    }

    /// @notice Non-LP cannot call setMintReady
    function test_Mint_SetMintReady_NonLP_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        vm.prank(attacker);
        vm.expectRevert(IErrors.Unauthorized.selector);
        MintFacet(address(hub)).setMintReady(reqId);
    }

    /// @notice Non-LP cannot claim griefing deposit on expired ready mint
    function test_Mint_ClaimGriefingDeposit_NonLP_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        // Warp past READY timeout, then cancelMint to reach EXPIRED_READY
        vm.roll(block.number + 50000);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        vm.prank(attacker);
        vm.expectRevert(IErrors.Unauthorized.selector);
        MintFacet(address(hub)).claimGriefingDeposit(reqId, bytes32(uint256(0xdeadbeef)));
    }

    // ========== MINT: STATE ORDERING ==========

    /// @notice finalizeMint on a PENDING request (before provideLPKey) must revert
    function test_Mint_FinalizeMint_OnPending_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);

        vm.prank(user);
        vm.expectRevert(IErrors.InvalidStatus.selector);
        MintFacet(address(hub)).revealSecret(reqId, bytes32(uint256(0x1234)));
    }

    /// @notice finalizeMint with wrong secret must revert
    function test_Mint_FinalizeMint_WrongSecret_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        vm.prank(user);
        vm.expectRevert(IErrors.InvalidSecret.selector);
        MintFacet(address(hub)).revealSecret(reqId, bytes32(uint256(0xbadbad)));
    }

    /// @notice provideLPKey on already-provided request must revert
    function test_Mint_ProvideLPKey_AlreadyProvided_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        vm.prank(lp);
        vm.expectRevert(IErrors.InvalidStatus.selector);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)), bytes32(uint256(0xdeadbeef)));
    }

    // ========== MINT: DEADLINE ENFORCEMENT ==========

    /// @notice cancelMint before timeout must revert
    function test_Mint_CancelMint_BeforeTimeout_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);

        vm.prank(user);
        vm.expectRevert(IMintOperations.TimeoutNotReached.selector);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));
    }

    /// @notice provideLPKey after deadline must revert
    function test_Mint_ProvideLPKey_AfterDeadline_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);

        // Warp past timeout
        vm.roll(block.number + 50000);

        vm.prank(lp);
        vm.expectRevert(IErrors.DeadlineExpired.selector);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)), bytes32(uint256(0xdeadbeef)));
    }

    /// @notice setMintReady after deadline must revert
    function test_Mint_SetMintReady_AfterDeadline_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        // Warp past timeout
        vm.roll(block.number + 50000);

        vm.prank(lp);
        vm.expectRevert(IErrors.DeadlineExpired.selector);
        MintFacet(address(hub)).setMintReady(reqId);
    }

    // ========== BURN: AUTHORIZATION ==========

    /// @notice Non-user cannot call requestBurn (msg.sender must == user)
    function test_Burn_RequestBurn_NonUser_Reverts() public {
        uint256 minted = _mintForUser(user, lp);

        vm.prank(attacker);
        vm.expectRevert(IBurnOperations.OnlyUserCanInitiate.selector);
        BurnFacet(address(hub)).requestBurn(minted, lp, user, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
    }

    /// @notice Non-router cannot call requestBurnFromRouter
    function test_Burn_RequestBurnFromRouter_NonRouter_Reverts() public {
        uint256 minted = _mintForUser(user, lp);

        vm.prank(attacker);
        vm.expectRevert(IBurnOperations.OnlyRouter.selector);
        BurnFacet(address(hub)).requestBurnFromRouter(minted, lp, user, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
    }

    /// @notice Non-LP cannot call proposeHash
    function test_Burn_ProposeHash_NonLP_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);

        bytes32 secret = bytes32(uint256(0xcafebabe));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        bytes32 secretHash = keccak256(abi.encodePacked(px, py));

        vm.prank(attacker);
        vm.expectRevert(IErrors.Unauthorized.selector);
        BurnFacet(address(hub)).proposeHash(burnId, secretHash, bytes32(uint256(0x1111)), bytes32(uint256(0x2222)));
    }

    /// @notice Non-user cannot call confirmMoneroLock
    function test_Burn_ConfirmMoneroLock_NonUser_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        vm.prank(attacker);
        vm.expectRevert(IErrors.Unauthorized.selector);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);
    }

    /// @notice Non-user cannot call abortBurn
    function test_Burn_AbortBurn_NonUser_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);

        // Warp past deadline
        vm.roll(block.number + 172805);

        vm.prank(attacker);
        vm.expectRevert(IErrors.Unauthorized.selector);
        BurnFacet(address(hub)).abortBurn(burnId);
    }

    /// @notice Non-user cannot call forceSettleBurn
    function test_Burn_ForceSettleBurn_NonUser_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);

        vm.roll(block.number + 172805);

        vm.prank(attacker);
        vm.expectRevert(IErrors.Unauthorized.selector);
        BurnFacet(address(hub)).forceSettleBurn(burnId);
    }

    /// @notice Non-user cannot call claimSlashedCollateral
    function test_Burn_ClaimSlashedCollateral_NonUser_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        vm.roll(block.number + 172805);

        vm.prank(attacker);
        vm.expectRevert(IErrors.Unauthorized.selector);
        BurnFacet(address(hub)).claimSlashedCollateral(burnId, TEST_USER_SECRET);
    }

    // ========== BURN: STATE ORDERING ==========

    /// @notice confirmMoneroLock before proposeHash must revert
    function test_Burn_ConfirmMoneroLock_BeforePropose_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);

        // Skip proposeHash, go straight to confirm
        vm.prank(user);
        vm.expectRevert(IErrors.InvalidStatus.selector);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);
    }

    /// @notice finalizeBurn on REQUESTED (before confirm) must revert
    function test_Burn_FinalizeBurn_BeforeConfirm_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        // Skip confirmMoneroLock, try to finalize
        vm.prank(lp);
        vm.expectRevert(IErrors.InvalidStatus.selector);
        BurnFacet(address(hub)).finalizeBurn(burnId, bytes32(uint256(0xcafebabe)));
    }

    /// @notice finalizeBurn with wrong secret must revert
    function test_Burn_FinalizeBurn_WrongSecret_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        vm.prank(lp);
        vm.expectRevert(IErrors.InvalidSecret.selector);
        BurnFacet(address(hub)).finalizeBurn(burnId, bytes32(uint256(0xbadbad)));
    }

    /// @notice proposeHash on already-proposed request must revert
    function test_Burn_ProposeHash_AlreadyProposed_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        vm.prank(lp);
        vm.expectRevert(IErrors.InvalidStatus.selector);
        BurnFacet(address(hub)).proposeHash(burnId, bytes32(uint256(0xaaaa)), bytes32(uint256(0x1111)), bytes32(uint256(0x2222)));
    }

    // ========== BURN: DEADLINE ENFORCEMENT ==========

    /// @notice abortBurn before deadline must revert
    function test_Burn_AbortBurn_BeforeDeadline_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);

        vm.prank(user);
        vm.expectRevert(IBurnOperations.DeadlineNotExpired.selector);
        BurnFacet(address(hub)).abortBurn(burnId);
    }

    /// @notice forceSettleBurn before deadline must revert
    function test_Burn_ForceSettleBurn_BeforeDeadline_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);

        vm.prank(user);
        vm.expectRevert(IBurnOperations.DeadlineNotExpired.selector);
        BurnFacet(address(hub)).forceSettleBurn(burnId);
    }

    /// @notice claimSlashedCollateral before deadline must revert
    function test_Burn_ClaimSlashed_BeforeDeadline_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        // Don't warp — deadline not expired yet
        vm.prank(user);
        vm.expectRevert(IBurnOperations.DeadlineNotExpired.selector);
        BurnFacet(address(hub)).claimSlashedCollateral(burnId, TEST_USER_SECRET);
    }

    /// @notice claimSlashedCollateral with zero userSecret must revert
    function test_Burn_ClaimSlashed_ZeroSecret_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        vm.roll(block.number + 172805);

        vm.prank(user);
        vm.expectRevert(IErrors.InvalidUserSecret.selector);
        BurnFacet(address(hub)).claimSlashedCollateral(burnId, bytes32(0));
    }

    /// @notice claimSlashedCollateral with wrong userSecret must revert
    function test_Burn_ClaimSlashed_WrongSecret_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        vm.roll(block.number + 172805);

        vm.prank(user);
        vm.expectRevert(IErrors.InvalidUserSecret.selector);
        BurnFacet(address(hub)).claimSlashedCollateral(burnId, bytes32(uint256(0xbadc0ffee)));
    }

    /// @notice claimSlashedCollateral with correct userSecret succeeds and emits the secret
    ///         so the LP can sweep the shared XMR (invariant: every exit reveals a secret).
    function test_Burn_ClaimSlashed_CorrectSecret_EmitsUserSecret() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        vm.roll(block.number + 172805);

        vm.recordLogs();
        vm.prank(user);
        BurnFacet(address(hub)).claimSlashedCollateral(burnId, TEST_USER_SECRET);

        // BurnSlashed(requestId, user, collateralSeized, userSecret) — requestId and user
        // are indexed; the non-indexed data is abi.encode(collateralSeized, userSecret).
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found = false;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("BurnSlashed(bytes32,address,uint256,bytes32)")
                && logs[i].topics[1] == burnId
                && logs[i].topics[2] == bytes32(uint256(uint160(user)))) {
                (uint256 seized, bytes32 emittedSecret) = abi.decode(logs[i].data, (uint256, bytes32));
                assertEq(emittedSecret, TEST_USER_SECRET, "userSecret must be emitted for LP sweep");
                assertGt(seized, 0, "user must receive a payout");
                found = true;
                break;
            }
        }
        assertTrue(found, "BurnSlashed event must be emitted");
    }

    /// @notice resolveDeclinedProposal before deadline must revert
    function test_Burn_ResolveDeclined_BeforeDeadline_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        vm.prank(lp);
        vm.expectRevert(IBurnOperations.DeadlineNotExpired.selector);
        BurnFacet(address(hub)).resolveDeclinedProposal(burnId, bytes32(uint256(1)));
    }

    /// @notice resolveDeclinedProposal with zero userSecret must revert
    function test_Burn_ResolveDeclined_ZeroSecret_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        vm.roll(block.number + 172805);

        vm.prank(lp);
        vm.expectRevert(IErrors.InvalidUserSecret.selector);
        BurnFacet(address(hub)).resolveDeclinedProposal(burnId, bytes32(0));
    }

    /// @notice resolveDeclinedProposal with wrong userSecret must revert
    function test_Burn_ResolveDeclined_WrongSecret_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        vm.roll(block.number + 172805);

        vm.prank(lp);
        vm.expectRevert(IErrors.InvalidUserSecret.selector);
        BurnFacet(address(hub)).resolveDeclinedProposal(burnId, bytes32(uint256(0xbadc0ffee)));
    }

    // ========== LIQUIDATION: GUARDS ==========

    /// @notice liquidate on healthy vault must revert
    function test_Liquidate_HealthyVault_Reverts() public {
        // Mint some debt so vault has debt but is still healthy
        _mintForUser(user, lp);

        vm.prank(keeper);
        vm.expectRevert(ILiquidationFacet.VaultHealthy.selector);
        LiquidationFacet(address(hub)).liquidate(lp, 100);
    }

    /// @notice liquidate with zero debtToClear must revert
    function test_Liquidate_ZeroAmount_Reverts() public {
        vm.prank(keeper);
        vm.expectRevert(IErrors.ZeroAmount.selector);
        LiquidationFacet(address(hub)).liquidate(lp, 0);
    }

    /// @notice backstopVault on self must revert
    function test_BackstopVault_Self_Reverts() public {
        vm.prank(lp);
        vm.expectRevert(IErrors.InvalidValue.selector);
        LiquidationFacet(address(hub)).backstopVault(lp);
    }

    /// @notice backstopVault on healthy vault must revert
    function test_BackstopVault_HealthyVault_Reverts() public {
        // Create second LP vault
        _createVaultAndDeposit(lp2, 100 ether);
        _configureVault(lp2);

        // Mint some debt on lp so it's not InsufficientDebt
        _mintForUser(user, lp);

        // lp2 tries to backstop lp, but lp is healthy
        vm.prank(lp2);
        vm.expectRevert(ILiquidationFacet.VaultHealthy.selector);
        LiquidationFacet(address(hub)).backstopVault(lp);
    }

    // ========== VAULT: GUARDS ==========

    /// @notice createVault when already exists must revert
    function test_Vault_CreateVault_AlreadyExists_Reverts() public {
        vm.prank(lp);
        vm.expectRevert(IVaultFacet.VaultAlreadyExists.selector);
        VaultFacet(address(hub)).createVault();
    }

    /// @notice setVaultMarketMetrics exceeding max must revert
    function test_Vault_SetMetrics_ExceedsMax_Reverts() public {
        vm.prank(lp);
        vm.expectRevert(IVaultFacet.ExceedsMaxMargin.selector);
        VaultFacet(address(hub)).setVaultMarketMetrics(type(uint16).max, 100);
    }

    /// @notice withdrawReturns with nothing pending must revert
    function test_Vault_WithdrawReturns_NothingPending_Reverts() public {
        vm.prank(lp);
        vm.expectRevert(IErrors.ZeroAmount.selector);
        VaultFacet(address(hub)).withdrawReturns(address(stata));
    }

    // ========== ORACLE: GUARDS ==========
    // The HyperCore oracle is permissionless (refreshPrices is a public poke
    // reading trustless L1 precompiles) — there is no updater role to guard.
    // The relevant guard is that invalid precompile data is rejected.

    /// @notice A zero oracle price from the precompile is ignored — the stored
    ///         price is not updated and goes stale.
    function test_Oracle_ZeroPrice_Ignored() public {
        mockOracle.setPrice(XMR_PERP_INDEX, 0);
        mockMark.setPrice(XMR_PERP_INDEX, 0);
        vm.warp(block.timestamp + 3 minutes);
        HyperCoreOracleFacet(address(hub)).refreshPrices(); // skips zero price
        vm.expectRevert();
        HyperCoreOracleFacet(address(hub)).getXmrPrice();
    }

    /// @notice getXmrPrice when stale must revert
    function test_Oracle_GetXmrPrice_Stale_Reverts() public {
        // Warp past 2 minute staleness window
        vm.warp(block.timestamp + 3 minutes);

        vm.expectRevert();
        HyperCoreOracleFacet(address(hub)).getXmrPrice();
    }

    // ========== VAULT EVICTION: GRIEFING PREVENTION ==========
    // activeVaultCount is at storage slot 37 (after vaultList at slot 36)
    uint256 constant ACTIVE_VAULT_COUNT_SLOT = 37;

    /// @notice Empty vaults are evictable when cap is reached
    function test_Vault_Eviction_EmptyVaultEvicted() public {
        // Create an empty vault (the griefer)
        address griefer = makeAddr("griefer");
        vm.prank(griefer);
        VaultFacet(address(hub)).createVault();

        // Set activeVaultCount to cap so next createVault triggers eviction
        vm.store(address(hub), bytes32(ACTIVE_VAULT_COUNT_SLOT), bytes32(uint256(10000)));

        // New LP creates vault — should evict the empty griefer vault
        address newLp = makeAddr("newLp");
        vm.prank(newLp);
        VaultFacet(address(hub)).createVault();

        // New LP should have an active vault (setMintGriefingDeposit should work)
        vm.prank(newLp);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);

        // Griefer's vault should be evicted — setMintGriefingDeposit should revert
        vm.prank(griefer);
        vm.expectRevert(IErrors.VaultDoesNotExist.selector);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
    }

    /// @notice Vault with debt cannot be evicted
    function test_Vault_Eviction_VaultWithDebt_Protected() public {
        // lp already has a vault with collateral from setUp
        // Create an empty griefer vault
        address griefer = makeAddr("griefer2");
        vm.prank(griefer);
        VaultFacet(address(hub)).createVault();

        // Mint some debt from lp's vault so it has normalizedDebt > 0
        _mintForUser(user, lp);

        // Set activeVaultCount to cap
        vm.store(address(hub), bytes32(ACTIVE_VAULT_COUNT_SLOT), bytes32(uint256(10000)));

        // New LP creates vault — should evict the empty griefer vault, NOT lp (who has debt)
        address newLp = makeAddr("newLp2");
        vm.prank(newLp);
        VaultFacet(address(hub)).createVault();

        // lp should still be active (setMintGriefingDeposit should work)
        vm.prank(lp);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.002 ether);

        // Griefer should be evicted – setMintGriefingDeposit should revert
        vm.prank(griefer);
        vm.expectRevert(IErrors.VaultDoesNotExist.selector);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
    }

    /// @notice When all vaults have collateral above 1% threshold, creation reverts
    function test_Vault_Eviction_AllVaultsAboveThreshold_Reverts() public {
        // lp has 100 ether (100e18 sDAI shares) from setUp
        // Create a second vault with 2 ether — above 1% of lp's 100 ether
        address small = makeAddr("small");
        _createVaultAndDeposit(small, 2 ether);

        // Set activeVaultCount to cap
        vm.store(address(hub), bytes32(ACTIVE_VAULT_COUNT_SLOT), bytes32(uint256(10000)));

        // Both vaults have collateral >= 1% of max (100 ether * 1% = 1 ether)
        // small has 2 ether > 1 ether threshold, so not evictable
        address newLp = makeAddr("newLp3");
        vm.prank(newLp);
        vm.expectRevert(wsXmrStorage.NoEvictableVaultFound.selector);
        VaultFacet(address(hub)).createVault();
    }

    /// @notice deactivateVault removes from vaultList and decrements activeVaultCount
    function test_Vault_Deactivate_ReducesActiveCount() public {
        uint256 countBefore = VaultFacet(address(hub)).getVaultCount();

        // Create a second vault with no collateral
        address lp3 = makeAddr("lp3");
        vm.prank(lp3);
        VaultFacet(address(hub)).createVault();

        assertEq(VaultFacet(address(hub)).getVaultCount(), countBefore + 1);

        // Deactivate it
        vm.prank(lp3);
        VaultFacet(address(hub)).deactivateVault();

        assertEq(VaultFacet(address(hub)).getVaultCount(), countBefore);
    }

    // ========== DEPLOYER LOCK: ONE-WAY PRIVILEGE REMOVAL ==========

    /// @notice Only the deployer may lock its own powers
    function test_LockDeployer_NonDeployer_Reverts() public {
        vm.prank(attacker);
        vm.expectRevert(IErrors.Unauthorized.selector);
        hub.lockDeployer();
    }

    /// @notice Locking is a one-way switch — a second call reverts
    function test_LockDeployer_SecondCall_Reverts() public {
        hub.lockDeployer();
        assertTrue(hub.deployerOperationsLocked(), "lock not set");

        vm.expectRevert(IwsXmrHub.AlreadyInitialized.selector);
        hub.lockDeployer();
    }

    /// @notice After locking, the deployer can no longer add selector routes
    function test_LockDeployer_PreventsAddSelectors() public {
        hub.lockDeployer();

        bytes4[] memory sels = new bytes4[](1);
        sels[0] = bytes4(keccak256("somePostLaunchSelector()"));

        vm.expectRevert(IErrors.Unauthorized.selector);
        hub.addSelectors(address(vaultFacet), sels);
    }

    /// @notice After locking, the deployer can no longer brick the hub by removing routes
    function test_LockDeployer_PreventsRemoveSelectors() public {
        hub.lockDeployer();

        bytes4[] memory sels = new bytes4[](1);
        sels[0] = bytes4(keccak256("someSelector()"));

        vm.expectRevert(IErrors.Unauthorized.selector);
        hub.removeSelectors(sels);
    }

    /// @notice After locking, the liquidity router cannot be reconfigured
    function test_LockDeployer_PreventsSetLiquidityRouter() public {
        hub.lockDeployer();

        vm.expectRevert(IErrors.Unauthorized.selector);
        hub.setLiquidityRouter(address(0xBEEF));
    }

    /// @notice After locking, facet registration can never be replayed
    function test_LockDeployer_PreventsRegisterFacets() public {
        hub.lockDeployer();

        vm.expectRevert(IErrors.Unauthorized.selector);
        hub.registerFacets(
            address(vaultFacet),
            address(mintFacet),
            address(burnFacet),
            address(liquidationFacet),
            address(yieldFacet),
            address(oracleFacet)
        );
    }

    // ========== wsXMR HUB LOCK: NO POST-LAUNCH MINTER SWAP ==========

    /// @notice Only the token deployer can lock the hub pointer
    function test_LockHub_NonDeployer_Reverts() public {
        vm.prank(attacker);
        vm.expectRevert(bytes("Only deployer"));
        wsxmr.lockHub();
    }

    /// @notice After lockHub, replaceHub can never repoint the token at a new minter
    function test_LockHub_PreventsReplaceHub() public {
        wsxmr.lockHub();
        assertTrue(wsxmr.hubLocked(), "hub not locked");

        vm.expectRevert(bytes("Hub locked"));
        wsxmr.replaceHub(address(0xBEEF));
    }

    /// @notice After lockHub, setHub can never repoint the token at a new minter
    function test_LockHub_PreventsSetHub() public {
        wsxmr.lockHub();

        vm.expectRevert(bytes("Hub locked"));
        wsxmr.setHub(address(0xBEEF));
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
}

// ========== INTERFACES FOR SELECTORS ==========

interface IVaultFacet {
    error VaultAlreadyExists();
    error MaxVaultsReached();
    error ExceedsMaxMargin();
    error ETHTransferFailed();
    error VaultNotEvictable();
}

interface IOracleFacet {
    error StalePrice();
    error PriceNormalizedToZero();
    error RefundFailed();
    error PriceDeviationTooHigh();
}

interface ILiquidationFacet {
    error VaultHealthy();
    error CancelBurnsFirst();
}
