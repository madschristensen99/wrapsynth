// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {CollateralLogic} from "../contracts/libraries/CollateralLogic.sol";
import {BurnLogic} from "../contracts/libraries/BurnLogic.sol";
import {YieldLogic} from "../contracts/libraries/YieldLogic.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";

contract MockVerifierProxy {
    function verify(bytes calldata) external pure returns (bool) {
        return true;
    }
}

/// @notice Wrapper to expose internal library functions for testing
contract LibraryWrapper {
    using CollateralLogic for *;
    using BurnLogic for *;
    using YieldLogic for *;

    // --- CollateralLogic pure functions ---

    function calculateCollateralRatio(uint256 collateralValueUsd, uint256 debtValueUsd)
        external pure returns (uint256)
    {
        return CollateralLogic.calculateCollateralRatio(collateralValueUsd, debtValueUsd);
    }

    function collateralToUsd(uint256 collateralAmount, uint256 collateralPrice)
        external pure returns (uint256)
    {
        return CollateralLogic.collateralToUsd(collateralAmount, collateralPrice);
    }

    function usdToCollateral(uint256 valueUsd, uint256 collateralPrice)
        external pure returns (uint256)
    {
        return CollateralLogic.usdToCollateral(valueUsd, collateralPrice);
    }

    function getCollateralValueForDebt(uint256 debtAmount, uint256 xmrPrice, uint256 ratio)
        external pure returns (uint256)
    {
        return CollateralLogic.getCollateralValueForDebt(debtAmount, xmrPrice, ratio);
    }

    // --- CollateralLogic view functions (need SDAI on fork) ---

    function calculateRatioFromShares(
        uint256 collateralShares,
        uint256 debtAmount,
        address sdai,
        uint256 collateralPrice,
        uint256 xmrPrice
    ) external view returns (uint256) {
        return CollateralLogic.calculateRatioFromShares(
            collateralShares, debtAmount, sdai, collateralPrice, xmrPrice
        );
    }

    function calculateVaultCRWithDeployment(
        uint256 idleShares,
        uint256 positionDAI,
        uint256 positionWsxmr,
        uint256 debtAmount,
        address sdai,
        uint256 collateralPrice,
        uint256 xmrPrice
    ) external view returns (uint256) {
        return CollateralLogic.calculateVaultCRWithDeployment(
            idleShares, positionDAI, positionWsxmr, debtAmount, sdai, collateralPrice, xmrPrice
        );
    }

    // --- BurnLogic pure functions ---

    function calculateBurnReward(
        uint256 wsxmrAmount,
        uint16 burnRewardBps,
        uint256 xmrPrice,
        uint256 collateralPrice
    ) external pure returns (uint256) {
        return BurnLogic.calculateBurnReward(wsxmrAmount, burnRewardBps, xmrPrice, collateralPrice);
    }

    function calculateRequiredCollateral(
        uint256 wsxmrAmount,
        uint256 xmrPrice,
        uint256 collateralPrice,
        uint256 liquidationRatio
    ) external pure returns (uint256) {
        return BurnLogic.calculateRequiredCollateral(
            wsxmrAmount, xmrPrice, collateralPrice, liquidationRatio
        );
    }

    // --- YieldLogic view functions (need SDAI on fork) ---

    function calculateVaultCollateralRatio(
        uint256 collateralShares,
        uint256 debtAmount,
        uint256 collateralPrice,
        uint256 xmrPrice
    ) external view returns (uint256) {
        return YieldLogic.calculateVaultCollateralRatio(
            collateralShares, debtAmount, collateralPrice, xmrPrice
        );
    }
}

