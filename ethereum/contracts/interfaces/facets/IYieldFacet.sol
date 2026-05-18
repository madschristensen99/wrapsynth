// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

/**
 * @title IYieldFacet
 * @notice Interface for yield harvesting and buy-and-burn operations
 */
interface IYieldFacet {
    // ========== EVENTS ==========
    
    event YieldHarvested(address indexed lpVault, uint256 yieldShares);
    event BuyAndBurnExecuted(
        uint256 sDAISpent,
        uint256 wsxmrBurned,
        uint256 keeperReward,
        uint256 newGlobalDebtIndex
    );
    
    // ========== ERRORS ==========
    
    error InvalidPoolFeeTier();
    error CooldownActive();
    error XMRNotDipped();
    error WarChestEmpty();
    error InvalidSpotPrice();
    error InvalidEMAPrice();
    error PriceExponentMismatch();
    
    // ========== CONSTANTS ==========
    // Note: Constants are defined in wsXmrStorage:
    // - COOLDOWN_PERIOD
    // - BUY_CHUNK_PERCENT
    // - EMA_TRIGGER_THRESHOLD
    // - KEEPER_REWARD_BPS
    
    // ========== FUNCTIONS ==========
    
    /// @notice Execute buy-and-burn when conditions are met
    /// @param poolFeeTier DEX pool fee tier to use
    function triggerBuyAndBurn(uint24 poolFeeTier) external;
    
    /// @notice Manually sync vault yield (usually automatic)
    /// @param lpVault Vault to sync
    function syncVaultYield(address lpVault) external;
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @notice Get current yield war chest balance
    function getYieldWarChest() external view returns (uint256);
    
    /// @notice Get last buy-and-burn timestamp
    function getLastBuyTimestamp() external view returns (uint256);
    
    /// @notice Check if buy-and-burn can be triggered
    function canTriggerBuyAndBurn() external view returns (bool possible, string memory reason);
    
    /// @notice Get vault's extractable yield
    function getVaultExtractableYield(address lpVault) external view returns (uint256);
    
    /// @notice Check if pool fee tier is allowed
    function isPoolFeeTierAllowed(uint24 tier) external view returns (bool);
}
