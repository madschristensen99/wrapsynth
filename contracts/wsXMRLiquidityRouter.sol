// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {VaultManager} from "./VaultManager.sol";
import {wsXMR} from "./wsXMR.sol";
import {ISavingsDAI} from "./interfaces/ISavingsDAI.sol";
import {GnosisAddresses} from "./GnosisAddresses.sol";

/**
 * @title wsXMRLiquidityRouter
 * @notice Co-LP matchmaking system for pairing LP collateral with user wsXMR
 * @dev Creates deep Uniswap V3 liquidity while maintaining protocol safety
 */
contract wsXMRLiquidityRouter is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ========== CONSTANTS ==========
    
    uint24 public constant POOL_FEE = 3000; // 0.3% fee tier
    int24 public constant TICK_SPACING = 60; // For 0.3% pools
    uint256 public constant BPS_DENOMINATOR = 10000;
    
    // Full range position (approximately -887272 to 887272 for full range)
    int24 public constant TICK_LOWER = -887220; // Divisible by 60
    int24 public constant TICK_UPPER = 887220;  // Divisible by 60

    // ========== STATE VARIABLES ==========
    
    VaultManager public immutable vaultManager;
    wsXMR public immutable wsxmrToken;
    INonfungiblePositionManager public immutable positionManager;
    
    // LP Configuration: How much collateral each LP allocates for liquidity
    mapping(address => uint256) public lpLiquidityAllocation; // sDAI shares allocated
    
    // User Deposits: wsXMR deposited by users for liquidity provision
    mapping(address => uint256) public userWsxmrDeposits;
    
    // Position Tracking
    struct LiquidityPosition {
        uint256 positionId; // Uniswap V3 NFT token ID
        address lpProvider;
        address userProvider;
        uint256 sDAIAmount;
        uint256 wsxmrAmount;
        uint256 lpInitialValueUSD; // LP's initial USD value contribution
        uint256 userInitialValueUSD; // User's initial USD value contribution
        uint256 createdAt;
    }
    
    mapping(uint256 => LiquidityPosition) public positions;
    uint256 public nextPositionIndex;
    
    // Fee tracking for distribution
    mapping(address => uint256) public pendingSDAIFees; // LP fees
    mapping(address => uint256) public pendingWsxmrFees; // User fees

    // ========== EVENTS ==========
    
    event LiquidityAllocated(address indexed lp, uint256 sDAIAmount);
    event LiquidityDeallocated(address indexed lp, uint256 sDAIAmount);
    event UserDepositedWsxmr(address indexed user, uint256 amount);
    event UserWithdrewWsxmr(address indexed user, uint256 amount);
    event PositionCreated(
        uint256 indexed positionIndex,
        uint256 uniswapTokenId,
        address indexed lp,
        address indexed user,
        uint256 sDAIAmount,
        uint256 wsxmrAmount
    );
    event PositionClosed(uint256 indexed positionIndex, uint256 sDAIReturned, uint256 wsxmrReturned);
    event FeesCollected(uint256 indexed positionIndex, uint256 sDAIFees, uint256 wsxmrFees);
    event FeesWithdrawn(address indexed recipient, uint256 sDAIAmount, uint256 wsxmrAmount);

    // ========== ERRORS ==========
    
    error Unauthorized();
    error InvalidAmount();
    error InsufficientBalance();
    error PositionNotFound();
    error VaultNotActive();

    // ========== CONSTRUCTOR ==========
    
    constructor(
        address _vaultManager,
        address _wsxmrToken,
        address _positionManager,
        address _initialOwner
    ) Ownable(_initialOwner) {
        vaultManager = VaultManager(_vaultManager);
        wsxmrToken = wsXMR(_wsxmrToken);
        positionManager = INonfungiblePositionManager(_positionManager);
    }

    // ========== LP FUNCTIONS ==========
    
    /**
     * @notice LP allocates sDAI collateral for liquidity provision
     * @param _sDAIAmount Amount of sDAI shares to allocate
     */
    function allocateLiquidity(uint256 _sDAIAmount) external nonReentrant {
        if (_sDAIAmount == 0) revert InvalidAmount();
        
        // Verify LP has an active vault
        (, , , , , , , , , , bool active) = vaultManager.vaults(msg.sender);
        if (!active) revert VaultNotActive();
        
        // Transfer sDAI from LP's vault (requires VaultManager approval)
        IERC20(GnosisAddresses.SDAI).safeTransferFrom(msg.sender, address(this), _sDAIAmount);
        
        lpLiquidityAllocation[msg.sender] += _sDAIAmount;
        
        emit LiquidityAllocated(msg.sender, _sDAIAmount);
    }
    
    /**
     * @notice LP deallocates sDAI collateral (if not in active positions)
     * @param _sDAIAmount Amount of sDAI shares to deallocate
     */
    function deallocateLiquidity(uint256 _sDAIAmount) external nonReentrant {
        if (_sDAIAmount == 0) revert InvalidAmount();
        if (lpLiquidityAllocation[msg.sender] < _sDAIAmount) revert InsufficientBalance();
        
        lpLiquidityAllocation[msg.sender] -= _sDAIAmount;
        
        // Return sDAI to LP
        IERC20(GnosisAddresses.SDAI).safeTransfer(msg.sender, _sDAIAmount);
        
        emit LiquidityDeallocated(msg.sender, _sDAIAmount);
    }

    // ========== USER FUNCTIONS ==========
    
    /**
     * @notice User deposits wsXMR for liquidity provision
     * @param _amount Amount of wsXMR to deposit
     */
    function depositWsxmr(uint256 _amount) external nonReentrant {
        if (_amount == 0) revert InvalidAmount();
        
        IERC20(address(wsxmrToken)).safeTransferFrom(msg.sender, address(this), _amount);
        userWsxmrDeposits[msg.sender] += _amount;
        
        emit UserDepositedWsxmr(msg.sender, _amount);
    }
    
    /**
     * @notice User withdraws wsXMR (if not in active positions)
     * @param _amount Amount of wsXMR to withdraw
     */
    function withdrawWsxmr(uint256 _amount) external nonReentrant {
        if (_amount == 0) revert InvalidAmount();
        if (userWsxmrDeposits[msg.sender] < _amount) revert InsufficientBalance();
        
        userWsxmrDeposits[msg.sender] -= _amount;
        
        IERC20(address(wsxmrToken)).safeTransfer(msg.sender, _amount);
        
        emit UserWithdrewWsxmr(msg.sender, _amount);
    }

    // ========== POSITION MANAGEMENT ==========
    
    /**
     * @notice Create a matched liquidity position on Uniswap V3
     * @param _lp Address of LP providing sDAI
     * @param _user Address of user providing wsXMR
     * @param _sDAIAmount Amount of sDAI to pair
     * @param _wsxmrAmount Amount of wsXMR to pair
     */
    function createPosition(
        address _lp,
        address _user,
        uint256 _sDAIAmount,
        uint256 _wsxmrAmount
    ) external nonReentrant returns (uint256 positionIndex) {
        // CRITICAL FIX: Authorization - only LP can create positions to prevent forced IL attacks
        // User cannot force LP funds into positions at manipulated prices
        if (msg.sender != _lp) revert Unauthorized();
        
        // Validate balances
        if (lpLiquidityAllocation[_lp] < _sDAIAmount) revert InsufficientBalance();
        if (userWsxmrDeposits[_user] < _wsxmrAmount) revert InsufficientBalance();
        
        // Deduct from available balances
        lpLiquidityAllocation[_lp] -= _sDAIAmount;
        userWsxmrDeposits[_user] -= _wsxmrAmount;
        
        // Approve Uniswap Position Manager
        IERC20(GnosisAddresses.SDAI).approve(address(positionManager), _sDAIAmount);
        IERC20(address(wsxmrToken)).approve(address(positionManager), _wsxmrAmount);
        
        // Determine token order (Uniswap requires token0 < token1)
        (address token0, address token1) = GnosisAddresses.SDAI < address(wsxmrToken)
            ? (GnosisAddresses.SDAI, address(wsxmrToken))
            : (address(wsxmrToken), GnosisAddresses.SDAI);
        
        (uint256 amount0, uint256 amount1) = token0 == GnosisAddresses.SDAI
            ? (_sDAIAmount, _wsxmrAmount)
            : (_wsxmrAmount, _sDAIAmount);
        
        // Create Uniswap V3 position
        (uint256 tokenId, , uint256 actual0, uint256 actual1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: POOL_FEE,
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: (amount0 * 98) / 100, // CRITICAL FIX: Tighter slippage for MEV protection
                amount1Min: (amount1 * 98) / 100,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        
        // CRITICAL FIX: Refund unused amounts and record position
        positionIndex = nextPositionIndex++;
        
        if (token0 == GnosisAddresses.SDAI) {
            if (actual0 < _sDAIAmount) lpLiquidityAllocation[_lp] += (_sDAIAmount - actual0);
            if (actual1 < _wsxmrAmount) userWsxmrDeposits[_user] += (_wsxmrAmount - actual1);
            
            positions[positionIndex] = LiquidityPosition({
                positionId: tokenId,
                lpProvider: _lp,
                userProvider: _user,
                sDAIAmount: actual0,
                wsxmrAmount: actual1,
                lpInitialValueUSD: (actual0 * vaultManager.getCollateralPrice(GnosisAddresses.SDAI)) / 1e18,
                userInitialValueUSD: (actual1 * vaultManager.getXmrPrice()) / 1e8,
                createdAt: block.timestamp
            });
        } else {
            if (actual0 < _wsxmrAmount) userWsxmrDeposits[_user] += (_wsxmrAmount - actual0);
            if (actual1 < _sDAIAmount) lpLiquidityAllocation[_lp] += (_sDAIAmount - actual1);
            
            positions[positionIndex] = LiquidityPosition({
                positionId: tokenId,
                lpProvider: _lp,
                userProvider: _user,
                sDAIAmount: actual1,
                wsxmrAmount: actual0,
                lpInitialValueUSD: (actual1 * vaultManager.getCollateralPrice(GnosisAddresses.SDAI)) / 1e18,
                userInitialValueUSD: (actual0 * vaultManager.getXmrPrice()) / 1e8,
                createdAt: block.timestamp
            });
        }
        
        emit PositionCreated(positionIndex, tokenId, _lp, _user, _sDAIAmount, _wsxmrAmount);
    }
    
    /**
     * @notice Close a liquidity position and return assets
     * @param _positionIndex Index of the position to close
     */
    function closePosition(uint256 _positionIndex) external nonReentrant {
        LiquidityPosition storage position = positions[_positionIndex];
        if (position.positionId == 0) revert PositionNotFound();
        
        // Only LP or user can close their position
        if (msg.sender != position.lpProvider && msg.sender != position.userProvider) {
            revert Unauthorized();
        }
        
        // Get position details
        (, , , , , , , uint128 liquidity, , , , ) = positionManager.positions(position.positionId);
        
        // Remove all liquidity
        (uint256 amount0, uint256 amount1) = positionManager.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: position.positionId,
                liquidity: liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        );
        
        // Collect tokens
        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: position.positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        
        // Determine which token is which
        (, , address token0, , , , , , , , , ) = positionManager.positions(position.positionId);
        
        // CRITICAL FIX: Distribute proportionally based on initial USD value contributions
        // This prevents LP from stealing user's assets when pool ratio shifts due to swaps
        uint256 totalReturnedValue = ((token0 == GnosisAddresses.SDAI ? collected0 : collected1) * 
            vaultManager.getCollateralPrice(GnosisAddresses.SDAI)) / 1e18 + 
            ((token0 == GnosisAddresses.SDAI ? collected1 : collected0) * 
            vaultManager.getXmrPrice()) / 1e8;
        
        // Calculate LP's proportional share of total value
        uint256 lpShareValue = (totalReturnedValue * position.lpInitialValueUSD) / 
            (position.lpInitialValueUSD + position.userInitialValueUSD);
        
        // Convert LP share to sDAI amount
        uint256 lpSDAI = (lpShareValue * 1e18) / vaultManager.getCollateralPrice(GnosisAddresses.SDAI);
        uint256 sDAIReturned = token0 == GnosisAddresses.SDAI ? collected0 : collected1;
        if (lpSDAI > sDAIReturned) lpSDAI = sDAIReturned;
        
        // Convert user share to wsXMR amount
        uint256 userWsxmr = ((totalReturnedValue - lpShareValue) * 1e8) / vaultManager.getXmrPrice();
        uint256 wsxmrReturned = token0 == GnosisAddresses.SDAI ? collected1 : collected0;
        if (userWsxmr > wsxmrReturned) userWsxmr = wsxmrReturned;
        
        // Credit proportional amounts
        lpLiquidityAllocation[position.lpProvider] += lpSDAI;
        userWsxmrDeposits[position.userProvider] += userWsxmr;
        
        // Remainder as fees (50/50 split)
        if (sDAIReturned > lpSDAI) {
            uint256 fee = sDAIReturned - lpSDAI;
            pendingSDAIFees[position.lpProvider] += fee / 2;
            pendingSDAIFees[position.userProvider] += fee - (fee / 2);
        }
        if (wsxmrReturned > userWsxmr) {
            uint256 fee = wsxmrReturned - userWsxmr;
            pendingWsxmrFees[position.lpProvider] += fee / 2;
            pendingWsxmrFees[position.userProvider] += fee - (fee / 2);
        }
        
        emit PositionClosed(_positionIndex, sDAIReturned, wsxmrReturned);
        
        // Clear position
        delete positions[_positionIndex];
    }
    
    /**
     * @notice Collect fees from an active position without closing it
     * @param _positionIndex Index of the position
     */
    function collectFees(uint256 _positionIndex) external nonReentrant {
        LiquidityPosition storage position = positions[_positionIndex];
        if (position.positionId == 0) revert PositionNotFound();
        
        // Collect accumulated fees
        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: position.positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        
        // Determine which token is which
        (, , address token0, , , , , , , , , ) = positionManager.positions(position.positionId);
        
        (uint256 sDAIFees, uint256 wsxmrFees) = token0 == GnosisAddresses.SDAI
            ? (collected0, collected1)
            : (collected1, collected0);
        
        // Split fees 50/50 between LP and user
        if (sDAIFees > 0) {
            pendingSDAIFees[position.lpProvider] += sDAIFees / 2;
            pendingSDAIFees[position.userProvider] += sDAIFees / 2;
        }
        
        if (wsxmrFees > 0) {
            pendingWsxmrFees[position.lpProvider] += wsxmrFees / 2;
            pendingWsxmrFees[position.userProvider] += wsxmrFees / 2;
        }
        
        emit FeesCollected(_positionIndex, sDAIFees, wsxmrFees);
    }
    
    /**
     * @notice Withdraw accumulated fees
     */
    function withdrawFees() external nonReentrant {
        uint256 sDAIAmount = pendingSDAIFees[msg.sender];
        uint256 wsxmrAmount = pendingWsxmrFees[msg.sender];
        
        if (sDAIAmount > 0) {
            pendingSDAIFees[msg.sender] = 0;
            IERC20(GnosisAddresses.SDAI).safeTransfer(msg.sender, sDAIAmount);
        }
        
        if (wsxmrAmount > 0) {
            pendingWsxmrFees[msg.sender] = 0;
            IERC20(address(wsxmrToken)).safeTransfer(msg.sender, wsxmrAmount);
        }
        
        emit FeesWithdrawn(msg.sender, sDAIAmount, wsxmrAmount);
    }

    // ========== VIEW FUNCTIONS ==========
    
    /**
     * @notice Get position details
     */
    function getPosition(uint256 _positionIndex) external view returns (LiquidityPosition memory) {
        return positions[_positionIndex];
    }
    
    /**
     * @notice Get LP's available liquidity allocation
     */
    function getLpAvailableLiquidity(address _lp) external view returns (uint256) {
        return lpLiquidityAllocation[_lp];
    }
    
    /**
     * @notice Get user's available wsXMR deposit
     */
    function getUserAvailableWsxmr(address _user) external view returns (uint256) {
        return userWsxmrDeposits[_user];
    }
}
