const monerojs = require("monero-javascript");
const axios = require("axios");
const fs = require("fs");
const { decompressToExtendedBase85, formatForCircuit } = require("./ed25519_utils");

// Decode Monero address to extract view key (A) and spend key (B)
function decodeMoneroAddress(address) {
    // Monero address format: [network_byte][spend_key (32 bytes)][view_key (32 bytes)][checksum (4 bytes)]
    const base58 = require('base58-monero');
    const decoded = base58.decode(address);
    
    // Monero uses: [network_byte][spend_public_key][view_public_key][checksum]
    // Skip network byte (1 byte), extract spend (32 bytes) then view (32 bytes)
    const spendKey = decoded.slice(1, 33).toString('hex');
    const viewKey = decoded.slice(33, 65).toString('hex');
    
    return {
        viewKey: viewKey,   // A: 64 hex chars (32 bytes)
        spendKey: spendKey  // B: 64 hex chars (32 bytes)
    };
}

// Real Monero stagenet transaction data
const TX_DATA = {
    hash: "827368baa751b395728f79608c0792419a88f08119601669baede39ba0225d4b",
    block: 2023616,
    secretKey: "ab923eb60a5de7ff9e40be288ae55ccaea5a6ee175180eabe7774a2951d59701",
    amount: 1150000000, // 0.00115 XMR
    destination: "77tyMuyZhpUNuqKfNTHL3J9AxDVX6MKRvgjLEMPra23CMUGX1UZEHJYLtG54ziVsUqdDLbtLrpMCnbPgvqAAzJrRM3jevta",
    node: "https://stagenet.xmr.ditatompel.com"
};

