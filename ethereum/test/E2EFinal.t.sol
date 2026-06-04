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

contract E2EFinalTest is Test {
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
    
    bytes32 public testSecret = bytes32(uint256(123456789));
    
    function setUp() public {
        string memory rpcUrl = vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"));
        vm.createSelectFork(rpcUrl);
        vm.warp(block.timestamp + 1 days);
        
        lp = makeAddr("lp");
        user = makeAddr("user");
        vm.deal(lp, 1000 ether);
        vm.deal(user, 1000 ether);
        
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
    
    function test_FullCycle() public {
        console.log("=== FULL MINT AND BURN CYCLE ===\n");
        
        // Update prices after warp (before any vault operations)
        SimpleOracleFacet(address(hub)).updatePrices(390_00000000, 1_00000000);
        
        // LP creates vault and deposits
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
        console.log("[1] LP deposited 100 xDAI\n");
        
        // User initiates mint (need at least 1e6 wsXMR for burn, which is 1e10 XMR atomic units)
        uint256 xmrAmount = 20000000000; // 0.002 XMR = ~$0.78 worth
        
        // Create commitment from Ed25519 public key
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 testCommitment = keccak256(abi.encodePacked(px, py));
        
        vm.prank(user);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user, xmrAmount, testCommitment);
        console.log("[2] User initiated mint");
        console.log("    Request ID:", vm.toString(requestId), "\n");
        
        // LP provides their Ed25519 public key for atomic swap
        bytes32 lpPublicKey = bytes32(uint256(0xdeadbeef));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey);
        console.log("[3] LP provided public key\n");
        
        // LP sets ready (after user locks XMR on Monero)
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(requestId);
        console.log("[4] LP set mint READY\n");
        
        // User finalizes
        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(requestId, testSecret);
        
        uint256 balance = wsxmr.balanceOf(user);
        console.log("[5] Mint finalized!");
        console.log("    User wsXMR balance:", balance, "\n");
        assertTrue(balance > 0, "Should have wsXMR");
        
        // User burns half
        uint256 burnAmount = balance / 2;
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(burnAmount, lp, user);
        console.log("[6] Burn requested:", burnAmount, "\n");
        
        // LP proposes hash (using Ed25519)
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));
        vm.prank(lp);
        BurnFacet(address(hub)).proposeHash(burnId, burnSecretHash);
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
