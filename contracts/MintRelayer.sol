// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./WrappedMonero.sol";

/**
 * @title MintRelayer
 * @notice ERC-4337 style relayer for privacy-preserving wXMR mints
 * @dev Users sign mint intents off-chain, relayers execute them
 * 
 * Privacy Flow:
 * 1. User sends XMR to LP's Monero address
 * 2. User signs MintIntent with fresh recipient address
 * 3. Relayer submits proof + intent signature
 * 4. wXMR minted to fresh address (no on-chain link to user)
 * 5. Relayer gets fee for gas costs
 */
contract MintRelayer is EIP712, ReentrancyGuard {
    using ECDSA for bytes32;

    // ════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ════════════════════════════════════════════════════════════════════════

    WrappedMonero public immutable wrappedMonero;
    
    // Relayer whitelist (optional - can be permissionless)
    mapping(address => bool) public authorizedRelayers;
    bool public permissionlessMode;
    address public owner;
    
    // Nonce tracking to prevent replay attacks
    mapping(address => uint256) public nonces;
    
    // Relayer fee (in basis points, e.g., 10 = 0.1%)
    uint256 public relayerFeeBps = 10;
    uint256 public constant MAX_RELAYER_FEE_BPS = 100; // Max 1%
    
    // Minimum relayer stake (to prevent spam)
    uint256 public minRelayerStake = 0.1 ether;
    mapping(address => uint256) public relayerStakes;
    
    // Intent expiry (max time between signing and execution)
    uint256 public constant MAX_INTENT_AGE = 1 hours;

    // ════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ════════════════════════════════════════════════════════════════════════

    struct MintIntent {
        address signer;           // Original user who sent XMR
        address recipient;        // Fresh address to receive wXMR
        address lp;              // LP to use for minting
        uint256 expectedAmount;  // Expected wXMR amount (in piconero)
        uint256 nonce;           // Replay protection
        uint256 deadline;        // Intent expiry timestamp
        uint256 maxRelayerFee;   // Max fee user willing to pay relayer (in piconero)
    }

    // ════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════════════

    event RelayerRegistered(address indexed relayer, uint256 stake);
    event RelayerUnregistered(address indexed relayer, uint256 stake);
    event MintRelayed(
        address indexed signer,
        address indexed recipient,
        address indexed relayer,
        uint256 amount,
        uint256 relayerFee
    );
    event RelayerFeeUpdated(uint256 oldFee, uint256 newFee);
    event PermissionlessModeToggled(bool enabled);

    // ════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ════════════════════════════════════════════════════════════════════════

    constructor(
        address payable _wrappedMonero
    ) EIP712("HookedMoneroMintRelayer", "1") {
        wrappedMonero = WrappedMonero(_wrappedMonero);
        owner = msg.sender;
        permissionlessMode = false;
    }

    // ════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ════════════════════════════════════════════════════════════════════════

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyAuthorizedRelayer() {
        if (!permissionlessMode) {
            require(authorizedRelayers[msg.sender], "Not authorized relayer");
        }
        require(relayerStakes[msg.sender] >= minRelayerStake, "Insufficient stake");
        _;
    }

    // ════════════════════════════════════════════════════════════════════════
    // RELAYER MANAGEMENT
    // ════════════════════════════════════════════════════════════════════════

    /**
     * @notice Register as a relayer by staking ETH
     */
    function registerRelayer() external payable {
        require(msg.value >= minRelayerStake, "Insufficient stake");
        relayerStakes[msg.sender] += msg.value;
        emit RelayerRegistered(msg.sender, msg.value);
    }

    /**
     * @notice Unregister and withdraw stake
     */
    function unregisterRelayer() external nonReentrant {
        uint256 stake = relayerStakes[msg.sender];
        require(stake > 0, "No stake");
        
        relayerStakes[msg.sender] = 0;
        authorizedRelayers[msg.sender] = false;
        
        (bool success, ) = msg.sender.call{value: stake}("");
        require(success, "Stake refund failed");
        
        emit RelayerUnregistered(msg.sender, stake);
    }

    /**
     * @notice Owner authorizes a relayer (if not permissionless)
     */
    function authorizeRelayer(address relayer) external onlyOwner {
        authorizedRelayers[relayer] = true;
    }

    /**
     * @notice Owner revokes relayer authorization
     */
    function revokeRelayer(address relayer) external onlyOwner {
        authorizedRelayers[relayer] = false;
    }

    /**
     * @notice Toggle permissionless mode
     */
    function togglePermissionlessMode() external onlyOwner {
        permissionlessMode = !permissionlessMode;
        emit PermissionlessModeToggled(permissionlessMode);
    }

    /**
     * @notice Update relayer fee
     */
    function setRelayerFee(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_RELAYER_FEE_BPS, "Fee too high");
        uint256 oldFee = relayerFeeBps;
        relayerFeeBps = newFeeBps;
        emit RelayerFeeUpdated(oldFee, newFeeBps);
    }

    /**
     * @notice Update minimum relayer stake
     */
    function setMinRelayerStake(uint256 newStake) external onlyOwner {
        minRelayerStake = newStake;
    }

    // ════════════════════════════════════════════════════════════════════════
    // RELAYED MINTING
    // ════════════════════════════════════════════════════════════════════════

    /**
     * @notice Relay a mint on behalf of a user
     * @dev Verifies user's signature and executes mint to fresh address
     */
    function relayMint(
        MintIntent calldata intent,
        bytes calldata signature,
        uint256[24] calldata proof,
        uint256[70] calldata publicSignals,
        WrappedMonero.DLEQProof calldata dleqProof,
        WrappedMonero.Ed25519Proof calldata ed25519Proof,
        WrappedMonero.MoneroTxOutput calldata output,
        uint256 blockHeight,
        bytes32[] calldata txMerkleProof,
        uint256 txIndex,
        bytes32[] calldata outputMerkleProof,
        uint256 outputIndex,
        bytes32 txPublicKey,
        bytes[] calldata priceUpdateData
    ) external payable onlyAuthorizedRelayer nonReentrant {
        // Verify intent signature
        _verifyIntent(intent, signature);
        
        // Verify intent is not expired
        require(block.timestamp <= intent.deadline, "Intent expired");
        require(intent.deadline <= block.timestamp + MAX_INTENT_AGE, "Deadline too far");
        
        // Increment nonce to prevent replay
        nonces[intent.signer]++;
        
        // Get amount from public signals (same as WrappedMonero.mint)
        uint256 v = publicSignals[0];
        
        // Calculate relayer fee
        uint256 relayerFee = (v * relayerFeeBps) / 10000;
        require(relayerFee <= intent.maxRelayerFee, "Relayer fee too high");
        
        // Get LP info to calculate fees
        (
            , // collateralAmount
            , // backedAmount
            uint256 mintFeeBps,
            , // burnFeeBps
            , // intentDepositBps
            , // moneroAddress
            , // privateViewKey
            , // active
              // registered
        ) = wrappedMonero.lpInfo(intent.lp);
        
        // Calculate net amount after LP fee (LP fee handled by WrappedMonero)
        uint256 lpFee = (v * mintFeeBps) / 10000;
        uint256 netAfterLPFee = v - lpFee;
        
        // Ensure user gets expected amount minus relayer fee
        require(netAfterLPFee >= intent.expectedAmount, "Amount too low");
        
        // Call WrappedMonero.mint - tokens go to this contract first
        wrappedMonero.mint{value: msg.value}(
            proof,
            publicSignals,
            dleqProof,
            ed25519Proof,
            output,
            blockHeight,
            txMerkleProof,
            txIndex,
            outputMerkleProof,
            outputIndex,
            address(this), // Mint to relayer contract first
            intent.lp,
            txPublicKey,  // Transaction public key for verification
            priceUpdateData
        );
        
        // Transfer tokens: relayer fee to relayer, rest to recipient
        if (relayerFee > 0) {
            require(
                wrappedMonero.transfer(msg.sender, relayerFee),
                "Relayer fee transfer failed"
            );
        }
        
        uint256 recipientAmount = netAfterLPFee - relayerFee;
        require(
            wrappedMonero.transfer(intent.recipient, recipientAmount),
            "Recipient transfer failed"
        );
        
        emit MintRelayed(
            intent.signer,
            intent.recipient,
            msg.sender,
            recipientAmount,
            relayerFee
        );
    }

    /**
     * @notice Create a mint intent for a user (convenience function)
     * @dev User can call this to create intent + deposit in one tx
     */
    function createMintIntentWithDeposit(
        address lp,
        uint256 expectedAmount
    ) external payable returns (bytes32 intentId) {
        // Forward to WrappedMonero
        intentId = wrappedMonero.createMintIntent{value: msg.value}(lp, expectedAmount);
    }

    // ════════════════════════════════════════════════════════════════════════
    // SIGNATURE VERIFICATION
    // ════════════════════════════════════════════════════════════════════════

    /**
     * @notice Verify mint intent signature
     */
    function _verifyIntent(
        MintIntent calldata intent,
        bytes calldata signature
    ) internal view {
        require(intent.nonce == nonces[intent.signer], "Invalid nonce");
        
        bytes32 structHash = keccak256(abi.encode(
            keccak256("MintIntent(address signer,address recipient,address lp,uint256 expectedAmount,uint256 nonce,uint256 deadline,uint256 maxRelayerFee)"),
            intent.signer,
            intent.recipient,
            intent.lp,
            intent.expectedAmount,
            intent.nonce,
            intent.deadline,
            intent.maxRelayerFee
        ));
        
        bytes32 digest = _hashTypedDataV4(structHash);
        address recoveredSigner = digest.recover(signature);
        
        require(recoveredSigner == intent.signer, "Invalid signature");
    }

    /**
     * @notice Get EIP-712 domain separator
     */
    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /**
     * @notice Get typed data hash for signing
     */
    function getTypedDataHash(MintIntent calldata intent) external view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            keccak256("MintIntent(address signer,address recipient,address lp,uint256 expectedAmount,uint256 nonce,uint256 deadline,uint256 maxRelayerFee)"),
            intent.signer,
            intent.recipient,
            intent.lp,
            intent.expectedAmount,
            intent.nonce,
            intent.deadline,
            intent.maxRelayerFee
        ));
        
        return _hashTypedDataV4(structHash);
    }

    // ════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════

    /**
     * @notice Get current nonce for a user
     */
    function getNonce(address user) external view returns (uint256) {
        return nonces[user];
    }

    /**
     * @notice Check if address is authorized relayer
     */
    function isAuthorizedRelayer(address relayer) external view returns (bool) {
        if (permissionlessMode) {
            return relayerStakes[relayer] >= minRelayerStake;
        }
        return authorizedRelayers[relayer] && relayerStakes[relayer] >= minRelayerStake;
    }

    // ════════════════════════════════════════════════════════════════════════
    // RECEIVE
    // ════════════════════════════════════════════════════════════════════════

    receive() external payable {
        // Accept ETH for relayer stakes
    }
}
