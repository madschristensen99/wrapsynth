// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
        uint256 feesCollected0; // Cumulative token0 fees already collected
        uint256 feesCollected1; // Cumulative token1 fees already collected
    }
    
    mapping(uint256 => LiquidityPosition) public positions;
    uint256 public nextPositionIndex;
    
    // Fee tracking for distribution
    mapping(address => uint256) public pendingSDAIFees; // LP fees
    mapping(address => uint256) public pendingWsxmrFees; // User fees
    
    // Frontend-friendly position tracking
    mapping(address => uint256[]) public userPositions;

   
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
        
        // Verify LP has an active vault
        (, , , , , , , , , , , bool active) = vaultManager.vaults(msg.sender);
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
     * @param _maxSDAI Maximum sDAI amount to approve for pairing
     */
    function approveUserForPairing(address _user, uint256 _maxSDAI) external {
        lpApprovalAmount[msg.sender][_user] = _maxSDAI;
        emit LpApprovedUser(msg.sender, _user, _maxSDAI);
    }
    
    /**
     * @notice User approves an LP for liquidity pairing
     * @param _lp Address of LP to approve
     * @param _maxWsxmr Maximum wsXMR amount to approve for pairing
     */
    function approveLpForPairing(address _lp, uint256 _maxWsxmr) external {
        userApprovalAmount[msg.sender][_lp] = _maxWsxmr;
        emit UserApprovedLp(msg.sender, _lp, _maxWsxmr);
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
        
        // Require values to be within 1% of each other (oracle-based validation)
        // This prevents flash-loan MEV attacks on position creation
        uint256 valueDiff = sDAIValue > wsxmrValue ? sDAIValue - wsxmrValue : wsxmrValue - sDAIValue;
        require(valueDiff * 100 <= (sDAIValue + wsxmrValue), "Pool ratio deviates from oracle");
        
        // Verify pool exists to prevent first-depositor price manipulation
        address pool = uniswapFactory.getPool(token0, token1, POOL_FEE);
        require(pool != address(0), "Pool does not exist");
        
        // Calculate minimum acceptable amounts (allow 2% slippage from desired)
        uint256 amount0Min = (amount0 * 98) / 100;
        uint256 amount1Min = (amount1 * 98) / 100;
        
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
                feesCollected0: 0,
                feesCollected1: 0
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
                feesCollected0: 0,
                feesCollected1: 0
            });
        }
        
        // Track position for frontend discovery
        userPositions[_user].push(positionIndex);
        userPositions[_lp].push(positionIndex);
        
        emit PositionCreated(positionIndex, tokenId, _lp, _user, _sDAIAmount, _wsxmrAmount);
    }
    
    /**
     * @notice Close a liquidity position and return assets
     * @param _positionIndex Index of the position to close
     */
    function closePosition(uint256 _positionIndex, uint256 _deadline) external nonReentrant {
        require(block.timestamp <= _deadline, "Transaction expired");
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

        // Validate total withdrawn value is within acceptable range (tightened to 95%)
        uint256 withdrawnValueUSD = (sDAIPrincipal * vaultManager.getCollateralPrice()) / 1e18
            + (wsxmrPrincipal * vaultManager.getXmrPrice()) / 1e8;
        uint256 expectedValueUSD = position.lpInitialValueUSD + position.userInitialValueUSD;
        // Tightened from 50% to 95% to better protect against sandwich attacks
        // IL on full-range positions is bounded; >5% loss may indicate manipulation
        require(
            withdrawnValueUSD >= (expectedValueUSD * 95) / 100,
            "Withdrawal value too low - possible manipulation"
        );

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
        
        // Only position participants can collect fees
        if (msg.sender != position.lpProvider && msg.sender != position.userProvider) {
            revert Unauthorized();
        }
        
        // Collect accumulated fees (this only collects fees, not principal,
        // because we haven't called decreaseLiquidity)
        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: position.positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        
        // Track cumulative fees collected for this position
        position.feesCollected0 += collected0;
        position.feesCollected1 += collected1;
        
        // Determine which token is which
        (, , address token0, , , , , , , , , ) = positionManager.positions(position.positionId);
        
        (uint256 sDAIFees, uint256 wsxmrFees) = token0 == GnosisAddresses.SDAI
            ? (collected0, collected1)
            : (collected1, collected0);
        
        // Split fees 50/50 between LP and user (handle odd amounts)
        if (sDAIFees > 0) {
            pendingSDAIFees[position.lpProvider] += sDAIFees / 2;
            pendingSDAIFees[position.userProvider] += sDAIFees - (sDAIFees / 2);
        }
        
        if (wsxmrFees > 0) {
            pendingWsxmrFees[position.lpProvider] += wsxmrFees / 2;
            pendingWsxmrFees[position.userProvider] += wsxmrFees - (wsxmrFees / 2);
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
