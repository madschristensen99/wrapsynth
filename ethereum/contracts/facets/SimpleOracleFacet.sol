// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";

/**
 * @title SimpleOracleFacet
 * @notice Simple oracle that accepts price updates from trusted updater
 * @dev Prices fetched off-chain from RedStone API and pushed on-chain
 */
contract SimpleOracleFacet is wsXmrStorage, IOracleFacet {
    
    address public priceUpdater;
    
    event PricesUpdated(uint256 xmrPrice, uint256 daiPrice, uint256 timestamp);
    event UpdaterChanged(address indexed oldUpdater, address indexed newUpdater);
    
    constructor(address _wsxmrToken, address _verifierProxy, address _priceUpdater) 
        wsXmrStorage(_wsxmrToken, _verifierProxy) 
    {
        priceUpdater = _priceUpdater;
    }
    
    // ========== PRICE UPDATE ==========
    
    /// @notice Update prices (called by price updater with real RedStone API data)
    function updatePrices(uint256 xmrPrice, uint256 daiPrice) external {
        require(msg.sender == priceUpdater || msg.sender == deployer, "Only updater");
        require(xmrPrice > 0 && daiPrice > 0, "Invalid prices");

        uint256 newPrice = xmrPrice * 1e10;

        // H3: Deviation guard — reject updates that move more than MAX_PRICE_DEVIATION_BPS.
        // Staleness-scaled: if last update is >90s old, skip guard so a stuck oracle can re-anchor.
        uint256 timeSinceUpdate = block.timestamp - lastXmrPriceTimestamp;
        if (msg.sender != deployer && timeSinceUpdate < 90 seconds) {
            uint256 oldPrice = uint256(uint192(lastXmrPrice)) * 1e10;
            if (oldPrice > 0) {
                uint256 diff = oldPrice > newPrice ? oldPrice - newPrice : newPrice - oldPrice;
                require((diff * BPS_DENOMINATOR) / oldPrice <= MAX_PRICE_DEVIATION_BPS, "Price deviation too high");
            }
        }

        // Prices come in 8 decimals from RedStone, store as int192
        lastXmrPrice = int192(int256(xmrPrice));
        lastXmrPriceTimestamp = block.timestamp;

        // M1: Update on-chain EMA accumulator
        if (xmrEmaPrice == 0) {
            xmrEmaPrice = newPrice;
        } else {
            xmrEmaPrice = (EMA_ALPHA_NUMERATOR * newPrice + (EMA_DENOMINATOR - EMA_ALPHA_NUMERATOR) * xmrEmaPrice) / EMA_DENOMINATOR;
        }

        lastCollateralPrice = int192(int256(daiPrice));
        lastCollateralPriceTimestamp = block.timestamp;

        emit PricesUpdated(xmrPrice, daiPrice, block.timestamp);
    }
    
    /// @inheritdoc IOracleFacet
    function updateOraclePrices(bytes[] calldata) external payable {
        // Compatibility function - does nothing, use updatePrices() instead
        if (msg.value > 0) {
            (bool success, ) = msg.sender.call{value: msg.value}("");
            require(success, "Refund failed");
        }
    }
    
    // ========== ADMIN ==========
    
    function setPriceUpdater(address newUpdater) external {
        require(msg.sender == deployer, "Only deployer");
        address oldUpdater = priceUpdater;
        priceUpdater = newUpdater;
        emit UpdaterChanged(oldUpdater, newUpdater);
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
        // RedStone uses 8 decimals, normalize to 18
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
        // RedStone uses 8 decimals, normalize to 18
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
        bytes4[] memory sels = new bytes4[](10);
        sels[0] = this.updatePrices.selector;
        sels[1] = this.updateOraclePrices.selector;
        sels[2] = this.setPriceUpdater.selector;
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
