// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IwsXmrLiquidityRouter} from "../interfaces/router/IwsXmrLiquidityRouter.sol";
import {ICoLPMatching} from "../interfaces/router/ICoLPMatching.sol";
import {ILiquidityPosition} from "../interfaces/router/ILiquidityPosition.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";
import {IBurnFacet} from "../interfaces/facets/IBurnFacet.sol";
import {IUniswapV3Factory} from "../interfaces/external/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "../interfaces/external/IUniswapV3Pool.sol";
import {INonfungiblePositionManager} from "../interfaces/external/INonfungiblePositionManager.sol";
import {GnosisAddresses} from "../GnosisAddresses.sol";

/**
 * @title wsXMRLiquidityRouter
 * @notice Co-LP router for pairing sDAI LPs with wsXMR holders in Uniswap V3 positions
 * @dev Implements dual-approval matchmaking, IL compensation, and fee splitting
 * 
 * Oracle Integration:
 * - Reads prices from SimpleOracleFacet (pushed by off-chain bot every ~5 min)
 * - No on-chain price updates needed (legacy Pyth integration removed)
 * - oracleUpdateData parameters kept for forward compatibility but ignored
 * - Any ETH sent for "updates" is refunded to pendingETHRefunds
 */
contract wsXMRLiquidityRouter is IwsXmrLiquidityRouter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ========== ERRORS ==========
    
    error ZeroAddress();
    error DeadlineExpired();
    error TransferFailed();

    // ========== IMMUTABLES ==========
    
    address public immutable hub;
    address public immutable wsxmrToken;
    address public immutable sDAI;
    address public immutable dexFactory;
    address public immutable dexPositionManager;

    // ========== STATE ==========
    
    address public pool;
    
    mapping(address => uint256) public lpSDAIBalance;
    mapping(address => uint256) public userWsxmrBalance;
    
    mapping(address => LPConfig) public lpConfigs;
    mapping(address => uint256) public lpTotalExposure;
    
    mapping(uint256 => Position) public positions;
    mapping(address => uint256[]) private _userPositions;
    uint256 public nextPositionIndex;
    
    mapping(address => uint256) public pendingSDAIFees;
    mapping(address => uint256) public pendingWsxmrFees;
    
    mapping(address => uint256) public pendingILSDAI;
    mapping(address => uint256) public pendingILWsxmr;
    
    mapping(address => uint256) public pendingETHRefunds;
    
    mapping(address => uint256) private _activePositionCount;

    // ========== CONSTANTS ==========
    
    uint24 public constant POOL_FEE = 3000;
    int24 public constant TICK_SPACING = 60;
    uint256 public constant MIN_DEPOSIT_AMOUNT = 1e6;
    uint256 public constant MIN_POSITION_DURATION = 1 hours;
    uint256 public constant MAX_ACTIVE_POSITIONS_PER_USER = 50;
    uint256 public constant BPS_DENOMINATOR = 10000;
    
    int24 private constant MIN_TICK = -887220;
    int24 private constant MAX_TICK = 887220;

    // ========== CONSTRUCTOR ==========
    
    constructor(
        address _hub,
        address _wsxmrToken,
        address _sDAI,
        address _dexFactory,
        address _dexPositionManager
    ) {
        if (_hub == address(0) || _wsxmrToken == address(0) || _sDAI == address(0) ||
            _dexFactory == address(0) || _dexPositionManager == address(0)) {
            revert ZeroAddress();
        }
        
        hub = _hub;
        wsxmrToken = _wsxmrToken;
        sDAI = _sDAI;
        dexFactory = _dexFactory;
        dexPositionManager = _dexPositionManager;
    }

    // ========== POOL INITIALIZATION ==========
    
    /// @inheritdoc IwsXmrLiquidityRouter
    function initializePool(bytes[] calldata oracleUpdateData) external payable nonReentrant returns (address) {
        if (pool != address(0)) revert PoolAlreadyInitialized();
        
        // Oracle migration note: oracleUpdateData is ignored. Prices are read from SimpleOracleFacet
        // which is updated off-chain by a bot pushing RedStone API data every ~5 minutes.
        // This parameter is kept for forward compatibility in case we re-add a pull oracle (Pyth/RedStone).
        // Any ETH sent is refunded since no update fee is needed.
        
        if (msg.value > 0) {
            pendingETHRefunds[msg.sender] += msg.value;
        }
        
        uint256 wsxmrPriceUsd = IOracleFacet(hub).getXmrPrice();
        uint256 sDAIPriceUsd = IOracleFacet(hub).getCollateralPrice();
        
        (address _token0, address _token1) = wsxmrToken < sDAI ? (wsxmrToken, sDAI) : (sDAI, wsxmrToken);
        
        pool = IUniswapV3Factory(dexFactory).getPool(_token0, _token1, POOL_FEE);
        if (pool == address(0)) {
            pool = IUniswapV3Factory(dexFactory).createPool(_token0, _token1, POOL_FEE);
        }
        
        uint160 sqrtPriceX96 = _calculateSqrtPriceX96(wsxmrPriceUsd, sDAIPriceUsd, _token0 == wsxmrToken);
        
        IUniswapV3Pool(pool).initialize(sqrtPriceX96);
        
        emit PoolInitialized(pool, sqrtPriceX96, sDAIPriceUsd, wsxmrPriceUsd);
        
        return pool;
    }

    // ========== LP FUNCTIONS ==========
    
    /// @inheritdoc ICoLPMatching
    function allocateLiquidity(uint256 sDAIAmount) external nonReentrant {
        if (sDAIAmount < MIN_DEPOSIT_AMOUNT) revert InvalidAmount();
        
        IERC20(sDAI).safeTransferFrom(msg.sender, address(this), sDAIAmount);
        lpSDAIBalance[msg.sender] += sDAIAmount;
        
        emit LiquidityAllocated(msg.sender, sDAIAmount);
    }
    
    /// @inheritdoc ICoLPMatching
    function withdrawSDAI(uint256 sDAIAmount) external nonReentrant {
        if (sDAIAmount == 0) revert InvalidAmount();
        if (lpSDAIBalance[msg.sender] < sDAIAmount) revert InsufficientBalance();
        
        lpSDAIBalance[msg.sender] -= sDAIAmount;
        IERC20(sDAI).safeTransfer(msg.sender, sDAIAmount);
        
        emit LiquidityDeallocated(msg.sender, sDAIAmount);
    }
    
    /// @inheritdoc ICoLPMatching
    function setLPConfig(
        uint256 maxPositionSize,
        uint256 maxTotalExposure,
        uint16 minCollateralRatioBps,
        bool acceptingPositions
    ) external nonReentrant {
        if (minCollateralRatioBps < 10000 || minCollateralRatioBps > 50000) revert InvalidConfig();
        if (maxPositionSize == 0 && acceptingPositions) revert InvalidConfig();
        if (maxTotalExposure < maxPositionSize && acceptingPositions) revert InvalidConfig();
        
        lpConfigs[msg.sender] = LPConfig({
            maxPositionSize: maxPositionSize,
            maxTotalExposure: maxTotalExposure,
            minCollateralRatioBps: minCollateralRatioBps,
            acceptingPositions: acceptingPositions
        });
        
        emit LPConfigUpdated(msg.sender, maxPositionSize, maxTotalExposure, minCollateralRatioBps, acceptingPositions);
    }

    // ========== USER FUNCTIONS ==========
    
    /// @inheritdoc ICoLPMatching
    function depositWsxmr(uint256 amount) external nonReentrant {
        if (amount < MIN_DEPOSIT_AMOUNT) revert InvalidAmount();
        
        IERC20(wsxmrToken).safeTransferFrom(msg.sender, address(this), amount);
        userWsxmrBalance[msg.sender] += amount;
        
        emit UserDepositedWsxmr(msg.sender, amount);
    }
    
    /// @inheritdoc ICoLPMatching
    function withdrawWsXMR(uint256 wsxmrAmount) external nonReentrant {
        if (wsxmrAmount == 0) revert InvalidAmount();
        if (userWsxmrBalance[msg.sender] < wsxmrAmount) revert InsufficientBalance();
        
        userWsxmrBalance[msg.sender] -= wsxmrAmount;
        IERC20(wsxmrToken).safeTransfer(msg.sender, wsxmrAmount);
        
        emit UserWithdrewWsxmr(msg.sender, wsxmrAmount);
    }
    
    /// @inheritdoc ICoLPMatching
    function burnFromInternalBalance(
        uint256 wsxmrAmount,
        address lpVault
    ) external nonReentrant returns (bytes32 requestId) {
        if (wsxmrAmount == 0) revert InvalidAmount();
        if (userWsxmrBalance[msg.sender] < wsxmrAmount) revert InsufficientBalance();
        
        userWsxmrBalance[msg.sender] -= wsxmrAmount;
        
        IERC20(wsxmrToken).forceApprove(hub, wsxmrAmount);
        
        requestId = IBurnFacet(hub).requestBurnFromRouter(wsxmrAmount, lpVault, msg.sender);
        
        return requestId;
    }

    // ========== POSITION LIFECYCLE ==========
    
    /// @inheritdoc ILiquidityPosition
    function createPosition(
        address lp,
        address user,
        uint256 sDAIAmount,
        uint256 wsxmrAmount,
        uint256 deadline
    ) external nonReentrant returns (uint256 positionIndex) {
        return _createPosition(lp, user, sDAIAmount, wsxmrAmount, deadline);
    }
    
    /// @inheritdoc ILiquidityPosition
    function createPositionWithPriceUpdate(
        address lp,
        address user,
        uint256 sDAIAmount,
        uint256 wsxmrAmount,
        uint256 deadline,
        bytes[] calldata oracleUpdateData
    ) external payable nonReentrant returns (uint256 positionIndex) {
        // Oracle migration note: Same as initializePool - oracleUpdateData ignored, prices read from hub.
        // Refund any ETH sent since no update fee needed.
        if (msg.value > 0) {
            pendingETHRefunds[msg.sender] += msg.value;
        }
        
        return _createPosition(lp, user, sDAIAmount, wsxmrAmount, deadline);
    }
    
    function _createPosition(
        address lp,
        address user,
        uint256 sDAIAmount,
        uint256 wsxmrAmount,
        uint256 deadline
    ) private returns (uint256 positionIndex) {
        if (pool == address(0)) revert PoolNotInitialized();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (sDAIAmount < MIN_DEPOSIT_AMOUNT || wsxmrAmount < MIN_DEPOSIT_AMOUNT) revert InvalidAmount();
        
        LPConfig memory config = lpConfigs[lp];
        if (!config.acceptingPositions) revert LPNotAcceptingPositions();
        if (sDAIAmount > config.maxPositionSize) revert ExceedsMaxPositionSize();
        if (lpTotalExposure[lp] + sDAIAmount > config.maxTotalExposure) revert ExceedsMaxTotalExposure();
        
        uint256 wsxmrPriceUsd = IOracleFacet(hub).getXmrPrice();
        uint256 sDAIPriceUsd = IOracleFacet(hub).getCollateralPrice();
        
        uint256 wsxmrValueUsd = (wsxmrAmount * wsxmrPriceUsd) / 1e8;
        uint256 sDAIValueUsd = (sDAIAmount * sDAIPriceUsd) / 1e18;
        uint256 collateralRatioBps = (wsxmrValueUsd * BPS_DENOMINATOR) / sDAIValueUsd;
        
        if (collateralRatioBps < config.minCollateralRatioBps) revert InsufficientCollateralRatio();
        
        if (lpSDAIBalance[lp] < sDAIAmount) revert InsufficientBalance();
        if (userWsxmrBalance[user] < wsxmrAmount) revert InsufficientBalance();
        
        if (_activePositionCount[lp] >= MAX_ACTIVE_POSITIONS_PER_USER) revert MaxPositionsReached();
        if (_activePositionCount[user] >= MAX_ACTIVE_POSITIONS_PER_USER) revert MaxPositionsReached();
        
        lpSDAIBalance[lp] -= sDAIAmount;
        userWsxmrBalance[user] -= wsxmrAmount;
        lpTotalExposure[lp] += sDAIAmount;
        
        uint256 lpInitialValueUSD = sDAIValueUsd;
        uint256 userInitialValueUSD = wsxmrValueUsd;
        
        IERC20(sDAI).forceApprove(dexPositionManager, sDAIAmount);
        IERC20(wsxmrToken).forceApprove(dexPositionManager, wsxmrAmount);
        
        (address _token0, address _token1) = sDAI < wsxmrToken ? (sDAI, wsxmrToken) : (wsxmrToken, sDAI);
        (uint256 amount0, uint256 amount1) = _token0 == sDAI ? (sDAIAmount, wsxmrAmount) : (wsxmrAmount, sDAIAmount);
        
        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager.MintParams({
            token0: _token0,
            token1: _token1,
            fee: POOL_FEE,
            tickLower: (MIN_TICK / TICK_SPACING) * TICK_SPACING,
            tickUpper: (MAX_TICK / TICK_SPACING) * TICK_SPACING,
            amount0Desired: amount0,
            amount1Desired: amount1,
            amount0Min: 0,
            amount1Min: 0,
            recipient: address(this),
            deadline: deadline
        });
        
        (uint256 tokenId, , uint256 actualAmount0, uint256 actualAmount1) = 
            INonfungiblePositionManager(dexPositionManager).mint(params);
        
        (uint256 actualSDAI, uint256 actualWsxmr) = _token0 == sDAI ? 
            (actualAmount0, actualAmount1) : (actualAmount1, actualAmount0);
        
        if (actualSDAI < sDAIAmount) {
            lpSDAIBalance[lp] += (sDAIAmount - actualSDAI);
        }
        if (actualWsxmr < wsxmrAmount) {
            userWsxmrBalance[user] += (wsxmrAmount - actualWsxmr);
        }
        
        positionIndex = nextPositionIndex++;
        
        positions[positionIndex] = Position({
            positionId: tokenId,
            lpProvider: lp,
            userProvider: user,
            sDAIAmount: actualSDAI,
            wsxmrAmount: actualWsxmr,
            lpInitialValueUSD: lpInitialValueUSD,
            userInitialValueUSD: userInitialValueUSD,
            createdAt: block.timestamp
        });
        
        _userPositions[lp].push(positionIndex);
        _userPositions[user].push(positionIndex);
        _activePositionCount[lp]++;
        _activePositionCount[user]++;
        
        emit PositionCreated(positionIndex, tokenId, lp, user, actualSDAI, actualWsxmr);
        
        return positionIndex;
    }
    
    /// @inheritdoc ILiquidityPosition
    function closePosition(
        uint256 positionIndex,
        uint256 deadline,
        uint256 minTotalValueUSD
    ) external nonReentrant {
        Position storage position = positions[positionIndex];
        if (position.positionId == 0) revert PositionNotFound();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (block.timestamp < position.createdAt + MIN_POSITION_DURATION) revert PositionTooYoung();
        
        address lp = position.lpProvider;
        address user = position.userProvider;
        
        if (msg.sender != lp && msg.sender != user) revert Unauthorized();
        
        INonfungiblePositionManager.DecreaseLiquidityParams memory decreaseParams = 
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: position.positionId,
                liquidity: _getPositionLiquidity(position.positionId),
                amount0Min: 0,
                amount1Min: 0,
                deadline: deadline
            });
        
        INonfungiblePositionManager(dexPositionManager).decreaseLiquidity(decreaseParams);
        
        INonfungiblePositionManager.CollectParams memory collectParams = 
            INonfungiblePositionManager.CollectParams({
                tokenId: position.positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });
        
        (uint256 amount0, uint256 amount1) = INonfungiblePositionManager(dexPositionManager).collect(collectParams);
        
        (address _token0, ) = sDAI < wsxmrToken ? (sDAI, wsxmrToken) : (wsxmrToken, sDAI);
        (uint256 returnedSDAI, uint256 returnedWsxmr) = _token0 == sDAI ? (amount0, amount1) : (amount1, amount0);
        
        uint256 wsxmrPriceUsd = IOracleFacet(hub).getXmrPrice();
        uint256 sDAIPriceUsd = IOracleFacet(hub).getCollateralPrice();
        
        uint256 lpFinalValueUSD = (returnedSDAI * sDAIPriceUsd) / 1e18;
        uint256 userFinalValueUSD = (returnedWsxmr * wsxmrPriceUsd) / 1e8;
        uint256 totalValueUSD = lpFinalValueUSD + userFinalValueUSD;
        
        if (totalValueUSD < minTotalValueUSD) revert WithdrawalValueTooLow();
        
        if (lpFinalValueUSD < position.lpInitialValueUSD) {
            uint256 lpLoss = position.lpInitialValueUSD - lpFinalValueUSD;
            uint256 compensationWsxmr = (lpLoss * 1e8) / wsxmrPriceUsd;
            if (compensationWsxmr <= returnedWsxmr) {
                returnedWsxmr -= compensationWsxmr;
                pendingILWsxmr[lp] += compensationWsxmr;
                emit ILWsxmrCredited(lp, compensationWsxmr, positionIndex);
            }
        }
        
        if (userFinalValueUSD < position.userInitialValueUSD) {
            uint256 userLoss = position.userInitialValueUSD - userFinalValueUSD;
            uint256 compensationSDAI = (userLoss * 1e18) / sDAIPriceUsd;
            if (compensationSDAI <= returnedSDAI) {
                returnedSDAI -= compensationSDAI;
                pendingILSDAI[user] += compensationSDAI;
                emit ILSDAICredited(user, compensationSDAI, positionIndex);
            }
        }
        
        lpSDAIBalance[lp] += returnedSDAI;
        userWsxmrBalance[user] += returnedWsxmr;
        
        lpTotalExposure[lp] -= position.sDAIAmount;
        
        INonfungiblePositionManager(dexPositionManager).burn(position.positionId);
        
        _activePositionCount[lp]--;
        _activePositionCount[user]--;
        
        delete positions[positionIndex];
        
        emit PositionClosed(positionIndex, returnedSDAI, returnedWsxmr);
    }
    
    /// @inheritdoc ILiquidityPosition
    function collectFees(uint256 positionIndex) external nonReentrant {
        Position storage position = positions[positionIndex];
        if (position.positionId == 0) revert PositionNotFound();
        
        address lp = position.lpProvider;
        address user = position.userProvider;
        
        if (msg.sender != lp && msg.sender != user) revert Unauthorized();
        
        INonfungiblePositionManager.CollectParams memory collectParams = 
            INonfungiblePositionManager.CollectParams({
                tokenId: position.positionId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            });
        
        (uint256 amount0, uint256 amount1) = INonfungiblePositionManager(dexPositionManager).collect(collectParams);
        
        (address _token0, ) = sDAI < wsxmrToken ? (sDAI, wsxmrToken) : (wsxmrToken, sDAI);
        (uint256 sDAIFees, uint256 wsxmrFees) = _token0 == sDAI ? (amount0, amount1) : (amount1, amount0);
        
        pendingSDAIFees[lp] += sDAIFees;
        pendingWsxmrFees[user] += wsxmrFees;
        
        emit FeesCollected(positionIndex, sDAIFees, wsxmrFees);
    }
    
    /// @inheritdoc ILiquidityPosition
    function withdrawFees() external nonReentrant {
        uint256 sDAIAmount = pendingSDAIFees[msg.sender];
        uint256 wsxmrAmount = pendingWsxmrFees[msg.sender];
        
        if (sDAIAmount > 0) {
            pendingSDAIFees[msg.sender] = 0;
            IERC20(sDAI).safeTransfer(msg.sender, sDAIAmount);
        }
        
        if (wsxmrAmount > 0) {
            pendingWsxmrFees[msg.sender] = 0;
            IERC20(wsxmrToken).safeTransfer(msg.sender, wsxmrAmount);
        }
        
        emit FeesWithdrawn(msg.sender, sDAIAmount, wsxmrAmount);
    }
    
    /// @inheritdoc ICoLPMatching
    function withdrawETH() external nonReentrant {
        uint256 amount = pendingETHRefunds[msg.sender];
        if (amount == 0) revert InvalidAmount();
        
        pendingETHRefunds[msg.sender] = 0;
        (bool success, ) = msg.sender.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    // ========== VIEW FUNCTIONS ==========
    
    /// @inheritdoc IwsXmrLiquidityRouter
    function poolInitialized() external view returns (bool) {
        return pool != address(0);
    }
    
    /// @inheritdoc IwsXmrLiquidityRouter
    function token0() external view returns (address) {
        return sDAI < wsxmrToken ? sDAI : wsxmrToken;
    }
    
    /// @inheritdoc IwsXmrLiquidityRouter
    function token1() external view returns (address) {
        return sDAI < wsxmrToken ? wsxmrToken : sDAI;
    }
    
    /// @inheritdoc IwsXmrLiquidityRouter
    function sDAIIsToken0() external view returns (bool) {
        return sDAI < wsxmrToken;
    }
    
    /// @inheritdoc ICoLPMatching
    function getLPConfig(address lp) external view returns (LPConfig memory) {
        return lpConfigs[lp];
    }
    
    /// @inheritdoc ICoLPMatching
    function getLpAvailableLiquidity(address lp) external view returns (uint256) {
        return lpSDAIBalance[lp];
    }
    
    /// @inheritdoc ICoLPMatching
    function getLpTotalExposure(address lp) external view returns (uint256) {
        return lpTotalExposure[lp];
    }
    
    /// @inheritdoc ICoLPMatching
    function getUserAvailableWsxmr(address user) external view returns (uint256) {
        return userWsxmrBalance[user];
    }
    
    /// @inheritdoc ICoLPMatching
    function getWithdrawableBalances(address account) external view returns (
        uint256 sDAIBalance,
        uint256 wsxmrBalance,
        uint256 sDAIFees,
        uint256 wsxmrFees
    ) {
        return (
            lpSDAIBalance[account] + pendingILSDAI[account],
            userWsxmrBalance[account] + pendingILWsxmr[account],
            pendingSDAIFees[account],
            pendingWsxmrFees[account]
        );
    }
    
    /// @inheritdoc ILiquidityPosition
    function getPosition(uint256 positionIndex) external view returns (Position memory) {
        return positions[positionIndex];
    }
    
    /// @inheritdoc ILiquidityPosition
    function getUserPositions(
        address account,
        uint256 cursor,
        uint256 limit
    ) external view returns (Position[] memory positionList, uint256 nextCursor) {
        uint256[] storage indices = _userPositions[account];
        uint256 length = indices.length;
        
        if (cursor >= length) {
            return (new Position[](0), cursor);
        }
        
        uint256 remaining = length - cursor;
        uint256 count = remaining < limit ? remaining : limit;
        
        positionList = new Position[](count);
        for (uint256 i = 0; i < count; i++) {
            positionList[i] = positions[indices[cursor + i]];
        }
        
        nextCursor = cursor + count;
        return (positionList, nextCursor);
    }
    
    /// @inheritdoc ILiquidityPosition
    function getPendingFees(address account) external view returns (
        uint256 sDAIFees,
        uint256 wsxmrFees
    ) {
        return (pendingSDAIFees[account], pendingWsxmrFees[account]);
    }
    
    /// @inheritdoc ILiquidityPosition
    function activePositionCount(address account) external view returns (uint256) {
        return _activePositionCount[account];
    }

    // ========== INTERNAL HELPERS ==========
    
    function _calculateSqrtPriceX96(
        uint256 wsxmrPriceUsd,
        uint256 sDAIPriceUsd,
        bool wsxmrIsToken0
    ) private pure returns (uint160) {
        uint256 priceRatio;
        
        if (wsxmrIsToken0) {
            priceRatio = (sDAIPriceUsd * 1e8) / wsxmrPriceUsd;
        } else {
            priceRatio = (wsxmrPriceUsd * 1e18) / (sDAIPriceUsd * 1e8);
        }
        
        uint256 sqrtPrice = _sqrt(priceRatio);
        return uint160((sqrtPrice * (1 << 96)) / 1e9);
    }
    
    function _sqrt(uint256 x) private pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
    
    function _getPositionLiquidity(uint256 tokenId) private view returns (uint128) {
        (, , , , , , , uint128 liquidity, , , , ) = 
            INonfungiblePositionManager(dexPositionManager).positions(tokenId);
        return liquidity;
    }
    
    receive() external payable {
        pendingETHRefunds[msg.sender] += msg.value;
    }
}
