// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/**
 * @title PythPriceConsumer
 * @notice Basic Pyth oracle integration for Gnosis Chain
 * @dev Consumes price feeds from Pyth Network
 */
contract PythPriceConsumer {
    IPyth public pyth;
    
    // Price feed IDs for common assets on Gnosis Chain
    // XMR/USD price feed ID
    bytes32 public constant XMR_USD_PRICE_ID = 0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d;
    // ETH/USD price feed ID
    bytes32 public constant ETH_USD_PRICE_ID = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    // BTC/USD price feed ID
    bytes32 public constant BTC_USD_PRICE_ID = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    
    event PriceUpdated(bytes32 indexed priceId, int64 price, uint64 conf, int32 expo, uint256 timestamp);
    
    /**
     * @notice Constructor
     * @param _pythContract Address of the Pyth contract on Gnosis Chain
     * Gnosis Chain Pyth contract: 0x2880aB155794e7179c9eE2e38200202908C17B43
     */
    constructor(address _pythContract) {
        pyth = IPyth(_pythContract);
    }
    
    /**
     * @notice Get the latest XMR/USD price
     * @return price The price with the expo applied
     * @return expo The price exponent
     * @return timestamp The timestamp of the price
     */
    function getXMRPrice() external view returns (int64 price, int32 expo, uint256 timestamp) {
        PythStructs.Price memory priceData = pyth.getPriceUnsafe(XMR_USD_PRICE_ID);
        return (priceData.price, priceData.expo, priceData.publishTime);
    }
    
    /**
     * @notice Get the latest ETH/USD price
     * @return price The price with the expo applied
     * @return expo The price exponent
     * @return timestamp The timestamp of the price
     */
    function getETHPrice() external view returns (int64 price, int32 expo, uint256 timestamp) {
        PythStructs.Price memory priceData = pyth.getPriceUnsafe(ETH_USD_PRICE_ID);
        return (priceData.price, priceData.expo, priceData.publishTime);
    }
    
    /**
     * @notice Get the latest BTC/USD price
     * @return price The price with the expo applied
     * @return expo The price exponent
     * @return timestamp The timestamp of the price
     */
    function getBTCPrice() external view returns (int64 price, int32 expo, uint256 timestamp) {
        PythStructs.Price memory priceData = pyth.getPriceUnsafe(BTC_USD_PRICE_ID);
        return (priceData.price, priceData.expo, priceData.publishTime);
    }
    
    /**
     * @notice Get price with confidence interval
     * @param priceId The Pyth price feed ID
     * @return price The price
     * @return conf The confidence interval
     * @return expo The price exponent
     * @return timestamp The timestamp of the price
     */
    function getPriceWithConfidence(bytes32 priceId) 
        external 
        view 
        returns (int64 price, uint64 conf, int32 expo, uint256 timestamp) 
    {
        PythStructs.Price memory priceData = pyth.getPriceUnsafe(priceId);
        return (priceData.price, priceData.conf, priceData.expo, priceData.publishTime);
    }
    
    /**
     * @notice Update price feeds with Pyth price update data
     * @param priceUpdateData The encoded price update data from Pyth
     */
    function updatePriceFeeds(bytes[] calldata priceUpdateData) external payable {
        // Get the update fee
        uint256 fee = pyth.getUpdateFee(priceUpdateData);
        require(msg.value >= fee, "Insufficient fee");
        
        // Update the price feeds
        pyth.updatePriceFeeds{value: fee}(priceUpdateData);
        
        // Refund excess payment
        if (msg.value > fee) {
            payable(msg.sender).transfer(msg.value - fee);
        }
    }
    
    /**
     * @notice Get the fee required to update price feeds
     * @param priceUpdateData The encoded price update data
     * @return fee The required fee in wei
     */
    function getUpdateFee(bytes[] calldata priceUpdateData) external view returns (uint256 fee) {
        return pyth.getUpdateFee(priceUpdateData);
    }
    
    /**
     * @notice Calculate USD value from price data
     * @param amount The amount in the asset's base units
     * @param price The price from Pyth
     * @param expo The price exponent from Pyth
     * @return usdValue The USD value (scaled by 1e8)
     */
    function calculateUSDValue(uint256 amount, int64 price, int32 expo) 
        public 
        pure 
        returns (uint256 usdValue) 
    {
        require(price > 0, "Invalid price");
        
        // Convert price to positive and handle exponent
        uint256 positivePrice = uint256(uint64(price));
        
        if (expo >= 0) {
            // Positive exponent: multiply
            usdValue = (amount * positivePrice * (10 ** uint32(expo))) / 1e12; // Assuming 12 decimals for XMR
        } else {
            // Negative exponent: divide
            usdValue = (amount * positivePrice) / (10 ** uint32(-expo)) / 1e12;
        }
        
        return usdValue;
    }
}
