// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IErrors} from "../IErrors.sol";
import {wsXmrStorage} from "../../core/wsXmrStorage.sol";

/**
 * @title IVaultFacet
 * @notice Interface for vault management operations
 * @dev Handles vault creation, collateral, and configuration
 */
interface IVaultFacet is IErrors {
    // ========== EVENTS ==========
    
    event VaultCreated(address indexed lpAddress);
    event CollateralDeposited(address indexed lpAddress, uint256 underlyingAmount, uint256 shares);
    event CollateralWithdrawn(address indexed lpAddress, uint256 underlyingAmount, uint256 shares);
    event MintGriefingDepositUpdated(address indexed lpVault, uint256 newDeposit);
    event MintReadyBondUpdated(address indexed lpVault, uint256 newBond);
    event VaultMarketMetricsUpdated(address indexed lpVault, uint16 mintFeeBps, uint16 burnRewardBps);
    event MaxMintBpsUpdated(address indexed lpVault, uint16 newMaxMintBps);
    event MinBurnAmountUpdated(address indexed lpVault, uint256 newMinBurnAmount);
    event MintTimeoutBlocksUpdated(address indexed lpVault, uint256 newBlocks);
    event BurnTimeoutBlocksUpdated(address indexed lpVault, uint256 newBlocks);
    event MinterWhitelistUpdated(address indexed lpVault, address indexed minter, bool whitelisted);
    // Note: ReturnQueued event is defined in wsXmrStorage
    event ReturnsWithdrawn(address indexed recipient, address indexed token, uint256 amount);
    
    // ========== ERRORS ==========
    
    error VaultAlreadyExists();
    error MaxVaultsReached();
    error ExceedsMaxMargin();
    error ETHTransferFailed();
    
    // ========== VAULT LIFECYCLE ==========
    
    /// @notice Create a new LP vault
    function createVault() external;
    
    /// @notice Deactivate vault (LP can reactivate by depositing)
    function deactivateVault() external;
    
    // ========== COLLATERAL MANAGEMENT ==========
    
    /// @notice Deposit native token (auto-converts to yield-bearing)
    /// @param amount Amount of native token to deposit
    function depositCollateral(uint256 amount) external;
    
    /// @notice Deposit yield-bearing shares directly
    /// @param shares Amount of shares to deposit
    function depositShares(uint256 shares) external;
    
    /// @notice Withdraw collateral (if health ratio allows)
    /// @param shares Amount of shares to withdraw
    function withdrawCollateral(uint256 shares) external;
    
    // ========== VAULT CONFIGURATION ==========
    
    /// @notice Set griefing deposit required for mint requests
    /// @param deposit ETH amount required (0 to disable)
    function setMintGriefingDeposit(uint256 deposit) external;
    
    /// @notice Set mint fees and burn rewards
    /// @param mintFeeBps Fee charged for minting (basis points, max 1000)
    /// @param burnRewardBps Reward paid for burning (basis points, max 1000)
    function setVaultMarketMetrics(uint16 mintFeeBps, uint16 burnRewardBps) external;
    
    /// @notice Set maximum single mint size
    /// @param maxMintBps Max mint as percentage of capacity (basis points)
    function setMaxMintBps(uint16 maxMintBps) external;
    
    /// @notice Set minimum burn amount
    /// @param minAmount Minimum wsXMR for burn requests (0 = global default)
    function setMinBurnAmount(uint256 minAmount) external;
    
    /// @notice Set mint timeout in blocks (360-17280, ~30 min to ~24 hours)
    /// @param blocks Number of blocks until mint request can be cancelled
    function setMintTimeoutBlocks(uint256 blocks) external;
    
    /// @notice Set burn timeout in blocks (360-17280, ~30 min to ~24 hours)
    /// @param blocks Number of blocks until burn request can be cancelled
    function setBurnTimeoutBlocks(uint256 blocks) external;
    
    /// @notice Whitelist a minter to bypass griefing deposit requirement
    /// @param minter Address to whitelist
    /// @param whitelisted True to whitelist, false to remove
    function setMinterWhitelist(address minter, bool whitelisted) external;
    
    /// @notice Batch whitelist multiple minters
    /// @param minters Array of addresses to whitelist
    /// @param whitelisted True to whitelist all, false to remove all
    function batchSetMinterWhitelist(address[] calldata minters, bool whitelisted) external;
    
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
    
    // ========== PENDING RETURNS ==========
    
    /// @notice Withdraw queued returns (pull pattern)
    /// @param token Token address (address(0) for ETH)
    function withdrawReturns(address token) external;
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @notice Get vault details
    function getVault(address lpAddress) external view returns (wsXmrStorage.Vault memory);
    
    /// @notice Get vault health ratio
    /// @return ratio Collateral ratio (150 = 150%)
    function getVaultHealth(address lpAddress) external view returns (uint256 ratio);
    
    /// @notice Get vault's actual debt (after applying debt index)
    function getVaultDebt(address lpAddress) external view returns (uint256);
    
    /// @notice Get total number of vaults
    function getVaultCount() external view returns (uint256);
    
    /// @notice Get vault address by index
    function getVaultAtIndex(uint256 index) external view returns (address);
    
    /// @notice Get pending returns for user
    function getPendingReturns(address user, address token) external view returns (uint256);
    
    /// @notice Check if address has an active vault
    function hasActiveVault(address lpAddress) external view returns (bool);
    
    /// @notice Check if a minter is whitelisted for a vault
    function isMinterWhitelisted(address vault, address minter) external view returns (bool);
    
    /// @notice Calculate collateral ratio for given amounts
    function calculateCollateralRatio(
        uint256 collateralAmount,
        uint256 debtAmount
    ) external view returns (uint256);
}
