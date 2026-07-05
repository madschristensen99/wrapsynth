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
import {IVaultFacet} from "../contracts/interfaces/facets/IVaultFacet.sol";

contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

interface IHubAdmin {
    error Unauthorized();
    function removeSelectors(bytes4[] calldata selectors) external;
    function replaceLiquidityRouter(address router) external;
    function getFacetAddress(bytes4 selector) external view returns (address);
    function getActualDebt(uint256 normalizedDebt) external view returns (uint256);
}

contract VaultFacetCoverageTest is Test {
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

        // Register calculateCollateralRatio selector (not in VaultFacet.selectors())
        bytes4[] memory crSelector = new bytes4[](1);
        crSelector[0] = VaultFacet.calculateCollateralRatio.selector;
        hub.addSelectors(address(vaultFacet), crSelector);

        _createVaultAndDeposit(lp, 100 ether);
        _configureVault(lp);
    }

    // ========== setMinterWhitelist ==========

    function test_SetMinterWhitelist_Add() public {
        vm.prank(lp);
        VaultFacet(address(hub)).setMinterWhitelist(user, true);
        assertTrue(_isMinterWhitelisted(lp, user), "should be whitelisted");
    }

    function test_SetMinterWhitelist_Remove() public {
        vm.startPrank(lp);
        VaultFacet(address(hub)).setMinterWhitelist(user, true);
        VaultFacet(address(hub)).setMinterWhitelist(user, false);
        vm.stopPrank();
        assertFalse(_isMinterWhitelisted(lp, user), "should be removed");
    }

    function test_SetMinterWhitelist_ZeroAddress_Reverts() public {
        vm.prank(lp);
        vm.expectRevert(IErrors.ZeroAddress.selector);
        VaultFacet(address(hub)).setMinterWhitelist(address(0), true);
    }

    function test_SetMinterWhitelist_NoVault_Reverts() public {
        vm.prank(attacker);
        vm.expectRevert(IErrors.VaultDoesNotExist.selector);
        VaultFacet(address(hub)).setMinterWhitelist(user, true);
    }

    // ========== batchSetMinterWhitelist ==========

    function test_BatchSetMinterWhitelist_Add() public {
        address[] memory minters = new address[](2);
        minters[0] = user;
        minters[1] = attacker;

        vm.prank(lp);
        VaultFacet(address(hub)).batchSetMinterWhitelist(minters, true);

        assertTrue(_isMinterWhitelisted(lp, user), "user should be whitelisted");
        assertTrue(_isMinterWhitelisted(lp, attacker), "attacker should be whitelisted");
    }

    function test_BatchSetMinterWhitelist_Remove() public {
        address[] memory minters = new address[](2);
        minters[0] = user;
        minters[1] = attacker;

        vm.startPrank(lp);
        VaultFacet(address(hub)).batchSetMinterWhitelist(minters, true);
        VaultFacet(address(hub)).batchSetMinterWhitelist(minters, false);
        vm.stopPrank();

        assertFalse(_isMinterWhitelisted(lp, user), "user should be removed");
        assertFalse(_isMinterWhitelisted(lp, attacker), "attacker should be removed");
    }

    function test_BatchSetMinterWhitelist_ZeroAddress_Reverts() public {
        address[] memory minters = new address[](2);
        minters[0] = user;
        minters[1] = address(0);

        vm.prank(lp);
        vm.expectRevert(IErrors.ZeroAddress.selector);
        VaultFacet(address(hub)).batchSetMinterWhitelist(minters, true);
    }

    function test_BatchSetMinterWhitelist_NoVault_Reverts() public {
        address[] memory minters = new address[](1);
        minters[0] = user;

        vm.prank(attacker);
        vm.expectRevert(IErrors.VaultDoesNotExist.selector);
        VaultFacet(address(hub)).batchSetMinterWhitelist(minters, true);
    }

    // ========== isMinterWhitelisted ==========

    function test_IsMinterWhitelisted_DefaultFalse() public {
        assertFalse(_isMinterWhitelisted(lp, user), "default should be false");
    }

    // ========== deactivateVault ==========

    function test_DeactivateVault_HappyPath() public {
        address newLp = makeAddr("newLp");
        vm.prank(newLp);
        VaultFacet(address(hub)).createVault();

        assertTrue(_hasActiveVault(newLp), "should be active");

        vm.prank(newLp);
        VaultFacet(address(hub)).deactivateVault();

        assertFalse(_hasActiveVault(newLp), "should be inactive");
    }

    function test_DeactivateVault_WithCollateral_Reverts() public {
        vm.prank(lp);
        vm.expectRevert(IVaultFacet.VaultHasCollateral.selector);
        VaultFacet(address(hub)).deactivateVault();
    }

    function test_DeactivateVault_AlreadyInactive_Reverts() public {
        address newLp = makeAddr("newLp2");
        vm.prank(newLp);
        VaultFacet(address(hub)).createVault();
        vm.prank(newLp);
        VaultFacet(address(hub)).deactivateVault();

        vm.prank(newLp);
        vm.expectRevert(IErrors.VaultDoesNotExist.selector);
        VaultFacet(address(hub)).deactivateVault();
    }

    // ========== hasActiveVault ==========

    function test_HasActiveVault_True() public {
        assertTrue(_hasActiveVault(lp), "lp should have active vault");
    }

    function test_HasActiveVault_False() public {
        assertFalse(_hasActiveVault(attacker), "attacker should not have vault");
    }

    // ========== getVaultAtIndex ==========

    function test_GetVaultAtIndex_ReturnsCorrect() public {
        address result = _getVaultAtIndex(0);
        assertEq(result, lp, "first vault should be lp");
    }

    function test_GetVaultAtIndex_MultipleVaults() public {
        _createVaultAndDeposit(lp2, 100 ether);
        assertEq(_getVaultAtIndex(0), lp, "first vault");
        assertEq(_getVaultAtIndex(1), lp2, "second vault");
    }

    // ========== calculateCollateralRatio ==========

    function test_CalculateCollateralRatio_ZeroDebt() public {
        uint256 ratio = _calculateCollateralRatio(100 ether, 0);
        assertEq(ratio, type(uint256).max, "zero debt should return max");
    }

    function test_CalculateCollateralRatio_WithDebt() public {
        // collateralShares in sDAI decimals (1e18), debtAmount in wsXMR decimals (1e8)
        uint256 ratio = _calculateCollateralRatio(100 ether, 1e8);
        assertGt(ratio, 0, "ratio should be positive");
        assertLt(ratio, type(uint256).max, "ratio should be finite");
    }

    // ========== replaceLiquidityRouter ==========

    function test_ReplaceLiquidityRouter_NonDeployer_Reverts() public {
        vm.prank(attacker);
        vm.expectRevert(IHubAdmin.Unauthorized.selector);
        IHubAdmin(address(hub)).replaceLiquidityRouter(address(0xdead));
    }

    function test_ReplaceLiquidityRouter_ZeroAddress_Reverts() public {
        vm.expectRevert(IErrors.ZeroAddress.selector);
        IHubAdmin(address(hub)).replaceLiquidityRouter(address(0));
    }

    // ========== removeSelectors ==========

    function test_RemoveSelectors_NonDeployer_Reverts() public {
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = bytes4(keccak256("test()"));
        vm.prank(attacker);
        vm.expectRevert(IHubAdmin.Unauthorized.selector);
        IHubAdmin(address(hub)).removeSelectors(sels);
    }

    // ========== getFacetAddress ==========

    function test_GetFacetAddress_Registered() public {
        address facet = IHubAdmin(address(hub)).getFacetAddress(VaultFacet.createVault.selector);
        assertEq(facet, address(vaultFacet), "should return vault facet");
    }

    function test_GetFacetAddress_Unregistered() public {
        bytes4 unknownSelector = bytes4(keccak256("unknownFunction()"));
        address facet = IHubAdmin(address(hub)).getFacetAddress(unknownSelector);
        assertEq(facet, address(0), "should return zero for unregistered");
    }

    // ========== getActualDebt ==========

    function test_GetActualDebt_ZeroNormalized() public {
        uint256 debt = IHubAdmin(address(hub)).getActualDebt(0);
        assertEq(debt, 0, "zero normalized should be zero debt");
    }

    function test_GetActualDebt_WithIndex() public {
        uint256 debt = IHubAdmin(address(hub)).getActualDebt(1000);
        assertEq(debt, 1000, "should equal normalized when index is 1e18");
    }

    // ========== HELPERS ==========

    function _hubView(bytes memory data) internal returns (bytes memory) {
        (bool success, bytes memory result) = address(hub).call(data);
        require(success, "hub view call failed");
        return result;
    }

    function _isMinterWhitelisted(address vault, address minter) internal returns (bool) {
        bytes memory result = _hubView(
            abi.encodeWithSelector(VaultFacet.isMinterWhitelisted.selector, vault, minter)
        );
        return abi.decode(result, (bool));
    }

    function _hasActiveVault(address lpAddress) internal returns (bool) {
        bytes memory result = _hubView(
            abi.encodeWithSelector(VaultFacet.hasActiveVault.selector, lpAddress)
        );
        return abi.decode(result, (bool));
    }

    function _getVaultAtIndex(uint256 index) internal returns (address) {
        bytes memory result = _hubView(
            abi.encodeWithSelector(VaultFacet.getVaultAtIndex.selector, index)
        );
        return abi.decode(result, (address));
    }

    function _calculateCollateralRatio(uint256 collateralAmount, uint256 debtAmount) internal returns (uint256) {
        bytes memory result = _hubView(
            abi.encodeWithSelector(VaultFacet.calculateCollateralRatio.selector, collateralAmount, debtAmount)
        );
        return abi.decode(result, (uint256));
    }

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
}
