// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/**
 * @title MockPyth
 * @notice Mock Pyth oracle for testing purposes
 */
contract MockPyth is IPyth {
    mapping(bytes32 => PythStructs.Price) private prices;
    
    function setPrice(bytes32 id, int64 price, int32 expo) external {
        prices[id] = PythStructs.Price({
            price: price,
            conf: uint64(uint256(int256(price)) / 100), // 1% confidence interval
            expo: expo,
            publishTime: block.timestamp
        });
    }
    
    function getPrice(bytes32 id) external view returns (PythStructs.Price memory) {
        return prices[id];
    }
    
    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory) {
        return prices[id];
    }
    
    function getPriceNoOlderThan(bytes32 id, uint age) external view returns (PythStructs.Price memory) {
        PythStructs.Price memory price = prices[id];
        require(block.timestamp - price.publishTime <= age, "Price too old");
        return price;
    }
    
    function getUpdateFee(bytes[] calldata updateData) external pure returns (uint feeAmount) {
        return updateData.length > 0 ? 1 wei : 0;
    }
    
    function updatePriceFeeds(bytes[] calldata updateData) external payable {
        // Mock implementation - does nothing
    }
    
    function updatePriceFeedsIfNecessary(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64[] calldata publishTimes
    ) external payable {
        // Mock implementation - does nothing
    }
    
    function getEmaPrice(bytes32 id) external view returns (PythStructs.Price memory) {
        return prices[id];
    }
    
    function getEmaPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory) {
        return prices[id];
    }
    
    function getEmaPriceNoOlderThan(bytes32 id, uint age) external view returns (PythStructs.Price memory) {
        PythStructs.Price memory price = prices[id];
        require(block.timestamp - price.publishTime <= age, "Price too old");
        return price;
    }
    
    function getValidTimePeriod() external pure returns (uint) {
        return 60;
    }
    
    function parsePriceFeedUpdates(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory) {
        PythStructs.PriceFeed[] memory feeds = new PythStructs.PriceFeed[](priceIds.length);
        for (uint i = 0; i < priceIds.length; i++) {
            feeds[i] = PythStructs.PriceFeed({
                id: priceIds[i],
                price: prices[priceIds[i]],
                emaPrice: prices[priceIds[i]]
            });
        }
        return feeds;
    }
    
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory) {
        return this.parsePriceFeedUpdates(updateData, priceIds, minPublishTime, maxPublishTime);
    }
}
