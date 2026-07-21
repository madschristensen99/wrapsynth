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

contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

contract LiquidationCoverageTest is Test {
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

    // ========== calculateLiquidation ==========

    function test_CalculateLiquidation_ReturnsValues() public {
        _mintForUser(user, lp);

        (uint256 collateralSeized, uint256 actualDebtCleared) = _calculateLiquidation(lp, 1000);

        assertGt(actualDebtCleared, 0, "debt cleared should be positive");
    }

    function test_CalculateLiquidation_DebtExceedsActual() public {
        _mintForUser(user, lp);

        (, uint256 actualDebtCleared) = _calculateLiquidation(lp, type(uint256).max);

        assertGt(actualDebtCleared, 0, "should return actual debt amount");
    }

    function test_CalculateLiquidation_NoDebt() public {
        (uint256 collateralSeized, uint256 actualDebtCleared) = _calculateLiquidation(lp, 1000);

        assertEq(collateralSeized, 0, "no debt -> no collateral seized");
        assertEq(actualDebtCleared, 0, "no debt -> no debt cleared");
    }

    // ========== getLiquidatableVaults ==========

    function test_GetLiquidatableVaults_NoneLiquidatable() public {
        (address[] memory vaults, ) = _getLiquidatableVaults(0, 100);

        bool foundNonZero = false;
        for (uint256 i = 0; i < vaults.length; i++) {
            if (vaults[i] != address(0)) {
                foundNonZero = true;
                break;
            }
        }
        assertFalse(foundNonZero, "no vaults should be liquidatable when healthy");
    }

    function test_GetLiquidatableVaults_OutOfRange() public {
        // startIndex beyond vaultList.length causes uint underflow in bounds check
        vm.expectRevert();
        _getLiquidatableVaults(10000, 10);
    }

    // ========== isVaultLiquidatable ==========

    function test_IsVaultLiquidatable_HealthyVault() public {
        assertFalse(_isVaultLiquidatable(lp), "healthy vault should not be liquidatable");
    }

    function test_IsVaultLiquidatable_NoDebt() public {
        assertFalse(_isVaultLiquidatable(lp), "vault with no debt should not be liquidatable");
    }

    function test_IsVaultLiquidatable_InactiveVault() public {
        assertFalse(_isVaultLiquidatable(attacker), "inactive vault should not be liquidatable");
    }

    // ========== isPoolFeeTierAllowed ==========

    function test_IsPoolFeeTierAllowed_AllowedTiers() public {
        assertTrue(_isPoolFeeTierAllowed(500), "500 should be allowed");
        assertTrue(_isPoolFeeTierAllowed(3000), "3000 should be allowed");
        assertTrue(_isPoolFeeTierAllowed(10000), "10000 should be allowed");
    }

    function test_IsPoolFeeTierAllowed_DisallowedTier() public {
        assertFalse(_isPoolFeeTierAllowed(123), "123 should not be allowed");
    }

    // ========== getVaultExtractableYield ==========

    function test_GetVaultExtractableYield_NoYield() public {
        uint256 yield_ = _getVaultExtractableYield(lp);
        assertEq(yield_, 0, "should have no extractable yield on fresh vault");
    }

    function test_GetVaultExtractableYield_WithDebt() public {
        _mintForUser(user, lp);
        uint256 yield_ = _getVaultExtractableYield(lp);
        assertEq(yield_, 0, "should have no extractable yield without sDAI appreciation");
    }

    // ========== HUB VIEW HELPERS ==========

    function _hubView(bytes memory data) internal returns (bytes memory) {
        (bool success, bytes memory result) = address(hub).call(data);
        require(success, "hub view call failed");
        return result;
    }

    function _calculateLiquidation(address lpVault, uint256 debtToClear)
        internal returns (uint256 collateralSeized, uint256 actualDebtCleared)
    {
        bytes memory r = _hubView(
            abi.encodeWithSelector(LiquidationFacet.calculateLiquidation.selector, lpVault, debtToClear)
        );
        return abi.decode(r, (uint256, uint256));
    }

    function _getLiquidatableVaults(uint256 startIndex, uint256 count)
        internal returns (address[] memory vaults, uint256[] memory debts)
    {
        bytes memory r = _hubView(
            abi.encodeWithSelector(LiquidationFacet.getLiquidatableVaults.selector, startIndex, count)
        );
        return abi.decode(r, (address[], uint256[]));
    }

    function _isVaultLiquidatable(address lpVault) internal returns (bool) {
        bytes memory r = _hubView(
            abi.encodeWithSelector(LiquidationFacet.isVaultLiquidatable.selector, lpVault)
        );
        return abi.decode(r, (bool));
    }

    function _isPoolFeeTierAllowed(uint24 tier) internal returns (bool) {
        bytes memory r = _hubView(
            abi.encodeWithSelector(YieldFacet.isPoolFeeTierAllowed.selector, tier)
        );
        return abi.decode(r, (bool));
    }

    function _getVaultExtractableYield(address lpVault) internal returns (uint256) {
        bytes memory r = _hubView(
            abi.encodeWithSelector(YieldFacet.getVaultExtractableYield.selector, lpVault)
        );
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
}
