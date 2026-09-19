// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MockL1Read
 * @notice Mock for HyperEVM L1-read precompiles (markPx 0x0806, oraclePx 0x0807,
 *         spotPx 0x0808). Deploy once, then vm.etch its runtime code onto each
 *         precompile address in test setUp — each etched address gets its own
 *         storage, so prices are set per-precompile.
 *
 * @dev    The real precompiles take raw abi.encode(uint32 index) calldata (NO
 *         function selector) and return abi.encode(uint64 price). This mock
 *         reproduces that ABI exactly via fallback().
 *
 *         Price convention: perp prices are uint64 scaled by 10^(6 - szDecimals).
 *         XMR perp has szDecimals=3 → raw value = price_usd * 1e3.
 *         (e.g. $581.69 → 581692)
 */
contract MockL1Read {
    /// @notice perp index => raw uint64 price (price * 10^(6-szDecimals))
    mapping(uint32 => uint64) public prices;

    /// @notice Set the price returned for a perp index
    /// @param index Perp index (e.g. 224 for XMR mainnet)
    /// @param price Raw price (price_usd * 10^(6-szDecimals); XMR: *1e3)
    function setPrice(uint32 index, uint64 price) external {
        prices[index] = price;
    }

    /// @dev Reproduce the precompile ABI: calldata = abi.encode(uint32 index),
    ///      returndata = abi.encode(uint64 price). No function selector.
    fallback() external {
        require(msg.data.length == 32, "MockL1Read: bad calldata");
        uint32 index = abi.decode(msg.data, (uint32));
        uint64 price = prices[index];
        bytes memory ret = abi.encode(price);
        assembly {
            return(add(ret, 0x20), mload(ret))
        }
    }
}
