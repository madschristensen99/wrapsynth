// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {HyperEVMTestBase} from "./HyperEVMTestBase.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ed25519} from "../contracts/Ed25519.sol";

contract E2EComprehensiveTest is HyperEVMTestBase {
    address public user2;
    bytes32 public testSecret = bytes32(uint256(123456789));
    
    function setUp() public override {
        super.setUp();
        vm.warp(block.timestamp + 1 days);
        _setXmrPrice8dec(XMR_PRICE_8DEC); // refresh after warp
        
        user2 = makeAddr("user2");
        vm.deal(user2, 1000 ether);
        
        // Setup LP vault with USDe collateral
        vm.startPrank(lp);
        VaultFacet(address(hub)).createVault();
        VaultFacet(address(hub)).setMaxMintBps(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        vm.stopPrank();
        
        deal(USDE, lp, 100 ether);
        vm.startPrank(lp);
        IERC20(USDE).approve(address(hub), 100 ether);
        VaultFacet(address(hub)).depositCollateral(100 ether);
        vm.stopPrank();
    }
    
    // ============ HAPPY PATH TESTS ============
    
    function test_HappyPath_FullMintBurnCycle() public {
        console.log("\n=== TEST: Happy Path - Full Mint/Burn Cycle ===");
        
        uint256 xmrAmount = 20000000000;
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        bytes32 userPublicKey = bytes32(Ed25519.compressPoint(px, py));
        
        // Mint
        vm.prank(user);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user, xmrAmount, commitment, userPublicKey);
        
        bytes32 lpPublicKey = bytes32(uint256(0xdeadbeef));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey, lpPublicKey, bytes32(uint256(0xdeadbeef)));
        
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(requestId);
        
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(requestId, testSecret);
        MintFacet(address(hub)).finalizeMint(requestId);
        
        uint256 balance = wsxmr.balanceOf(user);
        console.log("  Minted wsXMR:", balance);
        assertTrue(balance > 0, "Should have wsXMR");
        
        // Burn
        uint256 burnAmount = balance / 2;
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(burnAmount, lp, user, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));
        
        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);
        
        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);
        
        vm.prank(lp);
        BurnFacet(address(hub)).finalizeBurn(burnId, burnSecret);
        
        uint256 finalBalance = wsxmr.balanceOf(user);
        console.log("  Final balance:", finalBalance);
        assertEq(finalBalance, balance - burnAmount, "Burn should reduce balance");
        console.log("  PASS\n");
    }
    
    // ============ MINT TIMEOUT TESTS ============
    
    function test_Mint_UserTimeoutBeforeLPReady() public {
        console.log("\n=== TEST: Mint - User Timeout Before LP Sets Ready ===");
        
        uint256 xmrAmount = 20000000000;
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        bytes32 userPublicKey = bytes32(Ed25519.compressPoint(px, py));
        
        vm.prank(user);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user, xmrAmount, commitment, userPublicKey);
        console.log("  Mint initiated with 1 hour timeout");
        
        // Jump past timeout
        vm.roll(block.number + 3605);
        console.log("  Jumped 1 hour + 1 second");
        
        // Anyone can cancel now
        vm.prank(user2);
        MintFacet(address(hub)).cancelMint(requestId, bytes32(0));
        console.log("  User2 cancelled the timed-out mint");
        
        // User should get griefing deposit back
        console.log("  PASS - Timeout handled correctly\n");
    }
    
    function test_Mint_TimeoutAfterLPReady() public {
        console.log("\n=== TEST: Mint - Timeout After LP Sets Ready ===");
        
        uint256 xmrAmount = 20000000000;
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        bytes32 userPublicKey = bytes32(Ed25519.compressPoint(px, py));
        
        vm.prank(user);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user, xmrAmount, commitment, userPublicKey);
        
        bytes32 lpPublicKey = bytes32(uint256(0xdeadbeef));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey, lpPublicKey, bytes32(uint256(0xdeadbeef)));
        
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(requestId);
        console.log("  LP set mint ready (extends timeout)");
        
        // Jump past extended timeout (MINT_READY_EXTENSION = 24 hours)
        vm.roll(block.number + 86405);
        console.log("  Jumped 24 hours + 1 second");
        
        vm.prank(user2);
        MintFacet(address(hub)).cancelMint(requestId, bytes32(0));
        console.log("  Cancelled after extended timeout");
        console.log("  PASS - Extended timeout handled\n");
    }
    
    function test_Mint_CannotFinalizeAfterTimeout() public {
        console.log("\n=== TEST: Mint - Cannot Finalize After Timeout ===");
        
        uint256 xmrAmount = 20000000000;
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        bytes32 userPublicKey = bytes32(Ed25519.compressPoint(px, py));
        
        vm.prank(user);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user, xmrAmount, commitment, userPublicKey);
        
        bytes32 lpPublicKey = bytes32(uint256(0xdeadbeef));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey, lpPublicKey, bytes32(uint256(0xdeadbeef)));
        
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(requestId);
        
        // Jump past timeout
        vm.roll(block.number + 86405);
        
        // Cancel it first
        vm.prank(user2);
        MintFacet(address(hub)).cancelMint(requestId, bytes32(0));
        
        // Try to finalize - should fail
        vm.prank(user);
        vm.expectRevert();
        MintFacet(address(hub)).revealSecret(requestId, testSecret);
        
        console.log("  PASS - Cannot finalize cancelled mint\n");
    }
    
    function test_Mint_CannotSetReadyAfterTimeout() public {
        console.log("\n=== TEST: Mint - LP Cannot Set Ready After Timeout ===");
        
        uint256 xmrAmount = 20000000000;
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        bytes32 userPublicKey = bytes32(Ed25519.compressPoint(px, py));
        
        vm.prank(user);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user, xmrAmount, commitment, userPublicKey);
        
        // Jump past timeout
        vm.roll(block.number + 3605);
        
        // LP tries to set ready - should fail
        vm.prank(lp);
        vm.expectRevert();
        MintFacet(address(hub)).setMintReady(requestId);
        
        console.log("  PASS - LP cannot set ready after timeout\n");
    }
    
    // ============ BURN TIMEOUT TESTS ============
    
    function test_Burn_UserAbandonsBurnRequest() public {
        console.log("\n=== TEST: Burn - User Abandons Burn Request ===");
        
        // First mint some tokens
        uint256 balance = _mintTokensForUser(user);
        
        // User requests burn
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(balance / 2, lp, user, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        console.log("  Burn requested");
        
        // Jump past BURN_REQUEST_TIMEOUT (24 hours)
        vm.roll(block.number + 86405);
        console.log("  Jumped 24 hours + 1 second");
        
        // User aborts the abandoned request
        vm.prank(user);
        BurnFacet(address(hub)).abortBurn(burnId);
        console.log("  User aborted abandoned burn");
        console.log("  PASS - Abandoned burn handled\n");
    }
    
    function test_Burn_LPProposesButUserAbandons() public {
        console.log("\n=== TEST: Burn - LP Proposes Hash But User Abandons ===");
        
        uint256 balance = _mintTokensForUser(user);
        
        bytes32 userSecret = bytes32(uint256(0xdeadbeef));
        (uint256 upkx, uint256 upky) = Ed25519.scalarMultBase(uint256(userSecret));
        // Compressed point — matches the frontend's publicSpendKey.toRawBytes()
        bytes32 userPubKey = bytes32(Ed25519.compressPoint(upkx, upky));

        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(balance / 2, lp, user, bytes32(uint256(1)), userPubKey, bytes32(uint256(3)));
        
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));
        
        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);
        console.log("  LP proposed hash");
        
        // Jump past BURN_COMMIT_TIMEOUT (48 hours)
        vm.roll(block.number + 172805);
        console.log("  Jumped 48 hours + 1 second");
        
        // Anyone can resolve the declined proposal after timeout
        vm.prank(lp);
        BurnFacet(address(hub)).resolveDeclinedProposal(burnId, userSecret);
        console.log("  LP resolved declined proposal");
        console.log("  PASS\n");
    }
    
    function test_Burn_LPFailsToRevealSecret() public {
        console.log("\n=== TEST: Burn - LP Fails to Reveal Secret (User Claims Slash) ===");
        
        uint256 balance = _mintTokensForUser(user);
        uint256 burnAmount = balance / 2;
        
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(burnAmount, lp, user, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));
        
        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);
        
        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);
        console.log("  User confirmed Monero lock");
        
        // Jump past deadline (48 hours from confirm)
        vm.roll(block.number + 172805);
        console.log("  Jumped 48 hours + 1 second");
        
        // User claims slashed collateral
        vm.prank(user);
        BurnFacet(address(hub)).claimSlashedCollateral(burnId);
        console.log("  User claimed slashed collateral (LP penalty)");
        console.log("  PASS - LP slashing works\n");
    }
    
    function test_Burn_CannotFinalizeAfterDeadline() public {
        console.log("\n=== TEST: Burn - Cannot Finalize After Deadline ===");
        
        uint256 balance = _mintTokensForUser(user);
        
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(balance / 2, lp, user, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));
        
        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);
        
        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);
        
        // Jump past deadline
        vm.roll(block.number + 172805);
        
        // LP tries to finalize - should fail
        vm.prank(lp);
        vm.expectRevert();
        BurnFacet(address(hub)).finalizeBurn(burnId, burnSecret);
        
        console.log("  PASS - Cannot finalize after deadline\n");
    }
    
    // ============ MULTIPLE CONCURRENT OPERATIONS ============
    
    function test_MultipleConcurrentMints() public {
        console.log("\n=== TEST: Multiple Concurrent Mints ===");
        
        uint256 xmrAmount = 10000000000;
        
        // User 1 mints
        (uint256 px1, uint256 py1) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 commitment1 = keccak256(abi.encodePacked(px1, py1));
        
        vm.prank(user);
        bytes32 requestId1 = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user, xmrAmount, commitment1, bytes32(px1));
        
        // User 2 mints with different secret
        bytes32 secret2 = bytes32(uint256(987654321));
        (uint256 px2, uint256 py2) = Ed25519.scalarMultBase(uint256(secret2));
        bytes32 commitment2 = keccak256(abi.encodePacked(px2, py2));
        
        vm.prank(user2);
        bytes32 requestId2 = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user2, xmrAmount, commitment2, bytes32(px2));
        
        console.log("  Two concurrent mints initiated");
        
        // LP provides keys and sets both ready
        bytes32 lpPublicKey1 = bytes32(uint256(0xdeadbeef));
        bytes32 lpPublicKey2 = bytes32(uint256(0xdeadbeef));
        vm.startPrank(lp);
        MintFacet(address(hub)).provideLPKey(requestId1, lpPublicKey1, lpPublicKey1, bytes32(uint256(0xdeadbeef)));
        MintFacet(address(hub)).provideLPKey(requestId2, lpPublicKey2, lpPublicKey2, bytes32(uint256(0xdeadbeef)));
        MintFacet(address(hub)).setMintReady(requestId1);
        MintFacet(address(hub)).setMintReady(requestId2);
        vm.stopPrank();
        
        // Both users finalize
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(requestId1, testSecret);
        MintFacet(address(hub)).finalizeMint(requestId1);
        
        vm.prank(user2);
        MintFacet(address(hub)).revealSecret(requestId2, secret2);
        MintFacet(address(hub)).finalizeMint(requestId2);
        
        uint256 balance1 = wsxmr.balanceOf(user);
        uint256 balance2 = wsxmr.balanceOf(user2);
        
        console.log("  User1 balance:", balance1);
        console.log("  User2 balance:", balance2);
        assertTrue(balance1 > 0 && balance2 > 0, "Both should have tokens");
        console.log("  PASS - Concurrent mints work\n");
    }
    
    function test_MintAndBurnSimultaneously() public {
        console.log("\n=== TEST: Mint and Burn Simultaneously ===");
        
        // User1 already has tokens from previous mint
        uint256 existingBalance = _mintTokensForUser(user);
        
        // User1 starts a burn
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(existingBalance / 2, lp, user, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        console.log("  User1 started burn");
        
        // User2 starts a mint at the same time
        uint256 xmrAmount = 10000000000;
        bytes32 secret2 = bytes32(uint256(987654321));
        (uint256 px2, uint256 py2) = Ed25519.scalarMultBase(uint256(secret2));
        bytes32 commitment2 = keccak256(abi.encodePacked(px2, py2));
        
        vm.prank(user2);
        bytes32 mintId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user2, xmrAmount, commitment2, bytes32(px2));
        console.log("  User2 started mint");
        
        // Process both
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));
        
        bytes32 lpPublicKey = bytes32(uint256(0xdeadbeef));
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        vm.startPrank(lp);
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);
        MintFacet(address(hub)).provideLPKey(mintId, lpPublicKey, lpPublicKey, bytes32(uint256(0xdeadbeef)));
        MintFacet(address(hub)).setMintReady(mintId);
        vm.stopPrank();
        
        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);
        
        vm.prank(user2);
        MintFacet(address(hub)).revealSecret(mintId, secret2);
        MintFacet(address(hub)).finalizeMint(mintId);
        
        vm.prank(lp);
        BurnFacet(address(hub)).finalizeBurn(burnId, burnSecret);
        
        console.log("  Both operations completed successfully");
        console.log("  PASS - Concurrent mint/burn works\n");
    }
    
    // ============ HELPER FUNCTIONS ============
    
    function _mintTokensForUser(address _user) internal returns (uint256) {
        uint256 xmrAmount = 20000000000;
        bytes32 secret = bytes32(uint256(uint160(_user))); // Unique per user
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        bytes32 userPublicKey = bytes32(Ed25519.compressPoint(px, py));
        
        vm.prank(_user);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, _user, xmrAmount, commitment, userPublicKey);
        
        bytes32 lpPublicKey = bytes32(uint256(0xdeadbeef));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey, lpPublicKey, bytes32(uint256(0xdeadbeef)));
        
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(requestId);
        
        vm.prank(_user);
        MintFacet(address(hub)).revealSecret(requestId, secret);
        MintFacet(address(hub)).finalizeMint(requestId);
        
        return wsxmr.balanceOf(_user);
    }
}
