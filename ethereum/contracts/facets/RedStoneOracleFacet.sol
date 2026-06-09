// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";
import "@redstone-finance/evm-connector/contracts/data-services/PrimaryProdDataServiceConsumerBase.sol";

/**
 * @title RedStoneOracleFacet
 * @notice Oracle using RedStone Pull Oracles - simple and supports XMR!
 * @dev Extends RedStone base contract, data is injected into transactions
 */
contract RedStoneOracleFacet is wsXmrStorage, IOracleFacet, PrimaryProdDataServiceConsumerBase {
    
    // Feed IDs (RedStone uses string identifiers)
    bytes32 constant XMR_FEED_ID = bytes32("XMR");
    bytes32 constant DAI_FEED_ID = bytes32("DAI");
    
    // ========== CONSTRUCTOR ==========
    
    constructor(address _wsxmrToken, address _verifierProxy) 
        wsXmrStorage(_wsxmrToken, _verifierProxy) 
    {}
    
    // ========== PRICE UPDATE ==========
    
    /// @inheritdoc IOracleFacet
    /// @dev RedStone prices are passed in calldata, no need for explicit update
    function updateOraclePrices(bytes[] calldata) external payable {
        // Fetch prices from RedStone (data is in tx calldata)
        uint256 xmrPrice = getOracleNumericValueFromTxMsg(XMR_FEED_ID);
        uint256 daiPrice = getOracleNumericValueFromTxMsg(DAI_FEED_ID);
        
        // RedStone returns 8 decimals, convert to int192
        uint256 oldPrice = uint256(uint192(lastXmrPrice)) * 1e10;
        uint256 newPrice = uint256(xmrPrice) * 1e10;

        // H3: Deviation guard — compare against EMA (smoother) rather than last spot.
        // Falls back to oldPrice on first update when EMA is uninitialized.
        uint256 baselinePrice = xmrEmaPrice > 0 ? xmrEmaPrice : oldPrice;
        if (baselinePrice > 0) {
            uint256 diff = baselinePrice > newPrice ? baselinePrice - newPrice : newPrice - baselinePrice;
            if ((diff * BPS_DENOMINATOR) / baselinePrice > MAX_PRICE_DEVIATION_BPS) revert PriceDeviationTooHigh();
        }

        // M4: Extract and store the signed payload timestamp, not block.timestamp
        uint256 payloadTimestamp = extractTimestampsAndAssertAllAreEqual() / 1000;

        lastXmrPrice = int192(int256(xmrPrice));
        lastXmrPriceTimestamp = payloadTimestamp;

        // M1: Update on-chain EMA accumulator
        if (xmrEmaPrice == 0) {
            xmrEmaPrice = newPrice;
        } else {
            xmrEmaPrice = (EMA_ALPHA_NUMERATOR * newPrice + (EMA_DENOMINATOR - EMA_ALPHA_NUMERATOR) * xmrEmaPrice) / EMA_DENOMINATOR;
        }

        lastCollateralPrice = int192(int256(daiPrice));
        lastCollateralPriceTimestamp = payloadTimestamp;
        
        // Refund any sent ETH (not needed for RedStone)
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
        bytes4[] memory sels = new bytes4[](8);
        sels[0] = this.updateOraclePrices.selector;
        sels[1] = this.getXmrPrice.selector;
        sels[2] = this.getXmrPriceWithAge.selector;
        sels[3] = this.getCollateralPrice.selector;
        sels[4] = this.getCollateralPriceWithAge.selector;
        sels[5] = this.getXmrEmaPrice.selector;
        sels[6] = this.getUpdateFee.selector;
        sels[7] = this.normalizeDebt.selector;
        return sels;
    }
}
