const snarkjs = require("snarkjs");
const path = require("path");
const { generateWitness } = require("../../scripts/lpServer/proofGeneration/generate_witness.js");

/**
 * Generate a real ZK proof for testing
 * @param {Object} txData - Transaction data including r, H_s_scalar, v, etc.
 * @returns {Object} - Proof and public signals
 */
async function generateRealProof(txData) {
    console.log("    🔐 Generating real ZK proof (takes ~3 seconds)...");
    
    const circuitWasmPath = path.join(__dirname, "../../circuit/build/monero_bridge_js/monero_bridge.wasm");
    const zkeyPath = path.join(__dirname, "../../circuit/build/monero_bridge_final.zkey");
    
    // Generate witness
    const witness = await generateWitness(txData);
    
    // Prepare input for circuit
    const input = {
        r: witness.r,
        v: witness.v,
        H_s_scalar: witness.H_s_scalar,
        R_x: witness.R_x,
        S_x: witness.S_x,
        P_compressed: witness.P_compressed,
        ecdhAmount: witness.ecdhAmount,
        amountKey: witness.amountKey,
        commitment: witness.commitment
    };
    
    // Generate proof using snarkjs
    const { proof, publicSignals } = await snarkjs.plonk.fullProve(
        input,
        circuitWasmPath,
        zkeyPath
    );
    
    // Format proof for Solidity
    const proofCalldata = await snarkjs.plonk.exportSolidityCallData(proof, publicSignals);
    const proofArray = JSON.parse("[" + proofCalldata + "]");
    const proofBytes = proofArray[0];
    
    console.log("    ✅ Real ZK proof generated!");
    
    return {
        proof: proofBytes,
        publicSignals: publicSignals.map(s => s.toString()),
        dleqProof: witness.dleqProof,
        ed25519Proof: witness.ed25519Proof,
        witness: witness
    };
}

/**
 * Generate test transaction data for a known Monero transaction
 * @returns {Object} - Test transaction data
 */
function generateTestTxData() {
    // This would be real Monero transaction data
    // For now, using mock data that matches the circuit structure
    return {
        r: "0x" + "12".repeat(32), // Transaction private key component
        H_s_scalar: "0x" + "34".repeat(32), // Stealth address component
        v: "1000000000000", // 1 XMR in piconero
        ecdhAmount: "0x" + "56".repeat(8), // Encrypted amount
        R_x: "123456789", // Transaction public key X coordinate
        S_x: "987654321", // S = r*H_s X coordinate  
        P_compressed: "111111111", // Recipient public key
        A_compressed: "0x" + "78".repeat(32), // For DLEQ
        B_compressed: "0x" + "9a".repeat(32), // For DLEQ
        outputPubKey: "0x" + "bc".repeat(32),
        commitment: "0x" + "de".repeat(32),
        txHash: "0x" + "f0".repeat(32),
        outputIndex: 0,
        blockHeight: 3000001
    };
}

module.exports = {
    generateRealProof,
    generateTestTxData
};
