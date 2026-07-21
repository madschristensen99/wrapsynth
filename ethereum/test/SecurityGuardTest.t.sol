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

/**
 * @title Security Guard Tests
 * @notice High-value tests for authorization, state ordering, and deadline enforcement
 * @dev These tests target security-critical revert paths, not trivial input validation
 */
contract SecurityGuardTest is Test {
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
    address lp2 = makeAddr("lp2");
    address user = makeAddr("user");
    address attacker = makeAddr("attacker");
    address keeper = makeAddr("keeper");
    address priceUpdater = makeAddr("priceUpdater");

    uint256 constant XMR_PRICE_8DEC = 390_00000000;
    uint256 constant DAI_PRICE_8DEC = 1_00000000;

    function setUp() public {
        string memory rpcUrl = vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"));
        vm.createSelectFork(rpcUrl);

        vm.deal(address(this), 1_000_000 ether);
        vm.deal(lp, 1000 ether);
        vm.deal(lp2, 1000 ether);
        vm.deal(user, 1000 ether);
        vm.deal(attacker, 1000 ether);
        vm.deal(keeper, 1000 ether);

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

        // Set up price updater (non-deployer) for oracle tests
        SimpleOracleFacet(address(hub)).setPriceUpdater(priceUpdater);
        SimpleOracleFacet(address(hub)).updatePrices(XMR_PRICE_8DEC, DAI_PRICE_8DEC);

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
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)));
    }

    /// @notice Non-LP cannot call setMintReady
    function test_Mint_SetMintReady_NonLP_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        vm.prank(attacker);
        vm.expectRevert(IErrors.Unauthorized.selector);
        MintFacet(address(hub)).setMintReady(reqId, bytes32(uint256(0xdeadbeef)));
    }

    /// @notice Non-LP cannot claim griefing deposit on expired ready mint
    function test_Mint_ClaimGriefingDeposit_NonLP_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        // Warp past READY timeout, then cancelMint to reach EXPIRED_READY
        vm.roll(block.number + 10000);
        MintFacet(address(hub)).cancelMint(reqId);

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
        MintFacet(address(hub)).finalizeMint(reqId, bytes32(uint256(0x1234)));
    }

    /// @notice finalizeMint with wrong secret must revert
    function test_Mint_FinalizeMint_WrongSecret_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);
        _setMintReady(lp, reqId);

        vm.prank(user);
        vm.expectRevert(IErrors.InvalidSecret.selector);
        MintFacet(address(hub)).finalizeMint(reqId, bytes32(uint256(0xbadbad)));
    }

    /// @notice provideLPKey on already-provided request must revert
    function test_Mint_ProvideLPKey_AlreadyProvided_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        vm.prank(lp);
        vm.expectRevert(IErrors.InvalidStatus.selector);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)));
    }

    // ========== MINT: DEADLINE ENFORCEMENT ==========

    /// @notice cancelMint before timeout must revert
    function test_Mint_CancelMint_BeforeTimeout_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);

        vm.prank(user);
        vm.expectRevert(IMintOperations.TimeoutNotReached.selector);
        MintFacet(address(hub)).cancelMint(reqId);
    }

    /// @notice provideLPKey after deadline must revert
    function test_Mint_ProvideLPKey_AfterDeadline_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);

        // Warp past timeout
        vm.roll(block.number + 10000);

        vm.prank(lp);
        vm.expectRevert(IErrors.DeadlineExpired.selector);
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdead)), bytes32(uint256(0xbeef)));
    }

    /// @notice setMintReady after deadline must revert
    function test_Mint_SetMintReady_AfterDeadline_Reverts() public {
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        // Warp past timeout
        vm.roll(block.number + 10000);

        vm.prank(lp);
        vm.expectRevert(IErrors.DeadlineExpired.selector);
        MintFacet(address(hub)).setMintReady(reqId, bytes32(uint256(0xdeadbeef)));
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
        vm.roll(block.number + 34561);

        vm.prank(attacker);
        vm.expectRevert(IErrors.Unauthorized.selector);
        BurnFacet(address(hub)).abortBurn(burnId);
    }

    /// @notice Non-user cannot call forceSettleBurn
    function test_Burn_ForceSettleBurn_NonUser_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);

        vm.roll(block.number + 34561);

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

        vm.roll(block.number + 34561);

        vm.prank(attacker);
        vm.expectRevert(IErrors.Unauthorized.selector);
        BurnFacet(address(hub)).claimSlashedCollateral(burnId);
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
        BurnFacet(address(hub)).claimSlashedCollateral(burnId);
    }

    /// @notice resolveDeclinedProposal before deadline must revert
    function test_Burn_ResolveDeclined_BeforeDeadline_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        bytes32 burnId = _requestBurn(user, lp, minted);
        _proposeHash(lp, burnId);

        vm.prank(lp);
        vm.expectRevert(IBurnOperations.DeadlineNotExpired.selector);
        BurnFacet(address(hub)).resolveDeclinedProposal(burnId);
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
        VaultFacet(address(hub)).withdrawReturns(GnosisAddresses.SDAI);
    }

    // ========== ORACLE: GUARDS ==========

    /// @notice updatePrices by unauthorized caller must revert
    function test_Oracle_UpdatePrices_Unauthorized_Reverts() public {
        vm.prank(attacker);
        vm.expectRevert("Only updater");
        SimpleOracleFacet(address(hub)).updatePrices(XMR_PRICE_8DEC, DAI_PRICE_8DEC);
    }

    /// @notice updatePrices with zero price must revert
    function test_Oracle_UpdatePrices_ZeroPrice_Reverts() public {
        vm.prank(priceUpdater);
        vm.expectRevert("Invalid prices");
        SimpleOracleFacet(address(hub)).updatePrices(0, DAI_PRICE_8DEC);
    }

    /// @notice setPriceUpdater by non-deployer must revert
    function test_Oracle_SetUpdater_NonDeployer_Reverts() public {
        vm.prank(attacker);
        vm.expectRevert("Only deployer");
        SimpleOracleFacet(address(hub)).setPriceUpdater(attacker);
    }

    /// @notice getXmrPrice when stale must revert
    function test_Oracle_GetXmrPrice_Stale_Reverts() public {
        // Warp past 2 minute staleness window
        vm.warp(block.timestamp + 3 minutes);

        vm.expectRevert();
        SimpleOracleFacet(address(hub)).getXmrPrice();
    }

    // ========== HELPERS ==========

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
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)));
    }

    function _setMintReady(address _lp, bytes32 reqId) internal {
        vm.prank(_lp);
        MintFacet(address(hub)).setMintReady(reqId, bytes32(uint256(0xdeadbeef)));
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
