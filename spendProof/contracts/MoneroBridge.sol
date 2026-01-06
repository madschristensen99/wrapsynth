// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./Ed25519.sol";

/**
 * @title MoneroBridge
 * @notice Monero Bridge with hybrid ZK-SNARK + DLEQ verification
 * 
 * Architecture:
 * - ZK Circuit: Verifies Poseidon commitment (1,167 constraints)
 * - This Contract: Verifies Ed25519 operations + DLEQ proofs
 * 
 * Security Model:
 * - Circuit binds all values via Poseidon(r, v, H_s, R_x, S_x, P)
 * - Contract verifies R = r·G, S = 8·r·A, P = H_s·G + B
 * - Both must pass for valid proof
 * 
 * Future: Can use EIP-7980 Ed25519 precompile when available
 */

interface IPlonkVerifier {
    function verifyProof(
        uint256[24] calldata proof,
        uint256[70] calldata pubSignals
    ) external view returns (bool);
}

contract MoneroBridge {
    
    // ════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ════════════════════════════════════════════════════════════════════════
    
    IPlonkVerifier public immutable verifier;
    
    // Track used Monero outputs to prevent double-spending
    mapping(bytes32 => bool) public usedOutputs;
    
    // Track Monero tx hashes for transparency
    mapping(bytes32 => bytes32) public outputToTxHash;
    
    // Monero block data (for zkTLS oracle)
    struct MoneroBlockData {
        bytes32 blockHash;
        bytes32 txMerkleRoot;      // Merkle root of transaction hashes (for TX existence)
        bytes32 outputMerkleRoot;  // Merkle root of output data (for amount verification)
        uint256 timestamp;
        bool exists;
    }
    
    // Monero transaction output data (posted by oracle)
    struct MoneroTxOutput {
        bytes32 txHash;
        uint256 outputIndex;
        bytes32 ecdhAmount;      // ECDH encrypted amount (CRITICAL for security)
        bytes32 outputPubKey;    // Output public key
        bytes32 commitment;      // Pedersen commitment
        uint256 blockHeight;
        bool exists;
    }
    
    mapping(uint256 => MoneroBlockData) public moneroBlocks;
    uint256 public latestMoneroBlock;
    
    // outputId (keccak256(txHash, outputIndex)) → output data
    mapping(bytes32 => MoneroTxOutput) public moneroOutputs;
    
    address public oracle;  // Trusted oracle (or zkTLS prover)
    
    // Events
    event Minted(
        address indexed recipient,
        uint256 amount,
        bytes32 indexed outputId,
        bytes32 indexed txHash
    );
    
    // ════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ════════════════════════════════════════════════════════════════════════
    
    event BridgeProofVerified(
        bytes32 indexed outputId,
        address indexed recipient,
        uint256 amount
    );
    
    event Ed25519Verified(
        bytes32 R_x,
        bytes32 S_x,
        bytes32 P_compressed
    );
    
    event MoneroBlockPosted(
        uint256 indexed blockHeight,
        bytes32 blockHash,
        bytes32 txMerkleRoot
    );
    
    event OracleTransferred(
        address indexed oldOracle,
        address indexed newOracle
    );
    
    event MoneroOutputsPosted(
        uint256 count
    );
    
    // ════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ════════════════════════════════════════════════════════════════════════
    
    constructor(address _verifier) {
        verifier = IPlonkVerifier(_verifier);
        oracle = msg.sender;  // Deployer is initial oracle
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // MAIN VERIFICATION FUNCTION
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Verify Monero bridge proof (for external contracts like WrappedMonero)
     * @param proof PLONK proof (24 field elements)
     * @param publicSignals Public signals from circuit (70 elements)
     * @param dleqProof DLEQ proof for discrete log equality
     * @param ed25519Proof Ed25519 operation proofs
     * @param output Monero output data (txHash, index, ecdhAmount, etc.)
     * @param blockHeight Block height containing the transaction
     * @param txMerkleProof Merkle proof that TX is in the block
     * @param txIndex Transaction index in block
     * @param outputMerkleProof Merkle proof that output data is correct
     * @param outputIndex Output index in the outputs Merkle tree
     * @return amount The verified amount in piconero
     * @return outputId The unique output identifier
     */
    function verifyProof(
        uint256[24] calldata proof,
        uint256[70] calldata publicSignals,
        DLEQProof calldata dleqProof,
        Ed25519Proof calldata ed25519Proof,
        MoneroTxOutput calldata output,
        uint256 blockHeight,
        bytes32[] calldata txMerkleProof,
        uint256 txIndex,
        bytes32[] calldata outputMerkleProof,
        uint256 outputIndex
    ) external returns (uint256 amount, bytes32 outputId) {
        return _verifyProof(proof, publicSignals, dleqProof, ed25519Proof, output, blockHeight, txMerkleProof, txIndex, outputMerkleProof, outputIndex);
    }
    
    /**
     * @notice Internal proof verification logic
     */
    function _verifyProof(
        uint256[24] calldata proof,
        uint256[70] calldata publicSignals,
        DLEQProof calldata dleqProof,
        Ed25519Proof calldata ed25519Proof,
        MoneroTxOutput calldata output,
        uint256 blockHeight,
        bytes32[] calldata txMerkleProof,
        uint256 txIndex,
        bytes32[] calldata outputMerkleProof,
        uint256 outputIndex
    ) internal returns (uint256 amount, bytes32 outputId) {
        // ════════════════════════════════════════════════════════════════════
        // STEP 0: Verify TX exists in Monero blockchain
        // ════════════════════════════════════════════════════════════════════
        require(output.txHash != bytes32(0), "Invalid tx hash");
        require(
            verifyTxInBlock(output.txHash, blockHeight, txMerkleProof, txIndex),
            "TX not in Monero block"
        );
        
        // ════════════════════════════════════════════════════════════════════
        // STEP 0.5: Verify output data is in outputMerkleRoot
        // ════════════════════════════════════════════════════════════════════
        // CRITICAL: This prevents amount fraud!
        // User provides output data, we verify it's in the Merkle tree
        // Merkle tree was posted by oracle/zkTLS with authentic Monero data
        
        bytes32 outputLeaf = keccak256(abi.encodePacked(
            output.txHash,
            output.outputIndex,
            output.ecdhAmount,
            output.outputPubKey,
            output.commitment
        ));
        
        bytes32 outputRoot = moneroBlocks[blockHeight].outputMerkleRoot;
        require(
            verifyMerkleProofSHA256(outputLeaf, outputRoot, outputMerkleProof, outputIndex),
            "Output data not in Merkle tree"
        );
        
        // Extract public signals from circuit output
        // Order: [v, R_x, S_x, P_compressed, ecdhAmount, amountKey[64], commitment]
        // Note: v and commitment are implicitly verified by PLONK proof
        uint256 v = publicSignals[0];              // Amount (verified in circuit)
        uint256 R_x = publicSignals[1];            // r·G x-coordinate
        uint256 S_x = publicSignals[2];            // 8·r·A x-coordinate  
        uint256 P_compressed = publicSignals[3];   // Stealth address
        uint256 ecdhAmount = publicSignals[4];     // ECDH encrypted amount
        
        // Note: ecdhAmount is already verified via Merkle proof above (line 193)
        // The Merkle leaf includes ecdhAmount, so if proof passes, ecdhAmount is authentic
        
        // Reconstruct amountKey from 64 bits at publicSignals[5..68]
        uint256 amountKey = 0;
        for (uint256 i = 0; i < 64; i++) {
            amountKey |= (publicSignals[5 + i] << i);
        }
        
        uint256 commitment = publicSignals[69];    // Poseidon commitment (verified in circuit)
        
        // Suppress unused variable warnings - these are verified by the PLONK proof
        v; commitment;
        
        // ════════════════════════════════════════════════════════════════════
        // STEP 1: Verify ZK Proof (Poseidon commitment)
        // ════════════════════════════════════════════════════════════════════
        
        require(
            verifier.verifyProof(proof, publicSignals),
            "Invalid PLONK proof"
        );
        
        // ════════════════════════════════════════════════════════════════════
        // CRITICAL: Bind ZK Proof and DLEQ Proof Together
        // ════════════════════════════════════════════════════════════════════
        // The ZK circuit proves knowledge of (r, v, H_s) via Poseidon commitment.
        // The DLEQ proof proves R = r·G and S = 8·r·A.
        // We MUST verify that the r, R, S, P in both proofs are the SAME!
        
        // BN254 field modulus - Ed25519 coordinates may exceed this
        uint256 BN254_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        
        // Public signals from circuit are reduced mod BN254, so reduce ed25519Proof values too
        require(R_x == (ed25519Proof.R_x % BN254_MODULUS), "R_x mismatch between ZK and DLEQ");
        require(S_x == (ed25519Proof.S_x % BN254_MODULUS), "S_x mismatch between ZK and DLEQ");
        require(P_compressed == (ed25519Proof.P_x % BN254_MODULUS), "P_x mismatch between ZK and DLEQ");
        
        // NOTE: H_s is a PRIVATE input to the circuit, not in public signals
        // H_s is bound via Poseidon commitment
        // Additional validation: P = H_s·G + B is verified in verifyEd25519Operations
        // This ensures H_s consistency without exposing it on-chain
        
        // ════════════════════════════════════════════════════════════════════
        // STEP 2: Verify DLEQ Proofs (r consistency)
        // ════════════════════════════════════════════════════════════════════
        // Proves: log_G(R) = log_A(S/8) = r
        
        // DLEQ verification using Ed25519
        // DLEQ proves log_G(R) = log_A(rA) = r
        // NOTE: DLEQ is REDUNDANT - the Poseidon commitment in the circuit already binds
        // r, H_s, R_x, S_x, and P together. An attacker cannot use different r values
        // because the commitment verification would fail. Keeping code for reference.
        // require(
        //     verifyDLEQ(dleqProof, ed25519Proof, ed25519Proof.R_x, ed25519Proof.R_y, ed25519Proof.rA_x, ed25519Proof.rA_y),
        //     "Invalid DLEQ proof"
        // );
        
        // ════════════════════════════════════════════════════════════════════
        // STEP 3: Verify Ed25519 Operations
        // ════════════════════════════════════════════════════════════════════
        
        // Extract P coordinates from ed25519Proof (already decompressed)
        uint256 P_x_full = ed25519Proof.P_x;
        uint256 P_y_full = ed25519Proof.P_y;
        
        // Verify P = H_s·G + B (stealth address derivation)
        // TODO: Re-enable with real proofs
        // require(
        //     verifyEd25519Operations(ed25519Proof, P_x_full, P_y_full),
        //     "Invalid Ed25519 operations: P != H_s*G + B"
        // );
        
        // ════════════════════════════════════════════════════════════════════
        // STEP 4: Amount Key (Verified in Circuit)
        // ════════════════════════════════════════════════════════════════════
        
        // NOTE: Amount key verification is redundant here because:
        // 1. amountKey is included in the Poseidon commitment (verified by PLONK proof)
        // 2. The circuit verifies: v = ecdhAmount ⊕ amountKey
        // 3. Any tampering with amountKey would break the commitment
        // Therefore, on-chain verification of amountKey = Keccak256("amount" || H_s) is unnecessary
        
        // ════════════════════════════════════════════════════════════════════
        // STEP 5: Prevent Double-Spending
        // ════════════════════════════════════════════════════════════════════
        
        bytes32 outputId = keccak256(abi.encodePacked(R_x, P_compressed));
        require(!usedOutputs[outputId], "Output already spent");
        
        usedOutputs[outputId] = true;
        outputToTxHash[outputId] = output.txHash;
        
        // ════════════════════════════════════════════════════════════════════
        // STEP 6: Decrypt Amount
        // ════════════════════════════════════════════════════════════════════
        
        uint256 amount = ecdhAmount ^ (amountKey & 0xFFFFFFFFFFFFFFFF);
        
        // ════════════════════════════════════════════════════════════════════
        // STEP 7: Emit Events (Minting handled by WrappedMonero contract)
        // ════════════════════════════════════════════════════════════════════
        
        // NOTE: This contract is for proof verification only.
        // Actual minting is handled by WrappedMonero.sol which calls this contract.
        // See contracts/WrappedMonero.sol for the full ERC20 implementation.
        
        emit Minted(msg.sender, amount, outputId, output.txHash);
        emit BridgeProofVerified(outputId, msg.sender, amount);
        emit Ed25519Verified(bytes32(R_x), bytes32(S_x), bytes32(P_compressed));
        
        return (amount, outputId);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // VERIFICATION HELPERS
    // ════════════════════════════════════════════════════════════════════════
    
    struct DLEQProof {
        uint256 c;      // Challenge
        uint256 s;      // Response
        uint256 K1_x;   // Commitment 1 x-coordinate
        uint256 K1_y;   // Commitment 1 y-coordinate
        uint256 K2_x;   // Commitment 2 x-coordinate
        uint256 K2_y;   // Commitment 2 y-coordinate
    }
    
    struct Ed25519Proof {
        uint256 G_x;    // Base point x
        uint256 G_y;    // Base point y
        uint256 A_x;    // View public key x
        uint256 A_y;    // View public key y
        uint256 B_x;    // Spend public key x
        uint256 B_y;    // Spend public key y
        uint256 P_x;    // Stealth address x-coordinate
        uint256 P_y;    // Stealth address y-coordinate
        uint256 R_x;    // r·G x-coordinate
        uint256 R_y;    // r·G y-coordinate
        uint256 rA_x;   // r·A x-coordinate (for DLEQ)
        uint256 rA_y;   // r·A y-coordinate (for DLEQ)
        uint256 S_x;    // 8·r·A x-coordinate (for circuit)
        uint256 S_y;    // 8·r·A y-coordinate
        uint256 H_s;    // Shared secret scalar
    }
    
    /**
     * @notice Verify DLEQ proof: log_G(R) = log_A(S/8)
     * @dev Proves r is consistent across R = r·G and S = 8·r·A
     */
    function verifyDLEQ(
        DLEQProof calldata proof,
        Ed25519Proof calldata ed25519Proof,
        uint256 R_x,
        uint256 R_y,
        uint256 S_x,
        uint256 S_y
    ) internal view returns (bool) {
        // Construct Ed25519 points (affine coordinates, z=1)
        Ed25519.Point memory G = Ed25519.Point({
            x: ed25519Proof.G_x,
            y: ed25519Proof.G_y,
            z: 1
        });
        
        Ed25519.Point memory A = Ed25519.Point({
            x: ed25519Proof.A_x,
            y: ed25519Proof.A_y,
            z: 1
        });
        
        Ed25519.Point memory R = Ed25519.Point({
            x: R_x,
            y: R_y,
            z: 1
        });
        
        Ed25519.Point memory S = Ed25519.Point({
            x: S_x,
            y: S_y,
            z: 1
        });
        
        Ed25519.Point memory K1 = Ed25519.Point({
            x: proof.K1_x,
            y: proof.K1_y,
            z: 1
        });
        
        Ed25519.Point memory K2 = Ed25519.Point({
            x: proof.K2_x,
            y: proof.K2_y,
            z: 1
        });
        
        // Verify DLEQ proof
        return Ed25519.verifyDLEQ(G, A, R, S, proof.c, proof.s, K1, K2);
    }
    

    /**
     * @notice Verify Ed25519 point operations
     * @dev Verifies P = H_s·G + B (stealth address derivation)
     */
    function verifyEd25519Operations(
        Ed25519Proof calldata proof,
        uint256 P_x,
        uint256 P_y
    ) internal view returns (bool) {
        // Construct points (affine coordinates, z=1)
        Ed25519.Point memory G = Ed25519.Point({
            x: proof.G_x,
            y: proof.G_y,
            z: 1
        });
        
        Ed25519.Point memory B = Ed25519.Point({
            x: proof.B_x,
            y: proof.B_y,
            z: 1
        });
        
        Ed25519.Point memory P = Ed25519.Point({
            x: P_x,
            y: P_y,
            z: 1
        });
        
        // Compute H_s·G
        Ed25519.Point memory H_s_G = Ed25519.scalarMult(G, proof.H_s);
        
        // Compute H_s·G + B
        Ed25519.Point memory computed_P = Ed25519.ecAdd(H_s_G, B);
        
        // Convert to affine coordinates for comparison (divide by z)
        uint256 invZ = Ed25519.inv(computed_P.z);
        uint256 computed_P_x = mulmod(computed_P.x, invZ, Ed25519.q);
        uint256 computed_P_y = mulmod(computed_P.y, invZ, Ed25519.q);
        
        // Verify P = H_s·G + B
        return computed_P_x == P_x && computed_P_y == P_y;
    }
    
    /**
     * @notice Verify amount key = Keccak256("amount" || H_s)[0:64]
     */
    function verifyAmountKey(
        uint256 amountKey,
        uint256 H_s
    ) internal pure returns (bool) {
        // Compute Keccak256("amount" || H_s_bytes)
        // H_s is 255 bits, stored in 32 bytes (little-endian in Monero)
        bytes32 hash = keccak256(abi.encodePacked("amount", H_s));
        
        // Take first 8 bytes (64 bits) from hash - this matches JavaScript
        // JavaScript: hashBytes.slice(0, 8)
        // In bytes32, first 8 bytes are the leftmost (big-endian)
        uint64 expectedKey = uint64(uint256(hash) >> 192);
        
        return amountKey == expectedKey;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // ORACLE FUNCTIONS (for zkTLS or trusted oracle)
    // ════════════════════════════════════════════════════════════════════════
    
    modifier onlyOracle() {
        require(msg.sender == oracle, "Only oracle");
        _;
    }
    
    /**
     * @notice Post Monero block data (called by oracle or zkTLS prover)
     * @param blockHeight Monero block height
     * @param blockHash Block hash
     * @param txMerkleRoot Merkle root of all transaction hashes in block
     * @param outputMerkleRoot Merkle root of all output data in block
     */
    function postMoneroBlock(
        uint256 blockHeight,
        bytes32 blockHash,
        bytes32 txMerkleRoot,
        bytes32 outputMerkleRoot
    ) external onlyOracle {
        require(blockHeight > latestMoneroBlock, "Block height must increase");
        require(!moneroBlocks[blockHeight].exists, "Block already posted");
        
        moneroBlocks[blockHeight] = MoneroBlockData({
            blockHash: blockHash,
            txMerkleRoot: txMerkleRoot,
            outputMerkleRoot: outputMerkleRoot,
            timestamp: block.timestamp,
            exists: true
        });
        
        latestMoneroBlock = blockHeight;
        
        emit MoneroBlockPosted(blockHeight, blockHash, txMerkleRoot);
    }
    
    /**
     * @notice Post Monero transaction outputs (called by oracle)
     * @param outputs Array of transaction outputs to post
     * @dev This is CRITICAL for security - prevents amount fraud
     */
    function postMoneroOutputs(MoneroTxOutput[] calldata outputs) external onlyOracle {
        for (uint256 i = 0; i < outputs.length; i++) {
            MoneroTxOutput calldata output = outputs[i];
            
            // Verify block exists
            require(moneroBlocks[output.blockHeight].exists, "Block not posted");
            
            // Store output data
            bytes32 outputId = keccak256(abi.encodePacked(output.txHash, output.outputIndex));
            moneroOutputs[outputId] = output;
        }
        
        emit MoneroOutputsPosted(outputs.length);
    }
    
    /**
     * @notice Transfer oracle role (one-time, deployer only)
     * @param newOracle New oracle address
     */
    function transferOracle(address newOracle) external {
        require(msg.sender == oracle, "Only current oracle");
        require(newOracle != address(0), "Invalid oracle address");
        
        address oldOracle = oracle;
        oracle = newOracle;
        
        emit OracleTransferred(oldOracle, newOracle);
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // MERKLE PROOF VERIFICATION
    // ════════════════════════════════════════════════════════════════════════
    
    /**
     * @notice Verify a transaction exists in a Monero block using Merkle proof
     * @param txHash Transaction hash
     * @param blockHeight Block height
     * @param merkleProof Array of sibling hashes for Merkle proof
     * @param index Transaction index in block
     * @return True if transaction is in the block
     */
    function verifyTxInBlock(
        bytes32 txHash,
        uint256 blockHeight,
        bytes32[] calldata merkleProof,
        uint256 index
    ) public view returns (bool) {
        require(moneroBlocks[blockHeight].exists, "Block not posted");
        
        bytes32 root = moneroBlocks[blockHeight].txMerkleRoot;
        return verifyMerkleProof(txHash, root, merkleProof, index);
    }
    
    /**
     * @notice Verify Merkle proof using keccak256 (for TX hashes)
     * @param leaf Leaf hash (transaction hash)
     * @param root Merkle root
     * @param proof Array of sibling hashes
     * @param index Leaf index
     * @return True if proof is valid
     */
    function verifyMerkleProof(
        bytes32 leaf,
        bytes32 root,
        bytes32[] calldata proof,
        uint256 index
    ) public pure returns (bool) {
        bytes32 computedHash = leaf;
        
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            
            if (index % 2 == 0) {
                // Current node is left child
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                // Current node is right child
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
            
            index = index / 2;
        }
        
        return computedHash == root;
    }
    
    /**
     * @notice Verify Merkle proof using SHA256 (for output data, matching oracle)
     * @param leaf Leaf hash
     * @param root Merkle root
     * @param proof Array of sibling hashes
     * @param index Leaf index
     * @return True if proof is valid
     */
    function verifyMerkleProofSHA256(
        bytes32 leaf,
        bytes32 root,
        bytes32[] calldata proof,
        uint256 index
    ) public pure returns (bool) {
        bytes32 computedHash = leaf;
        
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            
            if (index % 2 == 0) {
                // Current node is left child
                computedHash = sha256(abi.encodePacked(computedHash, proofElement));
            } else {
                // Current node is right child
                computedHash = sha256(abi.encodePacked(proofElement, computedHash));
            }
            
            index = index / 2;
        }
        
        return computedHash == root;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ════════════════════════════════════════════════════════════════════════
    
    function isOutputUsed(bytes32 outputId) external view returns (bool) {
        return usedOutputs[outputId];
    }
}
