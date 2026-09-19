// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Test.sol";
import {HyperEVMTestBase} from "./HyperEVMTestBase.sol";
import {HyperCoreOracleFacet} from "../contracts/facets/HyperCoreOracleFacet.sol";
import {IOracleFacet} from "../contracts/interfaces/facets/IOracleFacet.sol";

/**
 * @title HyperCoreOracleFacetTest
 * @notice Verifies the HyperCore precompile oracle: raw-staticcall reads (no
 *         selector), oraclePx/markPx divergence handling (conservative max),
 *         fail-closed staleness, EMA sampling, and the zero-fee refresh surface.
 * @dev    Uses the etched MockL1Read precompiles from HyperEVMTestBase. Prices
 *         are expressed in the 8-decimal test convention; the mock stores the
 *         raw precompile value (price*1e3 for XMR szDecimals=3).
 *
 *         NOTE: hub view functions are read via low-level .call(), not
 *         staticcall — the hub's fallback TSTOREs the EIP-1153 delegate-context
 *         flag, which reverts in a static context.
 */
contract HyperCoreOracleFacetTest is HyperEVMTestBase {
    uint256 constant P390_8DEC = 390_00000000;
    uint256 constant P400_8DEC = 400_00000000;

    function setUp() public override {
        super.setUp();
    }

    // ========== Hub view helpers (.call, not staticcall — EIP-1153 TSTORE) ==========

    function _hubView(bytes memory data) internal returns (bytes memory) {
        (bool ok, bytes memory out) = address(hub).call(data);
        require(ok, "hub view call failed");
        return out;
    }

    function _hubCall(bytes memory data) internal returns (bool ok, bytes memory out) {
        (ok, out) = address(hub).call(data);
    }

    function _getXmrPrice() internal returns (uint256) {
        return abi.decode(_hubView(abi.encodeWithSelector(HyperCoreOracleFacet.getXmrPrice.selector)), (uint256));
    }

    function _getCollateralPrice() internal returns (uint256) {
        return abi.decode(_hubView(abi.encodeWithSelector(HyperCoreOracleFacet.getCollateralPrice.selector)), (uint256));
    }

    function _getXmrEmaPrice() internal returns (uint256) {
        return abi.decode(_hubView(abi.encodeWithSelector(HyperCoreOracleFacet.getXmrEmaPrice.selector)), (uint256));
    }

    function _getXmrPriceWithAge(uint256 maxAge) internal returns (uint256) {
        return abi.decode(_hubView(abi.encodeWithSelector(HyperCoreOracleFacet.getXmrPriceWithAge.selector, maxAge)), (uint256));
    }

    /// @dev Assert a hub view call reverts with the expected 4-byte selector.
    function _assertHubReverts(bytes memory data, bytes4 expectedSelector) internal {
        (bool ok, bytes memory out) = _hubCall(data);
        assertFalse(ok, "expected hub call to revert");
        require(out.length >= 4, "revert data too short");
        bytes4 sel = bytes4(out[0]) | (bytes4(out[1]) >> 8) | (bytes4(out[2]) >> 16) | (bytes4(out[3]) >> 24);
        assertEq(sel, expectedSelector, "unexpected revert selector");
    }

    // ========== Happy path: valid precompile read ==========

    /// @notice refreshPrices reads oraclePx and stores the 18-dec normalized price
    function test_Refresh_ReadsOraclePrice() public {
        _setXmrPrice8dec(P400_8DEC);
        assertEq(_getXmrPrice(), 400 ether, "getXmrPrice should return 18-dec normalized $400");
    }

    /// @notice Collateral (USDe) is the unit of account — fixed at $1.00
    function test_CollateralPrice_FixedAtOneDollar() public {
        _refreshOracle();
        assertEq(_getCollateralPrice(), 1 ether, "USDe collateral price should be $1.00 (18-dec)");
    }

    /// @notice The mock enforces the raw-ABI (no-selector) precompile encoding;
    ///         a successful refresh proves the storage layer staticcalls with
    ///         abi.encode(uint32) and no 4-byte selector.
    function test_RawStaticcallEncoding_NoSelector() public {
        // Direct call WITH a selector must fail — the mock requires exactly
        // 32-byte calldata (abi.encode(uint32)). This proves the facet's read
        // path uses the raw precompile ABI, not a Solidity interface call.
        (bool okWithSelector, ) = ORACLE_PX_PRECOMPILE.staticcall(
            abi.encodeWithSignature("oraclePx(uint32)", XMR_PERP_INDEX)
        );
        assertFalse(okWithSelector, "selector-prefixed call should fail (raw ABI expected)");

        // Raw abi.encode(uint32) succeeds and returns the mocked price.
        (bool okRaw, bytes memory out) = ORACLE_PX_PRECOMPILE.staticcall(abi.encode(XMR_PERP_INDEX));
        assertTrue(okRaw, "raw staticcall should succeed");
        assertEq(out.length, 32, "precompile returns 32-byte abi.encode(uint64)");
    }

    // ========== Divergence: conservative max ==========

    /// @notice oracle/mark within 2% → use oraclePx
    function test_Divergence_WithinThreshold_UsesOracle() public {
        _setXmrPrices8dec(390_00000000, 391_00000000); // ~0.26% divergence
        assertEq(_getXmrPrice(), 390 ether, "within 2% divergence should use oraclePx");
    }

    /// @notice oracle/mark diverge >2% upward → use the HIGHER (mark) price
    function test_Divergence_MarkHigher_UsesMax() public {
        _setXmrPrices8dec(390_00000000, 410_00000000); // ~5.1% divergence
        assertEq(_getXmrPrice(), 410 ether, ">2% divergence should use the higher price (mark)");
    }

    /// @notice oracle/mark diverge >2% downward → use the HIGHER (oracle) price
    function test_Divergence_OracleHigher_UsesMax() public {
        _setXmrPrices8dec(410_00000000, 390_00000000); // ~5.1% divergence
        assertEq(_getXmrPrice(), 410 ether, ">2% divergence should use the higher price (oracle)");
    }

    /// @notice mark = 0 (unavailable) → fall back to oraclePx
    function test_MarkZero_FallsBackToOracle() public {
        _setXmrPrices8dec(390_00000000, 0);
        assertEq(_getXmrPrice(), 390 ether, "mark=0 should fall back to oraclePx");
    }

    // ========== Fail-closed: oracle outage ==========

    /// @notice oraclePx = 0 → refresh no-ops; price goes stale and reads revert
    function test_OracleZero_FailsClosed() public {
        _setXmrPrice8dec(P390_8DEC);
        assertEq(_getXmrPrice(), 390 ether);

        // Simulate perp halt: oracle returns 0. Refresh is a silent no-op.
        mockOracle.setPrice(XMR_PERP_INDEX, 0);
        mockMark.setPrice(XMR_PERP_INDEX, 0);
        _refreshOracle(); // no-op — lastXmrPrice unchanged

        // Still reads the last good price until it goes stale (>120s).
        assertEq(_getXmrPrice(), 390 ether, "last good price served until stale");

        // Past the staleness window, price-dependent reads fail closed.
        vm.warp(block.timestamp + 121);
        _assertHubReverts(
            abi.encodeWithSelector(HyperCoreOracleFacet.getXmrPrice.selector),
            IOracleFacet.StalePrice.selector
        );
    }

    /// @notice getXmrPriceWithAge enforces a caller-specified staleness bound
    function test_GetXmrPriceWithAge_StalenessBound() public {
        _setXmrPrice8dec(P390_8DEC);
        assertEq(_getXmrPriceWithAge(60), 390 ether, "fresh price within 60s bound");

        vm.warp(block.timestamp + 61);
        _assertHubReverts(
            abi.encodeWithSelector(HyperCoreOracleFacet.getXmrPriceWithAge.selector, uint256(60)),
            IOracleFacet.StalePrice.selector
        );
    }

    // ========== EMA sampling ==========

    /// @notice EMA initializes to the first sampled price
    function test_Ema_InitializesToFirstSample() public {
        _setXmrPrice8dec(P390_8DEC);
        assertEq(_getXmrEmaPrice(), 390 ether, "EMA should initialize to first sampled price");
    }

    /// @notice EMA moves toward the new price but lags it (alpha ~0.182)
    function test_Ema_LagsSpotMove() public {
        _setXmrPrice8dec(P390_8DEC);
        uint256 emaBefore = _getXmrEmaPrice();

        vm.warp(block.timestamp + 31);
        _setXmrPrice8dec(P400_8DEC);

        uint256 emaAfter = _getXmrEmaPrice();
        assertGt(emaAfter, emaBefore, "EMA should rise toward the new price");
        assertLt(emaAfter, 400 ether, "EMA should lag the spot move");
        // Expected: 0.182*400 + 0.818*390 = 391.82
        assertApproxEqAbs(emaAfter, 391.82 ether, 0.01 ether, "EMA should track ~10-period average");
    }

    /// @notice EMA does not resample within the 30s interval
    function test_Ema_NoResampleWithinInterval() public {
        _setXmrPrice8dec(P390_8DEC);
        uint256 emaBefore = _getXmrEmaPrice();

        _setXmrPrice8dec(P400_8DEC); // move price, stay within interval
        assertEq(_getXmrEmaPrice(), emaBefore, "EMA should not resample within 30s interval");
    }

    // ========== Fee surface ==========

    /// @notice The precompile oracle is free — no update fee
    function test_GetUpdateFee_Zero() public {
        bytes[] memory empty = new bytes[](0);
        uint256 fee = abi.decode(
            _hubView(abi.encodeWithSelector(HyperCoreOracleFacet.getUpdateFee.selector, empty)),
            (uint256)
        );
        assertEq(fee, 0, "precompile oracle should have zero update fee");
    }

    /// @notice updateOraclePrices refreshes and refunds any attached value
    function test_UpdateOraclePrices_RefundsValue() public {
        uint256 balBefore = address(this).balance;
        bytes[] memory empty = new bytes[](0);
        HyperCoreOracleFacet(address(hub)).updateOraclePrices{value: 1 ether}(empty);
        assertEq(address(this).balance, balBefore, "msg.value should be refunded");
    }

    receive() external payable {}
}