contract LibraryCoverageTest is Test {
    LibraryWrapper public wrapper;

    uint256 constant XMR_PRICE_18DEC = 390 ether;
    uint256 constant DAI_PRICE_18DEC = 1 ether;
    uint256 constant WSXMR_DECIMALS = 1e8;

    function setUp() public {
        string memory rpcUrl = vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"));
        vm.createSelectFork(rpcUrl);
        wrapper = new LibraryWrapper();
    }

    // ========== CollateralLogic.calculateCollateralRatio (pure) ==========

    function test_CalculateCollateralRatio_ZeroDebt() public {
        uint256 ratio = wrapper.calculateCollateralRatio(1000 ether, 0);
        assertEq(ratio, type(uint256).max, "zero debt should return max");
    }

    function test_CalculateCollateralRatio_NormalCase() public {
        // 150% ratio: 150 collateral / 100 debt
        uint256 ratio = wrapper.calculateCollateralRatio(150 ether, 100 ether);
        assertEq(ratio, 150, "150/100 should be 150%");
    }

    function test_CalculateCollateralRatio_Undercollateralized() public {
        uint256 ratio = wrapper.calculateCollateralRatio(100 ether, 200 ether);
        assertEq(ratio, 50, "100/200 should be 50%");
    }

    // ========== CollateralLogic.collateralToUsd (pure) ==========

    function test_CollateralToUsd_CorrectConversion() public {
        // 100 DAI * $1 = $100
        uint256 usd = wrapper.collateralToUsd(100 ether, 1 ether);
        assertEq(usd, 100 ether, "100 DAI at $1 should be $100");
    }

    function test_CollateralToUsd_ZeroAmount() public {
        uint256 usd = wrapper.collateralToUsd(0, 1 ether);
        assertEq(usd, 0, "zero collateral should give zero USD");
    }

    // ========== CollateralLogic.usdToCollateral (pure) ==========

    function test_UsdToCollateral_CorrectConversion() public {
        // $100 / $1 = 100 DAI
        uint256 collateral = wrapper.usdToCollateral(100 ether, 1 ether);
        assertEq(collateral, 100 ether, "$100 at $1 should be 100 DAI");
    }

    function test_UsdToCollateral_ZeroUsd() public {
        uint256 collateral = wrapper.usdToCollateral(0, 1 ether);
        assertEq(collateral, 0, "zero USD should give zero collateral");
    }

    // ========== CollateralLogic.getCollateralValueForDebt (pure) ==========

    function test_GetCollateralValueForDebt_CorrectValue() public {
        // 1 wsXMR (1e8) at $390 = $390, at 150% ratio = $585
        uint256 value = wrapper.getCollateralValueForDebt(1e8, XMR_PRICE_18DEC, 150);
        assertEq(value, 585 ether, "1 wsXMR at $390, 150% ratio should be $585");
    }

    function test_GetCollateralValueForDebt_ZeroDebt() public {
        uint256 value = wrapper.getCollateralValueForDebt(0, XMR_PRICE_18DEC, 150);
        assertEq(value, 0, "zero debt should give zero value");
    }

    // ========== CollateralLogic.calculateRatioFromShares (view, needs fork) ==========

    function test_CalculateRatioFromShares_ZeroDebt() public {
        uint256 ratio = wrapper.calculateRatioFromShares(
            100 ether, 0, GnosisAddresses.SDAI, DAI_PRICE_18DEC, XMR_PRICE_18DEC
        );
        assertEq(ratio, type(uint256).max, "zero debt should return max");
    }

    function test_CalculateRatioFromShares_WithDebt() public {
        // 100 sDAI shares (~104.5 DAI at current rate) vs 1 wsXMR debt (1e8)
        uint256 ratio = wrapper.calculateRatioFromShares(
            100 ether, 1e8, GnosisAddresses.SDAI, DAI_PRICE_18DEC, XMR_PRICE_18DEC
        );
        assertGt(ratio, 0, "ratio should be positive");
        assertLt(ratio, type(uint256).max, "ratio should be finite");
    }

    // ========== CollateralLogic.calculateVaultCRWithDeployment (view, needs fork) ==========

    function test_CalculateVaultCRWithDeployment_ZeroDebt() public {
        uint256 ratio = wrapper.calculateVaultCRWithDeployment(
            100 ether, 50 ether, 50 ether, 0, GnosisAddresses.SDAI, DAI_PRICE_18DEC, XMR_PRICE_18DEC
        );
        assertEq(ratio, type(uint256).max, "zero debt should return max");
    }

    function test_CalculateVaultCRWithDeployment_WithDebt() public {
        uint256 ratio = wrapper.calculateVaultCRWithDeployment(
            100 ether, 50 ether, 50 ether, 1e8, GnosisAddresses.SDAI, DAI_PRICE_18DEC, XMR_PRICE_18DEC
        );
        assertGt(ratio, 0, "ratio should be positive");
        assertLt(ratio, type(uint256).max, "ratio should be finite");
    }

    // ========== BurnLogic.calculateBurnReward (pure) ==========

    function test_CalculateBurnReward_CorrectReward() public {
        // 1 wsXMR (1e8) at $390 = $390, 1% reward = $3.90
        // rewardCollateral = ($3.90 * 1e18) / $1 = 3.90 DAI
        uint256 reward = wrapper.calculateBurnReward(1e8, 100, XMR_PRICE_18DEC, DAI_PRICE_18DEC);
        assertEq(reward, 3.9 ether, "1% of 1 wsXMR at $390 should be 3.9 DAI");
    }

    function test_CalculateBurnReward_ZeroBps() public {
        uint256 reward = wrapper.calculateBurnReward(1e8, 0, XMR_PRICE_18DEC, DAI_PRICE_18DEC);
        assertEq(reward, 0, "zero bps should give zero reward");
    }

    function test_CalculateBurnReward_ZeroAmount() public {
        uint256 reward = wrapper.calculateBurnReward(0, 100, XMR_PRICE_18DEC, DAI_PRICE_18DEC);
        assertEq(reward, 0, "zero amount should give zero reward");
    }

    // ========== BurnLogic.calculateRequiredCollateral (pure) ==========

    function test_CalculateRequiredCollateral_CorrectValue() public {
        // 1 wsXMR (1e8) at $390 = $390, at 110% ratio = $429
        // requiredCollateral = ($429 * 1e18) / $1 = 429 DAI
        uint256 required = wrapper.calculateRequiredCollateral(1e8, XMR_PRICE_18DEC, DAI_PRICE_18DEC, 110);
        assertEq(required, 429 ether, "110% of 1 wsXMR at $390 should be 429 DAI");
    }

    function test_CalculateRequiredCollateral_ZeroAmount() public {
        uint256 required = wrapper.calculateRequiredCollateral(0, XMR_PRICE_18DEC, DAI_PRICE_18DEC, 110);
        assertEq(required, 0, "zero amount should give zero required");
    }

    // ========== YieldLogic.calculateVaultCollateralRatio (view, needs fork) ==========

    function test_CalculateVaultCollateralRatio_ZeroDebt() public {
        uint256 ratio = wrapper.calculateVaultCollateralRatio(
            100 ether, 0, DAI_PRICE_18DEC, XMR_PRICE_18DEC
        );
        assertEq(ratio, type(uint256).max, "zero debt should return max");
    }

    function test_CalculateVaultCollateralRatio_WithDebt() public {
        uint256 ratio = wrapper.calculateVaultCollateralRatio(
            100 ether, 1e8, DAI_PRICE_18DEC, XMR_PRICE_18DEC
        );
        assertGt(ratio, 0, "ratio should be positive");
        assertLt(ratio, type(uint256).max, "ratio should be finite");
    }
}
