// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";
import {IDataStreamsVerifier} from "../interfaces/external/IDataStreamsVerifier.sol";

/**
 * @title OracleFacet
 * @notice Handles price oracle operations for the wsXMR system
 * @dev Integrates with Chainlink Data Streams (formerly Mercury)
 */
contract OracleFacet is wsXmrStorage, IOracleFacet {
    
    // Chainlink Data Streams report schema v3
    struct ReportV3 {
        bytes32 feedId;
        uint32 validFromTimestamp;
        uint32 observationsTimestamp;
        uint192 nativeFee;
        uint192 linkFee;
        uint32 expiresAt;
        int192 price;
        int192 bid;
        int192 ask;
    }
    
    // ========== CONSTRUCTOR ==========
    
    constructor(address _wsxmrToken, address _verifierProxy) 
        wsXmrStorage(_wsxmrToken, _verifierProxy) 
    {}
    
    // ========== PRICE UPDATE ==========
    
    /// @inheritdoc IOracleFacet
    function updateChainlinkPrices(bytes[] calldata reports) external payable {
        uint256 refund = msg.value;
        
        for (uint256 i = 0; i < reports.length; i++) {
            bytes memory verified = IDataStreamsVerifier(verifierProxy).verify{value: 0}(reports[i], bytes(""));
            ReportV3 memory decoded = abi.decode(verified, (ReportV3));
            
            // Reject reports older than 30 seconds at submission time
            if (block.timestamp > decoded.observationsTimestamp + 30) revert StalePrice();

            if (decoded.feedId == 0x00038f3b8f8be4305564abf0ed3c9cc46cb8b4303c35ab54079ea873b7d74b3a) {
                lastXmrPrice = decoded.price;
                lastXmrPriceTimestamp = decoded.observationsTimestamp;
            } else if (decoded.feedId == 0x0003a9efc56074727bde001b0f0301eef38db844278734c32aa8b72dcb7902ba) {
                lastCollateralPrice = decoded.price;
                lastCollateralPriceTimestamp = decoded.observationsTimestamp;
            }
        }
        
        // Refund unused ETH
        if (refund > 0) {
            (bool success, ) = msg.sender.call{value: refund}("");
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
        // Chainlink Data Streams crypto feeds use 8 decimals for price
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
        // Chainlink Data Streams crypto feeds use 8 decimals for price
        uint256 normalized = uint256(uint192(price)) * 1e10;
        if (normalized == 0) revert PriceNormalizedToZero();
        return normalized;
    }
    
    /// @inheritdoc IOracleFacet
    function getXmrEmaPrice() external view returns (uint256) {
        // For now, return spot price. EMA calculation can be added later
        return getXmrPriceWithAge(2 minutes);
    }
    
    /// @inheritdoc IOracleFacet
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        // Chainlink Data Streams verification is currently free on most chains
        // This can be updated if fee structure changes
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
    
    // Note: Constants are inherited from wsXmrStorage as public constants
}
