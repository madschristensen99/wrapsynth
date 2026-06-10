// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, console} from "forge-std/Test.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {SimpleOracleFacet} from "../contracts/facets/SimpleOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {wsXmrStorage} from "../contracts/core/wsXmrStorage.sol";
import {Ed25519} from "../contracts/Ed25519.sol";

contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

contract E2EComprehensiveTest is Test {
    address constant WXDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    
    wsXmrHub public hub;
    wsXMR public wsxmr;
    SimpleOracleFacet public oracleFacet;
    VaultFacet public vaultFacet;
    MintFacet public mintFacet;
    BurnFacet public burnFacet;
    LiquidationFacet public liquidationFacet;
    YieldFacet public yieldFacet;
    MockVerifierProxy public verifier;
    
    address public lp;
    address public user;
    address public user2;
    
    bytes32 public testSecret = bytes32(uint256(123456789));
    
    function setUp() public {
        string memory rpcUrl = vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"));
        vm.createSelectFork(rpcUrl);
        vm.warp(block.timestamp + 1 days);
        
        lp = makeAddr("lp");
        user = makeAddr("user");
        user2 = makeAddr("user2");
        vm.deal(lp, 1000 ether);
        vm.deal(user, 1000 ether);
        vm.deal(user2, 1000 ether);
        
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
        
        // Update prices after warp (before any vault operations)
        SimpleOracleFacet(address(hub)).updatePrices(390_00000000, 1_00000000);
        
        // Setup LP vault
        vm.startPrank(lp);
        VaultFacet(address(hub)).createVault();
        VaultFacet(address(hub)).setMaxMintBps(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        VaultFacet(address(hub)).setMintReadyBond(0.001 ether);
        
        (bool success,) = WXDAI.call{value: 100 ether}("");
        require(success);
        IERC20(WXDAI).approve(address(hub), 100 ether);
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
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey, lpPublicKey);
        
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(requestId);
        
        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(requestId, testSecret);
        
        uint256 balance = wsxmr.balanceOf(user);
        console.log("  Minted wsXMR:", balance);
        assertTrue(balance > 0, "Should have wsXMR");
        
        // Burn
        uint256 burnAmount = balance / 2;
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(burnAmount, lp, user, bytes32(uint256(1)));
        
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
        vm.roll(block.number + 721);
        console.log("  Jumped 1 hour + 1 second");
        
        // Anyone can cancel now
        vm.prank(user2);
        MintFacet(address(hub)).cancelMint(requestId);
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
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey, lpPublicKey);
        
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(requestId);
        console.log("  LP set mint ready (extends timeout)");
        
        // Jump past extended timeout (MINT_READY_EXTENSION = 24 hours)
        vm.roll(block.number + 17281);
        console.log("  Jumped 24 hours + 1 second");
        
        vm.prank(user2);
        MintFacet(address(hub)).cancelMint(requestId);
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
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey, lpPublicKey);
        
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(requestId);
        
        // Jump past timeout
        vm.roll(block.number + 17281);
        
        // Cancel it first
        vm.prank(user2);
        MintFacet(address(hub)).cancelMint(requestId);
        
        // Try to finalize - should fail
        vm.prank(user);
        vm.expectRevert();
        MintFacet(address(hub)).finalizeMint(requestId, testSecret);
        
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
        vm.roll(block.number + 721);
        
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
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(balance / 2, lp, user, bytes32(uint256(1)));
        console.log("  Burn requested");
        
        // Jump past BURN_REQUEST_TIMEOUT (24 hours)
        vm.roll(block.number + 17281);
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
        
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(balance / 2, lp, user, bytes32(uint256(1)));
        
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));
        
        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);
        console.log("  LP proposed hash");
        
        // Jump past BURN_COMMIT_TIMEOUT (48 hours)
        vm.roll(block.number + 34561);
        console.log("  Jumped 48 hours + 1 second");
        
        // Anyone can resolve the declined proposal after timeout
        vm.prank(lp);
        BurnFacet(address(hub)).resolveDeclinedProposal(burnId);
        console.log("  LP resolved declined proposal");
        console.log("  PASS\n");
    }
    
    function test_Burn_LPFailsToRevealSecret() public {
        console.log("\n=== TEST: Burn - LP Fails to Reveal Secret (User Claims Slash) ===");
        
        uint256 balance = _mintTokensForUser(user);
        uint256 burnAmount = balance / 2;
        
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(burnAmount, lp, user, bytes32(uint256(1)));
        
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
        vm.roll(block.number + 34561);
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
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(balance / 2, lp, user, bytes32(uint256(1)));
        
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
        vm.roll(block.number + 34561);
        
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
        MintFacet(address(hub)).provideLPKey(requestId1, lpPublicKey1, lpPublicKey1);
        MintFacet(address(hub)).provideLPKey(requestId2, lpPublicKey2, lpPublicKey2);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(requestId1);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(requestId2);
        vm.stopPrank();
        
        // Both users finalize
        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(requestId1, testSecret);
        
        vm.prank(user2);
        MintFacet(address(hub)).finalizeMint(requestId2, secret2);
        
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
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(existingBalance / 2, lp, user, bytes32(uint256(1)));
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
        MintFacet(address(hub)).provideLPKey(mintId, lpPublicKey, lpPublicKey);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(mintId);
        vm.stopPrank();
        
        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);
        
        vm.prank(user2);
        MintFacet(address(hub)).finalizeMint(mintId, secret2);
        
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
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey, lpPublicKey);
        
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(requestId);
        
        vm.prank(_user);
        MintFacet(address(hub)).finalizeMint(requestId, secret);
        
        return wsxmr.balanceOf(_user);
    }
}
