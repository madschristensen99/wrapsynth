// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IwsXMR} from "./interfaces/core/IwsXMR.sol";

/**
 * @title wsXMR - Wrapped Monero
 * @notice Immutable ERC-20 token representing wrapped XMR.
 * @dev Deployed exclusively by the wsXmrHub. No admin keys exist.
 */
contract wsXMR is ERC20, ERC20Permit, IwsXMR {
    address public hub;
    address private immutable _deployer;

    constructor() ERC20("Wrapsynth Monero", "wsXMR") ERC20Permit("Wrapsynth Monero") {
        _deployer = msg.sender;
    }

    function setHub(address _hub) external {
        require(msg.sender == _deployer, "Only deployer");
        require(hub == address(0), "Hub already set");
        require(_hub != address(0), "Zero address");
        hub = _hub;
    }

    function mint(address _to, uint256 _amount) external {
        if (msg.sender != hub) revert OnlyHub();
        _mint(_to, _amount);
    }

    /**
     * @notice Admin burn - only callable by Hub
     * @dev This is NOT related to ERC20Permit. The permit extension enables
     *      gasless ERC-20 approve() via signatures. This burn() is an admin function.
     * @param _from Address to burn from
     * @param _amount Amount to burn
     */
    function burn(address _from, uint256 _amount) external {
        if (msg.sender != hub) revert OnlyHub();
        _burn(_from, _amount);
    }

    function decimals() public pure override(ERC20, IwsXMR) returns (uint8) {
        return 8; 
    }

    function nonces(address owner) public view override(ERC20Permit, IERC20Permit) returns (uint256) {
        return super.nonces(owner);
    }
}
