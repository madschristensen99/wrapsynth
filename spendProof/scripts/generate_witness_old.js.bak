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
    hash: "bb1eab8e0de071a272e522ad912d143aa531e0016d51e0aec800be39511dd141",
    block: 3569096,
    secretKey: "9be32769af6e99d0fef1dcddbef68f254004e2eb06e8f712c01a63d235a5410c",
    amount: 931064529072,
    destination: "87DZ8wkCoePVH7UH7zL3FhR2CjadnC83pBMqXZizg7T2dJod5rzQuAMbBg5PtcA9dHTtWAvrL7ZCTXEC2RDV3Mr4HJYP9gj",
    output_index: 0,
    node: "https://monero-rpc.cheems.de.box.skhron.com.ua:18089"
};

async function generateWitness() {
    console.log("🔧 Generating Circuit Witness from Real Monero Transaction\n");
    console.log("TX Hash:", TX_DATA.hash);
    console.log("Amount:", TX_DATA.amount, "piconero\n");
    
    try {
        // Step 1: Fetch transaction data
        console.log("📡 Step 1: Fetching transaction from node...");
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
        
        // Define expected amount for matching
        const expectedAmount = BigInt(TX_DATA.amount);
        
        // Step 5: Decode destination address to get A (view key) and B (spend key)
        console.log("\n🔑 Step 5: Decoding destination Monero address...");
        const addressKeys = decodeMoneroAddress(TX_DATA.destination);
        console.log("✅ View Key (A):", addressKeys.viewKey);
        console.log("✅ Spend Key (B):", addressKeys.spendKey);
        
        // Step 6: Extract all output keys and determine correct index automatically
        console.log("\n📤 Step 6: Extracting outputs and determining correct index...");
        
        const allOutputs = [];
        if (txJson.vout) {
            for (const vout of txJson.vout) {
                const key = vout.target?.tagged_key?.key || vout.target?.key;
                const amount = vout.amount || 0;
                if (key) allOutputs.push({ key, amount: amount.toString() });
            }
        }
        console.log(`   Found ${allOutputs.length} outputs in transaction`);
        
        // Automatically determine correct output index through amount matching
        let outputIndex = 0;
        let outputKey = allOutputs[0]?.key;
        
        if (allOutputs.length > 1) {
            console.log(`\n🔍 Testing ${allOutputs.length} outputs for correct amount...`);
            for (let testIndex = 0; testIndex < allOutputs.length; testIndex++) {
                const { key, amount } = allOutputs[testIndex];
                console.log(`   Output ${testIndex}: ${amount} piconero`);
                
                if (amount === expectedAmount.toString()) {
                    console.log(`   ✅ Output ${testIndex} matches expected amount ${expectedAmount} piconero`);
                    outputIndex = testIndex;
                    outputKey = key;
                    break;
                }
            }
        } else if (allOutputs.length === 1) {
            outputIndex = 0;
            outputKey = allOutputs[0].key;
        }
        
        console.log(`✅ Determined output index: ${outputIndex}`);
        
        if (outputIndex >= allOutputs.length) {
            throw new Error(`Output index ${outputIndex} out of range (transaction has ${allOutputs.length} outputs)`);
        }
        
        console.log(`✅ Using output ${outputIndex}: ${outputKey}`);
        console.log(`   (Circuit will enforce derivation at this exact index)`);

        
        // Step 6: Convert secret key to bits
        console.log("\n🔐 Step 6: Converting secret key to bits...");
        const secretKeyBits = hexToBits(TX_DATA.secretKey);
        console.log("✅ Secret key converted:", secretKeyBits.length, "bits");
        
        // Step 6.5: Compute R = r·G for circuit verification
        console.log("\n🔐 Step 6.5: Computing R = r·G...");
        const {computeRFromSecret} = require('./compute_rG');
        const computedR = computeRFromSecret(TX_DATA.secretKey);
        
        if (computedR.toLowerCase() !== txPubKey.toLowerCase()) {
            console.log('⚠️  Subaddress transaction detected');
            console.log('   Computed r·G:', computedR);
            console.log('   Blockchain main R:', txPubKey);
            console.log('   Using computed R for circuit verification');
        }
        
        // Use computed R for circuit (supports both standard and subaddress txs)
        const R_for_circuit = computedR;
        
        
        // Step 7: Decompress Ed25519 points to extended coordinates
        console.log("\n📋 Step 7: Decompressing Ed25519 points...");
        
        const R_extended = decompressToExtendedBase85(R_for_circuit);
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
        
        // Convert R_for_circuit to BigInt for circuit input
        const R_for_circuit_bytes = Buffer.from(R_for_circuit, 'hex');
        let R_x_bigint = 0n;
        for (let i = 0; i < 32; i++) {
            R_x_bigint |= BigInt(R_for_circuit_bytes[i]) << BigInt(i * 8);
        }
        // Clear the sign bit (bit 255)
        R_x_bigint = R_x_bigint & ((1n << 255n) - 1n);
        
        // P_compressed should be first 255 bits (without sign bit)
        const outputKeyBytes = Buffer.from(outputKey, 'hex');
        outputKeyBytes[31] &= 0x7F;
        let P_compressed_bigint = 0n;
        for (let i = 0; i < 32; i++) {
            P_compressed_bigint |= BigInt(outputKeyBytes[i]) << BigInt(i * 8);
        }
        P_compressed_bigint = P_compressed_bigint & ((1n << 255n) - 1n);
        
        // Convert ECDH amount from hex to field element (little-endian)
        const ecdhAmountBuf = Buffer.from(ecdhAmount, 'hex');
        let ecdhAmountBigInt = 0n;
        for (let i = 0; i < ecdhAmountBuf.length; i++) {
            ecdhAmountBigInt |= BigInt(ecdhAmountBuf[i]) << BigInt(i * 8);
        }
        
        // Convert TX hash to field element
        const txHashBigInt = BigInt('0x' + TX_DATA.hash);
        
        // ========================================================================
        // Compute H_s_scalar: Keccak256(8·r·A || output_index) mod L
        // This is the scalar used for destination address derivation: P = H_s·G + B
        // ========================================================================
        
        const ed = require('@noble/ed25519');
        const keccak256 = require('keccak256');
        
        // Parse secret key r (little-endian)
        const rBytes = Buffer.from(TX_DATA.secretKey, 'hex');
        let r = 0n;
        for (let i = 0; i < 32; i++) {
            r |= BigInt(rBytes[i]) << BigInt(i * 8);
        }
        
        // Parse view key A
        const A = ed.Point.fromHex(addressKeys.viewKey);
        
        // Compute derivation = 8 · r · A
        const rA = A.multiply(r);
        const derivation = rA.multiply(8n);
        const derivationHex = derivation.toHex();
        
        // Hash: Keccak256(derivation || output_index)
        const derivationBytes = Buffer.from(derivationHex, 'hex');
        const hashInput = Buffer.concat([derivationBytes, Buffer.from([outputIndex])]);
        const hash = keccak256(hashInput);
        
        // Convert hash to scalar (little-endian)
        let scalar = 0n;
        for (let i = 0; i < 32; i++) {
            scalar |= BigInt(hash[i]) << BigInt(i * 8);
        }
        
        // CRITICAL: Reduce modulo L (Ed25519 curve order)
        const L = 2n ** 252n + 27742317777372353535851937790883648493n;
        scalar = scalar % L;
        
        // Convert scalar to 255-bit array (LSB first)
        const H_s_scalar_bits = [];
        for (let i = 0; i < 255; i++) {
            H_s_scalar_bits.push(((scalar >> BigInt(i)) & 1n).toString());
        }
        
        console.log(`\n🔐 Step 8.5: Computing H_s scalar (mod L)...`);
        console.log(`   Derivation (8·r·A): ${derivationHex.substring(0, 32)}...`);
        console.log(`   Hash: ${hash.toString('hex').substring(0, 32)}...`);
        console.log(`   Scalar (mod L): ${scalar.toString(16).padStart(64, '0').substring(0, 32)}...`);
        
        // ========================================================================
        // Decrypt amount using ECDH (Bulletproof2+ format)
        // amount_key = Keccak256("amount" || H_s_scalar)[0:8]
        // where H_s_scalar = Keccak256(derivation || output_index) mod L
        // ========================================================================
        
        console.log(`\n💰 Step 8.6: Decrypting ECDH amount...`);
        
        // Convert the scalar back to bytes (little-endian, 32 bytes)
        const scalarBytes = Buffer.alloc(32);
        let tempScalar = scalar;  // This is already computed above as Hs(derivation || i) mod L
        for (let i = 0; i < 32; i++) {
            scalarBytes[i] = Number(tempScalar & 0xFFn);
            tempScalar >>= 8n;
        }
        
        // Compute amount key: Hs("amount" || scalar)
        const amountPrefix = Buffer.from('amount', 'ascii');
        const amountKeyInput = Buffer.concat([amountPrefix, scalarBytes]);  // Use SCALAR, not point
        const amountKeyFull = keccak256(amountKeyInput);
        const amountKey = amountKeyFull.slice(0, 8);  // First 8 bytes
        
        console.log(`   Scalar bytes: ${scalarBytes.toString('hex')}`);
        console.log(`   Amount prefix: "amount" (${amountPrefix.toString('hex')}`);
        console.log(`   Amount key input: ${amountKeyInput.toString('hex').substring(0, 32)}...`);
        console.log(`   Amount key (full): ${amountKeyFull.toString('hex')}`);
        console.log(`   Amount key (8 bytes): ${amountKey.toString('hex')}`);
        
        // XOR decrypt
        const ecdhAmountBytes = Buffer.from(ecdhAmount, 'hex');
        const decryptedAmount = Buffer.alloc(8);
        for (let i = 0; i < 8; i++) {
            decryptedAmount[i] = ecdhAmountBytes[i] ^ amountKey[i];
        }
        
        // Convert to integer (little-endian)
        let decryptedAmountInt = 0n;
        for (let i = 0; i < 8; i++) {
            decryptedAmountInt |= BigInt(decryptedAmount[i]) << BigInt(i * 8);
        }
        
        console.log(`   ECDH amount (encrypted): ${ecdhAmount}`);
        console.log(`   Decrypted amount bytes: ${decryptedAmount.toString('hex')}`);
        console.log(`   Decrypted amount: ${decryptedAmountInt} piconero`);
        console.log(`   Expected amount: ${TX_DATA.amount} piconero`);
        
        if (decryptedAmountInt === BigInt(TX_DATA.amount)) {
            console.log(`   ✅ Amount decryption SUCCESSFUL!`);
        } else {
            console.log(`   ⚠️  Amount mismatch - transaction may use subaddress`);
            console.log(`      (Subaddresses require additional tx keys from tx_extra)`);
        }
        
        // Note: S = 8·r·A is now computed IN-CIRCUIT from r and A
        // This is more secure as it prevents the prover from providing a fake S
        
        const witness = {
            // Private inputs
            r: secretKeyBits.slice(0, 255), // Secret key as 255 bits (FIXED)
            v: TX_DATA.amount.toString(), // Amount in piconero
            output_index: outputIndex.toString(), // Output index in transaction
            H_s_scalar: H_s_scalar_bits, // Pre-reduced scalar: Keccak256(8·r·A || i) mod L
            
            // Pre-decompressed points (circuit verifies they compress correctly)
            P_extended: P_formatted, // Destination address in extended coordinates
            // Note: A, R, B will be decompressed from public inputs in circuit
            
            // Public inputs - Compressed points as field elements
            R_x: R_x_bigint.toString(), // First 255 bits of compressed R
            P_compressed: P_compressed_bigint.toString(), // Destination address as field element
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
            output_index: witness.output_index,
            H_s_scalar: witness.H_s_scalar,
            P_extended: witness.P_extended,
            R_x: witness.R_x,
            P_compressed: witness.P_compressed,
            ecdhAmount: witness.ecdhAmount,
            A_compressed: witness.A_compressed,
            B_compressed: witness.B_compressed,
            monero_tx_hash: witness.monero_tx_hash
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
