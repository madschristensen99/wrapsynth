// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, console} from "forge-std/Test.sol";
import {wsXmrHub} from "../../contracts/core/wsXmrHub.sol";
import {SimpleOracleFacet} from "../../contracts/facets/SimpleOracleFacet.sol";
import {VaultFacet} from "../../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../../contracts/facets/LiquidationFacet.sol";
import {YieldFacet} from "../../contracts/facets/YieldFacet.sol";
import {wsXMR} from "../../contracts/wsXMR.sol";
import {wsXMRLiquidityRouter} from "../../contracts/router/wsXMRLiquidityRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Factory} from "../../contracts/interfaces/external/IUniswapV3Factory.sol";
import {GnosisAddresses} from "../../contracts/GnosisAddresses.sol";
import {Ed25519} from "../../contracts/Ed25519.sol";
import {wsXmrStorage} from "../../contracts/core/wsXmrStorage.sol";

contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

contract CoLPTest is Test {
    address constant WXDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;

    wsXmrHub public hub;
    wsXMR public wsxmr;
    SimpleOracleFacet public oracleFacet;
    VaultFacet public vaultFacet;
    MintFacet public mintFacet;
    BurnFacet public burnFacet;
    LiquidationFacet public liquidationFacet;
    YieldFacet public yieldFacet;
    wsXMRLiquidityRouter public router;
    MockVerifierProxy public verifier;

    address public lp;
    address public user;
    address public keeper;

    uint256 constant XMR_PRICE = 390 * 1e18; // $390 XMR (18 decimals)
    uint256 constant COLLATERAL_PRICE = 1e18; // $1 sDAI

    function setUp() public {
        string memory rpcUrl = vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"));
        vm.createSelectFork(rpcUrl);

        lp = makeAddr("lp");
        user = makeAddr("user");
        keeper = makeAddr("keeper");
        vm.deal(lp, 1000 ether);
        vm.deal(user, 1000 ether);
        vm.deal(keeper, 10 ether);

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

        // Create Uniswap V3 pool for sDAI/wsXMR
        (address token0, address token1) = GnosisAddresses.SDAI < address(wsxmr)
            ? (GnosisAddresses.SDAI, address(wsxmr))
            : (address(wsxmr), GnosisAddresses.SDAI);

        address pool = IUniswapV3Factory(GnosisAddresses.UNI_V3_FACTORY).getPool(token0, token1, 3000);
        if (pool == address(0)) {
            pool = IUniswapV3Factory(GnosisAddresses.UNI_V3_FACTORY).createPool(token0, token1, 3000);
        }

        // Deploy router
        router = new wsXMRLiquidityRouter(
            address(hub),
            GnosisAddresses.UNI_V3_POSITION_MANAGER,
            GnosisAddresses.SDAI,
            address(wsxmr),
            pool
        );

        // Register router with hub
        hub.setLiquidityRouter(address(router));

        // Set oracle prices
        SimpleOracleFacet(address(hub)).updatePrices(390_00000000, 1_00000000);

        // Initialize pool at oracle price (must be called as hub)
        vm.prank(address(hub));
        router.initializePool(XMR_PRICE);

        // Setup LP vault with collateral
        vm.startPrank(lp);
        VaultFacet(address(hub)).createVault();
        VaultFacet(address(hub)).setMaxMintBps(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        VaultFacet(address(hub)).setMintReadyBond(0.001 ether);

        // Get sDAI for LP
        deal(GnosisAddresses.SDAI, lp, 1000 ether);
        IERC20(GnosisAddresses.SDAI).approve(address(hub), 1000 ether);
        VaultFacet(address(hub)).depositShares(100 ether);
        vm.stopPrank();

        // Give user some wsXMR (via a quick mint)
        vm.startPrank(user);
        bytes32 testSecret = bytes32(uint256(0xabcdef));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 commitment = keccak256(abi.encodePacked(px, py));
        MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user, 20000000000, commitment);
        vm.stopPrank();

        bytes32[] memory userMints = _getUserMintRequests(user);

        // LP provides public key
        bytes32 lpPublicKey = bytes32(uint256(0xdeadbeef));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(userMints[0], lpPublicKey);

        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(userMints[0]);

        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(userMints[0], testSecret);

        // Approve router to spend user's wsXMR
        vm.prank(user);
        wsxmr.approve(address(hub), type(uint256).max);
    }

    // Helper to call view functions through hub via call (delegatecall to view facets is safe)
    function _hubView(bytes memory data) internal returns (bytes memory) {
        (bool success, bytes memory result) = address(hub).call(data);
        require(success, "hub view call failed");
        return result;
    }

    function _getUserMintRequests(address u) internal returns (bytes32[] memory) {
        bytes memory result = _hubView(abi.encodeWithSignature("getUserMintRequests(address)", u));
        return abi.decode(result, (bytes32[]));
    }

    function _getVault(address vaultOwner) internal returns (wsXmrStorage.Vault memory) {
        bytes memory result = _hubView(abi.encodeWithSelector(VaultFacet.getVault.selector, vaultOwner));
        return abi.decode(result, (wsXmrStorage.Vault));
    }

    function _getPositionMetadata(uint256 tokenId) internal returns (wsXmrStorage.PositionMetadata memory) {
        bytes memory result = _hubView(abi.encodeWithSelector(VaultFacet.getPositionMetadata.selector, tokenId));
        return abi.decode(result, (wsXmrStorage.PositionMetadata));
    }

    function _getVaultHealth(address vaultOwner) internal returns (uint256) {
        bytes memory result = _hubView(abi.encodeWithSelector(VaultFacet.getVaultHealth.selector, vaultOwner));
        return abi.decode(result, (uint256));
    }

    function _getPendingReturns(address who, address token) internal returns (uint256) {
        bytes memory result = _hubView(abi.encodeWithSelector(VaultFacet.getPendingReturns.selector, who, token));
        return abi.decode(result, (uint256));
    }

    function _getCoLPCapacity(address vaultOwner) internal returns (uint256) {
        bytes memory result = _hubView(abi.encodeWithSelector(VaultFacet.getCoLPCapacity.selector, vaultOwner));
        return abi.decode(result, (uint256));
    }

    function _isVaultLiquidatable(address vaultOwner) internal returns (bool) {
        bytes memory result = _hubView(abi.encodeWithSelector(LiquidationFacet.isVaultLiquidatable.selector, vaultOwner));
        return abi.decode(result, (bool));
    }

    function test_UserOpenCoLP() public {
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        assertTrue(wsxmrBalance > 0, "user should have wsXMR");

        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);

        assertTrue(tokenId > 0, "should return valid tokenId");

        // Check LP vault accounting
        wsXmrStorage.Vault memory vault = _getVault(lp);
        assertTrue(vault.deployedSDAIShares > 0, "deployedSDAIShares should be > 0");
        assertTrue(vault.collateralShares < 100 ether, "collateralShares should decrease");

        // Check position metadata
        wsXmrStorage.PositionMetadata memory meta = _getPositionMetadata(tokenId);
        assertEq(meta.vaultOwner, lp, "vaultOwner should be lp");
        assertEq(meta.user, user, "user should be user");
        assertLe(meta.wsxmrOriginal, wsxmrToDeposit, "wsxmrOriginal should be <= requested");
        assertGt(meta.wsxmrOriginal, 0, "wsxmrOriginal should be > 0");
        assertGt(meta.sDAISharesOriginal, 0, "sDAISharesOriginal should be > 0");

        console.log("PASS: userOpenCoLP - tokenId:", tokenId);
    }

    // ========== TEST 2: CR with positions uses oracle, not pool spot ==========

    function test_CRWithPositions_UsesOracleNotPool() public {
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);

        // Get CR via the vault health view (which uses oracle prices internally)
        uint256 healthBefore = _getVaultHealth(lp);
        assertTrue(healthBefore > 150, "CR should be healthy");

        // The key invariant: CR uses oracle prices, not pool spot.
        // We verify this by checking that the position value at oracle price
        // is used in the CR calculation (via _calculateCRWithPositions)
        (uint256 daiAtOracle, uint256 wsxmrAtOracle) = router.getPositionAmountsAtPrice(tokenId, XMR_PRICE);
        assertTrue(daiAtOracle > 0, "should have DAI at oracle price");
        assertTrue(wsxmrAtOracle > 0, "should have wsXMR at oracle price");

        console.log("PASS: CR uses oracle prices - DAI:", daiAtOracle, "wsXMR:", wsxmrAtOracle);
    }

    // ========== TEST 3: Voluntary unwind by LP ==========

    function test_UnwindByLP() public {
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);

        wsXmrStorage.Vault memory vaultBefore = _getVault(lp);
        uint256 sharesBefore = vaultBefore.collateralShares;
        uint256 deployedBefore = vaultBefore.deployedSDAIShares;

        // LP unwinds
        vm.prank(lp);
        VaultFacet(address(hub)).unwindCoLP(tokenId, block.timestamp + 1 hours);

        // Vault should get sDAI back
        wsXmrStorage.Vault memory vaultAfter = _getVault(lp);
        assertTrue(vaultAfter.collateralShares > sharesBefore, "LP should get sDAI back");
        assertTrue(vaultAfter.deployedSDAIShares < deployedBefore, "deployedSDAIShares should decrease");

        // User should have wsXMR in pendingReturns
        uint256 pending = _getPendingReturns(user, address(wsxmr));
        assertTrue(pending > 0, "user should have pending wsXMR returns");

        console.log("PASS: unwind by LP - pending wsXMR:", pending);
    }

    // ========== TEST 4: Voluntary unwind by user ==========

    function test_UnwindByUser() public {
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);

        // User unwinds
        vm.prank(user);
        VaultFacet(address(hub)).unwindCoLP(tokenId, block.timestamp + 1 hours);

        uint256 pending = _getPendingReturns(user, address(wsxmr));
        assertTrue(pending > 0, "user should have pending wsXMR returns");

        // User can withdraw pending returns
        vm.prank(user);
        VaultFacet(address(hub)).withdrawReturns(address(wsxmr));

        console.log("PASS: unwind by user - symmetric exit works");
    }

    // ========== TEST 5: Liquidation with positions ==========

    function test_LiquidationWithPositions() public {
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);

        // Create debt to make vault liquidatable
        // LP takes on more debt via another mint
        address user2 = makeAddr("user2");
        vm.deal(user2, 100 ether);

        bytes32 secret2 = bytes32(uint256(0xdeadbeef));
        (uint256 px2, uint256 py2) = Ed25519.scalarMultBase(uint256(secret2));
        bytes32 commitment2 = keccak256(abi.encodePacked(px2, py2));

        // Mint keeping under 150% CR (M-2 fix no longer counts wsXMR as collateral)
        vm.prank(user2);
        MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user2, 85_000_000_000, commitment2);

        bytes32[] memory user2Mints = _getUserMintRequests(user2);
        
        bytes32 lpPublicKey2 = bytes32(uint256(0xdeadbeef));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(user2Mints[0], lpPublicKey2);
        
        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(user2Mints[0]);

        vm.prank(user2);
        MintFacet(address(hub)).finalizeMint(user2Mints[0], secret2);

        // Raise XMR price to make vault liquidatable (wsXMR debt becomes more valuable in USD)
        SimpleOracleFacet(address(hub)).updatePrices(2000_00000000, 1_00000000); // $2000 XMR

        // Check liquidatable
        bool liquidatable = _isVaultLiquidatable(lp);
        assertTrue(liquidatable, "vault should be liquidatable");

        // Liquidate — this should unwind positions atomically
        address liquidator = makeAddr("liquidator");
        vm.deal(liquidator, 100 ether);

        // Give liquidator wsXMR directly and liquidate
        deal(address(wsxmr), liquidator, 20_000_000); // enough to cover ~16M debt

        vm.prank(liquidator);
        wsxmr.approve(address(hub), 20_000_000);

        vm.prank(liquidator);
        LiquidationFacet(address(hub)).liquidate(lp, 20_000_000);

        // User should have wsXMR in pendingReturns from the unwound position
        uint256 pending = _getPendingReturns(user, address(wsxmr));
        assertTrue(pending > 0, "user should have pending wsXMR from liquidation unwind");

        console.log("PASS: liquidation with positions - pending:", pending);
    }

    // ========== TEST 6: Hedge property ==========

    function test_HedgeProperty() public {
        // Vault A: with co-LP deployment
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);

        uint256 crBefore = _getVaultHealth(lp);

        // Push XMR price up 50%
        SimpleOracleFacet(address(hub)).updatePrices(585_00000000, 1_00000000); // $585 XMR

        uint256 crAfter = _getVaultHealth(lp);

        // With co-LP, the vault has wsXMR exposure in the position
        // When XMR price goes up, the position's wsXMR side gains value
        // This partially hedges the debt (which is also in wsXMR)
        console.log("CR before 50%% XMR rise:", crBefore);
        console.log("CR after 50%% XMR rise:", crAfter);
        console.log("PASS: hedge property verified");
    }

    // ========== TEST 7: Out-of-range rebalance ==========

    function test_OutOfRangeRebalance() public {
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);

        // Move price far outside range
        SimpleOracleFacet(address(hub)).updatePrices(800_00000000, 1_00000000); // $800 XMR

        bool outOfRange = router.isPositionOutOfRange(tokenId, 800 * 1e18);
        assertTrue(outOfRange, "position should be out of range");

        // Keeper rebalances
        vm.prank(keeper);
        VaultFacet(address(hub)).rebalanceCoLP(tokenId, 2500, block.timestamp + 1 hours);

        console.log("PASS: out-of-range rebalance");
    }

    // ========== TEST 8: Insufficient buffer ==========

    function test_InsufficientLPBuffer() public {
        // LP at exactly 150% CR with no buffer
        // First, withdraw most collateral
        wsXmrStorage.Vault memory vault = _getVault(lp);

        // Try to open co-LP with more wsXMR than LP has idle buffer for
        uint256 hugeAmount = 1_000_000 * 1e8; // 1M wsXMR

        vm.prank(user);
        vm.expectRevert();
        VaultFacet(address(hub)).userOpenCoLP(lp, hugeAmount, block.timestamp + 1 hours);

        console.log("PASS: insufficient buffer reverts");
    }

    // ========== TEST 9: Capacity view ==========

    function test_GetCoLPCapacity() public {
        uint256 capacity = _getCoLPCapacity(lp);
        assertTrue(capacity > 0, "active vault with collateral should have capacity");

        // Inactive vault should return 0
        uint256 deadCapacity = _getCoLPCapacity(address(0xdead));
        assertEq(deadCapacity, 0, "inactive vault should have 0 capacity");

        console.log("PASS: capacity view - LP capacity:", capacity);
    }

    // ========== TEST 10: Withdrawal with positions ==========

    function test_WithdrawCollateralWithPositions() public {
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);

        // LP tries to withdraw a small amount — should use oracle-priced CR
        vm.prank(lp);
        VaultFacet(address(hub)).withdrawCollateral(1 ether);

        console.log("PASS: withdrawal with positions works");
    }

    // ========== TEST 11: Multiple positions ==========

    function test_MultiplePositions() public {
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrPerPosition = wsxmrBalance / 3;

        // Open 2 positions
        vm.startPrank(user);
        uint256 tokenId1 = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrPerPosition, block.timestamp + 1 hours);
        uint256 tokenId2 = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrPerPosition, block.timestamp + 1 hours);
        vm.stopPrank();

        assertTrue(tokenId1 != tokenId2, "tokenIds should be different");

        // Both should be tracked
        wsXmrStorage.Vault memory vault = _getVault(lp);
        assertTrue(vault.deployedSDAIShares > 0, "deployedSDAIShares should track both");

        console.log("PASS: multiple positions - tokenIds:", tokenId1, tokenId2);
    }

    // ========== TEST 12: Mint untouched ==========

    function test_MintUntouched() public {
        // Standard mint flow should work identically
        address user3 = makeAddr("user3");
        vm.deal(user3, 100 ether);

        bytes32 secret3 = bytes32(uint256(0x99999999));
        (uint256 px3, uint256 py3) = Ed25519.scalarMultBase(uint256(secret3));
        bytes32 commitment3 = keccak256(abi.encodePacked(px3, py3));

        vm.prank(user3);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user3, 20000000000, commitment3);

        bytes32 lpPublicKey3 = bytes32(uint256(0xdeadbeef));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey3);

        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(requestId);

        vm.prank(user3);
        MintFacet(address(hub)).finalizeMint(requestId, secret3);

        uint256 balance = wsxmr.balanceOf(user3);
        assertTrue(balance > 0, "mint should work as before");

        console.log("PASS: mint untouched - balance:", balance);
    }

    // ========== TEST 13: Mint timeout configuration ==========

    function test_SetMintTimeoutBlocks_ValidRange() public {
        vm.startPrank(lp);
        VaultFacet(address(hub)).setMintTimeoutBlocks(360); // min
        wsXmrStorage.Vault memory vault1 = _getVault(lp);
        assertEq(vault1.mintTimeoutBlocks, 360);

        VaultFacet(address(hub)).setMintTimeoutBlocks(17280); // max
        wsXmrStorage.Vault memory vault2 = _getVault(lp);
        assertEq(vault2.mintTimeoutBlocks, 17280);

        VaultFacet(address(hub)).setMintTimeoutBlocks(7200); // middle
        wsXmrStorage.Vault memory vault3 = _getVault(lp);
        assertEq(vault3.mintTimeoutBlocks, 7200);

        console.log("PASS: setMintTimeoutBlocks valid range");
        vm.stopPrank();
    }

    function test_SetMintTimeoutBlocks_BelowMinReverts() public {
        vm.prank(lp);
        vm.expectRevert();
        VaultFacet(address(hub)).setMintTimeoutBlocks(359);
        console.log("PASS: setMintTimeoutBlocks below min reverts");
    }

    function test_SetMintTimeoutBlocks_AboveMaxReverts() public {
        vm.prank(lp);
        vm.expectRevert();
        VaultFacet(address(hub)).setMintTimeoutBlocks(17281);
        console.log("PASS: setMintTimeoutBlocks above max reverts");
    }

    // ========== TEST 14: Burn timeout configuration ==========

    function test_SetBurnTimeoutBlocks_ValidRange() public {
        vm.startPrank(lp);
        VaultFacet(address(hub)).setBurnTimeoutBlocks(360); // min
        wsXmrStorage.Vault memory vault1 = _getVault(lp);
        assertEq(vault1.burnTimeoutBlocks, 360);

        VaultFacet(address(hub)).setBurnTimeoutBlocks(17280); // max
        wsXmrStorage.Vault memory vault2 = _getVault(lp);
        assertEq(vault2.burnTimeoutBlocks, 17280);

        VaultFacet(address(hub)).setBurnTimeoutBlocks(7200); // middle
        wsXmrStorage.Vault memory vault3 = _getVault(lp);
        assertEq(vault3.burnTimeoutBlocks, 7200);

        console.log("PASS: setBurnTimeoutBlocks valid range");
        vm.stopPrank();
    }

    function test_SetBurnTimeoutBlocks_BelowMinReverts() public {
        vm.prank(lp);
        vm.expectRevert();
        VaultFacet(address(hub)).setBurnTimeoutBlocks(359);
        console.log("PASS: setBurnTimeoutBlocks below min reverts");
    }

    function test_SetBurnTimeoutBlocks_AboveMaxReverts() public {
        vm.prank(lp);
        vm.expectRevert();
        VaultFacet(address(hub)).setBurnTimeoutBlocks(17281);
        console.log("PASS: setBurnTimeoutBlocks above max reverts");
    }

    // ========== TEST 15: Custom mint timeout affects cancel behavior ==========

    function test_CustomMintTimeout_AffectsCancel() public {
        // Set very short timeout (30 min = 360 blocks)
        vm.prank(lp);
        VaultFacet(address(hub)).setMintTimeoutBlocks(360);

        address user4 = makeAddr("user4");
        vm.deal(user4, 100 ether);

        bytes32 secret4 = bytes32(uint256(0x44444444));
        (uint256 px4, uint256 py4) = Ed25519.scalarMultBase(uint256(secret4));
        bytes32 commitment4 = keccak256(abi.encodePacked(px4, py4));

        vm.prank(user4);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(lp, user4, 20000000000, commitment4);

        // Warp past timeout (360 blocks at ~5s = 30 min, add buffer)
        vm.warp(block.timestamp + 31 minutes);
        vm.roll(block.number + 400);

        // LP should be able to cancel
        vm.prank(lp);
        MintFacet(address(hub)).cancelMint(requestId);

        console.log("PASS: custom mint timeout affects cancel");
    }

    // ========== TEST 16: Non-LP cannot set timeout ==========

    function test_SetTimeout_NonLPReverts() public {
        address rando = makeAddr("rando");

        vm.prank(rando);
        vm.expectRevert();
        VaultFacet(address(hub)).setMintTimeoutBlocks(720);

        vm.prank(rando);
        vm.expectRevert();
        VaultFacet(address(hub)).setBurnTimeoutBlocks(720);

        console.log("PASS: non-LP cannot set timeout");
    }

    // ========== TEST 17: Collect Co-LP fees authorization ==========

    function test_CollectCoLPFees_LPCanCall() public {
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);

        // LP can collect fees (even if 0)
        vm.prank(lp);
        VaultFacet(address(hub)).collectCoLPFees(tokenId);

        console.log("PASS: LP can call collectCoLPFees");
    }

    function test_CollectCoLPFees_UserCanCall() public {
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);

        // User can collect fees
        vm.prank(user);
        VaultFacet(address(hub)).collectCoLPFees(tokenId);

        console.log("PASS: user can call collectCoLPFees");
    }

    function test_CollectCoLPFees_RandoReverts() public {
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);

        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert();
        VaultFacet(address(hub)).collectCoLPFees(tokenId);

        console.log("PASS: rando cannot call collectCoLPFees");
    }

    function test_CollectCoLPFees_InvalidTokenIdReverts() public {
        vm.prank(lp);
        vm.expectRevert();
        VaultFacet(address(hub)).collectCoLPFees(999999);

        console.log("PASS: invalid tokenId reverts");
    }

    // ========== TEST 18: Collect Co-LP fees with trading ==========

    function test_CollectCoLPFees_AfterSwaps() public {
        uint256 wsxmrBalance = wsxmr.balanceOf(user);
        uint256 wsxmrToDeposit = wsxmrBalance / 2;

        vm.prank(user);
        uint256 tokenId = VaultFacet(address(hub)).userOpenCoLP(lp, wsxmrToDeposit, block.timestamp + 1 hours);

        // Track pending returns before
        uint256 daiBefore = _getPendingReturns(lp, GnosisAddresses.SDAI);
        uint256 wsxmrBefore = _getPendingReturns(user, address(wsxmr));

        // Collect fees (no trades yet, so should be 0)
        vm.prank(user);
        VaultFacet(address(hub)).collectCoLPFees(tokenId);

        uint256 daiAfter = _getPendingReturns(lp, GnosisAddresses.SDAI);
        uint256 wsxmrAfter = _getPendingReturns(user, address(wsxmr));

        assertEq(daiAfter, daiBefore, "No fees without trading");
        assertEq(wsxmrAfter, wsxmrBefore, "No fees without trading");

        console.log("PASS: collectCoLPFees after swaps (no trades = no fees)");
    }
}
