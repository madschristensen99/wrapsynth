// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {BaseMockTestBase} from "./BaseTestBase.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {ILiquidationFacet} from "../contracts/interfaces/facets/ILiquidationFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ed25519} from "../contracts/Ed25519.sol";
import {IErrors} from "../contracts/interfaces/IErrors.sol";

contract LiquidationCoverageTestBase is BaseMockTestBase {
    address attacker = makeAddr("attacker");

    function setUp() public override {
        super.setUp();
        vm.deal(attacker, 1000 ether);
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

    // ========== Issue #69: liquidation eligibility counts free collateral only ==========

    /// @notice Regression: a vault whose FREE collateral (collateralShares minus
    ///         lockedCollateral) sits below LIQUIDATION_RATIO must be liquidatable even
    ///         when total shares — inflated by an in-flight mint key bond — sit above
    ///         it. The bond is never seizable, so counting it let an underwater vault
    ///         dodge liquidation and accrue bad debt.
    function test_Liquidate_MintBondDoesNotShield() public {
        _mintForUser(user, lp); // 0.02 wsXMR debt @ $390 → $7.80

        // Key a second identical mint — locks a 110%-of-par key bond (~$8.58)
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        // Pump XMR to $4,000 → debt ~$80. Total shares ~$100 → ~125% passed the old
        // total-collateral check; free ~$91.4 → ~114% is below the floor.
        _setXmrPrice8dec(4000_00000000);

        assertLt(hub.getVaultHealth(lp), 120, "free-collateral health below floor");
        assertTrue(_isVaultLiquidatable(lp), "free CR < 120% must be liquidatable");

        uint256 debt = hub.getVaultDebt(lp);
        deal(address(wsxmr), attacker, debt);
        vm.prank(attacker);
        LiquidationFacet(address(hub)).liquidate(lp, type(uint256).max);

        assertEq(hub.getVaultDebt(lp), 0, "debt fully cleared");
        assertGt(stata.balanceOf(attacker), 0, "liquidator seized collateral");
    }

    /// @notice Control: a vault whose free collateral remains above LIQUIDATION_RATIO
    ///         still reverts VaultHealthy — the free-collateral basis must not
    ///         over-trigger.
    function test_Liquidate_HealthyFreeCollateral_StillReverts() public {
        _mintForUser(user, lp);
        bytes32 reqId = _initiateMint(user, lp);
        _provideLPKey(lp, reqId);

        // $3,000 XMR → debt $60; free ~$91.4 → ~152% — healthy on either basis.
        _setXmrPrice8dec(3000_00000000);

        assertFalse(_isVaultLiquidatable(lp), "healthy vault not liquidatable");

        uint256 debt = hub.getVaultDebt(lp);
        deal(address(wsxmr), attacker, debt);
        vm.prank(attacker);
        vm.expectRevert(ILiquidationFacet.VaultHealthy.selector);
        LiquidationFacet(address(hub)).liquidate(lp, type(uint256).max);
    }

    /// @notice Committed burns settle BEFORE the eligibility check: their par payout
    ///         and debt removal are already applied. A vault that is healthy
    ///         post-settlement must not be liquidated — a naive pre-settlement
    ///         free-collateral check would double-count (lock excluded, debt kept).
    function test_Liquidate_HealthyAfterCommittedBurnSettle_Reverts() public {
        uint256 minted = _mintForUser(user, lp);
        uint256 burnAmount = minted / 2; // ~0.0099 wsXMR — half the vault's debt

        // REQUESTED → PROPOSED → COMMITTED (locks 110% par + reward at request price)
        bytes32 userSecret = bytes32(uint256(0xdeadbeef));
        (uint256 upkx, uint256 upky) = Ed25519.scalarMultBase(uint256(userSecret));
        bytes32 userPubKey = bytes32(Ed25519.compressPoint(upkx, upky));
        vm.startPrank(user);
        wsxmr.approve(address(hub), burnAmount);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(
            burnAmount, lp, user, bytes32(uint256(1)), userPubKey, bytes32(uint256(3))
        );
        vm.stopPrank();
        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 secretHash = keccak256(abi.encodePacked(bpx, bpy));
        vm.prank(lp);
        BurnFacet(address(hub)).proposeHash(burnId, secretHash, bytes32(uint256(0x1111)), bytes32(uint256(0x2222)));
        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);

        // $4,000 XMR → debt $80, burn lock ~$4.3. Pre-settlement free basis:
        // (100 − 4.3)/80 ≈ 119.6% would over-trigger. Post-settlement truth: the
        // burn pays par ($3.86 @ request price) + reward and removes $39.6 of debt
        // → ~$96 free / ~$40 debt ≈ 238% → genuinely healthy → VaultHealthy.
        _setXmrPrice8dec(4000_00000000);

        uint256 debtBefore = hub.getVaultDebt(lp);
        deal(address(wsxmr), attacker, debtBefore);
        vm.prank(attacker);
        vm.expectRevert(ILiquidationFacet.VaultHealthy.selector);
        LiquidationFacet(address(hub)).liquidate(lp, type(uint256).max);

        // Atomic revert: the in-flight burn is untouched and resolves via its own path.
        assertEq(hub.getVaultDebt(lp), debtBefore, "debt unchanged on revert");
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
        deal(USDE, who, amount);
        vm.startPrank(who);
        IERC20(USDE).approve(address(hub), amount);
        VaultFacet(address(hub)).depositCollateral(amount);
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
        MintFacet(address(hub)).provideLPKey(reqId, bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)), bytes32(uint256(0xdeadbeef)));
    }

    function _setMintReady(address _lp, bytes32 reqId) internal {
        vm.prank(_lp);
        MintFacet(address(hub)).setMintReady(reqId);
    }

    function _mintForUser(address _user, address _lp) internal returns (uint256) {
        bytes32 reqId = _initiateMint(_user, _lp);
        _provideLPKey(_lp, reqId);
        _setMintReady(_lp, reqId);
        vm.prank(_user);
        MintFacet(address(hub)).revealSecret(reqId, bytes32(uint256(0x1234)));
        MintFacet(address(hub)).finalizeMint(reqId);
        return wsxmr.balanceOf(_user);
    }
}
