// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IVaultFacet} from "../interfaces/facets/IVaultFacet.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";
import {ISavingsDAI} from "../interfaces/external/ISavingsDAI.sol";
import {GnosisAddresses} from "../GnosisAddresses.sol";
import {CollateralLogic} from "../libraries/CollateralLogic.sol";
import {YieldLogic} from "../libraries/YieldLogic.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IwsXmrLiquidityRouter} from "../interfaces/router/IwsXmrLiquidityRouter.sol";

/**
 * @title VaultFacet
 * @notice Handles vault management operations for the wsXMR system
 * @dev Manages LP _vaults, collateral deposits/withdrawals, and configuration
 */
contract VaultFacet is wsXmrStorage, IVaultFacet {
    using SafeERC20 for IERC20;
    
    // ========== ERRORS ==========
    
    error InvalidConfig();
    error InvalidRange();
    error PositionNotFound();
    error PositionInRange();
    error UnbalancedPair();
    error DeploymentTooAggressive();
    error InsufficientLPBuffer();
    
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
    
    // ========== CONSTRUCTOR ==========
    
    constructor(address _wsxmrToken, address _verifierProxy) 
        wsXmrStorage(_wsxmrToken, _verifierProxy) 
    {}
    
    // ========== MODIFIERS ==========
    
    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "ReentrancyGuard");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    // ========== VAULT LIFECYCLE ==========
    
    /// @inheritdoc IVaultFacet
    function createVault() external {
        if (_vaults[msg.sender].active) revert VaultAlreadyExists();
        if (vaultList.length >= MAX_VAULT_COUNT) revert MaxVaultsReached();
        
        _vaults[msg.sender] = Vault({
            lpAddress: msg.sender,
            collateralShares: 0,
            lockedCollateral: 0,
            normalizedDebt: 0,
            pendingDebt: 0,
            maxMintBps: 0,
            mintGriefingDeposit: 0,
            mintReadyBond: 0,
            mintFeeBps: 0,
            burnRewardBps: 0,
            liquidationNonce: 0,
            mintNonce: 0,
            minBurnAmount: 0,
            active: true,
            deployedSDAIShares: 0,
            maxCoLPRangeBps: uint16(DEFAULT_COLP_RANGE_BPS),
            mintTimeoutBlocks: DEFAULT_MINT_TIMEOUT_BLOCKS,
            burnTimeoutBlocks: DEFAULT_BURN_TIMEOUT_BLOCKS
        });
        
        vaultList.push(msg.sender);
        emit VaultCreated(msg.sender);
    }
    
    /// @inheritdoc IVaultFacet
    function deactivateVault() external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        _vaults[msg.sender].active = false;
    }
    
    // ========== COLLATERAL MANAGEMENT ==========
    
    /// @inheritdoc IVaultFacet
    function depositCollateral(uint256 amount) external nonReentrant {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (amount == 0) revert ZeroAmount();
        
        Vault storage vault = _vaults[msg.sender];
        
        // Transfer xDAI from user
        IERC20(GnosisAddresses.XDAI).safeTransferFrom(msg.sender, address(this), amount);
        
        // Approve and deposit to sDAI
        IERC20(GnosisAddresses.XDAI).forceApprove(GnosisAddresses.SDAI, amount);
        uint256 sDAIShares = ISavingsDAI(GnosisAddresses.SDAI).deposit(amount, address(this));
        
        _syncVaultYield(msg.sender);
        
        vault.collateralShares += sDAIShares;
        lpPrincipalDeposits[msg.sender] += amount;
        globalLpPrincipal += amount;
        lpPrincipalShares[msg.sender] += sDAIShares;
        globalLpPrincipalShares += sDAIShares;
        
        emit CollateralDeposited(msg.sender, amount, sDAIShares);
    }
    
    /// @inheritdoc IVaultFacet
    function depositShares(uint256 shares) external nonReentrant {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (shares == 0) revert ZeroAmount();
        
        Vault storage vault = _vaults[msg.sender];
        
        // Transfer sDAI shares directly from user
        IERC20(GnosisAddresses.SDAI).safeTransferFrom(msg.sender, address(this), shares);
        
        // Convert shares to underlying DAI value for principal tracking
        uint256 daiValue = ISavingsDAI(GnosisAddresses.SDAI).convertToAssets(shares);
        
        _syncVaultYield(msg.sender);
        
        vault.collateralShares += shares;
        lpPrincipalDeposits[msg.sender] += daiValue;
        globalLpPrincipal += daiValue;
        lpPrincipalShares[msg.sender] += shares;
        globalLpPrincipalShares += shares;
        
        emit CollateralDeposited(msg.sender, daiValue, shares);
    }
    
    /// @inheritdoc IVaultFacet
    function withdrawCollateral(uint256 shares) external nonReentrant {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (shares == 0) revert ZeroAmount();
        
        Vault storage vault = _vaults[msg.sender];
        
        // Sync yield FIRST
        _syncVaultYield(msg.sender);
        
        uint256 collateralAfterSync = vault.collateralShares;
        
        // Cannot withdraw locked collateral
        uint256 availableCollateral = vault.collateralShares - vault.lockedCollateral;
        if (availableCollateral < shares) revert InsufficientCollateral();
        
        // Check health ratio
        uint256 newCollateralAmount = vault.collateralShares - shares;
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        uint256 totalObligations = actualDebt + vault.pendingDebt;
        
        if (totalObligations > 0) {
            uint256 availableForDebt = newCollateralAmount > vault.lockedCollateral 
                ? newCollateralAmount - vault.lockedCollateral 
                : 0;
            
            uint256 ratio;
            if (vault.deployedSDAIShares > 0) {
                uint256 xmrPrice = _getXmrPriceFromStorage();
                uint256 collateralPrice = _getCollateralPriceFromStorage();
                (uint256 positionDAI, uint256 positionWsxmr) = 
                    _getVaultPositionTotalsAtOracle(msg.sender, xmrPrice);
                ratio = CollateralLogic.calculateVaultCRWithDeployment(
                    availableForDebt,
                    positionDAI,
                    positionWsxmr,
                    totalObligations,
                    GnosisAddresses.SDAI,
                    collateralPrice,
                    xmrPrice
                );
            } else {
                ratio = _calculateCollateralRatio(availableForDebt, totalObligations);
            }
            
            if (ratio < COLLATERAL_RATIO) revert InsufficientCollateral();
        }
        
        vault.collateralShares -= shares;
        
        uint256 daiReceived = ISavingsDAI(GnosisAddresses.SDAI).redeem(shares, msg.sender, address(this));
        
        // Deduct principal proportionally
        uint256 withdrawalProportion = (shares * 1e18) / collateralAfterSync;
        uint256 principalToDeduct = (lpPrincipalDeposits[msg.sender] * withdrawalProportion) / 1e18;
        if (principalToDeduct > lpPrincipalDeposits[msg.sender]) {
            principalToDeduct = lpPrincipalDeposits[msg.sender];
        }
        lpPrincipalDeposits[msg.sender] -= principalToDeduct;
        if (principalToDeduct > globalLpPrincipal) {
            principalToDeduct = globalLpPrincipal;
        }
        globalLpPrincipal -= principalToDeduct;
        
        uint256 sharesToDeduct = (lpPrincipalShares[msg.sender] * withdrawalProportion) / 1e18;
        if (sharesToDeduct > lpPrincipalShares[msg.sender]) {
            sharesToDeduct = lpPrincipalShares[msg.sender];
        }
        lpPrincipalShares[msg.sender] -= sharesToDeduct;
        if (sharesToDeduct > globalLpPrincipalShares) {
            sharesToDeduct = globalLpPrincipalShares;
        }
        globalLpPrincipalShares -= sharesToDeduct;
        
        emit CollateralWithdrawn(msg.sender, daiReceived, shares);
    }
    
    // ========== VAULT CONFIGURATION ==========
    
    /// @inheritdoc IVaultFacet
    function setMintGriefingDeposit(uint256 deposit) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        _vaults[msg.sender].mintGriefingDeposit = deposit;
        emit MintGriefingDepositUpdated(msg.sender, deposit);
    }
    
    /// @notice Set LP bond required when calling setMintReady
    /// @param bond Amount of native token LP must post when marking mint ready
    function setMintReadyBond(uint256 bond) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        _vaults[msg.sender].mintReadyBond = bond;
        emit MintReadyBondUpdated(msg.sender, bond);
    }
    
    /// @inheritdoc IVaultFacet
    function setVaultMarketMetrics(uint16 mintFeeBps, uint16 burnRewardBps) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (mintFeeBps > MAX_MARGIN_BPS || burnRewardBps > MAX_MARGIN_BPS) revert ExceedsMaxMargin();
        
        _vaults[msg.sender].mintFeeBps = mintFeeBps;
        _vaults[msg.sender].burnRewardBps = burnRewardBps;
        emit VaultMarketMetricsUpdated(msg.sender, mintFeeBps, burnRewardBps);
    }
    
    /// @inheritdoc IVaultFacet
    function setMaxMintBps(uint16 maxMintBps) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (maxMintBps > BPS_DENOMINATOR) revert InvalidValue();
        _vaults[msg.sender].maxMintBps = maxMintBps;
        emit MaxMintBpsUpdated(msg.sender, maxMintBps);
    }
    
    /// @inheritdoc IVaultFacet
    function setMinBurnAmount(uint256 minAmount) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        _vaults[msg.sender].minBurnAmount = minAmount;
        emit MinBurnAmountUpdated(msg.sender, minAmount);
    }
    
    /// @notice Whitelist a minter to bypass griefing deposit requirement
    /// @param minter Address to whitelist
    /// @param whitelisted True to whitelist, false to remove
    function setMinterWhitelist(address minter, bool whitelisted) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (minter == address(0)) revert ZeroAddress();
        whitelistedMinters[msg.sender][minter] = whitelisted;
        emit MinterWhitelistUpdated(msg.sender, minter, whitelisted);
    }
    
    /// @notice Batch whitelist multiple minters
    /// @param minters Array of addresses to whitelist
    /// @param whitelisted True to whitelist all, false to remove all
    function batchSetMinterWhitelist(address[] calldata minters, bool whitelisted) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        for (uint256 i = 0; i < minters.length; i++) {
            if (minters[i] == address(0)) revert ZeroAddress();
            whitelistedMinters[msg.sender][minters[i]] = whitelisted;
            emit MinterWhitelistUpdated(msg.sender, minters[i], whitelisted);
        }
    }
    
    /// @inheritdoc IVaultFacet
    function setMintTimeoutBlocks(uint256 blocks) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (blocks < MIN_MINT_TIMEOUT_BLOCKS || blocks > MAX_MINT_TIMEOUT_BLOCKS) revert InvalidConfig();
        _vaults[msg.sender].mintTimeoutBlocks = blocks;
        emit MintTimeoutBlocksUpdated(msg.sender, blocks);
    }
    
    /// @inheritdoc IVaultFacet
    function setBurnTimeoutBlocks(uint256 blocks) external {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (blocks < MIN_BURN_TIMEOUT_BLOCKS || blocks > MAX_BURN_TIMEOUT_BLOCKS) revert InvalidConfig();
        _vaults[msg.sender].burnTimeoutBlocks = blocks;
        emit BurnTimeoutBlocksUpdated(msg.sender, blocks);
    }
    
    // ========== CO-LP OPERATIONS ==========
    
    /// @notice Set the LP's preferred max range width for co-LP positions
    function setMaxCoLPRange(uint16 newMaxBps) external nonReentrant {
        if (!_vaults[msg.sender].active) revert VaultDoesNotExist();
        if (newMaxBps < MIN_COLP_RANGE_BPS || newMaxBps > MAX_COLP_RANGE_BPS) {
            revert InvalidConfig();
        }
        _vaults[msg.sender].maxCoLPRangeBps = newMaxBps;
        emit CoLPRangePreferenceUpdated(msg.sender, newMaxBps);
    }
    
    /// @notice User opens a co-LP position by pairing their wsXMR against an LP vault's idle collateral
    function userOpenCoLP(
        address lpVault,
        uint256 wsxmrAmount,
        uint256 deadline
    ) external nonReentrant returns (uint256 tokenId) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (!_vaults[lpVault].active) revert VaultDoesNotExist();
        if (wsxmrAmount == 0) revert ZeroAmount();
        
        Vault storage vault = _vaults[lpVault];
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        
        uint256 wsxmrUsd = (wsxmrAmount * xmrPrice) / WSXMR_DECIMALS;
        uint256 daiNeeded = (wsxmrUsd * 1e18) / collateralPrice;
        uint256 sharesNeeded = IERC4626(GnosisAddresses.SDAI).convertToShares(daiNeeded);
        
        uint256 availableIdle = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        if (availableIdle < sharesNeeded) revert InsufficientLPBuffer();
        
        IERC20(wsxmrToken).safeTransferFrom(msg.sender, address(this), wsxmrAmount);
        
        vault.collateralShares -= sharesNeeded;
        
        uint16 rangeBps = vault.maxCoLPRangeBps > 0
            ? vault.maxCoLPRangeBps
            : uint16(DEFAULT_COLP_RANGE_BPS);
        
        IERC20(GnosisAddresses.SDAI).safeTransfer(liquidityRouter, sharesNeeded);
        IERC20(wsxmrToken).safeTransfer(liquidityRouter, wsxmrAmount);
        
        (uint256 _tokenId, uint128 liquidity, int24 tickLower, int24 tickUpper) =
            IwsXmrLiquidityRouter(liquidityRouter).mintConcentratedPosition(
                sharesNeeded, wsxmrAmount, rangeBps, xmrPrice, deadline
            );
        tokenId = _tokenId;
        
        vault.deployedSDAIShares += sharesNeeded;
        _positionMetadata[tokenId] = PositionMetadata({
            vaultOwner: lpVault,
            user: msg.sender,
            sDAISharesOriginal: sharesNeeded,
            wsxmrOriginal: wsxmrAmount,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            createdAt: block.timestamp
        });
        _vaultPositions[lpVault].push(tokenId);
        _userPositions[msg.sender].push(tokenId);
        
        emit CoLPDeployed(lpVault, msg.sender, tokenId, sharesNeeded, wsxmrAmount, rangeBps);
    }
    
    /// @notice Either LP or user can close a co-LP position
    function unwindCoLP(uint256 tokenId, uint256 deadline) external nonReentrant {
        if (block.timestamp > deadline) revert DeadlineExpired();
        PositionMetadata memory meta = _positionMetadata[tokenId];
        if (meta.vaultOwner != msg.sender && meta.user != msg.sender) revert Unauthorized();
        
        _unwindAndDistribute(tokenId, false);
    }
    
    /// @notice Get the max wsXMR a vault can accept for co-LP
    function getCoLPCapacity(address lpVault) external view returns (uint256 maxWsxmrAcceptable) {
        Vault memory vault = _vaults[lpVault];
        if (!vault.active) return 0;
        
        uint256 availableIdle = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        if (availableIdle == 0) return 0;
        
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        
        uint256 daiAmount = IERC4626(GnosisAddresses.SDAI).convertToAssets(availableIdle);
        uint256 daiUsd = (daiAmount * collateralPrice) / 1e18;
        maxWsxmrAcceptable = (daiUsd * WSXMR_DECIMALS) / xmrPrice;
    }
    
    /// @notice Keeper-callable rebalance when a position goes out of range
    function rebalanceCoLP(uint256 tokenId, uint16 newRangeBps, uint256 deadline) 
        external nonReentrant 
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        PositionMetadata memory meta = _positionMetadata[tokenId];
        if (meta.vaultOwner == address(0)) revert PositionNotFound();
        
        Vault storage vault = _vaults[meta.vaultOwner];
        if (newRangeBps < MIN_COLP_RANGE_BPS || newRangeBps > vault.maxCoLPRangeBps) {
            revert InvalidRange();
        }
        
        uint256 xmrPrice = _getXmrPriceFromStorage();
        bool outOfRange = IwsXmrLiquidityRouter(liquidityRouter).isPositionOutOfRange(tokenId, xmrPrice);
        bool isOwner = msg.sender == meta.vaultOwner;
        if (!outOfRange && !isOwner) revert PositionInRange();
        
        address user = meta.user;
        (uint256 daiOut, uint256 wsxmrOut) = IwsXmrLiquidityRouter(liquidityRouter)
            .drainPosition(tokenId);
        
        uint256 keeperFee = 0;
        if (!isOwner) {
            keeperFee = (daiOut * COLP_REBALANCE_FEE_BPS) / BPS_DENOMINATOR;
            IERC20(GnosisAddresses.SDAI).safeTransfer(msg.sender, keeperFee);
            daiOut -= keeperFee;
        }
        
        _removePositionFromArrays(tokenId, meta.vaultOwner, user);
        if (vault.deployedSDAIShares >= meta.sDAISharesOriginal) {
            vault.deployedSDAIShares -= meta.sDAISharesOriginal;
        } else {
            vault.deployedSDAIShares = 0;
        }
        delete _positionMetadata[tokenId];
        
        if (daiOut > 0 && wsxmrOut > 0) {
            uint256 newTokenId = _deployToNewPosition(meta.vaultOwner, user, daiOut, wsxmrOut, newRangeBps, deadline);
            emit CoLPRebalanced(tokenId, newTokenId, meta.vaultOwner, user, msg.sender, newRangeBps);
        } else {
            if (daiOut > 0) {
                uint256 shares = ISavingsDAI(GnosisAddresses.SDAI).deposit(daiOut, address(this));
                vault.collateralShares += shares;
            }
            if (wsxmrOut > 0) {
                pendingReturns[user][wsxmrToken] += wsxmrOut;
            }
            emit CoLPUnwound(tokenId, meta.vaultOwner, user, daiOut, wsxmrOut, false);
        }
    }
    
    // ========== PENDING RETURNS ==========
    
    /// @inheritdoc IVaultFacet
    function withdrawReturns(address token) external nonReentrant {
        uint256 amount = pendingReturns[msg.sender][token];
        if (amount == 0) revert ZeroAmount();
        
        pendingReturns[msg.sender][token] = 0;
        
        if (token == GnosisAddresses.SDAI) {
            globalPendingSDAI -= amount;
        }
        
        if (token == address(0)) {
            (bool success, ) = payable(msg.sender).call{value: amount}("");
            if (!success) revert ETHTransferFailed();
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }
        
        emit ReturnsWithdrawn(msg.sender, token, amount);
    }
    
    // ========== VIEW FUNCTIONS ==========
    
    /// @inheritdoc IVaultFacet
    function getVault(address lpAddress) external view returns (Vault memory) {
        return _vaults[lpAddress];
    }
    
    /// @inheritdoc IVaultFacet
    function getVaultHealth(address lpAddress) external view returns (uint256 ratio) {
        Vault memory vault = _vaults[lpAddress];
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        return _calculateCollateralRatio(vault.collateralShares, actualDebt);
    }
    
    /// @inheritdoc IVaultFacet
    function getVaultDebt(address lpAddress) external view returns (uint256) {
        return IOracleFacet(oracleFacet).denormalizeDebt(_vaults[lpAddress].normalizedDebt);
    }
    
    /// @inheritdoc IVaultFacet
    function getVaultCount() external view returns (uint256) {
        return vaultList.length;
    }
    
    /// @inheritdoc IVaultFacet
    function getVaultAtIndex(uint256 index) external view returns (address) {
        return vaultList[index];
    }
    
    /// @inheritdoc IVaultFacet
    function getPendingReturns(address user, address token) external view returns (uint256) {
        return pendingReturns[user][token];
    }
    
    /// @inheritdoc IVaultFacet
    function hasActiveVault(address lpAddress) external view returns (bool) {
        return _vaults[lpAddress].active;
    }
    
    /// @notice Get position metadata for a co-LP position
    function getPositionMetadata(uint256 tokenId) external view returns (PositionMetadata memory) {
        return _positionMetadata[tokenId];
    }
    
    /// @notice Check if a minter is whitelisted for a vault
    function isMinterWhitelisted(address vault, address minter) external view returns (bool) {
        return whitelistedMinters[vault][minter];
    }
    
    // ========== DIAMOND INTROSPECTION ==========
    
    /// @notice Returns all function selectors implemented by this facet
    /// @dev Used by Diamond to build selector → facet routing table
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](30);
        sels[0] = this.createVault.selector;
        sels[1] = this.deactivateVault.selector;
        sels[2] = this.depositCollateral.selector;
        sels[3] = this.depositShares.selector;
        sels[4] = this.withdrawCollateral.selector;
        sels[5] = this.setMintGriefingDeposit.selector;
        sels[6] = this.setMintReadyBond.selector;
        sels[7] = this.setVaultMarketMetrics.selector;
        sels[8] = this.setMaxMintBps.selector;
        sels[9] = this.setMinBurnAmount.selector;
        sels[10] = this.setMinterWhitelist.selector;
        sels[11] = this.batchSetMinterWhitelist.selector;
        sels[12] = this.withdrawReturns.selector;
        sels[13] = this.getVault.selector;
        sels[14] = this.getVaultHealth.selector;
        sels[15] = this.getVaultDebt.selector;
        sels[16] = this.getVaultCount.selector;
        sels[17] = this.getVaultAtIndex.selector;
        sels[18] = this.getPendingReturns.selector;
        sels[19] = this.hasActiveVault.selector;
        sels[20] = this.getPositionMetadata.selector;
        sels[21] = this.isMinterWhitelisted.selector;
        sels[22] = this.selectors.selector;
        sels[23] = this.setMaxCoLPRange.selector;
        sels[24] = this.userOpenCoLP.selector;
        sels[25] = this.unwindCoLP.selector;
        sels[26] = this.rebalanceCoLP.selector;
        sels[27] = this.getCoLPCapacity.selector;
        sels[28] = this.setMintTimeoutBlocks.selector;
        sels[29] = this.setBurnTimeoutBlocks.selector;
        return sels;
    }
    
    /// @inheritdoc IVaultFacet
    function calculateCollateralRatio(
        uint256 collateralAmount,
        uint256 debtAmount
    ) external view returns (uint256) {
        return _calculateCollateralRatio(collateralAmount, debtAmount);
    }
    
    // ========== INTERNAL FUNCTIONS ==========
    
    function _syncVaultYield(address lpAddress) internal {
        Vault storage vault = _vaults[lpAddress];
        if (vault.collateralShares == 0) return;
        
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        
        // Skip yield calculation if no debt - no point checking prices
        if (actualDebt == 0 && vault.pendingDebt == 0) return;
        
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        
        uint256 yieldShares = YieldLogic.calculateExtractableYield(
            vault.collateralShares,
            vault.lockedCollateral,
            lpPrincipalShares[lpAddress],
            actualDebt,
            vault.pendingDebt,
            xmrPrice,
            collateralPrice
        );
        
        if (yieldShares > 0) {
            vault.collateralShares -= yieldShares;
            yieldWarChest += yieldShares;
        }
    }
    
    function _calculateCollateralRatio(
        uint256 collateralShares,
        uint256 debtAmount
    ) internal view returns (uint256 ratio) {
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        return CollateralLogic.calculateRatioFromShares(
            collateralShares,
            debtAmount,
            GnosisAddresses.SDAI,
            collateralPrice,
            xmrPrice
        );
    }
    
    function _getVaultPositionTotalsAtOracle(address vaultAddr, uint256 xmrPrice)
        internal view
        returns (uint256 totalDAI, uint256 totalWsxmr)
    {
        uint256[] memory positions = _vaultPositions[vaultAddr];
        for (uint256 i = 0; i < positions.length; i++) {
            (uint256 dai, uint256 wsxmr) = IwsXmrLiquidityRouter(liquidityRouter)
                .getPositionAmountsAtPrice(positions[i], xmrPrice);
            totalDAI += dai;
            totalWsxmr += wsxmr;
        }
    }
    
    function _unwindAndDistribute(uint256 tokenId, bool fromLiquidation) internal {
        PositionMetadata memory meta = _positionMetadata[tokenId];
        Vault storage vault = _vaults[meta.vaultOwner];
        
        (uint256 daiOut, uint256 wsxmrOut) = IwsXmrLiquidityRouter(liquidityRouter)
            .drainPosition(tokenId);
        
        if (vault.deployedSDAIShares >= meta.sDAISharesOriginal) {
            vault.deployedSDAIShares -= meta.sDAISharesOriginal;
        } else {
            vault.deployedSDAIShares = 0;
        }
        
        if (daiOut > 0) {
            vault.collateralShares += daiOut;
        }
        
        if (wsxmrOut > 0) {
            pendingReturns[meta.user][wsxmrToken] += wsxmrOut;
        }
        
        _removePositionFromArrays(tokenId, meta.vaultOwner, meta.user);
        delete _positionMetadata[tokenId];
        
        emit CoLPUnwound(tokenId, meta.vaultOwner, meta.user, daiOut, wsxmrOut, fromLiquidation);
    }
    
    function _removePositionFromArrays(uint256 tokenId, address vaultAddr, address userAddr) internal {
        uint256[] storage vpos = _vaultPositions[vaultAddr];
        for (uint256 i = 0; i < vpos.length; i++) {
            if (vpos[i] == tokenId) {
                vpos[i] = vpos[vpos.length - 1];
                vpos.pop();
                break;
            }
        }
        uint256[] storage upos = _userPositions[userAddr];
        for (uint256 i = 0; i < upos.length; i++) {
            if (upos[i] == tokenId) {
                upos[i] = upos[upos.length - 1];
                upos.pop();
                break;
            }
        }
    }
    
    function _deployToNewPosition(
        address lpVault,
        address user,
        uint256 daiAmount,
        uint256 wsxmrAmount,
        uint16 rangeBps,
        uint256 deadline
    ) internal returns (uint256 tokenId) {
        Vault storage vault = _vaults[lpVault];
        uint256 xmrPrice = _getXmrPriceFromStorage();
        
        IERC20(GnosisAddresses.SDAI).safeTransfer(liquidityRouter, daiAmount);
        IERC20(wsxmrToken).safeTransfer(liquidityRouter, wsxmrAmount);
        
        (uint256 _tokenId, uint128 liquidity, int24 tickLower, int24 tickUpper) =
            IwsXmrLiquidityRouter(liquidityRouter).mintConcentratedPosition(
                daiAmount, wsxmrAmount, rangeBps, xmrPrice, deadline
            );
        tokenId = _tokenId;
        
        vault.deployedSDAIShares += daiAmount;
        
        _positionMetadata[tokenId] = PositionMetadata({
            vaultOwner: lpVault,
            user: user,
            sDAISharesOriginal: daiAmount,
            wsxmrOriginal: wsxmrAmount,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            createdAt: block.timestamp
        });
        _vaultPositions[lpVault].push(tokenId);
        _userPositions[user].push(tokenId);
        
        emit CoLPDeployed(lpVault, user, tokenId, daiAmount, wsxmrAmount, rangeBps);
    }
}
