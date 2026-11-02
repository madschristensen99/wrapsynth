// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IErrors} from "../IErrors.sol";

/**
 * @title ILiquidationAuctionFacet
 * @notice Interface for the bonded-kick Dutch haircut liquidation auction.
 * @dev Oracle-free replacement for the old oracle-triggered liquidation path.
 *      No price input anywhere — the auction discovers the settlement haircut.
 */
interface ILiquidationAuctionFacet is IErrors {
    // ========== EVENTS ==========

    event KickStarted(address indexed vault, address indexed kicker, uint256 bond, uint256 auctionEnd);
    event ReauctionStarted(address indexed vault, address indexed kicker, uint256 bond, uint256 auctionEnd);
    event AuctionOpened(address indexed vault, uint256 offeredCollateral);
    event AuctionSettled(
        address indexed vault,
        address indexed bidder,
        uint256 debtCleared,
        uint256 clearingXBps,
        uint256 bidderCollateral,
        uint256 kickerPayout,
        bool wrongfulKick
    );
    event VaultFrozen(address indexed vault);
    event VaultBackstopped(
        address indexed oldVault,
        address indexed newVault,
        uint256 debtAssumed,
        uint256 collateralAbsorbed
    );

    // ========== KICK LIFECYCLE ==========

    /// @notice Kick a vault — post a bond and open the grace window.
    function kick(address lpVault) external;

    /// @notice Retry liquidation on a frozen vault — once per vault.
    function reauction(address lpVault) external;

    /// @notice Transition a kicked vault from grace into the auction.
    function openAuction(address lpVault) external;

    /// @notice Bid on an active auction — pay full debt, receive X(t)% of offered collateral.
    function bid(address lpVault) external;

    /// @notice Resolve a no-bid auction — freeze the vault, return the bond.
    function resolveKick(address lpVault) external;

    /// @notice Backstop a frozen vault — a healthy LP assumes debt + collateral.
    function backstopVault(address oldVault) external;

    // ========== VIEWS ==========

    /// @notice Current auction state for a vault.
    function auctionState(address lpVault)
        external
        view
        returns (
            bool active,
            uint8 phase,
            uint256 xBps,
            uint256 offeredCollateral,
            uint256 bond,
            address kicker,
            uint256 auctionEnd,
            bool frozen
        );

    /// @notice Bond required to kick a vault right now (normalized units).
    function getKickBond(address lpVault) external view returns (uint256);
}
