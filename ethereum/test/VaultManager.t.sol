// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {VaultManager} from "../contracts/VaultManager.sol";
import {MockVerifierProxy} from "../contracts/mocks/MockVerifierProxy.sol";
import {wsXMR} from "../contracts/wsXMR.sol";

contract VaultManagerTest is Test {
    VaultManager public vaultManager;
    MockVerifierProxy public verifier;
    wsXMR public wsxmr;

    bytes32 constant XMR_FEED = 0x00038f3b8f8be4305564abf0ed3c9cc46cb8b4303c35ab54079ea873b7d74b3a;
    bytes32 constant DAI_FEED = 0x0003a9efc56074727bde001b0f0301eef38db844278734c32aa8b72dcb7902ba;

    function setUp() public {
        verifier = new MockVerifierProxy();
        vaultManager = new VaultManager(address(verifier));
        wsxmr = vaultManager.wsxmrToken();
    }

    function test_ConstructorSetsVerifier() public view {
        assertEq(address(vaultManager.verifierProxy()), address(verifier));
    }

    function test_UpdatePricesStoresXmrPrice() public {
        // Set mock price for XMR feed: $160 in 8 decimals
        verifier.setPrice(XMR_FEED, 16000000000);

        // Build a dummy report payload
        bytes memory reportData = abi.encodePacked(uint16(3), XMR_FEED, uint256(0));
        bytes memory payload = abi.encode(bytes32(0), bytes32(0), bytes32(0), reportData);

        bytes[] memory reports = new bytes[](1);
        reports[0] = payload;

        vaultManager.updatePrices(reports);

        assertEq(vaultManager.lastXmrPrice(), 16000000000);
        assertEq(vaultManager.lastXmrPriceTimestamp(), block.timestamp);
    }

    function test_GetXmrPriceAfterUpdate() public {
        verifier.setPrice(XMR_FEED, 16000000000);

        bytes memory reportData = abi.encodePacked(uint16(3), XMR_FEED, uint256(0));
        bytes memory payload = abi.encode(bytes32(0), bytes32(0), bytes32(0), reportData);

        bytes[] memory reports = new bytes[](1);
        reports[0] = payload;

        vaultManager.updatePrices(reports);

        uint256 price = vaultManager.getXmrPrice();
        // 16000000000 * 1e10 = 160000000000000000000 (18 decimals)
        assertEq(price, 160000000000000000000);
    }

    function test_GetXmrPriceRevertsWhenStale() public {
        vm.expectRevert(VaultManager.StalePrice.selector);
        vaultManager.getXmrPrice();
    }
}
