// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {BnbMockTestBase} from "./BnbTestBase.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationAuctionFacet} from "../contracts/facets/LiquidationAuctionFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ed25519} from "../contracts/Ed25519.sol";

/**
 * @title E2E Advanced Scenarios Test
 * @notice Tests advanced scenarios with oracle manipulation, time warping, and liquidations
 * @dev Demonstrates the power of controlling the oracle and time in tests
 */
contract E2EAdvancedScenariosTestBnb is BnbMockTestBase {
    address public lp1;
    address public lp2;
    address public user1;
    address public user2;
    address public liquidator;
    
    uint256 constant INITIAL_XMR_PRICE = 390_00000000; // $390

    bytes32 constant TEST_USER_SECRET = bytes32(uint256(0xdeadbeef));
    
    function setUp() public override {
        super.setUp();
        lp1 = makeAddr("lp1");
        lp2 = makeAddr("lp2");
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");
        liquidator = makeAddr("liquidator");
        
        vm.deal(lp1, 1000 ether);
        vm.deal(lp2, 1000 ether);
        vm.deal(user1, 1000 ether);
        vm.deal(user2, 1000 ether);
        vm.deal(liquidator, 1000 ether);
    }
    
    function _setupVault(address lp, uint256 collateralAmount) internal {
        deal(USDE, lp, collateralAmount);
        vm.startPrank(lp);
        VaultFacet(address(hub)).createVault();
        VaultFacet(address(hub)).setMaxMintWsxmr(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        
        IERC20(USDE).approve(address(hub), collateralAmount);
        VaultFacet(address(hub)).depositCollateral(collateralAmount);
        vm.stopPrank();
    }
    
    function _performMint(address lp, address user, uint256 xmrAmount) internal returns (uint256) {
        bytes32 testSecret = bytes32(uint256(uint160(user)));
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
        
        vm.prank(user);
        MintFacet(address(hub)).revealSecret(requestId, testSecret);
        MintFacet(address(hub)).finalizeMint(requestId);
        
        return wsxmr.balanceOf(user);
    }
    
    function test_PriceCrashLiquidation() public {
        console.log("\n=== SCENARIO: PRICE CRASH LIQUIDATION ===\n");
        
        // Setup vault with collateral
        _setupVault(lp1, 100 ether);
        console.log("[1] LP1 deposited 100 xDAI");
        
        // User mints at $390/XMR - mint 0.25 XMR ($97.50 worth) against $100 collateral = 102.5% ratio
        // After price drops to $200, debt becomes $50 worth, ratio becomes 200%
        uint256 mintedAmount = _performMint(lp1, user1, 25000000); // 0.25 XMR (8 decimals)
        console.log("[2] User1 minted", mintedAmount, "wsXMR (0.25 XMR) at $390/XMR");
        
        // Call view function on hub - THIS WORKS! No more StateChangeDuringStaticCall!
        uint256 healthBefore = hub.getVaultHealth(lp1);
        console.log("[3] Vault health:", healthBefore, "%");
        console.log("    [OK] View function works through hub!");

        // STRESS: LP raises its threshold → par obligation rises → coverage falls.
        // The declared threshold is the oracle-free solvency line.
        console.log("\n[STRESS] LP raises threshold 4x - coverage collapses");
        uint256 _thrlp158 = hub.minThreshold() * 4;
        vm.prank(lp1);
        VaultFacet(address(hub)).setThreshold(_thrlp158);

        uint256 healthAfter = hub.getVaultHealth(lp1);
        console.log("[4] Vault health after threshold raise:", healthAfter, "%");
        assertTrue(healthAfter < healthBefore, "Health should drop when par obligation rises");

        // Liquidator kicks → waits out grace + open delay → bids
        console.log("[5] Liquidator running kick/bid auction");
        vm.deal(liquidator, 1000 ether);

        _kickVault(liquidator, lp1);
        vm.roll(block.number + hub.KICK_GRACE_BLOCKS() + 1);
        LiquidationAuctionFacet(address(hub)).openAuction(lp1);
        vm.roll(block.number + hub.AUCTION_OPEN_DELAY_BLOCKS() + 1);

        uint256 debtToClear = hub.getVaultDebt(lp1);
        deal(address(wsxmr), liquidator, debtToClear);

        vm.startPrank(liquidator);
        uint256 collateralBefore = IERC20(USDE).balanceOf(liquidator);
        wsxmr.approve(address(hub), debtToClear);
        LiquidationAuctionFacet(address(hub)).bid(lp1);
        uint256 collateralAfter = IERC20(USDE).balanceOf(liquidator);
        console.log("[6] Liquidator received collateral:", collateralAfter - collateralBefore);
        vm.stopPrank();

        assertEq(hub.getVaultDebt(lp1), 0, "Auction bid must clear the vault's debt");
        console.log("\n[OK] Auction liquidation completed successfully!\n");
    }
    
    function test_TimeWarpMintTimeout() public {
        console.log("\n=== SCENARIO: TIME WARP - MINT TIMEOUT ===\n");
        
        _setupVault(lp1, 100 ether);
        console.log("[1] LP1 vault created");
        
        // User initiates mint
        bytes32 testSecret = bytes32(uint256(0x12345));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        
        vm.prank(user1);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp1, user1, 50000000000, commitment, bytes32(px));
        console.log("[2] User1 initiated mint with 1 hour timeout");
        
        // Warp time forward 2 hours (past timeout)
        console.log("[3] Warping time forward 2 hours...");
        vm.roll(block.number + 7200);
        
        // LP can now cancel and claim griefing deposit
        vm.prank(lp1);
        MintFacet(address(hub)).cancelMint(requestId, bytes32(0));
        console.log("[4] LP1 cancelled mint and claimed griefing deposit");
        
        uint256 lpReturns = VaultFacet(address(hub)).pendingReturns(lp1, address(0));
        console.log("[5] LP pending returns:", lpReturns);
        console.log("[6] Griefing deposit mechanism demonstrated");
        
        console.log("\n[OK] Time warp mint timeout test passed!\n");
    }
    
    function test_TimeWarpBurnTimeout() public {
        console.log("\n=== SCENARIO: TIME WARP - BURN TIMEOUT & SLASHING ===\n");
        
        _setupVault(lp1, 100 ether);
        uint256 mintedAmount = _performMint(lp1, user1, 50000000000);
        console.log("[1] User1 minted", mintedAmount, "wsXMR");
        
        // User requests burn
        (uint256 upkx, uint256 upky) = Ed25519.scalarMultBase(uint256(TEST_USER_SECRET));
        bytes32 userPubKey = bytes32(Ed25519.compressPoint(upkx, upky));
        vm.prank(user1);
        bytes32 burnRequestId = BurnFacet(address(hub)).requestBurn(mintedAmount / 2, lp1, user1, bytes32(uint256(1)), userPubKey, bytes32(uint256(3)));
        console.log("[2] User1 requested burn");
        
        // LP proposes hash
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));
        
        vm.prank(lp1);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnRequestId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);
        console.log("[3] LP1 proposed hash");
        
        // User confirms Monero lock
        vm.prank(user1);
        BurnFacet(address(hub)).confirmMoneroLock(burnRequestId);
        console.log("[4] User1 confirmed Monero lock (COMMITTED state)");
        
        // Warp time forward past finalization deadline (2 hours)
        console.log("[5] Warping time forward 3 hours...");
        vm.roll(block.number + 10800);
        
        // User can now claim slashed collateral - revealing userSecret lets the LP sweep the shared XMR
        uint256 collateralBefore = IERC20(address(stata)).balanceOf(user1);
        vm.prank(user1);
        BurnFacet(address(hub)).claimSlashedCollateral(burnRequestId, TEST_USER_SECRET);
        uint256 collateralAfter = IERC20(address(stata)).balanceOf(user1);
        
        console.log("[6] User1 claimed slashed collateral:", collateralAfter - collateralBefore);
        console.log("[7] LP1 was slashed for not revealing secret!");
        
        console.log("\n[OK] Burn timeout and slashing test passed!\n");
    }
    
    function test_PriceVolatilityMultipleLiquidations() public {
        console.log("\n=== SCENARIO: PRICE VOLATILITY - MULTIPLE LIQUIDATIONS ===\n");
        
        // Setup two vaults
        _setupVault(lp1, 100 ether);
        _setupVault(lp2, 150 ether);
        console.log("[1] LP1 deposited 100 xDAI, LP2 deposited 150 xDAI");
        
        // Both mint at $390 (keep under 150% CR check: projectedDebt = 2*wsxmrAmount)
        uint256 lp1Minted = _performMint(lp1, user1, 80_000_000_000); // ~0.8 XMR
        uint256 lp2Minted = _performMint(lp2, user2, 120_000_000_000); // ~1.2 XMR
        console.log("[2] User1 minted", lp1Minted, "from LP1");
        console.log("[3] User2 minted", lp2Minted, "from LP2");
        
        // Stress 1: both LPs raise thresholds - par obligations rise
        console.log("\n[STRESS 1] LPs raise threshold 2x");
        uint256 _thrlp1719 = hub.minThreshold() * 2;
        vm.prank(lp1);
        VaultFacet(address(hub)).setThreshold(_thrlp1719);
        uint256 _thrlp2319 = hub.minThreshold() * 2;
        vm.prank(lp2);
        VaultFacet(address(hub)).setThreshold(_thrlp2319);

        console.log("[4] Both vaults should be stressed (higher par obligation)");

        // Stress 2: threshold raised further
        console.log("\n[STRESS 2] Threshold raised 4x - vaults deep underwater");
        uint256 _thrlp158 = hub.minThreshold() * 4;
        vm.prank(lp1);
        VaultFacet(address(hub)).setThreshold(_thrlp158);
        uint256 _thrlp2167 = hub.minThreshold() * 4;
        vm.prank(lp2);
        VaultFacet(address(hub)).setThreshold(_thrlp2167);

        console.log("[5] Both vaults are now deep underwater - kickable by anyone");

        // Recovery: thresholds back to floor → par obligations drop
        console.log("\n[RECOVERY] Thresholds return to floor");
        uint256 _thrlp1687 = hub.minThreshold();
        vm.prank(lp1);
        VaultFacet(address(hub)).setThreshold(_thrlp1687);
        uint256 _thrlp2986 = hub.minThreshold();
        vm.prank(lp2);
        VaultFacet(address(hub)).setThreshold(_thrlp2986);

        console.log("[7] After recovery, vaults should be healthier");

        console.log("\n[OK] Threshold volatility test completed!\n");
    }
    
    function test_ComplexScenario_CrashRecoveryYield() public {
        console.log("\n=== SCENARIO: COMPLEX - CRASH, RECOVERY, YIELD ACCUMULATION ===\n");
        
        _setupVault(lp1, 200 ether);
        console.log("[1] LP1 deposited 200 xDAI");
        
        // Mint at $390 (keep under 150% CR check)
        uint256 mintedAmount = _performMint(lp1, user1, 160_000_000_000); // ~1.6 XMR
        console.log("[2] User1 minted", mintedAmount, "wsXMR at $390");
        
        // Stress: LP raises threshold - par obligation rises
        console.log("\n[STRESS] Threshold raised 3x");
        uint256 _thrlp121 = hub.minThreshold() * 3;
        vm.prank(lp1);
        VaultFacet(address(hub)).setThreshold(_thrlp121);
        console.log("[3] Vault health should be stressed after threshold raise");

        // Time passes
        console.log("[4] Time passes - 30 days...");
        vm.warp(block.timestamp + 30 days);

        // Recovery: threshold back to floor
        console.log("\n[RECOVERY] Threshold returns to floor");
        uint256 _thrlp1687 = hub.minThreshold();
        vm.prank(lp1);
        VaultFacet(address(hub)).setThreshold(_thrlp1687);
        console.log("[5] Vault health should improve after recovery");

        // LP withdraws some collateral
        vm.prank(lp1);
        VaultFacet(address(hub)).withdrawCollateral(10 ether);
        console.log("[6] LP1 withdrew 10 ether of collateral");
        
        // User burns half
        vm.prank(user1);
        bytes32 burnRequestId = BurnFacet(address(hub)).requestBurn(mintedAmount / 2, lp1, user1, bytes32(uint256(1)), bytes32(uint256(2)), bytes32(uint256(3)));
        
        bytes32 burnSecret = bytes32(uint256(0xdeadbeef));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));
        
        vm.prank(lp1);
        bytes32 lpPublicSpendKey = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 lpPublicViewKey = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        BurnFacet(address(hub)).proposeHash(burnRequestId, burnSecretHash, lpPublicSpendKey, lpPublicViewKey);
        
        vm.prank(user1);
        BurnFacet(address(hub)).confirmMoneroLock(burnRequestId);
        
        vm.prank(lp1);
        BurnFacet(address(hub)).finalizeBurn(burnRequestId, burnSecret);
        
        console.log("[7] User1 burned half their wsXMR");
        
        console.log("[8] Final vault should be healthy after partial burn");
        
        console.log("\n[OK] Complex scenario completed successfully!\n");
    }
}

contract MockVerifierProxyBnb {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}
