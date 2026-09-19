// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";

/**
 * @title HyperCoreOracleFacet
 * @notice Oracle facet reading the HyperCore native XMR perp price via HyperEVM
 *         L1-read precompiles — replaces SimpleOracleFacet's off-chain pusher.
 * @dev    Data source is the validator-maintained perp oracle (trustless), not a
 *         WrapSynth-operated price pusher. The actual read + divergence + EMA +
 *         storage-write logic lives in wsXmrStorage._tryRefreshOracle() so every
 *         state-changing entry point can self-refresh; this facet exposes the
 *         permissionless poke and the IOracleFacet read surface.
 *
 *         Prices are stored in the same 8-decimal format SimpleOracleFacet used,
 *         so _getXmrPriceFromStorage/_getCollateralPriceFromStorage and all
 *         downstream math are unchanged.
 *
 *         Collateral (USDe) is the unit of account — its price is fixed at $1.00.
 */
contract HyperCoreOracleFacet is wsXmrStorage, IOracleFacet {

    event PricesRefreshed(uint256 xmrPrice8dec, uint256 timestamp);

    constructor(address _wsxmrToken, address _verifierProxy)
        wsXmrStorage(_wsxmrToken, _verifierProxy)
    {}

    // ========== ORACLE REFRESH ==========

    /// @notice Permissionless oracle refresh — reads the HyperCore native XMR
    ///         perp oraclePx/markPx via L1-read precompiles and writes storage.
    /// @dev    Anyone can call; keepers/users poke it before price-sensitive
    ///         operations. State-changing entry points also self-refresh via
    ///         _tryRefreshOracle(), so this is belt-and-suspenders for view-only
    ///         freshness and EMA sampling.
    function refreshPrices() external {
        _tryRefreshOracle();
        emit PricesRefreshed(uint256(uint192(lastXmrPrice)), lastXmrPriceTimestamp);
    }

    /// @notice Legacy interface shim — RedStone push updates no longer exist.
    /// @dev    Kept for IOracleFacet compatibility; performs a precompile refresh
    ///         and ignores updateData. Costs no fee.
    function updateOraclePrices(bytes[] calldata /*updateData*/) external payable {
        _tryRefreshOracle();
        if (msg.value > 0) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice No fee — the oracle is read from precompiles, not pushed.
    function getUpdateFee(bytes[] calldata /*updateData*/) external pure returns (uint256) {
        return 0;
    }

    // ========== VIEW FUNCTIONS ==========

    /// @inheritdoc IOracleFacet
    function getXmrPrice() external view returns (uint256) {
        return _getXmrPriceFromStorage();
    }

    /// @inheritdoc IOracleFacet
    function getXmrPriceWithAge(uint256 maxAge) external view returns (uint256) {
        if (block.timestamp > lastXmrPriceTimestamp + maxAge) revert StalePrice();
        int192 price = lastXmrPrice;
        if (price <= 0) revert StalePrice();
        uint256 normalized = uint256(uint192(price)) * 1e10;
        if (normalized == 0) revert PriceNormalizedToZero();
        return normalized;
    }

    /// @inheritdoc IOracleFacet
    function getCollateralPrice() external view returns (uint256) {
        return _getCollateralPriceFromStorage();
    }

    /// @inheritdoc IOracleFacet
    function getCollateralPriceWithAge(uint256 maxAge) external view returns (uint256) {
        if (block.timestamp > lastCollateralPriceTimestamp + maxAge) revert StalePrice();
        int192 price = lastCollateralPrice;
        if (price <= 0) revert StalePrice();
        uint256 normalized = uint256(uint192(price)) * 1e10;
        if (normalized == 0) revert PriceNormalizedToZero();
        return normalized;
    }

    /// @inheritdoc IOracleFacet
    function getXmrEmaPrice() external view returns (uint256) {
        return xmrEmaPrice;
    }

    /// @inheritdoc IOracleFacet
    function normalizeDebt(uint256 actualDebt) external view returns (uint256) {
        return (actualDebt * 1e18) / globalDebtIndex;
    }

    /// @inheritdoc IOracleFacet
    function denormalizeDebt(uint256 normalizedDebt) external view returns (uint256) {
        return (normalizedDebt * globalDebtIndex) / 1e18;
    }

    // ========== DIAMOND INTROSPECTION ==========

    /// @notice Returns all function selectors implemented by this facet
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](10);
        sels[0] = this.refreshPrices.selector;
        sels[1] = this.updateOraclePrices.selector;
        sels[2] = this.getUpdateFee.selector;
        sels[3] = this.getXmrPrice.selector;
        sels[4] = this.getXmrPriceWithAge.selector;
        sels[5] = this.getCollateralPrice.selector;
        sels[6] = this.getCollateralPriceWithAge.selector;
        sels[7] = this.getXmrEmaPrice.selector;
        sels[8] = this.normalizeDebt.selector;
        sels[9] = this.denormalizeDebt.selector;
        return sels;
    }
}
