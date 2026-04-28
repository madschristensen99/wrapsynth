// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/**
 * @title MockPyth
 * @notice Mock Pyth oracle for testing
 */
contract MockPyth is IPyth {
    mapping(bytes32 => PythStructs.Price) private prices;
    mapping(bytes32 => PythStructs.Price) private emaPrices;
    
    uint256 public updateFee = 0;
    
    function setPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        prices[id] = PythStructs.Price({
            price: price,
            conf: conf,
            expo: expo,
            publishTime: publishTime
        });
    }
    
    function setEmaPrice(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime) external {
        emaPrices[id] = PythStructs.Price({
            price: price,
            conf: conf,
            expo: expo,
            publishTime: publishTime
        });
    }
    
    function setUpdateFee(uint256 fee) external {
        updateFee = fee;
    }
    
    // IPyth interface implementation
    function getPrice(bytes32 id) external view returns (PythStructs.Price memory) {
        return prices[id];
    }
    
    function getPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory) {
        return prices[id];
    }
    
    function getPriceNoOlderThan(bytes32 id, uint256 age) external view returns (PythStructs.Price memory) {
        PythStructs.Price memory price = prices[id];
        require(price.publishTime > 0, "Price not found");
        require(block.timestamp - price.publishTime <= age, "Price too old");
        return price;
    }
    
    function getEmaPrice(bytes32 id) external view returns (PythStructs.Price memory) {
        return emaPrices[id];
    }
    
    function getEmaPriceUnsafe(bytes32 id) external view returns (PythStructs.Price memory) {
        return emaPrices[id];
    }
    
    function getEmaPriceNoOlderThan(bytes32 id, uint256 age) external view returns (PythStructs.Price memory) {
        PythStructs.Price memory price = emaPrices[id];
        require(price.publishTime > 0, "Price not found");
        require(block.timestamp - price.publishTime <= age, "Price too old");
        return price;
    }
    
    function getUpdateFee(bytes[] calldata) external view returns (uint256) {
        return updateFee;
    }
    
    function updatePriceFeeds(bytes[] calldata) external payable {
        // Mock implementation - does nothing
    }
    
    function updatePriceFeedsIfNecessary(
        bytes[] calldata,
        bytes32[] calldata,
        uint64[] calldata
    ) external payable {
        // Mock implementation
    }
    
    function getValidTimePeriod() external pure returns (uint256) {
        return 60;
    }
    
    function parsePriceFeedUpdates(
        bytes[] calldata,
        bytes32[] calldata,
        uint64,
        uint64
    ) external payable returns (PythStructs.PriceFeed[] memory) {
        return new PythStructs.PriceFeed[](0);
    }
    
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata,
        bytes32[] calldata,
        uint64,
        uint64
    ) external payable returns (PythStructs.PriceFeed[] memory) {
        return new PythStructs.PriceFeed[](0);
    }
}