async function generateWitness() {
    console.log("🔧 Generating Circuit Witness from Real Monero Transaction\n");
    console.log("TX Hash:", TX_DATA.hash);
    console.log("Amount:", TX_DATA.amount, "piconero\n");
    
    try {
        // Step 1: Fetch transaction data
        console.log("📡 Step 1: Fetching transaction from stagenet...");
        const response = await axios.post(`${TX_DATA.node}/gettransactions`, {
            txs_hashes: [TX_DATA.hash],
            decode_as_json: true
        });
        
        if (!response.data || !response.data.txs || response.data.txs.length === 0) {
            throw new Error("Transaction not found");
        }
        
        const txData = response.data.txs[0];
        const txJson = JSON.parse(txData.as_json);
        
        console.log("✅ Transaction fetched");
        console.log("   Version:", txJson.version);
        console.log("   RCT Type:", txJson.rct_signatures.type);
        
        // Step 2: Extract transaction public key (R)
        console.log("\n🔑 Step 2: Extracting transaction public key (R)...");
        let txPubKey = null;
        if (txJson.extra && txJson.extra[0] === 1 && txJson.extra.length >= 33) {
            txPubKey = Buffer.from(txJson.extra.slice(1, 33)).toString('hex');
            console.log("✅ TX Public Key (R):", txPubKey);
        } else {
            throw new Error("Could not extract transaction public key");
        }
        
        // Step 3: Extract ECDH encrypted amount
        console.log("\n💰 Step 3: Extracting ECDH encrypted amount...");
        const ecdhInfo = txJson.rct_signatures.ecdhInfo;
        if (!ecdhInfo || ecdhInfo.length === 0) {
            throw new Error("No ECDH info found");
        }
        
        // Assuming output 0 is our output (0.02 XMR)
        const ecdhAmount = ecdhInfo[0].amount;
        console.log("✅ ECDH Encrypted Amount:", ecdhAmount);
        
        // Step 4: Extract Pedersen commitment
        console.log("\n🎯 Step 4: Extracting Pedersen commitment...");
        const commitments = txJson.rct_signatures.outPk;
        if (!commitments || commitments.length === 0) {
            throw new Error("No commitments found");
        }
        
        const commitment = commitments[0];
        console.log("✅ Commitment (C):", commitment);
        
        // Step 5: Decode destination address to get A (view key) and B (spend key)
        console.log("\n🔑 Step 5: Decoding destination Monero address...");
        const addressKeys = decodeMoneroAddress(TX_DATA.destination);
        console.log("✅ View Key (A):", addressKeys.viewKey);
        console.log("✅ Spend Key (B):", addressKeys.spendKey);
        
        // Step 6: Extract one-time address (output public key)
        console.log("\n📤 Step 6: Extracting output public key...");
        let outputKey = null;
        if (txJson.vout && txJson.vout[0] && txJson.vout[0].target) {
            outputKey = txJson.vout[0].target.key || txJson.vout[0].target.tagged_key?.key;
        }
        if (!outputKey) {
            console.log("⚠️  Output key not found in expected location");
            console.log("   vout[0]:", JSON.stringify(txJson.vout[0], null, 2));
            outputKey = "unknown";
        } else {
            console.log("✅ Output Key (P):", outputKey);
        }
        
        // Step 6: Convert secret key to bits
        console.log("\n🔐 Step 6: Converting secret key to bits...");
        const secretKeyBits = hexToBits(TX_DATA.secretKey);
        console.log("✅ Secret key converted:", secretKeyBits.length, "bits");
        
        // Step 7: Decompress Ed25519 points to extended coordinates
        console.log("\n📋 Step 7: Decompressing Ed25519 points...");
        
        const R_extended = decompressToExtendedBase85(txPubKey);
        const P_extended = decompressToExtendedBase85(outputKey);
        const A_extended = decompressToExtendedBase85(addressKeys.viewKey);
        const B_extended = decompressToExtendedBase85(addressKeys.spendKey);
        const C_extended = decompressToExtendedBase85(commitment);
        
        console.log("\n✅ All points decompressed to extended coordinates!");
        
        // Step 8: Format for circuit
        console.log("\n📋 Step 8: Formatting for circuit input...");
        
        const R_formatted = formatForCircuit(R_extended);
        const P_formatted = formatForCircuit(P_extended);
        const A_formatted = formatForCircuit(A_extended);
        const B_formatted = formatForCircuit(B_extended);
        const C_formatted = formatForCircuit(C_extended);
        
        // Step 9: Create complete witness
        console.log("\n📋 Step 9: Creating complete witness...");
        
        // SUBADDRESS COMPATIBILITY:
        // Monero supports two types of addresses:
        // 1. Standard addresses (prefix 5 on stagenet): Use the main tx public key R from extra field
        // 2. Subaddresses (prefix 7 on stagenet): Use additional tx public keys (one per output)
        //
        // Feather wallet provides the correct tx_key for the specific output:
        // - For standard addresses: This matches the main R in the transaction's extra field
        // - For subaddresses: This is the additional tx key for that specific output
        //
        // To support both cases, we compute R from the secret key provided by Feather.
        // The circuit then verifies r·G = R, proving knowledge of the transaction secret key.
        // This approach works for both standard addresses and subaddresses.
        const {computeRFromSecret} = require('./compute_rG');
        const computedR = computeRFromSecret(TX_DATA.secretKey);
        
        const computedRBytes = Buffer.from(computedR, 'hex');
        // Clear the sign bit (bit 255)
        computedRBytes[31] &= 0x7F;
        // Convert to BigInt (little-endian)
        let R_x_bigint = 0n;
        for (let i = 0; i < 32; i++) {
            R_x_bigint |= BigInt(computedRBytes[i]) << BigInt(i * 8);
        }
        // Ensure it's only 255 bits
        R_x_bigint = R_x_bigint & ((1n << 255n) - 1n);
        
        // P_compressed and C_compressed should also be first 255 bits (without sign bit)
        const outputKeyBytes = Buffer.from(outputKey, 'hex');
        outputKeyBytes[31] &= 0x7F;
        let P_compressed_bigint = 0n;
        for (let i = 0; i < 32; i++) {
            P_compressed_bigint |= BigInt(outputKeyBytes[i]) << BigInt(i * 8);
        }
        P_compressed_bigint = P_compressed_bigint & ((1n << 255n) - 1n);
        
        const commitmentBytes = Buffer.from(commitment, 'hex');
        commitmentBytes[31] &= 0x7F;
        let C_compressed_bigint = 0n;
        for (let i = 0; i < 32; i++) {
            C_compressed_bigint |= BigInt(commitmentBytes[i]) << BigInt(i * 8);
        }
        C_compressed_bigint = C_compressed_bigint & ((1n << 255n) - 1n);
        
        // Convert ECDH amount from hex to field element
        const ecdhAmountBigInt = BigInt('0x' + ecdhAmount);
        
        // Convert TX hash to field element
        const txHashBigInt = BigInt('0x' + TX_DATA.hash);
        
        const witness = {
            // Private inputs
            r: secretKeyBits.slice(0, 256), // Secret key as 256 bits
            v: TX_DATA.amount.toString(), // Amount in piconero
            gamma: Array(256).fill("0"), // Dummy gamma (verification disabled - we don't have sender's gamma)
            
            // Pre-decompressed points (circuit verifies they compress correctly)
            P_extended: P_formatted, // Destination address in extended coordinates
            A_extended: A_formatted, // LP view key (decoded from destination address)
            B_extended: B_formatted, // LP spend key (decoded from destination address)
            
            // Public inputs - Compressed points as field elements
            R_x: R_x_bigint.toString(), // First 255 bits of compressed R
            P_compressed: P_compressed_bigint.toString(), // Destination address as field element
            C_compressed: C_compressed_bigint.toString(), // Commitment as field element
            ecdhAmount: ecdhAmountBigInt.toString(),
            
            // Bridge-specific inputs - LP keys
            A_compressed: (() => {
                const aBytes = Buffer.from(addressKeys.viewKey, 'hex');
                aBytes[31] &= 0x7F;
                let aBigInt = 0n;
                for (let i = 0; i < 32; i++) {
                    aBigInt |= BigInt(aBytes[i]) << BigInt(i * 8);
                }
                return (aBigInt & ((1n << 255n) - 1n)).toString();
            })(),
            B_compressed: (() => {
                const bBytes = Buffer.from(addressKeys.spendKey, 'hex');
                bBytes[31] &= 0x7F;
                let bBigInt = 0n;
                for (let i = 0; i < 32; i++) {
                    bBigInt |= BigInt(bBytes[i]) << BigInt(i * 8);
                }
                return (bBigInt & ((1n << 255n) - 1n)).toString();
            })(),
            monero_tx_hash: (txHashBigInt % (1n << 252n)).toString(), // Reduced to fit field
            bridge_tx_binding: "0", // Keccak256 of bridge tx (would be computed)
            chain_id: "42161", // Arbitrum chain ID
            
            // Metadata for reference (extended coordinates for debugging)
            _metadata: {
                tx_hash: TX_DATA.hash,
                tx_pubkey: txPubKey,
                output_key: outputKey,
                commitment: commitment,
                ecdh_amount_hex: ecdhAmount,
                amount_piconero: TX_DATA.amount,
                destination: TX_DATA.destination,
                R_extended: R_formatted,
                P_extended: P_formatted,
                C_extended: C_formatted
            }
        };
        
        // Save to file
        const outputPath = "witness_data.json";
        fs.writeFileSync(outputPath, JSON.stringify(witness, null, 2));
        console.log(`\n✅ Complete witness data saved to ${outputPath}`);
        
        // Also save in a format ready for circuit testing
        const circuitInput = {
            r: witness.r,
            v: witness.v,
            gamma: witness.gamma,
            A_extended: witness.A_extended,
            R_extended: witness._metadata.R_extended,
            P_extended: witness.P_extended,
            B_extended: witness.B_extended,
            R_x: witness.R_x,
            P_compressed: witness.P_compressed,
            C_compressed: witness.C_compressed,
            ecdhAmount: witness.ecdhAmount,
            B_compressed: witness.B_compressed,
            monero_tx_hash: witness.monero_tx_hash,
            bridge_tx_binding: witness.bridge_tx_binding,
            chain_id: witness.chain_id
        };
        
        fs.writeFileSync("input.json", JSON.stringify(circuitInput, null, 2));
        console.log(`✅ Circuit input saved to input.json`);
        
        // Display summary
        console.log("\n" + "=".repeat(70));
        console.log("📊 WITNESS GENERATION SUMMARY");
        console.log("=".repeat(70));
        console.log("\n✅ Successfully Extracted:");
        console.log("   • Transaction public key (R):", txPubKey.substring(0, 16) + "...");
        console.log("   • Output public key (P):", outputKey !== "unknown" ? outputKey.substring(0, 16) + "..." : "unknown");
        console.log("   • Pedersen commitment (C):", commitment.substring(0, 16) + "...");
        console.log("   • ECDH encrypted amount:", ecdhAmount);
        console.log("   • Secret key (256 bits)");
        console.log("   • Amount:", TX_DATA.amount, "piconero");
        
        console.log("\n✅ Complete:");
        console.log("   • Ed25519 points decompressed to extended coordinates");
        console.log("   • Converted to base 2^85 representation (3 limbs)");
        console.log("   • Formatted as circuit inputs");
        console.log("   • Witness data ready for circuit!");
        
        console.log("\n💡 Next Steps:");
        console.log("   1. Generate witness: node build/monero_bridge_js/generate_witness.js");
        console.log("   2. Setup ceremony: snarkjs powersoftau new bn128 12 pot12_0000.ptau");
        console.log("   3. Generate proving key: snarkjs groth16 setup");
        console.log("   4. Generate proof: snarkjs groth16 prove");
        console.log("   5. Verify proof: snarkjs groth16 verify");
        
        console.log("\n🎉 Real Monero data successfully processed!");
        console.log("   ✓ All cryptographic operations completed");
        console.log("   ✓ Witness ready for circuit execution\n");
        
        return witness;
        
    } catch (error) {
        console.error("\n❌ Error generating witness:");
        console.error(error.message);
        if (error.response) {
            console.error("API Error:", error.response.status, error.response.data);
        }
        throw error;
    }
}

// Helper: Convert hex to bits (LSB first)
// BYTE ORDER CONVERSION:
// Feather wallet displays transaction keys in big-endian hex format (human-readable).
// However, Monero internally uses little-endian byte order for scalars.
//
// This function processes the hex string byte-by-byte from left to right,
// which effectively reverses the byte order during conversion to bits.
// Example: "4cbf8f2c..." becomes scalar 0x0a8065b4... (bytes reversed)
//
// Each byte is then converted to 8 bits in LSB-first order (little-endian bit order).
// This double conversion (byte reversal + LSB bits) correctly transforms Feather's
// big-endian display format into the little-endian scalar format expected by the circuit.
function hexToBits(hex) {
    const bits = [];
    for (let i = 0; i < hex.length; i += 2) {
        const byte = parseInt(hex.substr(i, 2), 16);
        for (let j = 0; j < 8; j++) {
            bits.push((byte >> j) & 1);
        }
    }
    return bits;
}

// Run the generator
if (require.main === module) {
    generateWitness()
        .then(() => {
            console.log("✅ Witness generation completed");
            process.exit(0);
        })
        .catch(err => {
            console.error("❌ Witness generation failed:", err.message);
            process.exit(1);
        });
}

module.exports = { generateWitness };
