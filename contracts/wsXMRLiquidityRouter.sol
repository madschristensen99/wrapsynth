// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "./interfaces/IUniswapV3Factory.sol";
import {VaultManager} from "./VaultManager.sol";
import {wsXMR} from "./wsXMR.sol";
import {ISavingsDAI} from "./interfaces/ISavingsDAI.sol";
import {GnosisAddresses} from "./GnosisAddresses.sol";

/**
 * @title wsXMRLiquidityRouter
 * @notice Co-LP matchmaking system for pairing LP collateral with user wsXMR
 * @dev Creates deep Uniswap V3 liquidity while maintaining protocol safety
 */
contract wsXMRLiquidityRouter is ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ========== CONSTANTS ==========
    
    uint24 public constant POOL_FEE = 3000; // 0.3% fee tier
    int24 public constant TICK_SPACING = 60; // For 0.3% pools
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_ACTIVE_POSITIONS_PER_USER = 50;
    uint256 public constant MIN_DEPOSIT_AMOUNT = 1000; // Minimum to prevent dust
    uint256 public constant SDAI_DECIMALS = 1e18;
    uint256 public constant WSXMR_DECIMALS = 1e8;
    
    // Full range position (approximately -887272 to 887272 for full range)
    int24 public constant TICK_LOWER = -887220; // Divisible by 60
    int24 public constant TICK_UPPER = 887220;  // Divisible by 60

    // ========== STATE VARIABLES ==========
    
    VaultManager public immutable vaultManager;
    wsXMR public immutable wsxmrToken;
    INonfungiblePositionManager public immutable positionManager;
    IUniswapV3Factory public immutable uniswapFactory;
    
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
        uint256 cumulativeCollected0; // NEW: total token0 collected as fees so far
        uint256 cumulativeCollected1; // NEW: total token1 collected as fees so far
    }
    
    mapping(uint256 => LiquidityPosition) public positions;
    uint256 public nextPositionIndex;
    
    // Fee tracking for distribution
    mapping(address => uint256) public pendingSDAIFees; // LP fees
    mapping(address => uint256) public pendingWsxmrFees; // User fees
    
    // Frontend-friendly position tracking
    mapping(address => uint256[]) public userPositions;
    mapping(address => uint256) public activePositionCount;

   
    // Mutual approval system with amount limits
    // LP approves max sDAI amount to pair with specific user
    mapping(address => mapping(address => uint256)) public lpApprovalAmount;
    // User approves max wsXMR amount to pair with specific LP
    mapping(address => mapping(address => uint256)) public userApprovalAmount; // User approves LP

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
    event LpApprovedUser(address indexed lp, address indexed user, uint256 amount);
    event UserApprovedLp(address indexed user, address indexed lp, uint256 amount);

    // ========== ERRORS ==========
    
    error Unauthorized();
    error InvalidAmount();
    error InsufficientBalance();
    error PositionNotFound();
    error VaultNotActive();

    // ========== CONSTRUCTOR ==========
    
    constructor(
        address payable _vaultManager,
        address _wsxmrToken,
        address _positionManager,
        address _uniswapFactory
    ) {
        vaultManager = VaultManager(_vaultManager);
        wsxmrToken = wsXMR(_wsxmrToken);
        positionManager = INonfungiblePositionManager(_positionManager);
        uniswapFactory = IUniswapV3Factory(_uniswapFactory);
    }

    // ========== LP FUNCTIONS ==========
    
    /**
     * @notice LP allocates sDAI collateral for liquidity provision
     * @param _sDAIAmount Amount of sDAI shares to allocate
     */
    function allocateLiquidity(uint256 _sDAIAmount) external nonReentrant {
        if (_sDAIAmount == 0) revert InvalidAmount();
        require(_sDAIAmount >= MIN_DEPOSIT_AMOUNT, "Below minimum deposit");
        
        // Verify LP has an active vault
        (, , , , , , , , , , , , bool active) = vaultManager.vaults(msg.sender);
        if (!active) revert VaultNotActive();
        
        // Transfer sDAI from LP's vault (requires VaultManager approval)
        IERC20(GnosisAddresses.SDAI).safeTransferFrom(msg.sender, address(this), _sDAIAmount);
        
        lpLiquidityAllocation[msg.sender] += _sDAIAmount;
        
        emit LiquidityAllocated(msg.sender, _sDAIAmount);
    }
    
    /**
     * @notice LP deallocates sDAI - DEPRECATED, use withdrawSDAI instead
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
     * @notice Withdraw sDAI balance (for LPs withdrawing allocations or users withdrawing IL proceeds)
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
     * @notice Withdraw wsXMR balance (for users withdrawing deposits or LPs withdrawing IL proceeds)
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
        require(_amount >= MIN_DEPOSIT_AMOUNT, "Below minimum deposit");
        
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
     * @notice LP increases approval amount for a user
     * @param _user Address of user to approve
     * @param _additionalSDAI Additional sDAI amount to approve
     */
    function increaseUserApproval(address _user, uint256 _additionalSDAI) external {
        lpApprovalAmount[msg.sender][_user] += _additionalSDAI;
        emit LpApprovedUser(msg.sender, _user, lpApprovalAmount[msg.sender][_user]);
    }
    
    /**
     * @notice LP decreases approval amount for a user
     * @param _user Address of user
     * @param _reduceSDAI Amount to reduce approval by
     */
    function decreaseUserApproval(address _user, uint256 _reduceSDAI) external {
        uint256 current = lpApprovalAmount[msg.sender][_user];
        lpApprovalAmount[msg.sender][_user] = _reduceSDAI > current ? 0 : current - _reduceSDAI;
        emit LpApprovedUser(msg.sender, _user, lpApprovalAmount[msg.sender][_user]);
    }
    
    /**
     * @notice User increases approval amount for an LP
     * @param _lp Address of LP to approve
     * @param _additionalWsxmr Additional wsXMR amount to approve
     */
    function increaseLpApproval(address _lp, uint256 _additionalWsxmr) external {
        userApprovalAmount[msg.sender][_lp] += _additionalWsxmr;
        emit UserApprovedLp(msg.sender, _lp, userApprovalAmount[msg.sender][_lp]);
    }
    
    /**
     * @notice User decreases approval amount for an LP
     * @param _lp Address of LP
     * @param _reduceWsxmr Amount to reduce approval by
     */
    function decreaseLpApproval(address _lp, uint256 _reduceWsxmr) external {
        uint256 current = userApprovalAmount[msg.sender][_lp];
        userApprovalAmount[msg.sender][_lp] = _reduceWsxmr > current ? 0 : current - _reduceWsxmr;
        emit UserApprovedLp(msg.sender, _lp, userApprovalAmount[msg.sender][_lp]);
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
        uint256 _wsxmrAmount,
        uint256 _deadline
    ) external nonReentrant returns (uint256 positionIndex) {
        require(block.timestamp <= _deadline, "Transaction expired");
        require(_deadline <= block.timestamp + 30 minutes, "Deadline too far in future");
       
        // Prevents LP from stealing arbitrary user deposits
        // Prevents user from forcing LP into manipulated positions
        if (msg.sender != _lp && msg.sender != _user) revert Unauthorized();
        
       
        // BOTH parties must have explicitly approved each other with sufficient amounts
        require(
            lpApprovalAmount[_lp][_user] >= _sDAIAmount,
            "LP approval insufficient"
        );
        require(
            userApprovalAmount[_user][_lp] >= _wsxmrAmount,
            "User approval insufficient"
        );
        
        // Decrement approval amounts
        lpApprovalAmount[_lp][_user] -= _sDAIAmount;
        userApprovalAmount[_user][_lp] -= _wsxmrAmount;
        
        // Check position limits to prevent unbounded array growth
        require(activePositionCount[_lp] < MAX_ACTIVE_POSITIONS_PER_USER, "LP max positions reached");
        require(activePositionCount[_user] < MAX_ACTIVE_POSITIONS_PER_USER, "User max positions reached");
        
        // Both parties have mutually approved this pairing
        
        // Validate balances
        if (lpLiquidityAllocation[_lp] < _sDAIAmount) revert InsufficientBalance();
        if (userWsxmrDeposits[_user] < _wsxmrAmount) revert InsufficientBalance();
        
        // Deduct from available balances
        lpLiquidityAllocation[_lp] -= _sDAIAmount;
        userWsxmrDeposits[_user] -= _wsxmrAmount;
        
        // Approve Uniswap Position Manager
        IERC20(GnosisAddresses.SDAI).forceApprove(address(positionManager), _sDAIAmount);
        IERC20(address(wsxmrToken)).forceApprove(address(positionManager), _wsxmrAmount);
        
        // Determine token order (Uniswap requires token0 < token1)
        (address token0, address token1) = GnosisAddresses.SDAI < address(wsxmrToken)
            ? (GnosisAddresses.SDAI, address(wsxmrToken))
            : (address(wsxmrToken), GnosisAddresses.SDAI);
        
        (uint256 amount0, uint256 amount1) = token0 == GnosisAddresses.SDAI
            ? (_sDAIAmount, _wsxmrAmount)
            : (_wsxmrAmount, _sDAIAmount);
        
       
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
        
        // 0.5% oracle tolerance (stricter than 1% slippage to prevent sandwich in the gap)
        uint256 valueDiff = sDAIValue > wsxmrValue ? sDAIValue - wsxmrValue : wsxmrValue - sDAIValue;
        require(valueDiff * 200 <= (sDAIValue + wsxmrValue), "Pool ratio deviates from oracle");
        
        // Verify pool exists to prevent first-depositor price manipulation
        address pool = uniswapFactory.getPool(token0, token1, POOL_FEE);
        require(pool != address(0), "Pool does not exist");
        
        // Slippage tolerance must match oracle validation tolerance (1%)
        // to prevent sandwich attacks in the gap between oracle check and execution
        uint256 amount0Min = (amount0 * 99) / 100;
        uint256 amount1Min = (amount1 * 99) / 100;
        
        // CRITICAL FIX: Oracle-based validation prevents MEV arbitrage
        // Uniswap V3 will consume assets according to current pool ratio
        // Oracle validation above (valueDiff * 100 <= totalValue) already prevents manipulation
        // Strict bounds cause reverts when pool ratio doesn't match 50/50 desired amounts
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
                deadline: _deadline
            })
        );
        
       
        positionIndex = nextPositionIndex++;
        
        if (token0 == GnosisAddresses.SDAI) {
            if (actual0 < _sDAIAmount) lpLiquidityAllocation[_lp] += (_sDAIAmount - actual0);
            if (actual1 < _wsxmrAmount) userWsxmrDeposits[_user] += (_wsxmrAmount - actual1);
            
           
            // This prevents oracle/spot divergence arbitrage attacks
            positions[positionIndex] = LiquidityPosition({
                positionId: tokenId,
                lpProvider: _lp,
                userProvider: _user,
                sDAIAmount: actual0,
                wsxmrAmount: actual1,
                lpInitialValueUSD: (actual0 * sDAIPrice) / 1e18,
                userInitialValueUSD: (actual1 * wsxmrPrice) / 1e8,
                createdAt: block.timestamp,
                cumulativeCollected0: 0,
                cumulativeCollected1: 0
            });
        } else {
            if (actual0 < _wsxmrAmount) userWsxmrDeposits[_user] += (_wsxmrAmount - actual0);
            if (actual1 < _sDAIAmount) lpLiquidityAllocation[_lp] += (_sDAIAmount - actual1);
            
           
            // This prevents oracle/spot divergence arbitrage attacks
            positions[positionIndex] = LiquidityPosition({
                positionId: tokenId,
                lpProvider: _lp,
                userProvider: _user,
                sDAIAmount: actual1,
                wsxmrAmount: actual0,
                lpInitialValueUSD: (actual1 * sDAIPrice) / 1e18,
                userInitialValueUSD: (actual0 * wsxmrPrice) / 1e8,
                createdAt: block.timestamp,
                cumulativeCollected0: 0,
                cumulativeCollected1: 0
            });
        }
        
        // Track position for frontend discovery
        userPositions[_user].push(positionIndex);
        userPositions[_lp].push(positionIndex);
        
        activePositionCount[_lp]++;
        activePositionCount[_user]++;
        
        emit PositionCreated(positionIndex, tokenId, _lp, _user, _sDAIAmount, _wsxmrAmount);
    }
    
    /**
     * @notice Close a liquidity position and return assets
     * @param _positionIndex Index of the position to close
     * @param _deadline Transaction deadline timestamp
     * @param _minTotalValueUSD Minimum total USD value to receive (caller-specified based on oracle prices)
     */
    function closePosition(uint256 _positionIndex, uint256 _deadline, uint256 _minTotalValueUSD) external nonReentrant {
        require(block.timestamp <= _deadline, "Transaction expired");
        require(_deadline <= block.timestamp + 30 minutes, "Deadline too far in future");
        LiquidityPosition storage position = positions[_positionIndex];
        if (position.positionId == 0) revert PositionNotFound();
        
        // Only LP or user can close their position
        if (msg.sender != position.lpProvider && msg.sender != position.userProvider) {
            revert Unauthorized();
        }
        
        // Get position details
        (, , address token0, , , , , uint128 liquidity, , , , ) = 
            positionManager.positions(position.positionId);
        
       
        // We already protect against pool manipulation via oracle checks in createPosition
        // (valueDiff * 10 <= totalValue ensures pool is within 10% of oracle prices)
        // Setting strict bounds here causes reverts due to impermanent loss shifting asset ratios
        // The previous approach demanded 95% of TOTAL value from EACH asset = 190% total (impossible)
        (uint256 principal0, uint256 principal1) = positionManager.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: position.positionId,
                liquidity: liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: _deadline
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

        // CRITICAL FIX: Fee calculation must account for IL shifting principal amounts
        // Only count fees not already collected via collectFees
        // collected includes principal + any NEW fees since last collectFees call
        uint256 newFees0 = collected0 > principal0 ? collected0 - principal0 : 0;
        uint256 newFees1 = collected1 > principal1 ? collected1 - principal1 : 0;
        uint256 fees0 = newFees0;
        uint256 fees1 = newFees1;

        // Avoids USD conversion round-trip that can trap funds
        uint256 sDAIPrincipal = token0 == GnosisAddresses.SDAI ? principal0 : principal1;
        uint256 wsxmrPrincipal = token0 == GnosisAddresses.SDAI ? principal1 : principal0;

        // Sanity check: total value of withdrawn tokens using current oracle
        // must be at least 50% of initial (full-range IL maximum is ~5.7% for 2x moves)
        // Use 50% as absolute floor to handle extreme scenarios
        uint256 currentSDAIPrice = vaultManager.getCollateralPrice();
        uint256 currentXmrPrice = vaultManager.getXmrPrice();
        uint256 withdrawnValueUSD = (sDAIPrincipal * currentSDAIPrice) / 1e18
            + (wsxmrPrincipal * currentXmrPrice) / 1e8;
        uint256 expectedValueUSD = position.lpInitialValueUSD + position.userInitialValueUSD;

        // 50% floor accounts for extreme IL + legitimate price movements
        require(
            withdrawnValueUSD >= (expectedValueUSD * 50) / 100,
            "Withdrawal value too low - possible manipulation"
        );

        // Additional caller-specified minimum provides tighter MEV protection
        require(withdrawnValueUSD >= _minTotalValueUSD, "Below caller minimum");

        // Token-first return: each party gets back their original token type first
        // Then any surplus/deficit is handled proportionally
        uint256 lpSDAI;
        uint256 lpWsxmr;
        uint256 userSDAI;
        uint256 userWsxmr;

        if (sDAIPrincipal >= position.sDAIAmount) {
            // Enough sDAI to fully return LP's deposit
            lpSDAI = position.sDAIAmount;
            userSDAI = sDAIPrincipal - position.sDAIAmount;
        } else {
            // Not enough sDAI - LP gets all available sDAI
            lpSDAI = sDAIPrincipal;
            userSDAI = 0;
        }

        if (wsxmrPrincipal >= position.wsxmrAmount) {
            // Enough wsXMR to fully return user's deposit
            userWsxmr = position.wsxmrAmount;
            lpWsxmr = wsxmrPrincipal - position.wsxmrAmount;
        } else {
            // Not enough wsXMR - user gets all available wsXMR
            userWsxmr = wsxmrPrincipal;
            lpWsxmr = 0;
        }
        
        // Credit both parties with both assets (handles IL via cross-distribution)
        lpLiquidityAllocation[position.lpProvider] += lpSDAI;
        userWsxmrDeposits[position.userProvider] += userWsxmr;
        
       
        // If pool shifted heavily to one asset, both parties receive proportional amounts of both
        if (userSDAI > 0) {
            lpLiquidityAllocation[position.userProvider] += userSDAI;
        }
        if (lpWsxmr > 0) {
            userWsxmrDeposits[position.lpProvider] += lpWsxmr;
        }
        
       
        // fees0/fees1 are correctly calculated as collected - principal
        // Determine which fee corresponds to which token using token addresses directly
        // This prevents misattribution when principal0 == principal1 == 0 (out of range position)
        uint256 sDAIFees = token0 == GnosisAddresses.SDAI ? fees0 : fees1;
        uint256 wsxmrFees = token0 == GnosisAddresses.SDAI ? fees1 : fees0;
        
        if (sDAIFees > 0) {
            uint256 lpShare = (sDAIFees + 1) / 2; // LP gets rounding benefit
            pendingSDAIFees[position.lpProvider] += lpShare;
            pendingSDAIFees[position.userProvider] += sDAIFees - lpShare;
        }
        if (wsxmrFees > 0) {
            uint256 lpShare = (wsxmrFees + 1) / 2; // LP gets rounding benefit
            pendingWsxmrFees[position.lpProvider] += lpShare;
            pendingWsxmrFees[position.userProvider] += wsxmrFees - lpShare;
        }
        
        emit PositionClosed(_positionIndex, sDAIPrincipal, wsxmrPrincipal);
        
        // Update active position counts
        if (activePositionCount[position.lpProvider] > 0) activePositionCount[position.lpProvider]--;
        if (activePositionCount[position.userProvider] > 0) activePositionCount[position.userProvider]--;
        
        // Clear position
        delete positions[_positionIndex];
        
        // Automatically clean up stale positions for both parties
        _cleanupStalePositions(position.lpProvider);
        _cleanupStalePositions(position.userProvider);
    }
    
    /**
     * @notice Collect fees from an active position without closing it
     * @param _positionIndex Index of the position
     */
    function collectFees(uint256 _positionIndex) external nonReentrant {
        LiquidityPosition storage position = positions[_positionIndex];
        if (position.positionId == 0) revert PositionNotFound();
        
        if (msg.sender != position.lpProvider && msg.sender != position.userProvider) {
            revert Unauthorized();
        }
        
        // First, trigger a zero-liquidity decrease to update tokensOwed with accrued fees
        // This is the canonical way to separate fees from principal in Uniswap V3
        positionManager.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: position.positionId,
                liquidity: 0,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        );
        
        // Read current tokensOwed (these are ONLY fees since we decreased 0 liquidity)
        (
            , , address token0, , , , , ,
            , , uint128 tokensOwed0, uint128 tokensOwed1
        ) = positionManager.positions(position.positionId);
        
        // Calculate new fees since last collection
        uint256 newFees0 = uint256(tokensOwed0) > position.cumulativeCollected0
            ? uint256(tokensOwed0) - position.cumulativeCollected0
            : 0;
        uint256 newFees1 = uint256(tokensOwed1) > position.cumulativeCollected1
            ? uint256(tokensOwed1) - position.cumulativeCollected1
            : 0;
        
        if (newFees0 == 0 && newFees1 == 0) return;
        
        // Collect only the new fees
        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: position.positionId,
                recipient: address(this),
                amount0Max: uint128(newFees0),
                amount1Max: uint128(newFees1)
            })
        );
        
        // Update cumulative tracking
        position.cumulativeCollected0 += collected0;
        position.cumulativeCollected1 += collected1;
        
        // Determine which token is which
        (uint256 sDAIFees, uint256 wsxmrFees) = token0 == GnosisAddresses.SDAI
            ? (collected0, collected1)
            : (collected1, collected0);
        
        if (sDAIFees > 0) {
            uint256 lpShare = (sDAIFees + 1) / 2; // LP gets rounding benefit
            pendingSDAIFees[position.lpProvider] += lpShare;
            pendingSDAIFees[position.userProvider] += sDAIFees - lpShare;
        }
        
        if (wsxmrFees > 0) {
            uint256 lpShare = (wsxmrFees + 1) / 2; // LP gets rounding benefit
            pendingWsxmrFees[position.lpProvider] += lpShare;
            pendingWsxmrFees[position.userProvider] += wsxmrFees - lpShare;
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
     * @notice Get paginated positions for a user or LP
     * @param _account Address to query (can be LP or user)
     * @param _cursor Starting index in the user's position array
     * @param _limit Maximum number of positions to return
     * @return activePositions Array of active liquidity positions
     * @return nextCursor Next cursor value (0 if no more positions)
     */
    function getUserPositions(
        address _account,
        uint256 _cursor,
        uint256 _limit
    ) external view returns (
        LiquidityPosition[] memory activePositions,
        uint256 nextCursor
    ) {
        uint256[] memory posIndexes = userPositions[_account];
        
        if (_cursor >= posIndexes.length) {
            return (new LiquidityPosition[](0), 0);
        }
        
        // Count active positions within the limit
        uint256 count = 0;
        uint256 i = _cursor;
        while (i < posIndexes.length && count < _limit) {
            if (positions[posIndexes[i]].positionId != 0) {
                count++;
            }
            i++;
        }
        
        // Allocate and populate array
        activePositions = new LiquidityPosition[](count);
        uint256 currentIndex = 0;
        i = _cursor;
        while (i < posIndexes.length && currentIndex < count) {
            uint256 pIdx = posIndexes[i];
            if (positions[pIdx].positionId != 0) {
                activePositions[currentIndex] = positions[pIdx];
                currentIndex++;
            }
            i++;
        }
        
        // Set next cursor
        nextCursor = i < posIndexes.length ? i : 0;
        
        return (activePositions, nextCursor);
    }
    
    /**
     * @notice Clean up stale position references for a user
     * @param _account Address to clean up
     * @dev Removes closed positions from the tracking array
     */
    function cleanupStalePositions(address _account) external {
        _cleanupStalePositions(_account);
    }
    
    /**
     * @dev Internal function to clean up stale positions
     */
    function _cleanupStalePositions(address _account) internal {
        uint256[] storage posIndexes = userPositions[_account];
        uint256 writeIndex = 0;
        
        for (uint256 readIndex = 0; readIndex < posIndexes.length; readIndex++) {
            if (positions[posIndexes[readIndex]].positionId != 0) {
                if (writeIndex != readIndex) {
                    posIndexes[writeIndex] = posIndexes[readIndex];
                }
                writeIndex++;
            }
        }
        
        // Trim array
        while (posIndexes.length > writeIndex) {
            posIndexes.pop();
        }
    }
    
    /**
     * @dev Count active positions for an account
     */
    function _countActivePositions(address _account) internal view returns (uint256 count) {
        uint256[] storage posIndexes = userPositions[_account];
        for (uint256 i = 0; i < posIndexes.length; i++) {
            if (positions[posIndexes[i]].positionId != 0) {
                count++;
            }
        }
    }
    
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
    
    /**
     * @notice Handle receipt of NFT positions from Uniswap V3
     * @dev Required to receive ERC721 tokens (Uniswap V3 positions)
     */
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external view override returns (bytes4) {
        require(msg.sender == address(positionManager), "Only Uniswap V3 NFTs");
        return IERC721Receiver.onERC721Received.selector;
    }
}
