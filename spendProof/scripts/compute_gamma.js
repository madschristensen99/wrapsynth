// Compute gamma (commitment blinding factor) from transaction data
const crypto = require('crypto');
const keccak = require('keccak');
const ed = require('@noble/ed25519');

// Enable synchronous methods
ed.etc.sha512Sync = (...m) => crypto.createHash('sha512').update(ed.etc.concatBytes(...m)).digest();

async function computeGamma(secretKeyHex, viewKeyHex, outputIndex = 0) {
    console.log("🔐 Computing Gamma (Commitment Blinding Factor)\n");
    
    // Step 1: Compute shared secret S = r·A
    console.log("Step 1: Compute shared secret S = r·A");
    const r = Buffer.from(secretKeyHex, 'hex');
    const A = Buffer.from(viewKeyHex, 'hex');
    
    console.log("- Secret key r:", secretKeyHex);
    console.log("- View key A:", viewKeyHex);
    
    // Compute r·A using Ed25519
    // Note: @noble/ed25519 uses different API
    // Ed25519 order: l = 2^252 + 27742317777372353535851937790883648493
    const ED25519_ORDER = 2n**252n + 27742317777372353535851937790883648493n;
    const r_bigint = BigInt('0x' + secretKeyHex) % ED25519_ORDER;
    console.log("- Secret key (reduced mod l):", r_bigint.toString(16));
    
    console.log("- Parsing view key as Ed25519 point...");
    console.log("- View key length:", viewKeyHex.length, "chars (", viewKeyHex.length/2, "bytes)");
    
    // Get point from public key A
    let A_point;
    try {
        A_point = ed.Point.fromHex(viewKeyHex);
        console.log("- ✅ Successfully parsed point");
    } catch (e) {
        console.log("- ❌ Error parsing point:", e.message);
        throw e;
    }
    
    // Multiply: S = r·A
    const S_point = A_point.multiply(r_bigint);
    
    // Multiply by cofactor 8 (Monero does this)
    const S8_point = S_point.multiply(8n);
    
    // Convert to bytes (compressed)
    const S_hex = S8_point.toHex();
    const S = Buffer.from(S_hex, 'hex');
    console.log("- Shared secret S (32 bytes):", Buffer.from(S).toString('hex'));
    console.log();
    
    // Step 2: Compute amount_key = Keccak256(S || output_index)
    console.log("Step 2: Compute amount_key = Keccak256(S || output_index)");
    const outputIndexBuf = Buffer.from([outputIndex]); // varint encoding for small numbers
    const derivationInput = Buffer.concat([Buffer.from(S), outputIndexBuf]);
    console.log("- Input:", derivationInput.toString('hex'));
    
    const amount_key = keccak('keccak256').update(derivationInput).digest();
    console.log("- Amount key:", amount_key.toString('hex'));
    console.log();
    
    // Step 3: Compute gamma = Keccak256("commitment_mask" || amount_key)
    console.log("Step 3: Compute gamma = Keccak256('commitment_mask' || amount_key)");
    const commitmentMask = Buffer.from("commitment_mask", 'utf8');
    const gammaInput = Buffer.concat([commitmentMask, amount_key]);
    console.log("- Input:", gammaInput.toString('hex'));
    
    const gamma_hash = keccak('keccak256').update(gammaInput).digest();
    console.log("- Gamma (before reduction):", gamma_hash.toString('hex'));
    
    // Convert to bits (253 bits for circuit)
    const gammaBits = [];
    for (let i = 0; i < 32; i++) {
        for (let j = 0; j < 8; j++) {
            if (gammaBits.length < 253) {
                gammaBits.push((gamma_hash[i] >> j) & 1);
            }
        }
    }
    
    console.log("- Gamma (253 bits for circuit):", gammaBits.slice(0, 20).join(''), "... (truncated)");
    console.log();
    
    return {
        sharedSecret: Buffer.from(S).toString('hex'),
        amountKey: amount_key.toString('hex'),
        gamma: gamma_hash.toString('hex'),
        gammaBits: gammaBits
    };
}

// Test with real transaction data
const TX_DATA = {
    secretKey: "4cbf8f2cfb622ee126f08df053e99b96aa2e8c1cfd575d2a651f3343b465800a",
    viewKey: "4b3b20221b57a7f34aeea3c407d8b5a15489629907ddbb0d8313bc184aa17f81"
};

computeGamma(TX_DATA.secretKey, TX_DATA.viewKey, 0)
    .then(result => {
        console.log("═══════════════════════════════════════");
        console.log("✅ Successfully computed gamma!");
        console.log("Use gammaBits array as witness input");
        console.log("═══════════════════════════════════════");
    })
    .catch(err => {
        console.error("❌ Error:", err.message);
    });

module.exports = { computeGamma };
