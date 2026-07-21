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

contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

interface IOracleFacetErrors {
    error StalePrice();
    error PriceNormalizedToZero();
}

contract OracleCoverageTest is Test {
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

        // Register getUpdateFee selector (not in SimpleOracleFacet.selectors())
        bytes4[] memory feeSelector = new bytes4[](1);
        feeSelector[0] = SimpleOracleFacet.getUpdateFee.selector;
        hub.addSelectors(address(oracleFacet), feeSelector);

        _createVaultAndDeposit(lp, 100 ether);
        _configureVault(lp);
    }

    receive() external payable {}

    // ========== getCollateralPrice ==========

    function test_GetCollateralPrice_ReturnsCorrect() public {
        uint256 price = _getCollateralPrice();
        assertEq(price, DAI_PRICE_8DEC * 1e10, "should return normalized DAI price");
    }

    function test_GetCollateralPrice_Stale_Reverts() public {
        vm.warp(block.timestamp + 3 minutes);
        vm.expectRevert(IOracleFacetErrors.StalePrice.selector);
        _getCollateralPrice();
    }

    // ========== getCollateralPriceWithAge ==========

    function test_GetCollateralPriceWithAge_CustomAge() public {
        uint256 price = _getCollateralPriceWithAge(5 minutes);
        assertEq(price, DAI_PRICE_8DEC * 1e10, "should return price within 5 min window");
    }

    function test_GetCollateralPriceWithAge_Stale_Reverts() public {
        vm.warp(block.timestamp + 6 minutes);
        vm.expectRevert(IOracleFacetErrors.StalePrice.selector);
        _getCollateralPriceWithAge(5 minutes);
    }

    // ========== getXmrPriceWithAge ==========

    function test_GetXmrPriceWithAge_CustomAge() public {
        uint256 price = _getXmrPriceWithAge(5 minutes);
        assertEq(price, XMR_PRICE_8DEC * 1e10, "should return XMR price within 5 min window");
    }

    function test_GetXmrPriceWithAge_Stale_Reverts() public {
        vm.warp(block.timestamp + 6 minutes);
        vm.expectRevert(IOracleFacetErrors.StalePrice.selector);
        _getXmrPriceWithAge(5 minutes);
    }

    // ========== getUpdateFee ==========

    function test_GetUpdateFee_ReturnsZero() public {
        bytes[] memory emptyData = new bytes[](0);
        uint256 fee = _getUpdateFee(emptyData);
        assertEq(fee, 0, "update fee should be zero");
    }

    // ========== normalizeDebt ==========

    function test_NormalizeDebt_WithIndex() public {
        uint256 normalized = _normalizeDebt(1000);
        assertEq(normalized, 1000, "normalized should equal actual when index is 1e18");
    }

    function test_NormalizeDebt_ZeroDebt() public {
        uint256 normalized = _normalizeDebt(0);
        assertEq(normalized, 0, "zero debt should normalize to zero");
    }

    // ========== denormalizeDebt ==========

    function test_DenormalizeDebt_WithIndex() public {
        uint256 actual = _denormalizeDebt(1000);
        assertEq(actual, 1000, "actual should equal normalized when index is 1e18");
    }

    function test_DenormalizeDebt_Zero() public {
        uint256 actual = _denormalizeDebt(0);
        assertEq(actual, 0, "zero normalized should denormalize to zero");
    }

    // ========== updateOraclePrices ==========

    function test_UpdateOraclePrices_RefundsETH() public {
        bytes[] memory emptyData = new bytes[](0);
        uint256 balanceBefore = address(this).balance;
        SimpleOracleFacet(address(hub)).updateOraclePrices{value: 0.1 ether}(emptyData);
        uint256 balanceAfter = address(this).balance;
        assertEq(balanceAfter, balanceBefore, "ETH should be refunded");
    }

    function test_UpdateOraclePrices_NoETH_NoRevert() public {
        bytes[] memory emptyData = new bytes[](0);
        SimpleOracleFacet(address(hub)).updateOraclePrices(emptyData);
    }

    // ========== HUB VIEW HELPERS ==========

    function _hubView(bytes memory data) internal returns (bytes memory) {
        (bool success, bytes memory result) = address(hub).call(data);
        require(success, "hub view call failed");
        return result;
    }

    function _getCollateralPrice() internal returns (uint256) {
        bytes memory r = _hubView(abi.encodeWithSelector(SimpleOracleFacet.getCollateralPrice.selector));
        return abi.decode(r, (uint256));
    }

    function _getCollateralPriceWithAge(uint256 maxAge) internal returns (uint256) {
        bytes memory r = _hubView(
            abi.encodeWithSelector(SimpleOracleFacet.getCollateralPriceWithAge.selector, maxAge)
        );
        return abi.decode(r, (uint256));
    }

    function _getXmrPriceWithAge(uint256 maxAge) internal returns (uint256) {
        bytes memory r = _hubView(
            abi.encodeWithSelector(SimpleOracleFacet.getXmrPriceWithAge.selector, maxAge)
        );
        return abi.decode(r, (uint256));
    }

    function _getUpdateFee(bytes[] memory data) internal returns (uint256) {
        bytes memory r = _hubView(abi.encodeWithSelector(SimpleOracleFacet.getUpdateFee.selector, data));
        return abi.decode(r, (uint256));
    }

    function _normalizeDebt(uint256 actualDebt) internal returns (uint256) {
        bytes memory r = _hubView(abi.encodeWithSelector(SimpleOracleFacet.normalizeDebt.selector, actualDebt));
        return abi.decode(r, (uint256));
    }

    function _denormalizeDebt(uint256 normalizedDebt) internal returns (uint256) {
        bytes memory r = _hubView(abi.encodeWithSelector(SimpleOracleFacet.denormalizeDebt.selector, normalizedDebt));
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
        VaultFacet(address(hub)).setVaultMarketMetrics(100, 100);
        vm.stopPrank();
    }
}
