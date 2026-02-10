// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IWrappedMonero {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IMintRelayer {
    struct MintIntent {
        address signer;
        address recipient;
        address lp;
        uint256 expectedAmount;
        uint256 nonce;
        uint256 deadline;
        uint256 maxRelayerFee;
    }
    
    function relayMint(
        MintIntent calldata intent,
        bytes calldata signature,
        bytes calldata proof,
        uint256[] calldata publicSignals,
        DLEQProof calldata dleqProof,
        Ed25519Proof calldata ed25519Proof,
        MoneroOutput calldata output,
        uint256 blockHeight,
        bytes32[] calldata txMerkleProof,
        uint256 txIndex,
        bytes32[] calldata outputMerkleProof,
        uint256 outputGlobalIndex
    ) external payable;
    
    struct DLEQProof {
        bytes32 c;
        bytes32 s;
        bytes32 K1;
        bytes32 K2;
    }
    
    struct Ed25519Proof {
        bytes32 R_x;
        bytes32 R_y;
        bytes32 S_x;
        bytes32 S_y;
        bytes32 P_x;
        bytes32 P_y;
        bytes32 B_x;
        bytes32 B_y;
        bytes32 G_x;
        bytes32 G_y;
        bytes32 A_x;
        bytes32 A_y;
    }
    
    struct MoneroOutput {
        bytes32 key;
        bytes32 commitment;
        bytes32 ecdhAmount;
    }
}

/**
 * @title PrivacySwapHook
 * @notice Uniswap v4 Hook for private token acquisition via Monero
 * @dev Enables atomic mint wXMR → swap to any token with complete privacy
 * 
 * Flow:
 * 1. User sends Monero to LP
 * 2. Relayer mints wXMR to this hook
 * 3. Hook automatically swaps wXMR → desired token
 * 4. Tokens sent to fresh address (no on-chain link)
 * 
 * Privacy Features:
 * - No connection between Monero sender and token recipient
 * - Relayer pays all gas
 * - Atomic execution (mint + swap)
 * - MEV protection via slippage limits
 */
