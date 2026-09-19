// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {HyperEVMTestBase} from "./HyperEVMTestBase.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ed25519} from "../contracts/Ed25519.sol";

contract E2EFinalTest is HyperEVMTestBase {
    bytes32 public testSecret = bytes32(uint256(123456789));
    
    function setUp() public override {
        super.setUp();
        vm.warp(block.timestamp + 1 days);
        _setXmrPrice8dec(XMR_PRICE_8DEC); // refresh after warp
    }
    
    function test_FullCycle() public {
        console.log("=== FULL MINT AND BURN CYCLE ===\n");
        
        // LP creates vault and deposits USDe
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
        console.log("[1] LP deposited 100 USDe\n");
        
        // User initiates mint (need at least 1e6 wsXMR for burn, which is 1e10 XMR atomic units)
        uint256 xmrAmount = 20000000000; // 0.002 XMR = ~$0.78 worth
        
        // Create commitment from Ed25519 public key
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 testCommitment = keccak256(abi.encodePacked(px, py));
        bytes32 userPublicKey = bytes32(Ed25519.compressPoint(px, py));
        
        vm.prank(user);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user, xmrAmount, testCommitment, userPublicKey);
        console.log("[2] User initiated mint");
        console.log("    Request ID:", vm.toString(requestId), "\n");
        
        // LP provides their Ed25519 public key for atomic swap
        bytes32 lpPublicKey = bytes32(uint256(0xdeadbeef));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey, lpPublicKey, bytes32(uint256(0xdeadbeef)));
        console.log("[3] LP provided public key\n");
        
        // LP sets ready (after user locks XMR on Monero)
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady(requestId);
        console.log("[4] LP set mint READY\n");
        
        // User finalizes
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(requestId, testSecret);
        MintFacet(address(hub)).finalizeMint(requestId);
        
        uint256 balance = wsxmr.balanceOf(user);
        console.log("[5] Mint finalized!");
        console.log("    User wsXMR balance:", balance, "\n");
        assertTrue(balance > 0, "Should have wsXMR");
        
        // User burns half
        uint256 burnAmount = balance / 2;
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(burnAmount, lp, user, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        console.log("[6] Burn requested:", burnAmount, "\n");
        
        // LP proposes hash (using Ed25519)
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));
        vm.prank(lp);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);
        console.log("[7] LP proposed hash\n");
        
        // User confirms Monero lock
        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);
        console.log("[8] User confirmed Monero lock\n");
        
        // LP finalizes burn
        vm.prank(lp);
        BurnFacet(address(hub)).finalizeBurn(burnId, burnSecret);
        
        uint256 finalBalance = wsxmr.balanceOf(user);
        console.log("[9] Burn finalized!");
        console.log("    Final balance:", finalBalance, "\n");
        assertTrue(finalBalance == balance - burnAmount, "Burn should reduce balance");
        
        console.log("=== SUCCESS: FULL MINT AND BURN CYCLE COMPLETE ===");
    }
}
