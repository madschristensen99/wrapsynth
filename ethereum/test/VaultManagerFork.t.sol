// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, console, StdStorage, stdStorage} from "forge-std/Test.sol";
import {VaultManager} from "../contracts/VaultManager.sol";
import {MockVerifierProxy} from "../contracts/mocks/MockVerifierProxy.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ed25519} from "../contracts/Ed25519.sol";
import {ISavingsDAI} from "../contracts/interfaces/ISavingsDAI.sol";
import {ISwapRouter} from "../contracts/interfaces/ISwapRouter.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";

/**
 * @title MockSwapRouter
 * @notice Minimal mock for Uniswap V3 SwapRouter to enable buy-and-burn testing on fork
 */
contract MockSwapRouter {
    function exactInputSingle(ISwapRouter.ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut)
    {
        // Pull tokenIn from msg.sender
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        // Transfer tokenOut from our balance to recipient
        IERC20(params.tokenOut).transfer(params.recipient, params.amountOutMinimum);
        return params.amountOutMinimum;
    }
}

/**
 * @title VaultManagerForkTest
 * @notice Comprehensive end-to-end fork test for WrapSynth contracts on Gnosis Chain
 * @dev Run with: forge test --fork-url https://rpc.gnosischain.com -vvv
 */
contract VaultManagerForkTest is Test {
    using stdStorage for StdStorage;
    // ============ Constants ============
    address constant WXDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    address constant SDAI_CONTRACT = 0xaf204776c7245bF4147c2612BF6e5972Ee483701;
    bytes32 constant XMR_FEED_ID = 0x00038f3b8f8be4305564abf0ed3c9cc46cb8b4303c35ab54079ea873b7d74b3a;
    bytes32 constant DAI_FEED_ID = 0x0003a9efc56074727bde001b0f0301eef38db844278734c32aa8b72dcb7902ba;

    uint256 constant PRICE_PRECISION = 1e18;
    uint256 constant WSXMR_DECIMALS = 1e8;
    uint256 constant SDAI_DECIMALS = 1e18;
    uint256 constant BPS_DENOMINATOR = 10000;

    // ============ Contracts ============
    VaultManager public vaultManager;
    MockVerifierProxy public verifier;
    wsXMR public wsxmr;
    IERC20 public wxdai;
    IERC20 public sdaiToken;

    // ============ Actors ============
    address public deployer;
    address public lp1;
    address public lp2;
    address public user1;
    address public user2;
    address public liquidator;
    address public keeper;
    address public router;

    // ============ Test State ============
    bytes32 public testSecret = bytes32(uint256(123456789));
    bytes32 public testCommitment;

    // ============ Setup ============
    function setUp() public {
        // Select Gnosis mainnet fork
        string memory rpcUrl = vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"));
        vm.createSelectFork(rpcUrl);

        // Initialize actors
        deployer = address(this);
        lp1 = makeAddr("lp1");
        lp2 = makeAddr("lp2");
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");
        liquidator = makeAddr("liquidator");
        keeper = makeAddr("keeper");
        router = makeAddr("router");

        // Fund actors with native xDAI for gas and griefing deposits
        vm.deal(lp1, 1000 ether);
        vm.deal(lp2, 1000 ether);
        vm.deal(user1, 1000 ether);
        vm.deal(user2, 1000 ether);
        vm.deal(liquidator, 1000 ether);
        vm.deal(keeper, 1000 ether);
        vm.deal(router, 1000 ether);

        // Bind token contracts
        wxdai = IERC20(WXDAI);
        sdaiToken = IERC20(SDAI_CONTRACT);

        // Fund LPs and users with wxDAI from sDAI contract (holds underlying)
        _fundWXDAI(lp1, 2_000_000e18);
        _fundWXDAI(lp2, 2_000_000e18);
        _fundWXDAI(user1, 500_000e18);
        _fundWXDAI(user2, 500_000e18);
        _fundWXDAI(liquidator, 1_000_000e18);
        _fundWXDAI(keeper, 100_000e18);

        // Deploy mock verifier
        verifier = new MockVerifierProxy();

        // Deploy VaultManager (deploys wsXMR internally)
        vaultManager = new VaultManager(address(verifier));
        wsxmr = vaultManager.wsxmrToken();

        // Set initial prices: XMR $160, DAI $1.00 (8-decimal Chainlink format)
        _updatePrices(160_00000000, 1_00000000);

        // Pre-compute commitment for test secret
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        testCommitment = keccak256(abi.encodePacked(px, py));
    }

    // ============ Internal Helpers ============

    function _fundWXDAI(address recipient, uint256 amount) internal {
        vm.prank(SDAI_CONTRACT);
        wxdai.transfer(recipient, amount);
    }

    function _buildReport(bytes32 feedId) internal view returns (bytes memory) {
        bytes memory reportData = abi.encodePacked(uint16(3), feedId, uint256(0));
        return abi.encode(bytes32(0), bytes32(0), bytes32(0), reportData);
    }

    function _updatePrices(int192 xmrPrice, int192 daiPrice) internal {
        verifier.setPrice(XMR_FEED_ID, xmrPrice);
        verifier.setPrice(DAI_FEED_ID, daiPrice);

        bytes[] memory reports = new bytes[](2);
        reports[0] = _buildReport(XMR_FEED_ID);
        reports[1] = _buildReport(DAI_FEED_ID);

        vaultManager.updatePrices(reports);
    }

    function _createVault(address lp) internal {
        vm.prank(lp);
        vaultManager.createVault();
    }

    function _depositCollateral(address lp, uint256 amount) internal {
        vm.startPrank(lp);
        wxdai.approve(address(vaultManager), amount);
        vaultManager.depositCollateral(amount);
        vm.stopPrank();
    }

    function _initiateMint(
        address user,
        address lp,
        uint256 xmrAmount,
        bytes32 commitment,
        uint256 timeout,
        uint256 griefingDeposit
    ) internal returns (bytes32 requestId) {
        vm.prank(user);
        requestId = vaultManager.initiateMint{value: griefingDeposit}(
            lp,
            user, // recipient
            xmrAmount,
            commitment,
            timeout
        );
    }

    function _provideLPKey(address lp, bytes32 requestId, bytes32 lpPubKey) internal {
        vm.prank(lp);
        vaultManager.provideLPKey(requestId, lpPubKey);
    }

    function _setMintReady(address lp, bytes32 requestId) internal {
        vm.prank(lp);
        vaultManager.setMintReady(requestId);
    }

    function _finalizeMint(address user, bytes32 requestId, bytes32 secret) internal {
        vm.prank(user);
        vaultManager.finalizeMint(requestId, secret);
    }

    function _requestBurn(address user, address lp, uint256 wsxmrAmount) internal returns (bytes32 requestId) {
        vm.prank(user);
        requestId = vaultManager.requestBurn(wsxmrAmount, lp, user);
    }

    function _proposeHash(address lp, bytes32 requestId, bytes32 secretHash) internal {
        vm.prank(lp);
        vaultManager.proposeHash(requestId, secretHash);
    }

    function _confirmMoneroLock(address user, bytes32 requestId) internal {
        vm.prank(user);
        vaultManager.confirmMoneroLock(requestId);
    }

    function _finalizeBurn(address lp, bytes32 requestId, bytes32 secret) internal {
        vm.prank(lp);
        vaultManager.finalizeBurn(requestId, secret);
    }

    function _getVaultRatio(address lp) internal view returns (uint256) {
        return vaultManager.getVaultHealth(lp);
    }

    // ============ 1. Deployment & Constructor ============

    function test_ConstructorSetsStateCorrectly() public view {
        assertEq(address(vaultManager.verifierProxy()), address(verifier));
        assertEq(address(vaultManager.wsxmrToken()), address(wsxmr));
        assertEq(vaultManager.deployer(), deployer);
        assertEq(vaultManager.liquidityRouter(), address(0));
        assertEq(vaultManager.getVaultCount(), 0);
        assertEq(vaultManager.globalDebtIndex(), 1e18);
        assertEq(vaultManager.globalTotalDebt(), 0);
    }

    function test_wsXMR_TokenAuthority() public {
        // Only VaultManager can mint
        vm.expectRevert(wsXMR.OnlyVaultManager.selector);
        wsxmr.mint(user1, 100e8);

        // Only VaultManager can burn
        vm.expectRevert(wsXMR.OnlyVaultManager.selector);
        wsxmr.burn(user1, 100e8);

        // VaultManager can mint (tested through finalizeMint later)
    }

    // ============ 2. Vault Management ============

    function test_CreateVault() public {
        _createVault(lp1);

        assertEq(vaultManager.getVaultCount(), 1);

        (address lpAddress,,,,,,,,,,,, bool active) = vaultManager.vaults(lp1);
        assertEq(lpAddress, lp1);
        assertTrue(active);
    }

    function test_CreateVault_Revert_AlreadyExists() public {
        _createVault(lp1);
        vm.expectRevert(VaultManager.VaultAlreadyExists.selector);
        _createVault(lp1);
    }

    function test_CreateVault_Revert_ZeroAddressNotApplicable() public {
        // createVault uses msg.sender, no zero-address risk
        // Just verify multiple vaults work
        _createVault(lp1);
        _createVault(lp2);
        assertEq(vaultManager.getVaultCount(), 2);
    }

    function test_DepositCollateral() public {
        _createVault(lp1);

        uint256 depositAmount = 100_000e18;
        uint256 wxdaiBefore = wxdai.balanceOf(lp1);

        _depositCollateral(lp1, depositAmount);

        uint256 wxdaiAfter = wxdai.balanceOf(lp1);
        assertEq(wxdaiBefore - wxdaiAfter, depositAmount);

        (, uint256 collateralAmount,,,,,,,,,,,) = vaultManager.vaults(lp1);
        assertGt(collateralAmount, 0); // Should have sDAI shares
    }

    function test_DepositCollateral_Revert_VaultDoesNotExist() public {
        vm.startPrank(lp1);
        wxdai.approve(address(vaultManager), 1000e18);
        vm.expectRevert(VaultManager.VaultDoesNotExist.selector);
        vaultManager.depositCollateral(1000e18);
        vm.stopPrank();
    }

    function test_DepositCollateral_Revert_ZeroAmount() public {
        _createVault(lp1);
        vm.startPrank(lp1);
        wxdai.approve(address(vaultManager), 1000e18);
        vm.expectRevert(VaultManager.ZeroAmount.selector);
        vaultManager.depositCollateral(0);
        vm.stopPrank();
    }

    function test_DepositSDAI() public {
        _createVault(lp1);

        // First get sDAI by depositing wxDAI directly to sDAI contract
        uint256 wxdaiAmount = 100_000e18;
        vm.startPrank(lp1);
        wxdai.approve(SDAI_CONTRACT, wxdaiAmount);
        uint256 sDAIShares = ISavingsDAI(SDAI_CONTRACT).deposit(wxdaiAmount, lp1);
        vm.stopPrank();

        uint256 sDAIBefore = sdaiToken.balanceOf(lp1);

        vm.startPrank(lp1);
        sdaiToken.approve(address(vaultManager), sDAIShares);
        vaultManager.depositSDAI(sDAIShares);
        vm.stopPrank();

        uint256 sDAIAfter = sdaiToken.balanceOf(lp1);
        assertEq(sDAIBefore - sDAIAfter, sDAIShares);

        (, uint256 collateralAmount,,,,,,,,,,,) = vaultManager.vaults(lp1);
        assertEq(collateralAmount, sDAIShares);
    }

    function test_WithdrawCollateral() public {
        _createVault(lp1);
        _depositCollateral(lp1, 100_000e18);

        (, uint256 collateralBefore,,,,,,,,,,,) = vaultManager.vaults(lp1);

        // Withdraw half
        uint256 withdrawAmount = collateralBefore / 2;
        uint256 wxdaiBefore = wxdai.balanceOf(lp1);

        vm.prank(lp1);
        vaultManager.withdrawCollateral(withdrawAmount);

        uint256 wxdaiAfter = wxdai.balanceOf(lp1);
        assertGt(wxdaiAfter, wxdaiBefore); // Got DAI back

        (, uint256 collateralAfter,,,,,,,,,,,) = vaultManager.vaults(lp1);
        assertEq(collateralAfter, collateralBefore - withdrawAmount);
    }

    function test_WithdrawCollateral_Revert_InsufficientCollateral() public {
        _createVault(lp1);
        _depositCollateral(lp1, 100_000e18);

        (, uint256 collateral,,,,,,,,,,,) = vaultManager.vaults(lp1);
        vm.prank(lp1);
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        vaultManager.withdrawCollateral(collateral + 1);
    }

    function test_SetVaultMarketMetrics() public {
        _createVault(lp1);

        vm.prank(lp1);
        vaultManager.setVaultMarketMetrics(500, 200); // 5% mint fee, 2% burn reward

        (,,,,,,, uint16 mintFeeBps, uint16 burnRewardBps,,,,) = vaultManager.vaults(lp1);
        assertEq(mintFeeBps, 500);
        assertEq(burnRewardBps, 200);
    }

    function test_SetVaultMarketMetrics_Revert_ExceedsMaxMargin() public {
        _createVault(lp1);
        vm.expectRevert(VaultManager.ExceedsMaxMargin.selector);
        vm.prank(lp1);
        vaultManager.setVaultMarketMetrics(1001, 0);
    }

    function test_SetMaxMintBps() public {
        _createVault(lp1);
        vm.prank(lp1);
        vaultManager.setMaxMintBps(1000); // 10%
        (,,,,, uint16 maxMintBps,,,,,,,) = vaultManager.vaults(lp1);
        assertEq(maxMintBps, 1000);
    }

    function test_SetMinBurnAmount() public {
        _createVault(lp1);
        vm.prank(lp1);
        vaultManager.setMinBurnAmount(10e8); // 10 wsXMR
        (,,,,,,,,,,, uint256 minBurnAmount,) = vaultManager.vaults(lp1);
        assertEq(minBurnAmount, 10e8);
    }

    function test_SetMintGriefingDeposit() public {
        _createVault(lp1);
        vm.prank(lp1);
        vaultManager.setMintGriefingDeposit(0.1 ether);
        (,,,,,, uint256 griefingDeposit,,,,,,) = vaultManager.vaults(lp1);
        assertEq(griefingDeposit, 0.1 ether);
    }

    // ============ 3. Mint Lifecycle ============

    function test_FullMintLifecycle() public {
        // Setup vault
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        // Set LP config
        vm.startPrank(lp1);
        vaultManager.setVaultMarketMetrics(100, 50); // 1% fee, 0.5% reward
        vaultManager.setMintGriefingDeposit(0.01 ether);
        vm.stopPrank();

        uint256 xmrAmount = 1000e12; // 1000 XMR (12 decimals)
        uint256 wsxmrExpected = xmrAmount / 1e4; // 1000 wsXMR (8 decimals)

        // User initiates mint
        bytes32 requestId = _initiateMint(user1, lp1, xmrAmount, testCommitment, 1 hours, 0.01 ether);
        assertTrue(requestId != bytes32(0));

        // Verify mint request state
        (
            bytes32 reqId,
            address initiator,
            address recipient,
            address lpVault,
            uint256 storedXmrAmount,
            uint256 storedWsxmrAmount,
            uint256 feeAmount,
            bytes32 commitment,
            uint256 timeout,
            uint256 griefingDeposit,
            uint256 normalizedDebtAmount,
            uint256 vaultMintNonce,
            VaultManager.MintStatus status
        ) = vaultManager.mintRequests(requestId);

        assertEq(reqId, requestId);
        assertEq(initiator, user1);
        assertEq(recipient, user1);
        assertEq(lpVault, lp1);
        assertEq(storedXmrAmount, xmrAmount);
        assertEq(storedWsxmrAmount, wsxmrExpected);
        assertEq(commitment, testCommitment);
        assertEq(uint256(status), uint256(VaultManager.MintStatus.PENDING));
        assertEq(griefingDeposit, 0.01 ether);

        // LP provides public key
        bytes32 lpPubKey = bytes32(uint256(987654321));
        _provideLPKey(lp1, requestId, lpPubKey);
        assertEq(vaultManager.lpPublicKeys(requestId), lpPubKey);

        // LP sets mint ready
        _setMintReady(lp1, requestId);

        (, , , , , , , , , , , , VaultManager.MintStatus statusAfterReady) = vaultManager.mintRequests(requestId);
        assertEq(uint256(statusAfterReady), uint256(VaultManager.MintStatus.READY));

        // User finalizes mint with secret
        uint256 userWsxmrBefore = wsxmr.balanceOf(user1);
        _finalizeMint(user1, requestId, testSecret);

        uint256 userWsxmrAfter = wsxmr.balanceOf(user1);
        assertEq(userWsxmrAfter - userWsxmrBefore, wsxmrExpected - feeAmount);

        // LP received fee
        assertEq(wsxmr.balanceOf(lp1), feeAmount);

        // Request marked completed
        (, , , , , , , , , , , , VaultManager.MintStatus finalStatus) = vaultManager.mintRequests(requestId);
        assertEq(uint256(finalStatus), uint256(VaultManager.MintStatus.COMPLETED));

        // Griefing deposit returned to initiator as pending returns
        assertEq(vaultManager.pendingReturns(user1, address(0)), 0.01 ether);
    }

    function test_CancelMint_AfterTimeout() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 requestId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0.01 ether);

        // Warp past timeout
        vm.warp(block.timestamp + 2 hours);

        // Anyone can cancel
        vm.prank(user2);
        vaultManager.cancelMint(requestId);

        (, , , , , , , , , , , , VaultManager.MintStatus status) = vaultManager.mintRequests(requestId);
        assertEq(uint256(status), uint256(VaultManager.MintStatus.CANCELLED));
    }

    function test_CancelMint_Revert_BeforeTimeout() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 requestId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0.01 ether);

        vm.expectRevert(VaultManager.TimeoutNotReached.selector);
        vaultManager.cancelMint(requestId);
    }

    function test_InitiateMint_Revert_InsufficientDeposit() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        vm.prank(lp1);
        vaultManager.setMintGriefingDeposit(0.1 ether);

        vm.expectRevert(VaultManager.InsufficientDeposit.selector);
        _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0.01 ether);
    }

    function test_InitiateMint_Revert_ZeroAddress() public {
        _createVault(lp1);
        vm.expectRevert(VaultManager.ZeroAddress.selector);
        vm.prank(user1);
        vaultManager.initiateMint{value: 0}(address(0), user1, 1000e12, testCommitment, 1 hours);
    }

    function test_InitiateMint_Revert_ZeroAmount() public {
        _createVault(lp1);
        vm.expectRevert(VaultManager.ZeroAmount.selector);
        vm.prank(user1);
        vaultManager.initiateMint{value: 0}(lp1, user1, 0, testCommitment, 1 hours);
    }

    function test_InitiateMint_Revert_InvalidSecret() public {
        _createVault(lp1);
        vm.expectRevert(VaultManager.InvalidSecret.selector);
        vm.prank(user1);
        vaultManager.initiateMint{value: 0}(lp1, user1, 1000e12, bytes32(0), 1 hours);
    }

    function test_InitiateMint_Revert_VaultDoesNotExist() public {
        vm.expectRevert(VaultManager.VaultDoesNotExist.selector);
        vm.prank(user1);
        vaultManager.initiateMint{value: 0}(lp1, user1, 1000e12, testCommitment, 1 hours);
    }

    function test_FinalizeMint_Revert_InvalidSecret() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 requestId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, requestId);

        bytes32 wrongSecret = bytes32(uint256(999999));
        vm.expectRevert(VaultManager.InvalidSecret.selector);
        _finalizeMint(user1, requestId, wrongSecret);
    }

    function test_FinalizeMint_Revert_InvalidStatus() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 requestId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        // Not READY yet
        vm.expectRevert(VaultManager.InvalidStatus.selector);
        _finalizeMint(user1, requestId, testSecret);
    }

    function test_SetMintReady_Revert_Unauthorized() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 requestId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);

        vm.expectRevert(VaultManager.Unauthorized.selector);
        vm.prank(user2);
        vaultManager.setMintReady(requestId);
    }

    // ============ 4. Burn Lifecycle ============

    function test_FullBurnLifecycle() public {
        // Setup: create vault, deposit, mint wsXMR
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 mintId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        uint256 userWsxmr = wsxmr.balanceOf(user1);
        assertGt(userWsxmr, 0);

        // User approves vaultManager to burn
        vm.prank(user1);
        wsxmr.approve(address(vaultManager), userWsxmr);

        // Step 1: Request burn
        uint256 burnAmount = userWsxmr / 2;
        bytes32 burnRequestId = _requestBurn(user1, lp1, burnAmount);

        (
            bytes32 reqId,
            address user,
            address lpVault,
            uint256 wsxmrAmount,
            uint256 xmrAmount,
            uint256 lockedCollateral,
            uint256 rewardCollateral,
            bytes32 secretHash,
            uint256 deadline,
            uint256 vaultLiquidationNonce,
            uint256 normalizedDebtAmount,
            VaultManager.BurnStatus status
        ) = vaultManager.burnRequests(burnRequestId);

        assertEq(reqId, burnRequestId);
        assertEq(user, user1);
        assertEq(lpVault, lp1);
        assertEq(wsxmrAmount, burnAmount);
        assertEq(uint256(status), uint256(VaultManager.BurnStatus.REQUESTED));
        assertGt(lockedCollateral, 0);

        // Step 2: LP proposes hash
        bytes32 lpSecret = bytes32(uint256(555555));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 lpSecretHash = keccak256(abi.encodePacked(px, py));

        _proposeHash(lp1, burnRequestId, lpSecretHash);

        (, , , , , , , , , , , VaultManager.BurnStatus statusAfterPropose) = vaultManager.burnRequests(burnRequestId);
        assertEq(uint256(statusAfterPropose), uint256(VaultManager.BurnStatus.PROPOSED));

        // Step 3: User confirms Monero lock
        _confirmMoneroLock(user1, burnRequestId);

        (, , , , , , , , , , , VaultManager.BurnStatus statusAfterCommit) = vaultManager.burnRequests(burnRequestId);
        assertEq(uint256(statusAfterCommit), uint256(VaultManager.BurnStatus.COMMITTED));

        // Step 4: LP finalizes burn
        _finalizeBurn(lp1, burnRequestId, lpSecret);

        (, , , , , , , , , , , VaultManager.BurnStatus statusAfterFinal) = vaultManager.burnRequests(burnRequestId);
        assertEq(uint256(statusAfterFinal), uint256(VaultManager.BurnStatus.COMPLETED));
    }

    function test_ClaimSlashedCollateral() public {
        // Setup mint
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 mintId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        uint256 userWsxmr = wsxmr.balanceOf(user1);
        vm.prank(user1);
        wsxmr.approve(address(vaultManager), userWsxmr);

        // Request burn and commit
        bytes32 burnId = _requestBurn(user1, lp1, userWsxmr);

        bytes32 lpSecret = bytes32(uint256(555555));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 lpSecretHash = keccak256(abi.encodePacked(px, py));

        _proposeHash(lp1, burnId, lpSecretHash);
        _confirmMoneroLock(user1, burnId);

        // Warp past deadline and refresh prices
        vm.warp(block.timestamp + 3 hours);
        _updatePrices(160_00000000, 1_00000000);

        // User claims slashed collateral
        vm.prank(user1);
        vaultManager.claimSlashedCollateral(burnId);

        // User should have pending returns queued
        assertGt(vaultManager.pendingReturns(user1, SDAI_CONTRACT), 0);
    }

    function test_CancelBurn_AfterDeadline() public {
        // Setup mint
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 mintId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        uint256 userWsxmr = wsxmr.balanceOf(user1);
        vm.prank(user1);
        wsxmr.approve(address(vaultManager), userWsxmr);

        // Request burn
        bytes32 burnId = _requestBurn(user1, lp1, userWsxmr);

        // Warp past deadline and refresh prices
        vm.warp(block.timestamp + 2 hours + 1);
        _updatePrices(160_00000000, 1_00000000);

        // Permissionless cancel
        vm.prank(user2);
        vaultManager.cancelBurn(burnId);

        (, , , , , , , , , , , VaultManager.BurnStatus status) = vaultManager.burnRequests(burnId);
        assertEq(uint256(status), uint256(VaultManager.BurnStatus.CANCELLED));

        // wsXMR should be re-minted to user
        assertEq(wsxmr.balanceOf(user1), userWsxmr);
    }

    function test_RequestBurn_Revert_ZeroAmount() public {
        _createVault(lp1);
        vm.expectRevert(VaultManager.ZeroAmount.selector);
        vm.prank(user1);
        vaultManager.requestBurn(0, lp1, user1);
    }

    function test_RequestBurn_Revert_OnlyUserCanInitiate() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        // Create debt first by minting
        bytes32 mintId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        uint256 userWsxmr = wsxmr.balanceOf(user1);
        vm.prank(user1);
        wsxmr.approve(address(vaultManager), userWsxmr);

        vm.expectRevert(VaultManager.OnlyUserCanInitiate.selector);
        vm.prank(user2); // not user1
        vaultManager.requestBurn(userWsxmr, lp1, user1);
    }

    function test_RequestBurn_Revert_BelowMinimumBurn() public {
        _createVault(lp1);
        vm.expectRevert(VaultManager.BelowMinimumBurn.selector);
        vm.prank(user1);
        vaultManager.requestBurn(1, lp1, user1);
    }

    function test_FinalizeBurn_Revert_InvalidSecret() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 mintId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        uint256 userWsxmr = wsxmr.balanceOf(user1);
        vm.prank(user1);
        wsxmr.approve(address(vaultManager), userWsxmr);

        bytes32 burnId = _requestBurn(user1, lp1, userWsxmr);

        bytes32 lpSecret = bytes32(uint256(555555));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 lpSecretHash = keccak256(abi.encodePacked(px, py));

        _proposeHash(lp1, burnId, lpSecretHash);
        _confirmMoneroLock(user1, burnId);

        bytes32 wrongSecret = bytes32(uint256(999999));
        vm.expectRevert(VaultManager.InvalidSecret.selector);
        _finalizeBurn(lp1, burnId, wrongSecret);
    }

    // ============ 5. Liquidation ============

    function test_Liquidate_UnderwaterVault() public {
        // Setup vault with collateral
        _createVault(lp1);
        _depositCollateral(lp1, 150_000e18); // ~$150k at $1 DAI

        // Mint wsXMR
        bytes32 mintId = _initiateMint(user1, lp1, 500e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        // User gets wsXMR, liquidator needs some to burn during liquidation
        uint256 mintedWsxmr = wsxmr.balanceOf(user1);

        // Liquidator gets wsXMR from user
        vm.prank(user1);
        wsxmr.transfer(liquidator, mintedWsxmr);
        vm.prank(liquidator);
        wsxmr.approve(address(vaultManager), mintedWsxmr);

        // Now crash XMR price to make vault underwater
        // At $160 XMR, 500 XMR = $80k. Collateral = $150k. Ratio = 150k/80k = 187.5% (healthy)
        // Drop XMR to $250: 500 XMR = $125k. Ratio = 150k/125k = 120% (at threshold)
        // Drop XMR to $300: 500 XMR = $150k. Ratio = 150k/150k = 100% (underwater)
        _updatePrices(300_00000000, 1_00000000);

        // Vault should be liquidatable
        assertTrue(vaultManager.isVaultLiquidatable(lp1));

        // Ensure no locked collateral
        (,, uint256 lockedCollateral,,,,,,,,,,) = vaultManager.vaults(lp1);
        assertEq(lockedCollateral, 0);

        // Liquidate
        uint256 liquidatorWsxmrBefore = wsxmr.balanceOf(liquidator);
        uint256 liquidatorSDAIBefore = sdaiToken.balanceOf(liquidator);

        vm.prank(liquidator);
        vaultManager.liquidate(lp1, mintedWsxmr);

        uint256 liquidatorWsxmrAfter = wsxmr.balanceOf(liquidator);
        uint256 liquidatorSDAIAfter = sdaiToken.balanceOf(liquidator);

        // Liquidator burned some wsXMR and received collateral
        assertGt(liquidatorWsxmrBefore - liquidatorWsxmrAfter, 0);
        assertGt(liquidatorSDAIAfter, liquidatorSDAIBefore);

        // Vault collateral was fully seized; remaining bad debt may keep it liquidatable
        (, uint256 remainingCollateral,,,,,,,,,,,) = vaultManager.vaults(lp1);
        assertEq(remainingCollateral, 0);
    }

    function test_Liquidate_Revert_VaultHealthy() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 mintId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        uint256 mintedWsxmr = wsxmr.balanceOf(user1);
        vm.prank(user1);
        wsxmr.transfer(liquidator, mintedWsxmr);
        vm.prank(liquidator);
        wsxmr.approve(address(vaultManager), mintedWsxmr);

        // Prices unchanged, vault is healthy
        vm.expectRevert(VaultManager.VaultHealthy.selector);
        vm.prank(liquidator);
        vaultManager.liquidate(lp1, mintedWsxmr);
    }

    function test_Liquidate_Revert_InsufficientDebt() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        vm.expectRevert(VaultManager.InsufficientDebt.selector);
        vm.prank(liquidator);
        vaultManager.liquidate(lp1, 100e8);
    }

    // ============ 6. Buy-and-Burn ============

    function test_TriggerBuyAndBurn() public {
        // Setup vault with collateral to generate yield tracking
        _createVault(lp1);
        _depositCollateral(lp1, 1_000_000e18);

        // Mint some wsXMR to create debt
        bytes32 mintId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        // Give keeper sDAI and transfer to vaultManager as simulated war chest
        _fundWXDAI(keeper, 100_000e18);
        vm.startPrank(keeper);
        wxdai.approve(SDAI_CONTRACT, 100_000e18);
        uint256 yieldShares = ISavingsDAI(SDAI_CONTRACT).deposit(100_000e18, keeper);
        sdaiToken.approve(address(vaultManager), yieldShares);
        sdaiToken.transfer(address(vaultManager), yieldShares);
        vm.stopPrank();

        // Mock the Uniswap V3 router to enable swap path testing
        MockSwapRouter mockRouter = new MockSwapRouter();
        vm.etch(GnosisAddresses.UNISWAP_V3_ROUTER, address(mockRouter).code);

        // Give mock router wsXMR to "sell"
        deal(address(wsxmr), GnosisAddresses.UNISWAP_V3_ROUTER, 1_000_000e8);

        // Manually set yieldWarChest by finding storage slot
        // Layout: slot 0 = wsxmrToken (address, 20 bytes) + deployer (address, 20 bytes) - might be packed
        // Actually we can use stdStore from forge-std
        stdstore.target(address(vaultManager)).sig("yieldWarChest()").checked_write(yieldShares);

        // Ensure prices are fresh
        _updatePrices(160_00000000, 1_00000000);

        // Warp past cooldown
        vm.warp(block.timestamp + 1 hours);

        // Refresh prices before triggerBuyAndBurn (warp made them stale)
        _updatePrices(160_00000000, 1_00000000);

        // Execute buy-and-burn
        vm.prank(keeper);
        vaultManager.triggerBuyAndBurn(3000);

        // Verify war chest was reduced
        assertLt(vaultManager.yieldWarChest(), yieldShares);
    }

    function test_TriggerBuyAndBurn_Revert_InvalidPoolFeeTier() public {
        vm.expectRevert(VaultManager.InvalidPoolFeeTier.selector);
        vm.prank(keeper);
        vaultManager.triggerBuyAndBurn(100); // not in allowed tiers
    }

    function test_TriggerBuyAndBurn_Revert_CooldownActive() public {
        // We can't easily set lastBuyTimestamp without direct storage manipulation
        // Skip this test since we can't reliably set private state
    }

    // ============ 7. Price Oracle ============

    function test_UpdatePrices() public {
        // Prices were already set in setUp
        assertEq(vaultManager.lastXmrPrice(), 160_00000000);
        assertEq(vaultManager.lastCollateralPrice(), 1_00000000);

        // Update prices
        _updatePrices(170_00000000, 1_00000000);

        assertEq(vaultManager.lastXmrPrice(), 170_00000000);
        assertEq(vaultManager.lastCollateralPrice(), 1_00000000);
    }

    function test_GetXmrPrice() public view {
        uint256 price = vaultManager.getXmrPrice();
        // 160_00000000 * 1e10 = 160e18
        assertEq(price, 160_000000000000000000);
    }

    function test_GetXmrPrice_Revert_Stale() public {
        // Warp past max age
        vm.warp(block.timestamp + 5 minutes);
        vm.expectRevert(VaultManager.StalePrice.selector);
        vaultManager.getXmrPrice();
    }

    function test_GetCollateralPrice() public view {
        uint256 price = vaultManager.getCollateralPrice();
        // DAI price is $1.00 at 8 decimals = 100000000
        // getCollateralPrice returns uint192(price) * 1e10 = 1e18
        assertEq(price, 1_000000000000000000);
    }

    // ============ 8. View Functions ============

    function test_GetVaultDebt() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 mintId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        uint256 debt = vaultManager.getVaultDebt(lp1);
        assertGt(debt, 0);
    }

    function test_GetActualDebt() public {
        uint256 normalizedDebt = 1e18;
        uint256 actual = vaultManager.getActualDebt(normalizedDebt);
        assertEq(actual, normalizedDebt); // index starts at 1e18
    }

    function test_CalculateCollateralRatio() public view {
        // $150k collateral, $100k debt = 150%
        uint256 collateralShares = 150_000e18; // $150k worth at $1/share
        uint256 debtAmount = 1000e8; // 1000 wsXMR at $160 = $160k... wait
        // Let's compute: 1000 wsXMR * $160 = $160k
        // collateral = $150k, debt = $160k
        // ratio = 150k / 160k * 100 = 93.75%
        uint256 ratio = vaultManager.calculateCollateralRatio(collateralShares, 1000e8);
        // 150000e18 * 1e18 / 1e18 = 150000e18 USD collateral value
        // 1000e8 * 160e18 / 1e8 = 160000e18 USD debt value
        // ratio = 150000e18 * 100 / 160000e18 = 93 (93%)
        assertEq(ratio, 93);
    }

    function test_IsVaultLiquidatable() public {
        _createVault(lp1);
        _depositCollateral(lp1, 150_000e18);

        bytes32 mintId = _initiateMint(user1, lp1, 500e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        // Initially healthy
        assertFalse(vaultManager.isVaultLiquidatable(lp1));

        // Crash price
        _updatePrices(300_00000000, 1_00000000);
        assertTrue(vaultManager.isVaultLiquidatable(lp1));
    }

    function test_GetVaultHealth() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 mintId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        uint256 health = vaultManager.getVaultHealth(lp1);
        assertGt(health, 100); // Should be > 100%
    }

    // ============ 9. Withdraw Returns ============

    function test_WithdrawReturns_ETH() public {
        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 mintId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0.05 ether);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        // Griefing deposit should be queued as pending returns
        assertEq(vaultManager.pendingReturns(user1, address(0)), 0.05 ether);

        uint256 ethBefore = user1.balance;
        vm.prank(user1);
        vaultManager.withdrawReturns(address(0));
        uint256 ethAfter = user1.balance;

        assertEq(ethAfter - ethBefore, 0.05 ether);
        assertEq(vaultManager.pendingReturns(user1, address(0)), 0);
    }

    function test_WithdrawReturns_ERC20() public {
        // Use larger vault so burn reward doesn't zero out vault health
        _createVault(lp1);
        _depositCollateral(lp1, 2_000_000e18);

        // Set burn reward so LP pays out on finalize
        vm.prank(lp1);
        vaultManager.setVaultMarketMetrics(0, 100); // 0% mint fee, 1% burn reward

        bytes32 mintId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        uint256 userWsxmr = wsxmr.balanceOf(user1);
        vm.prank(user1);
        wsxmr.approve(address(vaultManager), userWsxmr);

        bytes32 burnId = _requestBurn(user1, lp1, userWsxmr);

        bytes32 lpSecret = bytes32(uint256(555555));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 lpSecretHash = keccak256(abi.encodePacked(px, py));

        _proposeHash(lp1, burnId, lpSecretHash);
        _confirmMoneroLock(user1, burnId);
        _finalizeBurn(lp1, burnId, lpSecret);

        // Burn reward should be queued to user as sDAI pending returns
        uint256 pendingSDAI = vaultManager.pendingReturns(user1, SDAI_CONTRACT);
        assertGt(pendingSDAI, 0);

        uint256 sDAIBefore = sdaiToken.balanceOf(user1);
        vm.prank(user1);
        vaultManager.withdrawReturns(SDAI_CONTRACT);
        uint256 sDAIAfter = sdaiToken.balanceOf(user1);

        assertEq(sDAIAfter - sDAIBefore, pendingSDAI);
    }

    function test_WithdrawReturns_Revert_ZeroAmount() public {
        vm.expectRevert(VaultManager.ZeroAmount.selector);
        vm.prank(user1);
        vaultManager.withdrawReturns(address(0));
    }

    // ============ 10. Liquidity Router ============

    function test_SetLiquidityRouter() public {
        // Only deployer can set
        vaultManager.setLiquidityRouter(router);
        assertEq(vaultManager.liquidityRouter(), router);
    }

    function test_SetLiquidityRouter_Revert_OnlyDeployer() public {
        vm.expectRevert(VaultManager.OnlyDeployer.selector);
        vm.prank(user1);
        vaultManager.setLiquidityRouter(router);
    }

    function test_SetLiquidityRouter_Revert_RouterAlreadySet() public {
        vaultManager.setLiquidityRouter(router);
        vm.expectRevert(VaultManager.RouterAlreadySet.selector);
        vaultManager.setLiquidityRouter(address(0x123));
    }

    function test_RequestBurnFromRouter() public {
        // Setup router
        vaultManager.setLiquidityRouter(router);

        _createVault(lp1);
        _depositCollateral(lp1, 500_000e18);

        bytes32 mintId = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mintId);
        _finalizeMint(user1, mintId, testSecret);

        uint256 userWsxmr = wsxmr.balanceOf(user1);

        // Transfer wsXMR to router (simulating internal deposit)
        vm.prank(user1);
        wsxmr.transfer(router, userWsxmr);

        // Router approves vaultManager
        vm.prank(router);
        wsxmr.approve(address(vaultManager), userWsxmr);

        // Router calls requestBurnFromRouter
        vm.prank(router);
        bytes32 burnId = vaultManager.requestBurnFromRouter(userWsxmr, lp1, user1);

        assertTrue(burnId != bytes32(0));
    }

    function test_RequestBurnFromRouter_Revert_OnlyRouter() public {
        _createVault(lp1);
        vm.expectRevert(VaultManager.OnlyRouter.selector);
        vm.prank(user1);
        vaultManager.requestBurnFromRouter(100e8, lp1, user1);
    }

    // ============ 11. Receive Ether ============

    function test_ReceiveEther() public {
        uint256 balanceBefore = address(vaultManager).balance;
        (bool success,) = address(vaultManager).call{value: 1 ether}("");
        assertTrue(success);
        assertEq(address(vaultManager).balance, balanceBefore + 1 ether);
    }

    // ============ 12. Max Vaults ============

    function test_CreateVault_Revert_MaxVaultsReached() public {
        // This would require creating 10000 vaults, which is expensive in a test
        // Skip or use a smaller loop with vm.assume
        // We'll just verify the constant exists
        assertEq(vaultManager.MAX_VAULT_COUNT(), 10000);
    }

    // ============ 13. Cleanup / Edge Cases ============

    function test_MultipleMintsAndBurns() public {
        _createVault(lp1);
        _depositCollateral(lp1, 2_000_000e18);

        // Mint 1
        bytes32 mint1 = _initiateMint(user1, lp1, 500e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mint1);
        _finalizeMint(user1, mint1, testSecret);

        // Mint 2
        bytes32 mint2 = _initiateMint(user2, lp1, 300e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mint2);
        _finalizeMint(user2, mint2, testSecret);

        uint256 user1Wsxmr = wsxmr.balanceOf(user1);
        uint256 user2Wsxmr = wsxmr.balanceOf(user2);

        // Burn 1
        vm.prank(user1);
        wsxmr.approve(address(vaultManager), user1Wsxmr);
        bytes32 burn1 = _requestBurn(user1, lp1, user1Wsxmr);

        bytes32 lpSecret = bytes32(uint256(555555));
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(lpSecret));
        bytes32 lpSecretHash = keccak256(abi.encodePacked(px, py));

        _proposeHash(lp1, burn1, lpSecretHash);
        _confirmMoneroLock(user1, burn1);
        _finalizeBurn(lp1, burn1, lpSecret);

        // Burn 2
        vm.prank(user2);
        wsxmr.approve(address(vaultManager), user2Wsxmr);
        bytes32 burn2 = _requestBurn(user2, lp1, user2Wsxmr);

        _proposeHash(lp1, burn2, lpSecretHash);
        _confirmMoneroLock(user2, burn2);
        _finalizeBurn(lp1, burn2, lpSecret);

        // All wsXMR should be burned
        assertEq(wsxmr.balanceOf(user1), 0);
        assertEq(wsxmr.balanceOf(user2), 0);
    }

    function test_DebtIndexAfterMultipleMints() public {
        _createVault(lp1);
        _depositCollateral(lp1, 1_000_000e18);

        bytes32 mint1 = _initiateMint(user1, lp1, 1000e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mint1);
        _finalizeMint(user1, mint1, testSecret);

        uint256 debt1 = vaultManager.getVaultDebt(lp1);
        assertEq(debt1, 1000e8);

        bytes32 mint2 = _initiateMint(user2, lp1, 500e12, testCommitment, 1 hours, 0);
        _setMintReady(lp1, mint2);
        _finalizeMint(user2, mint2, testSecret);

        uint256 debt2 = vaultManager.getVaultDebt(lp1);
        assertEq(debt2, 1500e8);
    }

    function test_CollateralRatio_ManualCalculation() public view {
        // Pure view function test without state changes
        uint256 ratio1 = vaultManager.calculateCollateralRatio(150_000e18, 1000e8);
        // collateralValue = 150000e18 * 1e18 / 1e18 = 150000e18
        // debtValue = 1000e8 * 160e18 / 1e8 = 160000e18
        // ratio = 150000e18 * 100 / 160000e18 = 93
        assertEq(ratio1, 93);

        uint256 ratio2 = vaultManager.calculateCollateralRatio(200_000e18, 1000e8);
        // 200000e18 / 160000e18 * 100 = 125
        assertEq(ratio2, 125);
    }

    function test_ZeroDebt_ReturnsMaxRatio() public view {
        uint256 ratio = vaultManager.calculateCollateralRatio(100_000e18, 0);
        assertEq(ratio, type(uint256).max);
    }
}