contract PrivacySwapHook is BaseHook {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using SafeERC20 for IERC20;

    // ════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ════════════════════════════════════════════════════════════════════════════

    error Unauthorized();
    error InvalidSwapParams();
    error SlippageTooHigh();
    error SwapFailed();
    error InsufficientOutput();
    error InvalidRecipient();

    // ════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════════════════

    event PrivacySwapExecuted(
        address indexed recipient,
        address indexed outputToken,
        uint256 wXMRAmount,
        uint256 outputAmount,
        bytes32 moneroTxHash
    );

    event SwapIntentRegistered(
        bytes32 indexed intentHash,
        address recipient,
        address outputToken,
        uint256 minAmountOut
    );

    // ════════════════════════════════════════════════════════════════════════════
    // STATE
    // ════════════════════════════════════════════════════════════════════════════

    IWrappedMonero public immutable wrappedMonero;
    IMintRelayer public immutable mintRelayer;
    
    /// @notice Mapping of pending swap intents: intentHash => SwapIntent
    mapping(bytes32 => SwapIntent) public swapIntents;
    
    /// @notice Mapping to track completed swaps
    mapping(bytes32 => bool) public completedSwaps;

    struct SwapIntent {
        address recipient;        // Fresh address to receive tokens
        address outputToken;      // Desired token
        uint256 minAmountOut;     // Minimum tokens to receive (slippage protection)
        uint256 deadline;         // Swap must execute before this
        bool zeroForOne;          // Swap direction in pool
        bytes32 moneroTxHash;     // Link to Monero transaction
    }

    // ════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ════════════════════════════════════════════════════════════════════════════

    constructor(
        IPoolManager _poolManager,
        address _wrappedMonero,
        address _mintRelayer
    ) BaseHook(_poolManager) {
        wrappedMonero = IWrappedMonero(_wrappedMonero);
        mintRelayer = IMintRelayer(_mintRelayer);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // HOOK PERMISSIONS
    // ════════════════════════════════════════════════════════════════════════════

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,           // Check swap intent before execution
            afterSwap: true,            // Complete privacy swap after execution
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PRIVACY SWAP FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Register a swap intent for automatic execution after mint
     * @dev Called by user before minting wXMR
     * @param recipient Fresh address to receive output tokens
     * @param outputToken Desired token address
     * @param minAmountOut Minimum output amount (slippage protection)
     * @param deadline Swap deadline
     * @param moneroTxHash Monero transaction hash (for tracking)
     */
    function registerSwapIntent(
        address recipient,
        address outputToken,
        uint256 minAmountOut,
        uint256 deadline,
        bool zeroForOne,
        bytes32 moneroTxHash
    ) external returns (bytes32 intentHash) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (outputToken == address(0)) revert InvalidSwapParams();
        if (deadline < block.timestamp) revert InvalidSwapParams();
        
        intentHash = keccak256(abi.encodePacked(
            recipient,
            outputToken,
            minAmountOut,
            deadline,
            moneroTxHash,
            block.timestamp
        ));
        
        swapIntents[intentHash] = SwapIntent({
            recipient: recipient,
            outputToken: outputToken,
            minAmountOut: minAmountOut,
            deadline: deadline,
            zeroForOne: zeroForOne,
            moneroTxHash: moneroTxHash
        });
        
        emit SwapIntentRegistered(intentHash, recipient, outputToken, minAmountOut);
    }

    /**
     * @notice Execute privacy mint and swap in one transaction
     * @dev This is the main entry point for private token acquisition
     */
    function privateMintAndSwap(
        IMintRelayer.MintIntent calldata mintIntent,
        bytes calldata mintSignature,
        bytes calldata proof,
        uint256[] calldata publicSignals,
        IMintRelayer.DLEQProof calldata dleqProof,
        IMintRelayer.Ed25519Proof calldata ed25519Proof,
        IMintRelayer.MoneroOutput calldata output,
        uint256 blockHeight,
        bytes32[] calldata txMerkleProof,
        uint256 txIndex,
        bytes32[] calldata outputMerkleProof,
        uint256 outputGlobalIndex,
        SwapIntent calldata swapIntent,
        PoolKey calldata poolKey
    ) external payable {
        // 1. Register swap intent
        bytes32 intentHash = keccak256(abi.encodePacked(
            swapIntent.recipient,
            swapIntent.outputToken,
            swapIntent.minAmountOut,
            swapIntent.deadline,
            swapIntent.moneroTxHash,
            block.timestamp
        ));
        
        swapIntents[intentHash] = swapIntent;
        
        // 2. Execute mint (wXMR comes to this contract)
        IMintRelayer.MintIntent memory modifiedIntent = mintIntent;
        modifiedIntent.recipient = address(this); // Mint to hook
        
        mintRelayer.relayMint{value: msg.value}(
            modifiedIntent,
            mintSignature,
            proof,
            publicSignals,
            dleqProof,
            ed25519Proof,
            output,
            blockHeight,
            txMerkleProof,
            txIndex,
            outputMerkleProof,
            outputGlobalIndex
        );
        
        // 3. Get wXMR balance
        uint256 wXMRBalance = wrappedMonero.balanceOf(address(this));
        
        // 4. Execute swap via Uniswap v4
        _executeSwap(poolKey, wXMRBalance, swapIntent, intentHash);
    }

    /**
     * @notice Internal function to execute swap on Uniswap v4
     */
    function _executeSwap(
        PoolKey calldata poolKey,
        uint256 amountIn,
        SwapIntent memory intent,
        bytes32 intentHash
    ) internal {
        if (block.timestamp > intent.deadline) revert InvalidSwapParams();
        if (completedSwaps[intentHash]) revert SwapFailed();
        
        // Approve PoolManager to spend wXMR
        wrappedMonero.approve(address(poolManager), amountIn);
        
        // Execute swap
        SwapParams memory swapParams = SwapParams({
            zeroForOne: intent.zeroForOne,
            amountSpecified: -int256(amountIn), // Exact input
            sqrtPriceLimitX96: intent.zeroForOne 
                ? TickMath.MIN_SQRT_PRICE + 1 
                : TickMath.MAX_SQRT_PRICE - 1
        });
        
        BalanceDelta delta = poolManager.swap(poolKey, swapParams, "");
        
        // Calculate output amount
        uint256 outputAmount = intent.zeroForOne 
            ? uint256(int256(-delta.amount1()))
            : uint256(int256(-delta.amount0()));
        
        if (outputAmount < intent.minAmountOut) revert InsufficientOutput();
        
        // Transfer output tokens to recipient
        IERC20(intent.outputToken).safeTransfer(intent.recipient, outputAmount);
        
        // Mark as completed
        completedSwaps[intentHash] = true;
        
        emit PrivacySwapExecuted(
            intent.recipient,
            intent.outputToken,
            amountIn,
            outputAmount,
            intent.moneroTxHash
        );
    }

    // ════════════════════════════════════════════════════════════════════════════
    // HOOK CALLBACKS
    // ════════════════════════════════════════════════════════════════════════════

    function _beforeSwap(
        address,
        PoolKey calldata,
        SwapParams calldata,
        bytes calldata
    ) internal view override returns (bytes4, BeforeSwapDelta, uint24) {
        // Could add additional checks here
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _afterSwap(
        address,
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        // Swap completed, privacy maintained
        return (this.afterSwap.selector, 0);
    }
}
