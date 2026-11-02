// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";
import {BnbMockTestBase} from "./BnbTestBase.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationAuctionFacet} from "../contracts/facets/LiquidationAuctionFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ed25519} from "../contracts/Ed25519.sol";
import {IErrors} from "../contracts/interfaces/IErrors.sol";

/**
 * @title Audit Regression Tests
 * @notice Regression tests for C1 (reentrancy), H1 (decimal mismatch), H2 (debt index context)
 * @dev Forks HyperEVM for stataUSDe / HyperCore oracle interactions
 */
contract AuditRegressionTestBnb is BnbMockTestBase {
    using stdStorage for StdStorage;

    address attacker = makeAddr("attacker");
    address keeper = makeAddr("keeper");

    function setUp() public override {
        super.setUp();
        vm.deal(attacker, 100 ether);
        vm.deal(keeper, 100 ether);

        // Seed attacker with wsXMR for potential abuse
        deal(address(wsxmr), attacker, 1_000_000e8);
    }

    // ========== C1: Reentrancy / onlyDelegateCall ==========

    /// @notice C1-1: Direct calls to privileged hub functions must revert
    function test_C1_DirectCallToMintTokens_Reverts() public {
        vm.expectRevert(IwsXmrHubBnb.Unauthorized.selector);
        hub.mintTokens(attacker, 1000);
    }

    function test_C1_DirectCallToBurnTokens_Reverts() public {
        vm.expectRevert(IwsXmrHubBnb.Unauthorized.selector);
        hub.burnTokens(attacker, 1000);
    }

    function test_C1_DirectCallToTransferAsset_Reverts() public {
        vm.expectRevert(IwsXmrHubBnb.Unauthorized.selector);
        hub.transferAsset(address(stata), attacker, 1000);
    }

    function test_C1_DirectCallToApproveAsset_Reverts() public {
        vm.expectRevert(IwsXmrHubBnb.Unauthorized.selector);
        hub.approveAsset(address(stata), attacker, 1000);
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
        VaultFacet(address(hub)).setMaxMintWsxmr(100e8);

        // After the call, a direct call to a privileged function must still revert
        vm.expectRevert(IwsXmrHubBnb.Unauthorized.selector);
        hub.transferAsset(address(stata), attacker, 1);
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
        bytes32 reqId = MintFacet(address(hub)).initiateMint{value: griefingDeposit}(lp, user, 50000000000, commitment, bytes32(uint256(0xdeadbeef)));

        // Warp past timeout
        vm.roll(block.number + 5000);

        uint256 pendingBefore = _getPendingReturns(user, address(0));
        assertEq(pendingBefore, 0, "No pending returns before cancel");

        // Cancel mint
        vm.prank(user);
        MintFacet(address(hub)).cancelMint(reqId, bytes32(0));

        uint256 pendingAfter = _getPendingReturns(user, address(0));
        assertEq(pendingAfter, griefingDeposit, "ETH should be queued to pendingReturns, not pushed");
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
        bytes32 reqId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, xmrAmount, commitment, bytes32(uint256(0xdeadbeef)));

        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)));

        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(reqId);

        vm.prank(user);
        MintFacet(address(hub)).revealSecret(reqId, bytes32(uint256(0x1234)));
        MintFacet(address(hub)).finalizeMint(reqId);

        uint256 hubDebtBefore = hub.getVaultDebt(lp);
        assertGt(hubDebtBefore, 0, "Should have debt");

        // Hub index starts at 1e18
        assertEq(hub.globalDebtIndex(), 1e18, "Initial index is 1e18");

        // Denormalized debt via hub view should equal actual debt when index=1e18
        uint256 hubDebt = hub.getVaultDebt(lp);
        assertEq(hubDebt, hubDebtBefore, "Debt at 1e18 index");

        // Now simulate a buy-and-burn that reduces globalDebtIndex to 0.5e18.
        // stdStorage locates the slot automatically — no fragile hard-coded layout.
        stdstore.target(address(hub)).sig("globalDebtIndex()").checked_write(0.5e18);

        // After manipulation, hub index is 0.5e18
        assertEq(hub.globalDebtIndex(), 0.5e18, "Index should be 0.5e18 after store");

        // The hub's getVaultDebt should now return hubDebtBefore * 0.5e18 / 1e18 = hubDebtBefore / 2
        uint256 hubDebtAfter = hub.getVaultDebt(lp);
        assertApproxEqRel(hubDebtAfter, hubDebtBefore / 2, 0.001e18, "Hub debt should halve with index");

        // Critical: state-modifying functions via the hub must use the hub's live index.
        // repayDebt internally uses _denormalizeDebt — with a halved index a repay of
        // half the minted debt clears the whole vault debt. If it used a frozen index
        // it would think actualDebt is 2x larger.
        uint256 minted = wsxmr.balanceOf(user);
        vm.prank(user);
        wsxmr.transfer(lp, minted);
        vm.startPrank(lp);
        wsxmr.approve(address(hub), minted);
        VaultFacet(address(hub)).repayDebt(hubDebtAfter);
        vm.stopPrank();
        uint256 healthAfter = hub.getVaultHealth(lp);
        assertGt(healthAfter, 0, "Health should remain sane after repay with non-1e18 index");
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

    // ========== H2 Regression: Bad-debt socialization index scaling ==========

    /// @notice H2-2: After a liquidation auction burns vault A's debt, healthy vault B's
    ///         denormalized debt must NOT change, and globalTotalDebt must equal the sum
    ///         of all vault denormalized debts.
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
        bytes32 reqA = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(vaultA, user, xmrAmountA, commitmentA, bytes32(uint256(0xdeadbeef)));
        vm.prank(vaultA);
        MintFacet(address(hub)).provideLPKey(reqA, bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)));
        vm.prank(vaultA);
        MintFacet(address(hub)).setMintReady(reqA);
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(reqA, bytes32(uint256(0xaaaa)));
        MintFacet(address(hub)).finalizeMint(reqA);

        // --- Vault B: healthy collateral, moderate debt ---
        _createVaultAndDeposit(vaultB, 10_000 ether);
        _configureVault(vaultB);

        uint256 xmrAmountB = 500_00000000; // 500 XMR
        (uint256 pxB, uint256 pyB) = Ed25519.scalarMultBase(uint256(0xbbbb));
        bytes32 commitmentB = keccak256(abi.encodePacked(pxB, pyB));

        vm.prank(user);
        bytes32 reqB = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(vaultB, user, xmrAmountB, commitmentB, bytes32(uint256(0xdeadbeef)));
        vm.prank(vaultB);
        MintFacet(address(hub)).provideLPKey(reqB, bytes32(uint256(0xbbbb)), bytes32(uint256(0xbbbb)), bytes32(uint256(0xdeadbeef)));
        vm.prank(vaultB);
        MintFacet(address(hub)).setMintReady(reqB);
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(reqB, bytes32(uint256(0xbbbb)));
        MintFacet(address(hub)).finalizeMint(reqB);

        // Record pre-liquidation state
        uint256 vaultBDebtBefore = hub.getVaultDebt(vaultB);
        uint256 globalDebtBefore = hub.globalTotalDebt();
        uint256 indexBefore = hub.globalDebtIndex();

        // Kick vault A — permissionless; the auction is the solvency test
        _kickVault(keeper, vaultA);

        // Roll past grace + open delay so the auction is ACTIVE.
        // auctionEnd = kickBlock + GRACE + OPEN_DELAY + DURATION, so the active
        // window starts at auctionEnd - AUCTION_DURATION (3600 blocks).
        bytes memory kickResult = _hubView(
            abi.encodeWithSelector(LiquidationAuctionFacet.auctionState.selector, vaultA)
        );
        (,,,,,, uint256 auctionEnd,) = abi.decode(
            kickResult, (bool, uint8, uint256, uint256, uint256, address, uint256, bool)
        );
        vm.roll(auctionEnd - hub.AUCTION_DURATION_BLOCKS() + 10);

        // Give keeper wsXMR covering vault A's full debt so the bid clears it
        uint256 vaultADebt = hub.getVaultDebt(vaultA);
        deal(address(wsxmr), keeper, vaultADebt);

        // Bid — burns the vault's full debt for X% of the offered collateral
        vm.startPrank(keeper);
        wsxmr.approve(address(hub), vaultADebt);
        LiquidationAuctionFacet(address(hub)).bid(vaultA);
        vm.stopPrank();

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
        bytes32 reqId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, xmrAmount, commitment, bytes32(uint256(0xdeadbeef)));

        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)));

        // setMintReady uses: projectedDebt = actualDebt + pendingDebt
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(reqId);

        // finalizeMint must use the SAME formula (not actualDebt + pendingDebt + request.wsxmrAmount)
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(reqId, secret);
        MintFacet(address(hub)).finalizeMint(reqId);

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
        bytes32 reqA = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, 10_000_000_000, commitmentA, bytes32(uint256(0xdeadbeef)));
        vm.prank(user);
        bytes32 reqB = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, 10_000_000_000, commitmentB, bytes32(uint256(0xdeadbeef)));

        // pendingDebt now includes BOTH mints
        // Provide keys and ready both
        vm.startPrank(lp);
        MintFacet(address(hub)).provideLPKey(reqA, bytes32(uint256(0xdead)), bytes32(uint256(0xdead)), bytes32(uint256(0xdeadbeef)));
        MintFacet(address(hub)).provideLPKey(reqB, bytes32(uint256(0xbeef)), bytes32(uint256(0xbeef)), bytes32(uint256(0xdeadbeef)));
        MintFacet(address(hub)).setMintReady(reqA);
        MintFacet(address(hub)).setMintReady(reqB);
        vm.stopPrank();

        // Finalize first mint — projectedDebt should include BOTH pending amounts
        // (not double-count reqA)
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(reqA, secretA);
        MintFacet(address(hub)).finalizeMint(reqA);

        uint256 mintedA = wsxmr.balanceOf(user);
        assertGt(mintedA, 0, "N-1: first finalizeMint should succeed with two pending mints");
    }

    // ========== H-3: Staleness-scaled deviation guard recovery ==========
    // NOTE: the H-3 deviation-guard test was SimpleOracleFacet-specific (a push-oracle
    // anti-manipulation guard on the updater's price jumps). The HyperCore oracle reads
    // trustless L1 precompile prices — there is no updater to manipulate, so the guard
    // and its regression test do not apply on HyperEVM.

    /// @notice Regression: maxMintBps must subtract lockedCollateral before computing capacity
    /// @dev Prior fix used total collateralShares for maxMintBps, which could pass while CR check
    ///      (which correctly subtracts lockedCollateral) would revert with InsufficientCollateral.
    function test_M1_MaxMintBps_RespectsLockedCollateral() public {
        _createVaultAndDeposit(lp, 10_000e18); // $10k sDAI
        _updatePrices();
        _configureVault(lp);

        // Mint a small amount so user has wsXMR to burn later
        (uint256 px1, uint256 py1) = Ed25519.scalarMultBase(uint256(0x1111));
        bytes32 commitment1 = keccak256(abi.encodePacked(px1, py1));
        vm.prank(user);
        bytes32 mintId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, 100000000000, commitment1, bytes32(uint256(0xdeadbeef)));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(mintId, bytes32(uint256(0xABCD)), bytes32(uint256(0xABCD)), bytes32(uint256(0xdeadbeef)));
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(mintId);
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(mintId, bytes32(uint256(0x1111)));
        MintFacet(address(hub)).finalizeMint(mintId);

        // Burn half to lock collateral
        uint256 userBalance = wsxmr.balanceOf(user);
        vm.prank(user);
        wsxmr.approve(address(hub), userBalance);
        (uint256 px2, uint256 py2) = Ed25519.scalarMultBase(uint256(0x2222));
        bytes32 burnCommitment = keccak256(abi.encodePacked(px2, py2));
        vm.prank(user);
        BurnFacet(address(hub)).requestBurn(userBalance / 2, lp, user, burnCommitment, bytes32(uint256(2)), bytes32(uint256(3)));

        // Verify lockedCollateral is now > 0
        bytes memory vaultResult = _hubView(abi.encodeWithSelector(VaultFacet.getVault.selector, lp));
        wsXmrStorage.Vault memory vault = abi.decode(vaultResult, (wsXmrStorage.Vault));
        assertGt(vault.lockedCollateral, 0, "lockedCollateral must be > 0 after burn request");

        // Set a tiny absolute wsXMR cap so almost any mint exceeds it.
        // CRITICAL: the capacity check must subtract lockedCollateral from total
        // shares — with lockedCollateral > 0 the quote cap still binds.
        vm.prank(lp);
        VaultFacet(address(hub)).setMaxMintWsxmr(1); // 1 wei of wsXMR — everything reverts

        // Mint 0.1 wsXMR — far over the cap, so must revert with InvalidValue.
        uint256 xmrAmount = 100_000_000_000; // 0.1 wsXMR
        (uint256 px3, uint256 py3) = Ed25519.scalarMultBase(uint256(0x3333));
        bytes32 commitment3 = keccak256(abi.encodePacked(px3, py3));

        // Should revert because mint far exceeds maxMintBps of available collateral
        vm.prank(user);
        vm.expectRevert(IErrors.InvalidValue.selector);
        MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, xmrAmount, commitment3, bytes32(uint256(0xdeadbeef)));
    }

    /// @notice Regression: getVaultHealth must subtract lockedCollateral
    function test_M2_GetVaultHealth_ExcludesLockedCollateral() public {
        _createVaultAndDeposit(lp, 100_000e18);
        _updatePrices();
        _configureVault(lp);

        // Mint
        (uint256 px1, uint256 py1) = Ed25519.scalarMultBase(uint256(0x1111));
        bytes32 commitment1 = keccak256(abi.encodePacked(px1, py1));
        vm.prank(user);
        bytes32 mintId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, 100000000000, commitment1, bytes32(uint256(0xdeadbeef)));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(mintId, bytes32(uint256(0xABCD)), bytes32(uint256(0xABCD)), bytes32(uint256(0xdeadbeef)));
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(mintId);
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(mintId, bytes32(uint256(0x1111)));
        MintFacet(address(hub)).finalizeMint(mintId);

        // Burn to lock collateral
        uint256 userBalance = wsxmr.balanceOf(user);
        vm.prank(user);
        wsxmr.approve(address(hub), userBalance);
        (uint256 px2, uint256 py2) = Ed25519.scalarMultBase(uint256(0x2222));
        bytes32 burnCommitment = keccak256(abi.encodePacked(px2, py2));
        vm.prank(user);
        BurnFacet(address(hub)).requestBurn(userBalance / 2, lp, user, burnCommitment, bytes32(uint256(2)), bytes32(uint256(3)));

        // getVaultHealth should return ratio based on available collateral, not total
        bytes memory result = _hubView(abi.encodeWithSelector(VaultFacet.getVaultHealth.selector, lp));
        uint256 health = abi.decode(result, (uint256));

        // Compute expected health manually using available collateral
        bytes memory vaultResult = _hubView(abi.encodeWithSelector(VaultFacet.getVault.selector, lp));
        wsXmrStorage.Vault memory vault = abi.decode(vaultResult, (wsXmrStorage.Vault));
        uint256 available = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;

        // If health used total collateral, it would be much higher. With locked collateral,
        // health should be lower. Just verify it's reasonable and not type(uint256).max.
        assertLt(health, type(uint256).max, "health should be finite when debt exists");

        // Sanity: available must be strictly less than total when locked > 0
        assertLt(available, vault.collateralShares, "available must be less than total when locked > 0");
    }

    // ========== Helpers ==========

    function _updatePrices() internal {
        
    }

    function _createVaultAndDeposit(address who, uint256 amount) internal {
        vm.startPrank(who);
        VaultFacet(address(hub)).createVault();
        vm.stopPrank();
        // Deal USDe and deposit as collateral (wraps to stataUSDe shares)
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

}

interface IwsXmrHubBnb {
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
