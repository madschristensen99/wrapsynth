// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/Ed25519.sol";

contract Ed25519TestHelper {
    function testIsOnCurve(uint256 x, uint256 y) external pure returns (bool) {
        return Ed25519.isOnCurve(x, y);
    }
    
    function testSubmod(uint256 a, uint256 b, uint256 m) external pure returns (uint256) {
        return Ed25519.submod(a, b, m);
    }
}
