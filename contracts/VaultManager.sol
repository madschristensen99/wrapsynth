// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Secp256k1} from "./Secp256k1.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {wsXMR} from "./wsXMR.sol";

/**
 * @title VaultManager
 * @notice Manages LP vaults, collateralization, and mint/burn operations for wsXMR
 * @dev Integrates cryptographic proofs from atomic swaps with CDP vault mechanics
 */
contract VaultManager is Secp256k1, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ========== CONSTANTS ==========

    uint256 public constant COLLATERAL_RATIO = 150; // 150% overcollateralization
    uint256 public constant LIQUIDATION_RATIO = 120; // 120% liquidation threshold
    uint256 public constant LIQUIDATION_BONUS = 110; // 110% liquidator reward
    uint256 public constant RATIO_PRECISION = 100;
    uint256 public constant PRICE_PRECISION = 1e18;
    uint256 public constant BURN_TIMEOUT = 24 hours; 
    uint256 public constant MAX_MINT_TIMEOUT = 7 days; 

    // MARKET METRIC CONSTANTS
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant MAX_MARGIN_BPS = 1000; // 10% maximum fee/reward to prevent abuse

    // ========== STATE VARIABLES ==========

    wsXMR public immutable wsxmrToken;
    IPyth public immutable pyth;

    bytes32 public constant XMR_USD_FEED_ID = 0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d;
    bytes32 public constant MON_USD_FEED_ID = 0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1;

    uint256 public priceMaxAge = 5 minutes; 

    mapping(address => bool) public supportedCollateral;
    mapping(address => bytes32) public collateralPriceFeeds; 

    // ========== ENUMS ==========

    enum MintStatus { INVALID, PENDING, READY, COMPLETED, CANCELLED }

    enum BurnStatus { INVALID, REQUESTED, COMMITTED, COMPLETED, SLASHED, CANCELLED }

    // ========== STRUCTS ==========

    struct Vault {
        address lpAddress;
        address collateralAsset; 
        uint256 collateralAmount;
        uint256 lockedCollateral; 
        uint256 debtAmount; 
        uint256 mintGriefingDeposit; 
        uint16 mintFeeBps;       // Fee LP charges for minting (paid in wsXMR)
        uint16 burnRewardBps;    // Reward LP pays to incentivize burning (paid in Collateral)
        bool active;
    }

    struct MintRequest {
        bytes32 requestId;
        address user;
        address lpVault;
        uint256 xmrAmount; 
        uint256 wsxmrAmount; 
        uint256 feeAmount;       // Portion of wsxmrAmount that goes to LP as fee
        bytes32 claimCommitment; 
        uint256 timeout;
        uint256 griefingDeposit;<blockquote data-reasoning="true"><p><strong>Synthesizing the Design</strong><br><br>I'm now detailing the implementation. The mint fee will be deducted directly from the<code>wsXMR</code> received, directing the fee to the LP, and the burn reward will be provided by the LP, in the form of collateral, and tracked. I'm focusing on ensuring data consistency and correctness.</p></blockquote>


        MintStatus status;
    }

    struct BurnRequest {
        bytes32 requestId;
        address user;
        address lpVault;
        uint256 wsxmrAmount;
        uint256 xmrAmount;
        uint256 lockedCollateral; // Base collateral locked (still liquidatable)
        uint256 rewardCollateral; // Extra collateral added as a reward
        bytes32 secretHash; 
        uint256 deadline; 
        BurnStatus status;
    }

    // ========== MAPPINGS ==========

    mapping(address => Vault) public vaults;
    mapping(bytes32 => MintRequest) public mintRequests;
    mapping(bytes32 => BurnRequest) public burnRequests;
    address[] public vaultList;

    // ========== EVENTS ==========

    event VaultCreated(address indexed lpAddress, address indexed collateralAsset);
    event CollateralDeposited(address indexed lpAddress, address indexed asset, uint256 amount);
    event CollateralWithdrawn(address indexed lpAddress, address indexed asset, uint256 amount);
    event VaultMarketMetricsUpdated(address indexed lpVault, uint16 mintFeeBps, uint16 burnRewardBps);

    event MintInitiated(
        bytes32 indexed requestId,
        address indexed user,
        address indexed lpVault,
        uint256 xmrAmount,
        uint256 wsxmrAmount,
        uint256 feeAmount,
        bytes32 claimCommitment,
        uint256 timeout
    );
    event MintReady(bytes32 indexed requestId);
    event MintFinalized(bytes32 indexed requestId, bytes32 secret);
    event MintCancelled(bytes32 indexed requestId);
    event MintGriefingDepositUpdated(address indexed lpVault, uint256 newDeposit);

    event BurnRequested(
        bytes32 indexed requestId,
        address indexed user,
        address indexed lpVault,
        uint256 wsxmrAmount,
        uint256 xmrAmount,
        uint256 rewardCollateral
    );
    event BurnCommitted(bytes32 indexed requestId, bytes32 secretHash, uint256 deadline);
    event BurnFinalized(bytes32 indexed requestId, bytes32 secret, uint256 rewardPaid);
    event BurnSlashed(bytes32 indexed requestId, address indexed user, uint256 collateralSeized);
    event BurnCancelled(bytes32 indexed requestId);

    event VaultLiquidated(
        address indexed lpVault,
        address indexed liquidator,
        uint256 debtCleared,
        uint256 collateralSeized
    );

    event OracleUpdated(string indexed oracleType, address indexed newOracle);
    event CollateralSupported(address indexed asset, address indexed oracle);
    event PriceMaxAgeUpdated(uint256 newMaxAge);

    // ========== ERRORS ========== (Standardized)
    error ZeroAddress(); error ZeroAmount(); error VaultAlreadyExists(); 
    error VaultDoesNotExist(); error VaultNotActive(); error InsufficientCollateral();
    error InvalidCollateralAsset(); error InvalidMintRequest(); error InvalidBurnRequest();
    error MintAlreadyExists(); error BurnAlreadyExists(); error InvalidSecret();
    error InvalidStatus(); error TimeoutNotReached(); error DeadlineExpired();
    error DeadlineNotExpired(); error VaultHealthy(); error InsufficientDebt();
    error Unauthorized(); error InvalidValue(); error StalePrice();
    error InvalidAsset(); error InsufficientDeposit(); error ExceedsMaxMargin();

    constructor(
        address _wsxmrToken,
        address _pythContract,
        address _initialOwner
    ) Ownable(_initialOwner) {
        if (_wsxmrToken == address(0)) revert ZeroAddress();
        if (_pythContract == address(0)) revert ZeroAddress();
        if (_initialOwner == address(0)) revert ZeroAddress();

        wsxmrToken = wsXMR(_wsxmrToken);
        pyth = IPyth(_pythContract);

        supportedCollateral[address(0)] = true;
        collateralPriceFeeds[address(0)] = MON_USD_FEED_ID;
        emit CollateralSupported(address(0), _pythContract);
    }

    // ========== VAULT MANAGEMENT ==========

    function createVault(address _collateralAsset) external {
        if (vaults[msg.sender].active) revert VaultAlreadyExists();
        if (!supportedCollateral[_collateralAsset]) revert InvalidCollateralAsset();

        vaults[msg.sender] = Vault({
            lpAddress: msg.sender,
            collateralAsset: _collateralAsset,
            collateralAmount: 0,
            lockedCollateral: 0,
            debtAmount: 0,
            mintGriefingDeposit: 0,
            mintFeeBps: 0,
            burnRewardBps: 0,
            active: true
        });

        vaultList.push(msg.sender);
        emit VaultCreated(msg.sender, _collateralAsset);
    }

    function depositCollateral(uint256 _amount) external payable nonReentrant {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (_amount == 0) revert ZeroAmount();

        Vault storage vault = vaults[msg.sender];
        if (vault.collateralAsset == address(0)) {
            if (msg.value != _amount) revert InvalidValue();
            vault.collateralAmount += _amount;
        } else {
            if (msg.value != 0) revert InvalidValue();
            IERC20(vault.collateralAsset).safeTransferFrom(msg.sender, address(this), _amount);
            vault.collateralAmount += _amount;
        }
        emit CollateralDeposited(msg.sender, vault.collateralAsset, _amount);
    }

    function withdrawCollateral(uint256 _amount) external nonReentrant {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (_amount == 0) revert ZeroAmount();

        Vault storage vault = vaults[msg.sender];
        uint256 availableCollateral = vault.collateralAmount - vault.lockedCollateral;
        if (availableCollateral < _amount) revert InsufficientCollateral();

        uint256 newCollateralAmount = vault.collateralAmount - _amount;
        if (vault.debtAmount > 0) {
            uint256 ratio = calculateCollateralRatio(
                vault.collateralAsset,
                newCollateralAmount,
                vault.debtAmount
            );
            if (ratio < COLLATERAL_RATIO) revert InsufficientCollateral();
        }

        vault.collateralAmount = newCollateralAmount;
        if (vault.collateralAsset == address(0)) {
            (bool success, ) = payable(msg.sender).call{value: _amount}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(vault.collateralAsset).safeTransfer(msg.sender, _amount);
        }
        emit CollateralWithdrawn(msg.sender, vault.collateralAsset, _amount);
    }

    function setMintGriefingDeposit(uint256 _deposit) external {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        vaults[msg.sender].mintGriefingDeposit = _deposit;
        emit MintGriefingDepositUpdated(msg.sender, _deposit);
    }

    /**
     * @notice Allows LP to set Minting Fees and Burning Rewards to manage vault flow
     */
    function setVaultMarketMetrics(uint16 _mintFeeBps, uint16 _burnRewardBps) external {
        if (!vaults[msg.sender].active) revert VaultDoesNotExist();
        if (_mintFeeBps > MAX_MARGIN_BPS || _burnRewardBps > MAX_MARGIN_BPS) revert ExceedsMaxMargin();

        vaults[msg.sender].mintFeeBps = _mintFeeBps;
        vaults[msg.sender].burnRewardBps = _burnRewardBps;
        emit VaultMarketMetricsUpdated(msg.sender, _mintFeeBps, _burnRewardBps);
    }

    // ========== MINTING FLOW ==========

    function initiateMint(
        address _lpVault,
        uint256 _xmrAmount,
        bytes32 _claimCommitment,
        uint256 _timeoutDuration
    ) external payable returns (bytes32 requestId) {
        if (_lpVault == address(0)) revert ZeroAddress();
        if (_xmrAmount == 0) revert ZeroAmount();
        if (_claimCommitment == bytes32(0)) revert InvalidSecret();
        if (_timeoutDuration == 0 || _timeoutDuration > MAX_MINT_TIMEOUT) revert InvalidValue();
        if (!vaults[_lpVault].active) revert VaultDoesNotExist();

        Vault storage vault = vaults[_lpVault];
        if (msg.value < vault.mintGriefingDeposit) revert InsufficientDeposit();

        uint256 wsxmrAmount = _xmrAmount / 1e4;

        // Calculate the LP's service fee in wsXMR
        uint256 feeAmount = (wsxmrAmount * vault.mintFeeBps) / BPS_DENOMINATOR;

        uint256 newDebt = vault.debtAmount + wsxmrAmount;
        uint256 ratio = calculateCollateralRatio(vault.collateralAsset, vault.collateralAmount, newDebt);
        if (ratio < COLLATERAL_RATIO) revert InsufficientCollateral();

        requestId = keccak256(abi.encodePacked(
            msg.sender, _lpVault, _xmrAmount, _claimCommitment, block.timestamp, block.number
        ));

        if (mintRequests[requestId].status != MintStatus.INVALID) revert MintAlreadyExists();

        vault.debtAmount = newDebt;

        mintRequests[requestId] = MintRequest({
            requestId: requestId,
            user: msg.sender,
            lpVault: _lpVault,
            xmrAmount: _xmrAmount,
            wsxmrAmount: wsxmrAmount,
            feeAmount: feeAmount,
            claimCommitment: _claimCommitment,
            timeout: block.timestamp + _timeoutDuration,
            griefingDeposit: msg.value,
            status: MintStatus.PENDING
        });

        emit MintInitiated(
            requestId, msg.sender, _lpVault, _xmrAmount, wsxmrAmount, feeAmount,
            _claimCommitment, block.timestamp + _timeoutDuration
        );
        return requestId;
    }

    function setMintReady(bytes32 _requestId) external {
        MintRequest storage request = mintRequests[_requestId];
        if (request.status != MintStatus.PENDING) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();

        request.status = MintStatus.READY;
        emit MintReady(_requestId);
    }

    function finalizeMint(bytes32 _requestId, bytes32 _secret) external nonReentrant {
        MintRequest storage request = mintRequests[_requestId];
        if (request.status != MintStatus.READY) revert InvalidStatus();

        if (!mulVerify(uint256(_secret), uint256(request.claimCommitment))) revert InvalidSecret();

        // Split mint execution between User and LP if a fee was configured
        wsxmrToken.mint(request.user, request.wsxmrAmount - request.feeAmount);
        if (request.feeAmount > 0) {
            Vault storage vault = vaults[request.lpVault];
            wsxmrToken.mint(vault.lpAddress, request.feeAmount);
        }

        if (request.griefingDeposit > 0) {
            (bool success, ) = payable(request.user).call{value: request.griefingDeposit}("");
            require(success, "Deposit refund failed");
        }

        request.status = MintStatus.COMPLETED;
        emit MintFinalized(_requestId, _secret);
    }

    function cancelMint(bytes32 _requestId) external nonReentrant {
        MintRequest storage request = mintRequests[_requestId];
        if (request.status != MintStatus.PENDING && request.status != MintStatus.READY) {
            revert InvalidStatus();
        }

        uint256 requiredTimeout = request.status == MintStatus.READY 
            ? request.timeout + 24 hours 
            : request.timeout;

        if (block.timestamp < requiredTimeout) revert TimeoutNotReached();

        Vault storage vault = vaults[request.lpVault];
        vault.debtAmount -= request.wsxmrAmount;

        request.status = MintStatus.CANCELLED;
        uint256 depositToTransfer = request.griefingDeposit;

        emit MintCancelled(_requestId);

        if (depositToTransfer > 0) {
            (bool success, ) = payable(vault.lpAddress).call{value: depositToTransfer}("");
            require(success, "Deposit transfer to LP failed");
        }
    }

    // ========== BURNING FLOW ==========

    function requestBurn(
        uint256 _wsxmrAmount,
        address _lpVault
    ) external returns (bytes32 requestId) {
        if (_wsxmrAmount == 0) revert ZeroAmount();
        if (_lpVault == address(0)) revert ZeroAddress();
        if (!vaults[_lpVault].active) revert VaultDoesNotExist();

        Vault storage vault = vaults[_lpVault];
        if (vault.debtAmount < _wsxmrAmount) revert InsufficientDebt();

        uint256 collateralValue = getCollateralValueForDebt(_wsxmrAmount);
        uint256 collateralToLock = usdToCollateral(
            vault.collateralAsset,
            (collateralValue * LIQUIDATION_RATIO) / RATIO_PRECISION
        );

        // Calculate User Reward in Vault's collateral asset
        uint256 rewardUsd = (collateralValue * vault.burnRewardBps) / BPS_DENOMINATOR;
        uint256 rewardCollateral = usdToCollateral(vault.collateralAsset, rewardUsd);

        uint256 availableCollateral = vault.collateralAmount - vault.lockedCollateral;
        if (availableCollateral < (collateralToLock + rewardCollateral)) revert InsufficientCollateral();

        requestId = keccak256(abi.encodePacked(
            msg.sender, _lpVault, _wsxmrAmount, block.timestamp, block.number
        ));
        if (burnRequests[requestId].status != BurnStatus.INVALID) revert BurnAlreadyExists();

        wsxmrToken.burn(msg.sender, _wsxmrAmount);

        // Lock both Base Liquidation Collateral and Reward Collateral
        vault.lockedCollateral += (collateralToLock + rewardCollateral);
        vault.debtAmount -= _wsxmrAmount;

        uint256 xmrAmount = _wsxmrAmount * 1e4;

        burnRequests[requestId] = BurnRequest({
            requestId: requestId,
            user: msg.sender,
            lpVault: _lpVault,
            wsxmrAmount: _wsxmrAmount,
            xmrAmount: xmrAmount,
            lockedCollateral: collateralToLock, 
            rewardCollateral: rewardCollateral,
            secretHash: bytes32(0), 
            deadline: block.timestamp + 48 hours, 
            status: BurnStatus.REQUESTED
        });

        emit BurnRequested(requestId, msg.sender, _lpVault, _wsxmrAmount, xmrAmount, rewardCollateral);
        return requestId;
    }

    function commitBurn(bytes32 _requestId, bytes32 _secretHash) external nonReentrant {
        BurnRequest storage request = burnRequests[_requestId];
        if (request.status != BurnStatus.REQUESTED) revert InvalidStatus();

        Vault storage vault = vaults[request.lpVault];
        if (msg.sender != vault.lpAddress) revert Unauthorized();
        if (_secretHash == bytes32(0)) revert InvalidSecret();

        request.secretHash = _secretHash;
        request.deadline = block.timestamp + BURN_TIMEOUT; 
        request.status = BurnStatus.COMMITTED;

        emit BurnCommitted(_requestId, _secretHash, request.deadline);
    }

    function finalizeBurn(bytes32 _requestId, bytes32 _secret) external nonReentrant {
        BurnRequest storage request = burnRequests[_requestId];
        if (request.status != BurnStatus.COMMITTED) revert InvalidStatus();
        if (block.timestamp >= request.deadline) revert DeadlineExpired();

        if (!mulVerify(uint256(_secret), uint256(request.secretHash))) {
            revert InvalidSecret();
        }

        Vault storage vault = vaults[request.lpVault];

        // Safely adjust vault locked collateral
        uint256 totalUnlock = request.lockedCollateral + request.rewardCollateral;
        if (vault.lockedCollateral >= totalUnlock) {
            vault.lockedCollateral -= totalUnlock;
        } else {
            vault.lockedCollateral = 0; // Protection against liquidation underflows
        }

        // Process the burn reward directly to the User
        if (request.rewardCollateral > 0) {
            vault.collateralAmount -= request.rewardCollateral;
            if (vault.collateralAsset == address(0)) {
                (bool success, ) = payable(request.user).call{value: request.rewardCollateral}("");
                require(success, "ETH transfer failed");
            } else {
                IERC20(vault.collateralAsset).safeTransfer(request.user, request.rewardCollateral);
            }
        }

        request.status = BurnStatus.COMPLETED;
        emit BurnFinalized(_requestId, _secret, request.rewardCollateral);
    }

    function claimSlashedCollateral(bytes32 _requestId) external nonReentrant {
        BurnRequest storage request = burnRequests[_requestId];
        if (request.status != BurnStatus.COMMITTED) revert InvalidStatus();
        if (msg.sender != request.user) revert Unauthorized();
        if (block.timestamp < request.deadline) revert DeadlineNotExpired();

        Vault storage vault = vaults[request.lpVault];

        uint256 totalSeized = request.lockedCollateral + request.rewardCollateral;

        if (vault.lockedCollateral >= totalSeized) {
            vault.lockedCollateral -= totalSeized;
        } else {
            vault.lockedCollateral = 0; 
        }
        vault.collateralAmount -= totalSeized;

        if (vault.collateralAsset == address(0)) {
            (bool success, ) = payable(request.user).call{value: totalSeized}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(vault.collateralAsset).safeTransfer(request.user, totalSeized);
        }

        request.lockedCollateral = 0;
        request.rewardCollateral = 0;
        request.status = BurnStatus.SLASHED;

        emit BurnSlashed(_requestId, request.user, totalSeized);
    }

    function cancelBurn(bytes32 _requestId) external nonReentrant {
        BurnRequest storage request = burnRequests[_requestId];
        if (request.status != BurnStatus.REQUESTED) revert InvalidStatus();
        if (block.timestamp < request.deadline) revert DeadlineNotExpired();

        Vault storage vault = vaults[request.lpVault];
        vault.debtAmount += request.wsxmrAmount;

        uint256 totalUnlock = request.lockedCollateral + request.rewardCollateral;
        if (vault.lockedCollateral >= totalUnlock) {
            vault.lockedCollateral -= totalUnlock;
        } else {
            vault.lockedCollateral = 0;
        }

        wsxmrToken.mint(request.user, request.wsxmrAmount);

        request.status = BurnStatus.CANCELLED;
        emit BurnCancelled(_requestId);
    }

    // ========== LIQUIDATION ==========

    function liquidate(address _lpVault, uint256 _debtToClear) external nonReentrant {
        if (!vaults[_lpVault].active) revert VaultDoesNotExist();
        if (_debtToClear == 0) revert ZeroAmount();

        Vault storage vault = vaults[_lpVault];
        if (vault.debtAmount == 0) revert InsufficientDebt();
        if (_debtToClear > vault.debtAmount) {
            _debtToClear = vault.debtAmount;
        }

        uint256 availableCollateral = vault.collateralAmount - vault.lockedCollateral;
        uint256 ratio = calculateCollateralRatio(
            vault.collateralAsset, availableCollateral, vault.debtAmount
        );
        if (ratio >= LIQUIDATION_RATIO) revert VaultHealthy();

        uint256 collateralValue = getCollateralValueForDebt(_debtToClear);
        uint256 collateralToSeize = (collateralValue * LIQUIDATION_BONUS) / RATIO_PRECISION;
        uint256 collateralAmount = usdToCollateral(vault.collateralAsset, collateralToSeize);

        if (collateralAmount > vault.collateralAmount) {
            _debtToClear = (_debtToClear * vault.collateralAmount) / collateralAmount;
            collateralAmount = vault.collateralAmount;
        }

        uint256 preSeizureCollateral = vault.collateralAmount;
        vault.collateralAmount -= collateralAmount;
        vault.debtAmount -= _debtToClear;

        // Underflow protection resolved using safe math
        if (vault.lockedCollateral > 0 && collateralAmount > 0) {
            uint256 lockedReduction = (vault.lockedCollateral * collateralAmount) / preSeizureCollateral;
            if (vault.lockedCollateral > lockedReduction) {
                vault.lockedCollateral -= lockedReduction;
            } else {
                vault.lockedCollateral = 0;
            }
        }

        wsxmrToken.burn(msg.sender, _debtToClear);

        if (vault.collateralAsset == address(0)) {
            (bool success, ) = payable(msg.sender).call{value: collateralAmount}("");
            require(success, "ETH transfer failed");
        } else {
            IERC20(vault.collateralAsset).safeTransfer(msg.sender, collateralAmount);
        }

        emit VaultLiquidated(_lpVault, msg.sender, _debtToClear, collateralAmount);
    }

    // ========== ORACLE AND INTERNAL LOGIC ========== 
    // (Existing getXmrPrice, getCollateralPrice, calculateCollateralRatio, etc)
    // Have been preserved exactly as requested in original. Example snippet:

    function getXmrPrice() public view returns (uint256) {
        uint256 maxAge = priceMaxAge;
        PythStructs.Price memory priceData = pyth.getPriceNoOlderThan(XMR_USD_FEED_ID, maxAge);
        if (priceData.price <= 0) revert StalePrice();

        uint256 price = uint256(uint64(priceData.price));
        uint256 conf = uint256(uint64(priceData.conf));
        if (conf * 10 > price) revert StalePrice(); 

        int32 expo = priceData.expo;
        if (expo >= 0) {
            return price * (10 ** uint32(expo)) * 1e18;
        } else {
            uint32 absExpo = uint32(-expo);
            if (absExpo >= 18) {
                return price / (10 ** (absExpo - 18));
            } else {
                return price * (10 ** (18 - absExpo));
            }
        }
    }

    function getCollateralPrice(address _asset) public view returns (uint256) {
        bytes32 feedId = collateralPriceFeeds[_asset];
        if (feedId == bytes32(0)) revert InvalidAsset();

        uint256 maxAge = priceMaxAge;
        PythStructs.Price memory priceData = pyth.getPriceNoOlderThan(feedId, maxAge);
        if (priceData.price <= 0) revert StalePrice();

        uint256 price = uint256(uint64(priceData.price));
        uint256 conf = uint256(uint64(priceData.conf));
        if (conf * 10 > price) revert StalePrice(); 

        int32 expo = priceData.expo;
        if (expo >= 0) {
            return price * (10 ** uint32(expo)) * 1e18;
        } else {
            uint32 absExpo = uint32(-expo);
            if (absExpo >= 18) {
                return price / (10 ** (absExpo - 18));
            } else {
                return price * (10 ** (18 - absExpo));
            }
        }
    }

    function calculateCollateralRatio(
        address _collateralAsset,
        uint256 _collateralAmount,
        uint256 _debtAmount
    ) public view returns (uint256 ratio) {
        if (_debtAmount == 0) return type(uint256).max;
        uint256 collateralPrice = getCollateralPrice(_collateralAsset);
        uint256 xmrPrice = getXmrPrice();
        uint8 collateralDecimals = _collateralAsset == address(0) ? 18 : IERC20Metadata(_collateralAsset).decimals();
        uint256 collateralValue = (_collateralAmount * collateralPrice) / (10 ** collateralDecimals);
        uint256 debtValue = (_debtAmount * xmrPrice) / 1e8;
        ratio = (collateralValue * RATIO_PRECISION) / debtValue;
    }

    function getCollateralValueForDebt(uint256 _debtAmount) internal view returns (uint256) {
        uint256 xmrPrice = getXmrPrice();
        return (_debtAmount * xmrPrice) / 1e8;
    }

    function usdToCollateral(address _asset, uint256 _usdValue) internal view returns (uint256) {
        uint256 collateralPrice = getCollateralPrice(_asset);
        uint8 decimals = _asset == address(0) ? 18 : IERC20Metadata(_asset).decimals();
        return (_usdValue * (10 ** decimals)) / collateralPrice;
    }

    // ========== VIEW / ADMIN FUNCTIONS ==========

    function getVault(address _lpAddress) external view returns (Vault memory) { return vaults[_lpAddress]; }
    function getVaultCollateralRatio(address _lpAddress) external view returns (uint256) {
        Vault memory vault = vaults[_lpAddress];
        if (!vault.active) revert VaultDoesNotExist();
        return calculateCollateralRatio(vault.collateralAsset, vault.collateralAmount, vault.debtAmount);
    }
    function isVaultLiquidatable(address _lpAddress) external view returns (bool) {
        Vault memory vault = vaults[_lpAddress];
        if (!vault.active || vault.debtAmount == 0) return false;
        return calculateCollateralRatio(vault.collateralAsset, vault.collateralAmount, vault.debtAmount) < LIQUIDATION_RATIO;
    }
    function getVaultCount() external view returns (uint256) { return vaultList.length; }

    function addCollateralSupport(address _asset, bytes32 _pythFeedId) external onlyOwner {
        if (_pythFeedId == bytes32(0)) revert InvalidAsset();
        supportedCollateral[_asset] = true;
        collateralPriceFeeds[_asset] = _pythFeedId;
        emit CollateralSupported(_asset, address(pyth));
    }
    function removeCollateralSupport(address _asset) external onlyOwner {
        supportedCollateral[_asset] = false;
        delete collateralPriceFeeds[_asset];
    }
    function setPriceMaxAge(uint256 _maxAge) external onlyOwner {
        if (_maxAge == 0 || _maxAge > 1 hours) revert InvalidValue();
        priceMaxAge = _maxAge;
        emit PriceMaxAgeUpdated(_maxAge);
    }
    function updatePythPrices(bytes[] calldata pythUpdateData) external payable {
        uint256 fee = pyth.getUpdateFee(pythUpdateData);
        pyth.updatePriceFeeds{value: fee}(pythUpdateData);
        if (msg.value > fee) {
            (bool success, ) = payable(msg.sender).call{value: msg.value - fee}("");
            require(success, "Refund failed");
        }
    }
}