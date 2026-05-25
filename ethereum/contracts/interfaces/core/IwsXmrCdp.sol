// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IVaultFacet} from "../facets/IVaultFacet.sol";
import {IMintFacet} from "../facets/IMintFacet.sol";
import {IBurnFacet} from "../facets/IBurnFacet.sol";
import {ILiquidationFacet} from "../facets/ILiquidationFacet.sol";
import {IYieldFacet} from "../facets/IYieldFacet.sol";
import {IOracleFacet} from "../facets/IOracleFacet.sol";

/**
 * @title IwsXmrCdp
 * @notice Aggregate interface for the complete CDP system
 * @dev Combines all facet interfaces for convenience
 * 
 * This interface represents the full CDP functionality when interacting
 * with the system through a router or aggregator contract.
 */
interface IwsXmrCdp is
    IVaultFacet,
    IMintFacet,
    IBurnFacet,
    ILiquidationFacet,
    IYieldFacet,
    IOracleFacet
{
    // ========== SYSTEM CONSTANTS ==========
    
    /// @notice Required collateral ratio (150%)
    function COLLATERAL_RATIO() external pure returns (uint256);
    
    /// @notice Precision for ratio calculations
    function RATIO_PRECISION() external pure returns (uint256);
    
    /// @notice Basis points denominator
    function BPS_DENOMINATOR() external pure returns (uint256);
    
    // ========== SYSTEM STATE ==========
    
    /// @notice Total wsXMR debt across all vaults
    function globalTotalDebt() external view returns (uint256);
    
    /// @notice Global debt index for proportional debt reduction
    function globalDebtIndex() external view returns (uint256);
    
    /// @notice Total bad debt from liquidations
    function globalBadDebt() external view returns (uint256);
    
    /// @notice Debt locked in pending burn requests
    function globalPendingBurnDebt() external view returns (uint256);
}
