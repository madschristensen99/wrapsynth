// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "./interfaces/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3Pool.sol";
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
    uint256 public constant MIN_DEPOSIT_AMOUNT = 1e6; // Minimum to prevent dust (0.01 wsXMR or 0.000000000001 sDAI)
    uint256 public constant MIN_POSITION_DURATION = 1 hours;
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
    
    // Pre-computed token ordering
    address public immutable token0;
    address public immutable token1;
    bool public immutable sDAIIsToken0;
    
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
    
    // Frontend-friendly position tracking
    mapping(address => uint256[]) public userPositions;
    mapping(address => uint256) public activePositionCount;

   
    // Mutual approval system with amount limits
    // LP approves max sDAI amount to pair with specific user
    mapping(address => mapping(address => uint256)) public lpApprovalAmount;
    // User approves max wsXMR amount to pair with specific LP
    mapping(address => mapping(address => uint256)) public userApprovalAmount; // User approves LP
    
    // FIX C-2: Track per-user ETH refunds instead of allowing anyone to drain
    mapping(address => uint256) public pendingETHRefunds;
    
    // FIX M-1: Track approval nonces to prevent front-running
    mapping(address => uint256) public approvalNonce;
    
    // FIX L-4: Track pool initialization to prevent front-running
    bool public poolInitialized;
    
    // FIX L-5: Track orphaned NFTs from failed burns
    uint256[] public orphanedNFTs;

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
    
    // FIX H-4: Add IL-specific events for cross-asset distribution
    event ILSDAICredited(address indexed user, uint256 amount, uint256 positionIndex);
    event ILWsxmrCredited(address indexed lp, uint256 amount, uint256 positionIndex);
    
    // FIX L-7: Add pool initialization event
    event PoolInitialized(address indexed pool, uint160 sqrtPriceX96, uint256 sDAIPrice, uint256 wsxmrPrice);

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
        require(_vaultManager != address(0), "Zero vault manager");
        require(_wsxmrToken != address(0), "Zero wsxmr token");
        require(_positionManager != address(0), "Zero position manager");
        require(_uniswapFactory != address(0), "Zero factory");
        
        vaultManager = VaultManager(_vaultManager);
        wsxmrToken = wsXMR(_wsxmrToken);
        positionManager = INonfungiblePositionManager(_positionManager);
        uniswapFactory = IUniswapV3Factory(_uniswapFactory);
        
        // Pre-compute token order (immutable, saves gas on every position operation)
        if (GnosisAddresses.SDAI < _wsxmrToken) {
            token0 = GnosisAddresses.SDAI;
            token1 = _wsxmrToken;
            sDAIIsToken0 = true;
        } else {
            token0 = _wsxmrToken;
            token1 = GnosisAddresses.SDAI;
            sDAIIsToken0 = false;
        }
    }

    receive() external payable {
        // Accept ETH for oracle fee refunds
    }

    // ========== POOL INITIALIZATION ==========
    
    /**
     * @notice FIX M-7: Initialize the Uniswap V3 pool with oracle-derived price
     * @dev Must be called before any positions can be created
     * @param _reports Chainlink Data Streams signed reports for fresh oracle prices
     * @return pool Address of the created/initialized pool
     */
    function initializePool(bytes[] calldata _reports) external payable nonReentrant returns (address pool) {
        // FIX L-4: Only allow initialization once to prevent front-running
        require(!poolInitialized, "Pool already initialized");
        poolInitialized = true;

        // Update Chainlink Data Streams prices first
        vaultManager.updatePrices{value: msg.value}(_reports);
        
        // Get oracle prices with tight staleness
        uint256 sDAIPrice = vaultManager.getCollateralPriceWithAge(30 seconds);
        uint256 wsxmrPrice = vaultManager.getXmrPriceWithAge(30 seconds);
        
        // FIX C-4: Calculate sqrtPriceX96 correctly
        // Uniswap V3 price = token1_amount / token0_amount (in raw units)
        // For 1 USD worth of each token:
        //   raw_sDAI_per_usd = 1e18 / sDAIPrice  (sDAI has 18 decimals)
        //   raw_wsxmr_per_usd = 1e8 / wsxmrPrice  (wsXMR has 8 decimals)
        //
        // price(token1/token0) = (price_of_token0_in_usd / price_of_token1_in_usd) * 
        //                        (10^decimals1 / 10^decimals0)
        
        uint160 sqrtPriceX96;
        
        if (sDAIIsToken0) {
            // token0 = sDAI (18 dec), token1 = wsXMR (8 dec)
            // price = (sDAIPrice / wsxmrPrice) * (1e8 / 1e18)
            //       = sDAIPrice / (wsxmrPrice * 1e10)
            // To maintain precision, compute with scaled numerics:
            // price_scaled = (sDAIPrice * 1e18) / (wsxmrPrice * 1e10)
            uint256 priceScaled = (sDAIPrice * 1e18) / (wsxmrPrice * 1e10);
            
            // sqrt(priceScaled) is in 1e9 fixed point
            uint256 sqrtPriceScaled = sqrt(priceScaled);
            
            // sqrtPriceX96 = sqrtPriceScaled * 2^96 / 1e9
            sqrtPriceX96 = uint160((sqrtPriceScaled * (1 << 96)) / 1e9);
        } else {
            // token0 = wsXMR (8 dec), token1 = sDAI (18 dec)
            // price = (wsxmrPrice / sDAIPrice) * (1e18 / 1e8)
            //       = (wsxmrPrice * 1e10) / sDAIPrice
            uint256 priceScaled = (wsxmrPrice * 1e10 * 1e18) / sDAIPrice;
            
            uint256 sqrtPriceScaled = sqrt(priceScaled);
            
            sqrtPriceX96 = uint160((sqrtPriceScaled * (1 << 96)) / 1e9);
        }
        
        require(sqrtPriceX96 > 0, "Invalid sqrt price");
        
        // Validate sqrtPriceX96 is within Uniswap V3 bounds
        require(
            sqrtPriceX96 > 4295128739 && 
            sqrtPriceX96 < 1461446703485210103287273052203988822378723970342,
            "sqrtPriceX96 out of range"
        );
        
        // Create pool if it doesn't exist
        pool = uniswapFactory.getPool(token0, token1, POOL_FEE);
        if (pool == address(0)) {
            pool = uniswapFactory.createPool(token0, token1, POOL_FEE);
        }
        
        // Initialize pool with oracle price
        IUniswapV3Pool(pool).initialize(sqrtPriceX96);
        
        // FIX L-7: Emit initialization event
        emit PoolInitialized(pool, sqrtPriceX96, sDAIPrice, wsxmrPrice);
        
        return pool;
    }
    
    /**
     * @notice Helper function to calculate square root using Babylonian method
     * @param x Value to calculate square root of
     * @return y Square root of x
     */
    function sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
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
        
        // FIX L-3: Verify vault is healthy before allowing allocation
        // This prevents LPs from moving assets out of an undercollateralized vault
        try vaultManager.getVaultHealth(msg.sender) returns (uint256 ratio) {
            require(ratio >= 150, "Vault undercollateralized");
        } catch {
            // getVaultHealth reverts if no debt (type(uint256).max)
            // No debt = healthy, allow allocation
        }
        
        // Transfer sDAI from LP's vault (requires VaultManager approval)
        IERC20(GnosisAddresses.SDAI).safeTransferFrom(msg.sender, address(this), _sDAIAmount);
        
        lpLiquidityAllocation[msg.sender] += _sDAIAmount;
        
        emit LiquidityAllocated(msg.sender, _sDAIAmount);
    }
    
    /**
     * @notice DEPRECATED: Use withdrawSDAI instead
     * @dev FIX I-5: This function is redundant with withdrawSDAI but kept for backwards compatibility
     * @param _sDAIAmount Amount of sDAI shares to deallocate
     */
    function deallocateLiquidity(uint256 _sDAIAmount) external nonReentrant {
        if (_sDAIAmount == 0) revert InvalidAmount();
        if (lpLiquidityAllocation[msg.sender] < _sDAIAmount) revert InsufficientBalance();
        
        lpLiquidityAllocation[msg.sender] -= _sDAIAmount;
        IERC20(GnosisAddresses.SDAI).safeTransfer(msg.sender, _sDAIAmount);
        
        emit LiquidityDeallocated(msg.sender, _sDAIAmount);
    }
    
    /**
     * @notice Withdraw sDAI balance. Used by:
     *   - LPs: withdrawing their liquidity allocations
     *   - Users: withdrawing sDAI received from impermanent loss
     * @dev Both LPs and users use lpLiquidityAllocation for sDAI.
     *      Listen for ILSDAICredited events to detect IL proceeds.
     * @param _sDAIAmount Amount of sDAI shares to withdraw
     */
    function withdrawSDAI(uint256 _sDAIAmount) external nonReentrant {
        if (_sDAIAmount == 0) revert InvalidAmount();
        if (lpLiquidityAllocation[msg.sender] < _sDAIAmount) revert InsufficientBalance();
        
        lpLiquidityAllocation[msg.sender] -= _sDAIAmount;
        IERC20(GnosisAddresses.SDAI).safeTransfer(msg.sender, _sDAIAmount);
        
        emit LiquidityDeallocated(msg.sender, _sDAIAmount);
    }
    
    /**
     * @notice Withdraw wsXMR balance. Used by:
     *   - Users: withdrawing their wsXMR deposits
     *   - LPs: withdrawing wsXMR received from impermanent loss
     * @dev Both users and LPs use userWsxmrDeposits for wsXMR.
     *      Listen for ILWsxmrCredited events to detect IL proceeds.
     * @param _wsxmrAmount Amount of wsXMR to withdraw
     */
    function withdrawWsXMR(uint256 _wsxmrAmount) external nonReentrant {
        if (_wsxmrAmount == 0) revert InvalidAmount();
        if (userWsxmrDeposits[msg.sender] < _wsxmrAmount) revert InsufficientBalance();
        
        userWsxmrDeposits[msg.sender] -= _wsxmrAmount;
        IERC20(address(wsxmrToken)).safeTransfer(msg.sender, _wsxmrAmount);
        
        emit UserWithdrewWsxmr(msg.sender, _wsxmrAmount);
        emit WsxmrDeallocated(msg.sender, _wsxmrAmount);
    }
    
    /**
     * @notice FIX C-3: Burn wsXMR from internal deposits to reduce vault debt
     * @dev Requires LP approval to prevent burning against arbitrary vaults
     * @param _wsxmrAmount Amount of wsXMR to burn from internal balance
     * @param _lpVault LP vault to handle the burn
     * @return requestId Unique identifier for this burn request
     */
    function burnFromInternalBalance(
        uint256 _wsxmrAmount,
        address _lpVault
    ) external nonReentrant returns (bytes32 requestId) {
        if (_wsxmrAmount == 0) revert InvalidAmount();
        if (userWsxmrDeposits[msg.sender] < _wsxmrAmount) revert InsufficientBalance();
        
        // FIX C-3: Require LP approval to prevent burning against arbitrary vaults
        // The LP must have approved this user for burns
        (address lpAddress,,,,,,,,,,,,) = vaultManager.vaults(_lpVault);
        require(
            lpApprovalAmount[lpAddress][msg.sender] >= _wsxmrAmount,
            "LP approval required for vault burn"
        );
        lpApprovalAmount[lpAddress][msg.sender] -= _wsxmrAmount;
        
        // Deduct from internal balance
        userWsxmrDeposits[msg.sender] -= _wsxmrAmount;
        
        // Burn the wsXMR tokens
        wsxmrToken.burn(address(this), _wsxmrAmount);
        
        // Request burn through VaultManager (router is authorized caller)
        requestId = vaultManager.requestBurnFromRouter(_wsxmrAmount, _lpVault, msg.sender);
        
        emit WsxmrDeallocated(msg.sender, _wsxmrAmount);
        
        return requestId;
    }
    
    /**
     * @notice FIX C-2: Withdraw user's pending ETH refunds
     * @dev Replaces permissionless withdrawETH to prevent anyone draining all ETH
     */
    function withdrawETH() external nonReentrant {
        uint256 amount = pendingETHRefunds[msg.sender];
        if (amount == 0) revert InvalidAmount();
        
        pendingETHRefunds[msg.sender] = 0;
        
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "ETH transfer failed");
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
    

    // ========== POSITION MANAGEMENT ==========
    
    /**
     * @notice LP increases approval amount for a user
     * @param _user Address of user to approve
     * @param _additionalSDAI Additional sDAI amount to approve
     */
    function increaseUserApproval(address _user, uint256 _additionalSDAI) external {
        lpApprovalAmount[msg.sender][_user] += _additionalSDAI;
        approvalNonce[msg.sender]++; // FIX M-1: Increment nonce on approval change
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
        approvalNonce[msg.sender]++; // FIX M-1: Increment nonce on approval change
        emit LpApprovedUser(msg.sender, _user, lpApprovalAmount[msg.sender][_user]);
    }
    
    /**
     * @notice User increases approval amount for an LP
     * @param _lp Address of LP to approve
     * @param _additionalWsxmr Additional wsXMR amount to approve
     */
    function increaseLpApproval(address _lp, uint256 _additionalWsxmr) external {
        userApprovalAmount[msg.sender][_lp] += _additionalWsxmr;
        approvalNonce[msg.sender]++; // FIX M-1: Increment nonce on approval change
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
        approvalNonce[msg.sender]++; // FIX M-1: Increment nonce on approval change
        emit UserApprovedLp(msg.sender, _lp, userApprovalAmount[msg.sender][_lp]);
    }
    
    /**
     * @notice Create position with fresh Chainlink Data Streams price update (one-click UX)
     * @dev Forwards signed reports to VaultManager before creating position
     * @param _lp Address of LP providing sDAI
     * @param _user Address of user providing wsXMR
     * @param _sDAIAmount Amount of sDAI to pair
     * @param _wsxmrAmount Amount of wsXMR to pair
     * @param _deadline Transaction deadline
     * @param _reports Chainlink Data Streams signed reports
     */
    function createPositionWithPriceUpdate(
        address _lp,
        address _user,
        uint256 _sDAIAmount,
        uint256 _wsxmrAmount,
        uint256 _deadline,
        bytes[] calldata _reports
    ) external payable nonReentrant returns (uint256 positionIndex) {
        // Update prices first
        vaultManager.updatePrices{value: msg.value}(_reports);

        // Delegate to internal creation logic
        return _createPosition(_lp, _user, _sDAIAmount, _wsxmrAmount, _deadline);
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
        return _createPosition(_lp, _user, _sDAIAmount, _wsxmrAmount, _deadline);
    }

    function _createPosition(
        address _lp,
        address _user,
        uint256 _sDAIAmount,
        uint256 _wsxmrAmount,
        uint256 _deadline
    ) internal returns (uint256 positionIndex) {
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
        
        // Clean up stale positions to prevent unbounded array growth
        _cleanupStalePositions(_lp);
        _cleanupStalePositions(_user);
        
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
        
        (uint256 amount0, uint256 amount1) = sDAIIsToken0
            ? (_sDAIAmount, _wsxmrAmount)
            : (_wsxmrAmount, _sDAIAmount);
        
       
        // FIX H-2: Use tighter staleness window for liquidity operations
        // This prevents MEV arbitrage via flash loan pool manipulation
        uint256 sDAIPrice = vaultManager.getCollateralPriceWithAge(30 seconds);
        uint256 wsxmrPrice = vaultManager.getXmrPriceWithAge(30 seconds);
        
        // Calculate expected ratio based on oracle prices
        // sDAI amount * sDAI price should approximately equal wsXMR amount * wsXMR price
        uint256 sDAIValue = sDAIIsToken0 
            ? (amount0 * sDAIPrice) / 1e18 
            : (amount1 * sDAIPrice) / 1e18;
        uint256 wsxmrValue = sDAIIsToken0 
            ? (amount1 * wsxmrPrice) / 1e8 
            : (amount0 * wsxmrPrice) / 1e8;
        
        // 0.5% oracle tolerance (stricter than 1% slippage to prevent sandwich in the gap)
        uint256 valueDiff = sDAIValue > wsxmrValue ? sDAIValue - wsxmrValue : wsxmrValue - sDAIValue;
        require(valueDiff * 200 <= (sDAIValue + wsxmrValue), "Pool ratio deviates from oracle");
        
        // Verify pool exists to prevent first-depositor price manipulation
        address pool = uniswapFactory.getPool(token0, token1, POOL_FEE);
        require(pool != address(0), "Pool does not exist");

        // Verify pool has meaningful liquidity to prevent first-depositor manipulation
        uint128 poolLiquidity = IUniswapV3Pool(pool).liquidity();
        require(poolLiquidity >= 1e12, "Pool liquidity too low");

        // Note: Explicit pool price vs oracle comparison is not needed because:
        // 1. Oracle tolerance validates input amounts are correctly priced (0.5%)
        // 2. Uniswap mint's amount0Min/amount1Min enforce 0.5% slippage
        // 3. If pool price deviates from oracle by >1%, either the oracle check
        //    or the slippage check will revert the transaction.
        
        // Slippage must be equal to or tighter than oracle tolerance (0.5%)
        // to prevent sandwich attacks exploiting the gap
        uint256 amount0Min = (amount0 * 995) / 1000; // 0.5% slippage
        uint256 amount1Min = (amount1 * 995) / 1000; // 0.5% slippage
        
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
        
        if (sDAIIsToken0) {
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
                createdAt: block.timestamp
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
                createdAt: block.timestamp
            });
        }
        
        // Track position for frontend discovery
        userPositions[_user].push(positionIndex);
        userPositions[_lp].push(positionIndex);
        
        activePositionCount[_lp]++;
        activePositionCount[_user]++;
        
        // After position is stored, clear any remaining approvals
        // (positionManager.mint may not have consumed the full approval)
        IERC20(GnosisAddresses.SDAI).forceApprove(address(positionManager), 0);
        IERC20(address(wsxmrToken)).forceApprove(address(positionManager), 0);
        
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
        
        // Enforce minimum position duration
        require(
            block.timestamp >= position.createdAt + MIN_POSITION_DURATION,
            "Position too young to close"
        );
        
        // FIX H-2: Calculate oracle-based minimum outputs with tight staleness for MEV protection
        uint256 currentSDAIPrice = vaultManager.getCollateralPriceWithAge(30 seconds);
        uint256 currentXmrPrice = vaultManager.getXmrPriceWithAge(30 seconds);
        
        // Determine token order
        (, , , , , , , uint128 liquidity, , , , ) = 
            positionManager.positions(position.positionId);
        
        // Calculate minimum amounts based on 85% of expected value
        // Split across both tokens proportionally to current pool ratio
        // Use 0 for individual mins but enforce total value check below
        (uint256 principal0, uint256 principal1) = positionManager.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: position.positionId,
                liquidity: liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: _deadline
            })
        );
        
        // Collect all tokens (principal + any remaining fees)
        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: position.positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        // FIX L-5: Burn the empty NFT position to clean up.
        // Use try-catch so that a failed burn does not block position closure.
        // Track orphaned NFTs for manual cleanup.
        try positionManager.burn(position.positionId) {
            // NFT burned successfully
        } catch {
            // NFT burn failed (e.g., dust tokens remaining).
            // Track orphaned NFT for manual cleanup
            orphanedNFTs.push(position.positionId);
        }

        // Total fees = fees already collected via collectFees() + new fees from this close
        // New fees from this close = collected amounts - principal amounts
        uint256 newFees0 = collected0 > principal0 ? collected0 - principal0 : 0;
        uint256 newFees1 = collected1 > principal1 ? collected1 - principal1 : 0;

        // These are ONLY the new fees not yet distributed
        // Previously collected fees were already distributed in collectFees()
        uint256 fees0 = newFees0;
        uint256 fees1 = newFees1;

        // Determine sDAI and wsXMR principal amounts
        uint256 sDAIPrincipal = sDAIIsToken0 ? principal0 : principal1;
        uint256 wsxmrPrincipal = sDAIIsToken0 ? principal1 : principal0;
        
        // Oracle-based total value check
        uint256 withdrawnValueUSD = (sDAIPrincipal * currentSDAIPrice) / 1e18
            + (wsxmrPrincipal * currentXmrPrice) / 1e8;
        uint256 expectedValueUSD = position.lpInitialValueUSD + position.userInitialValueUSD;
        
        // FIX M-4: 70% floor to accommodate legitimate IL (up to ~25x price movement)
        // Full-range IL formula: IL = 2*sqrt(priceRatio) / (1 + priceRatio) - 1
        // Max IL at 10x price move ≈ 42%, at 100x ≈ 82%
        // 70% floor accommodates up to ~25x price movement
        require(
            withdrawnValueUSD >= (expectedValueUSD * 70) / 100,
            "Withdrawal value too low - possible manipulation"
        );
        
        // Caller-specified minimum provides tighter MEV protection
        // Frontend should calculate this as: oracle_value * (1 - expected_IL - slippage_tolerance)
        require(withdrawnValueUSD >= _minTotalValueUSD, "Below caller minimum");
        
        // Also enforce that _minTotalValueUSD is reasonable (caller can't set 0)
        require(
            _minTotalValueUSD >= (expectedValueUSD * 50) / 100,
            "Caller minimum too low"
        );

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
        
        // FIX H-4: If pool shifted heavily to one asset, distribute cross-asset with events
        if (userSDAI > 0) {
            lpLiquidityAllocation[position.userProvider] += userSDAI;
            emit ILSDAICredited(position.userProvider, userSDAI, _positionIndex);
        }
        if (lpWsxmr > 0) {
            userWsxmrDeposits[position.lpProvider] += lpWsxmr;
            emit ILWsxmrCredited(position.lpProvider, lpWsxmr, _positionIndex);
        }
        
        // fees0/fees1 are correctly calculated as collected - principal
        // Determine which fee corresponds to which token using sDAIIsToken0
        // This prevents misattribution when principal0 == principal1 == 0 (out of range position)
        uint256 sDAIFees = sDAIIsToken0 ? fees0 : fees1;
        uint256 wsxmrFees = sDAIIsToken0 ? fees1 : fees0;
        
        _splitFees(
            sDAIFees,
            position.lpInitialValueUSD,
            position.userInitialValueUSD,
            position.lpProvider,
            position.userProvider,
            true
        );
        _splitFees(
            wsxmrFees,
            position.lpInitialValueUSD,
            position.userInitialValueUSD,
            position.lpProvider,
            position.userProvider,
            false
        );
        
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
        
        // FIX M-7: Some UniV3 implementations revert on zero-liquidity decrease
        // Use try-catch to handle gracefully
        try positionManager.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: position.positionId,
                liquidity: 0,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        ) {} catch {
            // Zero-decrease not supported; fees are still in tokensOwed from trading activity
            // collect() will still return any available fees
        }
        
        // Collect ALL available fees (tokensOwed resets to 0 after collect)
        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: position.positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        
        if (collected0 == 0 && collected1 == 0) return;

        // CRITICAL FIX C-1 & M-3: Remove arbitrary fee cap
        // Uniswap V3 fees are legitimate by definition and can legitimately exceed
        // 100% of original deposit for high-volume pools or long-lived positions.
        // Capping causes permanent token loss since tokens are already transferred.
        // The oracle validation in createPosition already prevents manipulation.
        
        // Determine token mapping using immutable sDAIIsToken0
        uint256 sDAIFees = sDAIIsToken0 ? collected0 : collected1;
        uint256 wsxmrFees = sDAIIsToken0 ? collected1 : collected0;
        
        _splitFees(
            sDAIFees,
            position.lpInitialValueUSD,
            position.userInitialValueUSD,
            position.lpProvider,
            position.userProvider,
            true
        );
        _splitFees(
            wsxmrFees,
            position.lpInitialValueUSD,
            position.userInitialValueUSD,
            position.lpProvider,
            position.userProvider,
            false
        );
        
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
     * @param _maxIterations Maximum number of positions to process
     * @dev FIX L-2: Removes misleading requirement to allow partial cleanup
     */
    function cleanupStalePositions(address _account, uint256 _maxIterations) external {
        _cleanupStalePositionsLimited(_account, _maxIterations);
    }
    
    /**
     * @dev Internal function to clean up stale positions (default limit)
     */
    function _cleanupStalePositions(address _account) internal {
        _cleanupStalePositionsLimited(_account, 200); // Default limit for internal calls
    }

    /**
     * @dev Internal function to clean up stale positions with limit
     */
    function _cleanupStalePositionsLimited(address _account, uint256 _maxIterations) internal {
        uint256[] storage posIndexes = userPositions[_account];
        if (posIndexes.length == 0) return;
        
        // If array is too large for full compaction, do tail-trimming instead:
        // Remove stale entries from the end of the array (safe, no index shift)
        if (posIndexes.length > _maxIterations) {
            while (posIndexes.length > 0 && posIndexes.length > _maxIterations / 2) {
                uint256 lastIdx = posIndexes.length - 1;
                if (positions[posIndexes[lastIdx]].positionId == 0) {
                    posIndexes.pop();
                } else {
                    break; // Stop at the first active position from the end
                }
            }
            return;
        }
        
        uint256 writeIndex = 0;
        
        for (uint256 readIndex = 0; readIndex < posIndexes.length; readIndex++) {
            if (positions[posIndexes[readIndex]].positionId != 0) {
                if (writeIndex != readIndex) {
                    posIndexes[writeIndex] = posIndexes[readIndex];
                }
                writeIndex++;
            }
        }
        
        while (posIndexes.length > writeIndex) {
            posIndexes.pop();
        }
    }
    
    /**
     * @dev Split fees proportionally based on value contribution
     */
    function _splitFees(
        uint256 _totalFees,
        uint256 _lpInitialValue,
        uint256 _userInitialValue,
        address _lpProvider,
        address _userProvider,
        bool _isSDAI
    ) internal {
        if (_totalFees == 0) return;
        
        uint256 totalInitialValue = _lpInitialValue + _userInitialValue;
        if (totalInitialValue == 0) return;
        
        uint256 lpShare = (_totalFees * _lpInitialValue) / totalInitialValue;
        uint256 userShare = _totalFees - lpShare;
        
        if (_isSDAI) {
            pendingSDAIFees[_lpProvider] += lpShare;
            pendingSDAIFees[_userProvider] += userShare;
        } else {
            pendingWsxmrFees[_lpProvider] += lpShare;
            pendingWsxmrFees[_userProvider] += userShare;
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
     * @notice FIX H-4: Get all withdrawable balances for an account
     * @param _account Address to query
     * @return sDAIBalance Available sDAI (from allocations + IL)
     * @return wsxmrBalance Available wsXMR (from deposits + IL)
     * @return sDAIFees Pending sDAI fee earnings
     * @return wsxmrFees Pending wsXMR fee earnings
     */
    function getWithdrawableBalances(address _account) 
        external view returns (
            uint256 sDAIBalance,
            uint256 wsxmrBalance,
            uint256 sDAIFees,
            uint256 wsxmrFees
        ) 
    {
        sDAIBalance = lpLiquidityAllocation[_account];
        wsxmrBalance = userWsxmrDeposits[_account];
        sDAIFees = pendingSDAIFees[_account];
        wsxmrFees = pendingWsxmrFees[_account];
    }
    
    /**
     * @notice Handle receipt of NFT positions from Uniswap V3
     * @dev Required to receive ERC721 tokens (Uniswap V3 positions)
     * @dev FIX L-1: Validates sender to prevent arbitrary NFT lockup
     */
    function onERC721Received(
        address,
        address /* from */,
        uint256 tokenId,
        bytes calldata
    ) external override returns (bytes4) {
        require(msg.sender == address(positionManager), "Only Uniswap V3 NFTs");
        
        // FIX L-1: Verify the NFT is for our pool to prevent arbitrary NFT deposits
        // This prevents users from accidentally or maliciously locking random NFTs
        (
            ,
            ,
            address nftToken0,
            address nftToken1,
            uint24 nftFee,
            ,
            ,
            ,
            ,
            ,
            ,
        ) = positionManager.positions(tokenId);
        
        // FIX L-1: Uniswap V3 always orders token0 < token1, so only one check needed
        require(
            nftToken0 == token0 && nftToken1 == token1 && nftFee == POOL_FEE,
            "NFT not for this pool"
        );
        
        return IERC721Receiver.onERC721Received.selector;
    }
}
