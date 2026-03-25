// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Create2Deployer
 * @notice Simple CREATE2 deployer for vanity addresses
 */
contract Create2Deployer {
    event Deployed(address indexed addr, bytes32 indexed salt);

    /**
     * @notice Deploy a contract using CREATE2
     * @param salt Salt for deterministic address
     * @param bytecode Contract bytecode
     * @return addr Deployed contract address
     */
    function deploy(bytes32 salt, bytes memory bytecode) external returns (address addr) {
        assembly {
            addr := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
            if iszero(extcodesize(addr)) {
                revert(0, 0)
            }
        }
        emit Deployed(addr, salt);
    }

    /**
     * @notice Compute the address for a given salt and bytecode
     * @param salt Salt for deterministic address
     * @param bytecode Contract bytecode
     * @return addr Predicted contract address
     */
    function computeAddress(bytes32 salt, bytes memory bytecode) external view returns (address addr) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                salt,
                keccak256(bytecode)
            )
        );
        addr = address(uint160(uint256(hash)));
    }
}
