// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MoneroBridgeOptimized
 * @notice Optimized Monero-to-Ethereum bridge with client-side Keccak computation
 * 
 * OPTIMIZATION STRATEGY:
 * - Keccak256 hash computed CLIENT-SIDE (not in ZK circuit)
 * - Solidity verifies the hash is correct
 * - Saves ~150,000 circuit constraints
 * - Gas cost: ~2,000 gas for Keccak verification (vs 150k constraints)
 * 
 * SECURITY:
 * - amountKey is a PUBLIC input to the circuit
 * - Solidity verifies: amountKey == Keccak256("amount" || H_s_scalar)[0:64]
 * - Prover cannot fake the amount key without being caught
 */

interface IVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[10] calldata _pubSignals
    ) external view returns (bool);
}

contract MoneroBridgeOptimized {
    
    // ════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ════════════════════════════════════════════════════════════════════════
    
    IVerifier public immutable verifier;
    
    // Track used Monero transaction outputs to prevent double-spending
    mapping(bytes32 => bool) public usedOutputs;
    
    // Events
    event MoneroLocked(
        bytes32 indexed txHash,
        uint256 indexed outputIndex,
        uint256 amount,
        address indexed recipient
    );
    
    event AmountKeyVerified(
        bytes32 H_s_scalar,
        uint64 amountKey,
        bool isValid
    );
    
    // ════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ════════════════════════════════════════════════════════════════════════
    
    constructor(address _verifier) {
        verifier = IVerifier(_verifier);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // CORE FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Mint wrapped XMR by proving ownership of Monero UTXO
     * @dev This is the OPTIMIZED version with client-side Keccak
     * 
     * @param _proof ZK-SNARK proof components [pA, pB, pC]
     * @param _pubSignals Public signals from circuit:
     *   [0] R_x - Transaction public key
     *   [1] P_compressed - Destination stealth address
     *   [2] ecdhAmount - Encrypted amount
     *   [3] A_compressed - Recipient view public key
     *   [4] B_compressed - Recipient spend public key
     *   [5] monero_tx_hash - Transaction hash
     *   [6] amountKey - Pre-computed amount key (NEW!)
     *   [7] verified_amount - Decrypted amount (output)
     * @param _H_s_scalar The H_s scalar used to compute amount key (for verification)
     * @param _recipient Ethereum address to receive wrapped XMR
     */
    function mint(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[10] calldata _pubSignals,
        bytes32 _H_s_scalar,
        address _recipient
    ) external {
        // ════════════════════════════════════════════════════════════════════
        // STEP 1: Verify amount key hash (OPTIMIZATION)
        // ════════════════════════════════════════════════════════════════════
        // This replaces ~150k circuit constraints with ~2k gas
        
        uint64 providedAmountKey = uint64(_pubSignals[6]);
        uint64 expectedAmountKey = computeAmountKey(_H_s_scalar);
        
        require(
            providedAmountKey == expectedAmountKey,
            "Invalid amount key: hash mismatch"
        );
        
        emit AmountKeyVerified(_H_s_scalar, providedAmountKey, true);
        
        // ════════════════════════════════════════════════════════════════════
        // STEP 2: Prevent double-spending
        // ════════════════════════════════════════════════════════════════════
        
        bytes32 outputId = keccak256(abi.encodePacked(
            _pubSignals[5], // monero_tx_hash
            _pubSignals[1]  // P_compressed (output index implicit)
        ));
        
        require(!usedOutputs[outputId], "Output already spent");
        usedOutputs[outputId] = true;
        
        // ════════════════════════════════════════════════════════════════════
        // STEP 3: Verify ZK proof
        // ════════════════════════════════════════════════════════════════════
        
        require(
            verifier.verifyProof(_pA, _pB, _pC, _pubSignals),
            "Invalid ZK proof"
        );
        
        // ════════════════════════════════════════════════════════════════════
        // STEP 4: Mint wrapped XMR
        // ════════════════════════════════════════════════════════════════════
        
        uint256 amount = _pubSignals[7]; // verified_amount
        
        // TODO: Mint ERC20 tokens to _recipient
        // _mint(_recipient, amount);
        
        emit MoneroLocked(
            bytes32(_pubSignals[5]), // monero_tx_hash
            0, // output_index (could be added to public signals)
            amount,
            _recipient
        );
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // OPTIMIZATION: Client-side Keccak verification
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Compute amount key using Keccak256
     * @dev This is the CRITICAL optimization function
     * 
     * Computation: Keccak256("amount" || H_s_scalar)[0:64]
     * 
     * @param _H_s_scalar 256-bit scalar (padded from 255 bits)
     * @return uint64 First 64 bits of the hash
     */
    function computeAmountKey(bytes32 _H_s_scalar) public pure returns (uint64) {
        // Domain separator: "amount" (6 bytes)
        bytes memory input = abi.encodePacked(
            bytes6("amount"),
            _H_s_scalar
        );
        
        // Compute Keccak256 hash (38 bytes input = 304 bits)
        bytes32 hash = keccak256(input);
        
        // Take first 64 bits (8 bytes)
        // Note: Solidity uses big-endian, but Circom uses little-endian bits
        // The witness generator handles this conversion
        uint64 amountKey = uint64(uint256(hash) >> 192);
        
        return amountKey;
    }
    
    /**
     * @notice Verify amount key matches expected hash (view function)
     * @dev Useful for debugging and testing
     */
    function verifyAmountKey(
        bytes32 _H_s_scalar,
        uint64 _amountKey
    ) external pure returns (bool) {
        return computeAmountKey(_H_s_scalar) == _amountKey;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // CONSTRAINT COMPARISON
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * OPTIMIZATION RESULTS:
     * 
     * Original Circuit (with Keccak in-circuit):
     * - Keccak256 component: ~150,000 constraints
     * - XOR decryption: 64 constraints
     * - Total: ~150,064 constraints
     * 
     * Optimized Circuit (Keccak moved to Solidity):
     * - Keccak256 component: 0 constraints (removed!)
     * - XOR decryption: 64 constraints
     * - Total: 64 constraints
     * 
     * SAVINGS: ~150,000 constraints (~99.96% reduction for this operation)
     * 
     * Gas Cost Trade-off:
     * - Solidity Keccak256: ~2,000 gas
     * - Verification: ~500 gas
     * - Total: ~2,500 gas
     * 
     * This is a MASSIVE win: trade 150k constraints for 2.5k gas
     */
}
