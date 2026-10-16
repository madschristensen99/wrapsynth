// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IErrors} from "../IErrors.sol";
import {wsXmrStorage} from "../../core/wsXmrStorage.sol";

/**
 * @title ICoLPFacet
 * @notice Interface for co-LP (co-liquidity-provision) operations
 * @dev Co-LP lives on its own facet to keep VaultFacet under the EIP-170
 *      contract size limit. Selectors are unchanged — the hub routes them
 *      to this facet instead of VaultFacet.
 */
interface ICoLPFacet is IErrors {
    // ========== EVENTS ==========

    event CoLPDeployed(
        address indexed vault,
        address indexed user,
        uint256 indexed tokenId,
        uint256 sDAIShares,
        uint256 wsxmrAmount,
        uint16 rangeBps
    );
    event CoLPUnwound(
        uint256 indexed tokenId,
        address indexed vault,
        address indexed user,
        uint256 daiReturned,
        uint256 wsxmrReturned,
        bool liquidationTriggered
    );
    event CoLPRebalanced(
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        address indexed vault,
        address user,
        address keeper,
        uint16 newRangeBps
    );
    event CoLPRangePreferenceUpdated(address indexed vault, uint16 maxRangeBps);
    event CoLPFeesCollected(uint256 indexed tokenId, uint256 daiFees, uint256 wsxmrFees);

    // ========== CO-LP OPERATIONS ==========

    /// @notice Set the LP's preferred max range width for co-LP positions
    /// @param newMaxBps Range width in basis points (1000-10000)
    function setMaxCoLPRange(uint16 newMaxBps) external;

    /// @notice User opens a co-LP position by pairing wsXMR against an LP vault's idle collateral
    /// @param lpVault LP vault address
    /// @param wsxmrAmount Amount of wsXMR to contribute
    /// @param deadline Transaction deadline
    /// @return tokenId V3 NFT token ID
    function userOpenCoLP(
        address lpVault,
        uint256 wsxmrAmount,
        uint256 deadline
    ) external returns (uint256 tokenId);

    /// @notice Collect accumulated fees from a co-LP position
    /// @param tokenId V3 NFT token ID
    function collectCoLPFees(uint256 tokenId) external;

    /// @notice Either LP or user closes a co-LP position
    /// @param tokenId V3 NFT token ID
    /// @param deadline Transaction deadline
    function unwindCoLP(uint256 tokenId, uint256 deadline) external;

    /// @notice Keeper-callable rebalance when a position goes out of range
    /// @param tokenId V3 NFT token ID
    /// @param newRangeBps New range width in basis points
    /// @param deadline Transaction deadline
    function rebalanceCoLP(uint256 tokenId, uint16 newRangeBps, uint256 deadline) external;

    /// @notice Get max wsXMR a vault can accept for co-LP
    /// @param lpVault LP vault address
    /// @return maxWsxmrAcceptable Maximum wsXMR the vault can pair
    function getCoLPCapacity(address lpVault) external view returns (uint256 maxWsxmrAcceptable);

    /// @notice Get position metadata for a co-LP position
    /// @param tokenId V3 NFT token ID
    function getPositionMetadata(uint256 tokenId) external view returns (wsXmrStorage.PositionMetadata memory);

    /// @notice Get the live co-LP position token IDs for a user
    /// @param user User address
    function getUserPositions(address user) external view returns (uint256[] memory);
}
