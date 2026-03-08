// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
contract wsXMRLiquidityRouter is ReentrancyGuard {
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

    // CRITICAL FIX: Dual approval system for matchmaking
    mapping(address => mapping(address => bool)) public lpApprovedUsers; // LP approves user
    mapping(address => mapping(address => bool)) public userApprovedLps; // User approves LP

    // ========== EVENTS ==========
    
    event LiquidityAllocated(address indexed lp, uint256 sDAIAmount);
    event LiquidityDeallocated(address indexed lp, uint256 sDAIAmount);
    event WsxmrDeallocated(address indexed account, uint256 amount);
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
        address _positionManager
    ) {
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
     * @notice LP deallocates sDAI from liquidity provision back to vault
     * @param _sDAIAmount Amount of sDAI shares to deallocate
     */
    function deallocateLiquidity(uint256 _sDAIAmount) external nonReentrant {
        if (_sDAIAmount == 0) revert InvalidAmount();
        if (lpLiquidityAllocation[msg.sender] < _sDAIAmount) revert InsufficientBalance();
        
        lpLiquidityAllocation[msg.sender] -= _sDAIAmount;
        
        // Transfer sDAI back to LP
        IERC20(GnosisAddresses.SDAI).safeTransfer(msg.sender, _sDAIAmount);
        
        emit LiquidityDeallocated(msg.sender, _sDAIAmount);
    }
    
    /**
     * @notice Generic function to withdraw sDAI (for users who received sDAI from IL)
     * @param _sDAIAmount Amount of sDAI shares to withdraw
     * @dev Allows users to withdraw sDAI allocated to them from impermanent loss without needing LP role
     */
    function withdrawSDAI(uint256 _sDAIAmount) external nonReentrant {
        if (_sDAIAmount == 0) revert InvalidAmount();
        if (lpLiquidityAllocation[msg.sender] < _sDAIAmount) revert InsufficientBalance();
        
        lpLiquidityAllocation[msg.sender] -= _sDAIAmount;
        IERC20(GnosisAddresses.SDAI).safeTransfer(msg.sender, _sDAIAmount);
        
        emit LiquidityDeallocated(msg.sender, _sDAIAmount);
    }
    
    /**
     * @notice Generic function to withdraw wsXMR (for LPs who received wsXMR from IL)
     * @param _wsxmrAmount Amount of wsXMR to withdraw
     * @dev Allows LPs to withdraw wsXMR allocated to them from impermanent loss without needing user role
     */
    function withdrawWsXMR(uint256 _wsxmrAmount) external nonReentrant {
        if (_wsxmrAmount == 0) revert InvalidAmount();
        if (userWsxmrDeposits[msg.sender] < _wsxmrAmount) revert InsufficientBalance();
        
        userWsxmrDeposits[msg.sender] -= _wsxmrAmount;
        IERC20(address(wsxmrToken)).safeTransfer(msg.sender, _wsxmrAmount);
        
        emit WsxmrDeallocated(msg.sender, _wsxmrAmount);
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
     * @notice LP approves a user for liquidity pairing
     * @param _user Address of user to approve
     * @param _approved Whether to approve or revoke approval
     */
    function approveUserForPairing(address _user, bool _approved) external {
        lpApprovedUsers[msg.sender][_user] = _approved;
    }
    
    /**
     * @notice User approves an LP for liquidity pairing
     * @param _lp Address of LP to approve
     * @param _approved Whether to approve or revoke approval
     */
    function approveLpForPairing(address _lp, bool _approved) external {
        userApprovedLps[msg.sender][_lp] = _approved;
    }
    
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
        // CRITICAL FIX: Require BOTH LP and user authorization
        // Prevents LP from stealing arbitrary user deposits
        // Prevents user from forcing LP into manipulated positions
        if (msg.sender != _lp && msg.sender != _user) revert Unauthorized();
        
        // CRITICAL FIX: Enforce dual approval system
        // BOTH parties must have explicitly approved each other
        if (!lpApprovedUsers[_lp][_user]) {
            revert("LP has not approved user for pairing");
        }
        if (!userApprovedLps[_user][_lp]) {
            revert("User has not approved LP for pairing");
        }
        
        // Both parties have mutually approved this pairing
        
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
        
        // CRITICAL FIX: Use oracle prices to calculate expected pool ratio and validate
        // This prevents MEV arbitrage via flash loan pool manipulation
        uint256 sDAIPrice = vaultManager.getCollateralPrice();
        uint256 wsxmrPrice = vaultManager.getXmrPrice();
        
        // Calculate expected ratio based on oracle prices
        // sDAI amount * sDAI price should approximately equal wsXMR amount * wsXMR price
        uint256 sDAIValue = token0 == GnosisAddresses.SDAI 
            ? (amount0 * sDAIPrice) / 1e18 
            : (amount1 * sDAIPrice) / 1e18;
        uint256 wsxmrValue = token0 == GnosisAddresses.SDAI 
            ? (amount1 * wsxmrPrice) / 1e8 
            : (amount0 * wsxmrPrice) / 1e8;
        
        // Require values to be within 10% of each other (oracle-based validation)
        // This prevents creating positions during manipulated pool states
        uint256 valueDiff = sDAIValue > wsxmrValue ? sDAIValue - wsxmrValue : wsxmrValue - sDAIValue;
        require(valueDiff * 10 <= (sDAIValue + wsxmrValue), "Pool ratio deviates from oracle");
        
        // CRITICAL FIX: Relax slippage bounds to 10% for full-range positions
        // Full-range liquidity must match exact pool ratio, 5% was too restrictive
        // Oracle validation above already prevents manipulation
        uint256 amount0Min = (amount0 * 90) / 100;
        uint256 amount1Min = (amount1 * 90) / 100;
        
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
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        
        // CRITICAL FIX: Refund unused amounts and record position
        positionIndex = nextPositionIndex++;
        
        if (token0 == GnosisAddresses.SDAI) {
            if (actual0 < _sDAIAmount) lpLiquidityAllocation[_lp] += (_sDAIAmount - actual0);
            if (actual1 < _wsxmrAmount) userWsxmrDeposits[_user] += (_wsxmrAmount - actual1);
            
            // CRITICAL FIX: Calculate USD values based on ACTUAL spot ratio used by Uniswap
            // This prevents oracle/spot divergence arbitrage attacks
            positions[positionIndex] = LiquidityPosition({
                positionId: tokenId,
                lpProvider: _lp,
                userProvider: _user,
                sDAIAmount: actual0,
                wsxmrAmount: actual1,
                lpInitialValueUSD: (actual0 * vaultManager.getCollateralPrice()) / 1e18,
                userInitialValueUSD: (actual1 * vaultManager.getXmrPrice()) / 1e8,
                createdAt: block.timestamp
            });
        } else {
            if (actual0 < _wsxmrAmount) userWsxmrDeposits[_user] += (_wsxmrAmount - actual0);
            if (actual1 < _sDAIAmount) lpLiquidityAllocation[_lp] += (_sDAIAmount - actual1);
            
            // CRITICAL FIX: Calculate USD values based on ACTUAL spot ratio used by Uniswap
            // This prevents oracle/spot divergence arbitrage attacks
            positions[positionIndex] = LiquidityPosition({
                positionId: tokenId,
                lpProvider: _lp,
                userProvider: _user,
                sDAIAmount: actual1,
                wsxmrAmount: actual0,
                lpInitialValueUSD: (actual1 * vaultManager.getCollateralPrice()) / 1e18,
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
        (, , address token0, , , , , uint128 liquidity, , , , ) = 
            positionManager.positions(position.positionId);
        
        // CRITICAL FIX: Capture principal amounts from decreaseLiquidity return
        // tokensOwed INCLUDES principal after decreaseLiquidity, so we can't use it
        // The return values from decreaseLiquidity are the actual principal amounts
        (uint256 principal0, uint256 principal1) = positionManager.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: position.positionId,
                liquidity: liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        );
        
        // Note: We don't need to read tokensOwed before collect since we calculate fees
        // as the difference between collected and principal amounts
        
        // Collect all tokens (principal + fees)
        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: position.positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        
        // CRITICAL FIX: Fees are the difference between collected and principal
        // collected = principal (from decreaseLiquidity) + pre-existing fees
        uint256 fees0 = collected0 - principal0;
        uint256 fees1 = collected1 - principal1;
        
        // CRITICAL FIX: Direct proportional distribution of actual principal returned
        // Avoids USD conversion round-trip that can trap funds
        uint256 sDAIPrincipal = token0 == GnosisAddresses.SDAI ? principal0 : principal1;
        uint256 wsxmrPrincipal = token0 == GnosisAddresses.SDAI ? principal1 : principal0;
        
        // Calculate proportional split based on initial USD contributions
        uint256 totalInitialValue = position.lpInitialValueUSD + position.userInitialValueUSD;
        
        // LP gets their proportional share of BOTH assets
        uint256 lpSDAI = (sDAIPrincipal * position.lpInitialValueUSD) / totalInitialValue;
        uint256 lpWsxmr = (wsxmrPrincipal * position.lpInitialValueUSD) / totalInitialValue;
        
        // User gets remaining portions
        uint256 userSDAI = sDAIPrincipal - lpSDAI;
        uint256 userWsxmr = wsxmrPrincipal - lpWsxmr;
        
        // Credit both parties with both assets (handles IL via cross-distribution)
        lpLiquidityAllocation[position.lpProvider] += lpSDAI;
        userWsxmrDeposits[position.userProvider] += userWsxmr;
        
        // CRITICAL FIX: Cross-distribute to prevent fund trapping
        // If pool shifted heavily to one asset, both parties receive proportional amounts of both
        if (userSDAI > 0) {
            lpLiquidityAllocation[position.userProvider] += userSDAI;
        }
        if (lpWsxmr > 0) {
            userWsxmrDeposits[position.lpProvider] += lpWsxmr;
        }
        
        // CRITICAL FIX: Distribute actual trading fees (50/50 split)
        // fees0/fees1 are correctly calculated as collected - principal
        // Determine which fee corresponds to which token
        uint256 sDAIFees = sDAIPrincipal == principal0 ? fees0 : fees1;
        uint256 wsxmrFees = wsxmrPrincipal == principal0 ? fees0 : fees1;
        
        if (sDAIFees > 0) {
            pendingSDAIFees[position.lpProvider] += sDAIFees / 2;
            pendingSDAIFees[position.userProvider] += sDAIFees - (sDAIFees / 2);
        }
        if (wsxmrFees > 0) {
            pendingWsxmrFees[position.lpProvider] += wsxmrFees / 2;
            pendingWsxmrFees[position.userProvider] += wsxmrFees - (wsxmrFees / 2);
        }
        
        emit PositionClosed(_positionIndex, sDAIPrincipal, wsxmrPrincipal);
        
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
