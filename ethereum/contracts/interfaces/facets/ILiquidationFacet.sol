// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

/**
 * @title ILiquidationFacet
 * @notice Facet implementation for handling liquidations.
 * @dev Contains logic to identify and initiate liquidation procedures.
 */
interface ILiquidationFacet {
    // For now, it only needs the signature that was used in the spec example:
    function getLiquidatableVaults(uint256 start, uint256 limit) external view returns (address[] memory vaults, uint256[] memory debts);

    // A placeholder for the core liquidation function derived from the spec usage.
    function liquidate(address vault, uint256 debtAmount) external;
}