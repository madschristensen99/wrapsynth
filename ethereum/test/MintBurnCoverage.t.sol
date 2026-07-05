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
        MintFacet(address(hub)).finalizeMint(reqId, bytes32(uint256(0x1234)));

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
        MintFacet(address(hub)).cancelMint(reqId);

        vm.roll(block.number + 500);

        uint256 pendingBefore = _getPendingReturns(user, address(0));
        MintFacet(address(hub)).sweepUnclaimedExpiredMint(reqId);
        uint256 pendingAfter = _getPendingReturns(user, address(0));

        assertGt(pendingAfter, pendingBefore, "user should get griefing deposit back");

        wsXmrStorage.MintRequest memory req = _getMintRequest(reqId);
        assertEq(uint256(req.status), uint256(wsXmrStorage.MintStatus.CANCELLED), "should be CANCELLED");
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
        MintFacet(address(hub)).cancelMint(reqId);

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
        VaultFacet(address(hub)).setMintReadyBond(0.001 ether);
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
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)));
    }

    function _setMintReady(address _lp, bytes32 reqId) internal {
        vm.prank(_lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(reqId, bytes32(uint256(0xdeadbeef)));
    }

    function _mintForUser(address _user, address _lp) internal returns (uint256) {
        bytes32 reqId = _initiateMint(_user, _lp);
        _provideLPKey(_lp, reqId);
        _setMintReady(_lp, reqId);
        vm.prank(_user);
        MintFacet(address(hub)).finalizeMint(reqId, bytes32(uint256(0x1234)));
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
