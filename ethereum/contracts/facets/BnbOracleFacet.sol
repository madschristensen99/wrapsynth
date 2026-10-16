// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";
import "@redstone-finance/evm-connector/contracts/data-services/PrimaryProdDataServiceConsumerBase.sol";

/**
 * @title BnbOracleFacet
 * @notice BNB Chain oracle: RedStone pull for XMR/USD (the only external
 *         price input) + fully on-chain TWAP for the collateral asset.
 * @dev    The collateral price is never pushed — _tryRefreshCollateralTwap
 *         (wsXmrStorage) recomputes QQQB/USD from the configured V3 pools
 *         inside every state-changing call, and refreshCollateralPrice()
 *         lets anyone refresh it explicitly.
 */
contract BnbOracleFacet is wsXmrStorage, IOracleFacet, PrimaryProdDataServiceConsumerBase {

    bytes32 constant XMR_FEED_ID = bytes32("XMR");

    // ========== CONSTRUCTOR ==========

    constructor(address _wsxmrToken, address _verifierProxy)
        wsXmrStorage(_wsxmrToken, _verifierProxy)
    {}

    // ========== PRICE UPDATE ==========

    /// @inheritdoc IOracleFacet
    /// @dev RedStone XMR price is passed in tx calldata. The collateral price
    ///      refresh rides along — it is on-chain TWAP, not a pushed feed.
    ///      If calldata carries no RedStone payload (no marker appended), the
    ///      call degrades to a soft refresh — _tryRefreshOracle legs +
    ///      msg.value refund — matching HyperCoreOracleFacet semantics.
    function updateOraclePrices(bytes[] calldata) external payable {
        if (!_hasRedStonePayload()) {
            _tryRefreshOracle();
            _refundSender();
            return;
        }
        uint256 xmrPrice = getOracleNumericValueFromTxMsg(XMR_FEED_ID);

        uint256 newPrice = uint256(xmrPrice) * 1e10;
        _assertDeviation(newPrice);

        // M4: Extract and store the signed payload timestamp, not block.timestamp
        uint256 payloadTimestamp = extractTimestampsAndAssertAllAreEqual() / 1000;

        lastXmrPrice = int192(int256(xmrPrice));
        lastXmrPriceTimestamp = payloadTimestamp;

        _updateEma(newPrice);

        // Collateral: best-effort on-chain TWAP refresh (no-op if unconfigured
        // or a pool lacks observation history)
        _tryRefreshCollateralTwap();

        _refundSender();
    }

    /// @notice Permissionless collateral-price refresh from the on-chain TWAP
    ///         pools. Reverts StalePrice if the refresh didn't produce a fresh
    ///         price (e.g. insufficient observation history on a pool).
    function refreshCollateralPrice() external {
        _refreshCollateralTwapOrRevert();
    }

    /// @notice Permissionless full refresh — mirrors HyperCoreOracleFacet's
    ///         refreshPrices entry point. Runs the shared _tryRefreshOracle
    ///         legs (precompile XMR read where configured + collateral TWAP).
    function refreshPrices() external {
        _tryRefreshOracle();
    }

    /// @dev H3: Deviation guard — compare against EMA (smoother) rather than last spot.
    function _assertDeviation(uint256 newPrice) internal view {
        uint256 timeSinceUpdate = block.timestamp - lastXmrPriceTimestamp;
        if (timeSinceUpdate >= 90 seconds) return;
        uint256 oldPrice = uint256(uint192(lastXmrPrice)) * 1e10;
        uint256 baselinePrice = xmrEmaPrice > 0 ? xmrEmaPrice : oldPrice;
        if (baselinePrice == 0) return;
        uint256 diff = baselinePrice > newPrice ? baselinePrice - newPrice : newPrice - baselinePrice;
        if ((diff * BPS_DENOMINATOR) / baselinePrice > MAX_PRICE_DEVIATION_BPS) revert PriceDeviationTooHigh();
    }

    /// @dev M1: Update on-chain EMA accumulator
    function _updateEma(uint256 newPrice) internal {
        if (xmrEmaPrice == 0) {
            xmrEmaPrice = newPrice;
        } else {
            xmrEmaPrice = (EMA_ALPHA_NUMERATOR * newPrice + (EMA_DENOMINATOR - EMA_ALPHA_NUMERATOR) * xmrEmaPrice) / EMA_DENOMINATOR;
        }
    }

    /// @dev True when msg.data ends with the RedStone payload marker — the
    ///      same check CalldataExtractor performs before decoding a package.
    function _hasRedStonePayload() internal pure returns (bool hasPayload) {
        if (msg.data.length < 32) return false;
        assembly {
            let tail := calldataload(sub(calldatasize(), 32))
            hasPayload := eq(
                0x0000000000000000000000000000000000000000000000000002ed57011e0000,
                and(tail, 0x0000000000000000000000000000000000000000000000000002ed57011e0000)
            )
        }
    }

    /// @dev Refund any sent ETH
    function _refundSender() internal {
        if (msg.value > 0) {
            (bool success, ) = msg.sender.call{value: msg.value}("");
            if (!success) revert RefundFailed();
        }
    }

    // ========== VIEW FUNCTIONS ==========

    /// @inheritdoc IOracleFacet
    function getXmrPrice() external view returns (uint256) {
        return getXmrPriceWithAge(2 minutes);
    }

    /// @inheritdoc IOracleFacet
    function getXmrPriceWithAge(uint256 maxAge) public view returns (uint256) {
        if (block.timestamp > lastXmrPriceTimestamp + maxAge) revert StalePrice();
        int192 price = lastXmrPrice;
        if (price <= 0) revert StalePrice();
        uint256 normalized = uint256(uint192(price)) * 1e10;
        if (normalized == 0) revert PriceNormalizedToZero();
        return normalized;
    }

    /// @inheritdoc IOracleFacet
    function getCollateralPrice() external view returns (uint256) {
        return getCollateralPriceWithAge(2 minutes);
    }

    /// @inheritdoc IOracleFacet
    function getCollateralPriceWithAge(uint256 maxAge) public view returns (uint256) {
        if (block.timestamp > lastCollateralPriceTimestamp + maxAge) revert StalePrice();
        int192 price = lastCollateralPrice;
        if (price <= 0) revert StalePrice();
        uint256 normalized = uint256(uint192(price)) * 1e10;
        if (normalized == 0) revert PriceNormalizedToZero();
        return normalized;
    }

    /// @inheritdoc IOracleFacet
    function getXmrEmaPrice() external view returns (uint256) {
        if (block.timestamp > lastXmrPriceTimestamp + 2 minutes) revert StalePrice();
        if (xmrEmaPrice == 0) revert StalePrice();
        return xmrEmaPrice;
    }

    /// @inheritdoc IOracleFacet
    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        // RedStone is free (data in calldata)
        return 0;
    }

    /// @inheritdoc IOracleFacet
    function normalizeDebt(uint256 actualDebt) external view returns (uint256) {
        if (globalDebtIndex == 0) return actualDebt;
        return (actualDebt * 1e18) / globalDebtIndex;
    }

    /// @inheritdoc IOracleFacet
    function denormalizeDebt(uint256 normalizedDebt) external view returns (uint256) {
        return (normalizedDebt * globalDebtIndex) / 1e18;
    }

    // ========== DIAMOND INTROSPECTION ==========

    /// @notice Returns all function selectors implemented by this facet
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](11);
        sels[0] = this.updateOraclePrices.selector;
        sels[1] = this.refreshCollateralPrice.selector;
        sels[10] = this.refreshPrices.selector;
        sels[2] = this.getXmrPrice.selector;
        sels[3] = this.getXmrPriceWithAge.selector;
        sels[4] = this.getCollateralPrice.selector;
        sels[5] = this.getCollateralPriceWithAge.selector;
        sels[6] = this.getXmrEmaPrice.selector;
        sels[7] = this.getUpdateFee.selector;
        sels[8] = this.normalizeDebt.selector;
        sels[9] = this.denormalizeDebt.selector;
        return sels;
    }
}
