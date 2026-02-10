// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockWstETH
 * @notice Mock wstETH for testnet that accepts ETH deposits
 * @dev Simplified version for testing - 1:1 ETH to wstETH conversion
 */
contract MockWstETH is ERC20 {
    
    event Deposited(address indexed user, uint256 ethAmount, uint256 wstETHAmount);
    event Withdrawn(address indexed user, uint256 wstETHAmount, uint256 ethAmount);
    
    constructor() ERC20("Wrapped Staked ETH", "wstETH") {}
    
    /**
     * @notice Deposit ETH and receive wstETH (1:1 for simplicity)
     */
    receive() external payable {
        require(msg.value > 0, "Zero deposit");
        _mint(msg.sender, msg.value);
        emit Deposited(msg.sender, msg.value, msg.value);
    }
    
    /**
     * @notice Deposit ETH and receive wstETH
     */
    function deposit() external payable {
        require(msg.value > 0, "Zero deposit");
        _mint(msg.sender, msg.value);
        emit Deposited(msg.sender, msg.value, msg.value);
    }
    
    /**
     * @notice Withdraw ETH by burning wstETH
     */
    function withdraw(uint256 wstETHAmount) external {
        require(wstETHAmount > 0, "Zero amount");
        require(balanceOf(msg.sender) >= wstETHAmount, "Insufficient balance");
        
        _burn(msg.sender, wstETHAmount);
        
        (bool success, ) = msg.sender.call{value: wstETHAmount}("");
        require(success, "ETH transfer failed");
        
        emit Withdrawn(msg.sender, wstETHAmount, wstETHAmount);
    }
    
    /**
     * @notice Get wstETH amount for ETH (1:1 in mock)
     */
    function getWstETHByStETH(uint256 stETHAmount) external pure returns (uint256) {
        return stETHAmount;
    }
    
    /**
     * @notice Get ETH amount for wstETH (1:1 in mock)
     */
    function getStETHByWstETH(uint256 wstETHAmount) external pure returns (uint256) {
        return wstETHAmount;
    }
}
