#!/usr/bin/env node

/**
 * Complete Proof Generation for Real Monero Transaction
 * 
 * This script:
 * 1. Computes H_s = Hs(r * A) from transaction private key and LP view key
 * 2. Decrypts the amount
 * 3. Generates witness data
 * 4. Creates PLONK proof
 */

const ed = require('@noble/ed25519');
const { keccak256 } = require('js-sha3');
const fs = require('fs');
const path = require('path');
const { generateWitness } = require('./generate_witness.js');
const { computeEd25519Operations } = require('./generate_dleq_proof.js');
const snarkjs = require('snarkjs');

// Ed25519 curve order
const L = BigInt('7237005577332262213973186563042994240857116359379907606001950938285454250989');

// Your transaction data
const TX_DATA = {
    txHash: '8759425cbf9865243bf5ba75934be23e9acba13711a23d7c23d4770d1689cdd9',
    r: 'e35691c195105c0881e41af2b11e232967bc588672842a1874f8ab122b3d9003',
    blockHeight: 3594966,
    outputIndex: 1, // Try output 1
    
    // LP keys (from address 87G8STCTDVLXm3RYuTBUigPNY4N1yDroBBbDSEwME4w9ezDDcTJhXcSL6urUJiHJK2hADMyqweuMZgaK9fw2bF21CyAuQBQ)
    lpViewKey: '14e6b2d5e3f3df596fcceacdec8f3d0cd12005ffe5848e40c2b176cf84612809',
};

/**
 * Hash to scalar (Monero's Hs function)
 */
function hashToScalar(data) {
    const hash = keccak256(data);
    const scalar = BigInt('0x' + hash) % L;
    return scalar;
}

/**
 * Compute H_s = Hs(r * A)
 */
async function computeSharedSecret(r_hex, A_hex) {
    console.log('\n🔐 Computing Shared Secret H_s = Hs(r * A)\n');
    
    // Parse r
    const r_scalar = BigInt('0x' + r_hex.replace(/^0x/, '')) % L;
    console.log('   r:', r_hex.substring(0, 16) + '...');
    
    // Decompress A (LP view key)
    const A = await ed.Point.fromHex(A_hex.replace(/^0x/, ''));
    console.log('   A (LP view key):', A_hex.substring(0, 16) + '...');
    
    // Compute r * A
    console.log('   Computing r * A...');
    const rA = A.multiply(r_scalar);
    console.log('   ✅ r * A computed');
    
    // Hash to scalar: H_s = Hs(r * A)
    const rA_bytes = Buffer.from(rA.toHex(), 'hex');
    const H_s = hashToScalar(rA_bytes);
    const H_s_hex = H_s.toString(16).padStart(64, '0');
    
    console.log('   ✅ H_s =', H_s_hex.substring(0, 16) + '...');
    console.log();
    
    return {
        H_s,
        H_s_hex,
        rA,
        rA_hex: rA_bytes.toString('hex')
    };
}

/**
 * Decrypt ECDH amount
 */
function decryptAmount(ecdhAmount_hex, H_s_hex) {
    console.log('\n🔓 Decrypting Amount\n');
    
    // Compute amount key = Hs(H_s || "amount")
    const amountPrefix = Buffer.from('amount', 'ascii');
    const H_s_bytes = Buffer.from(H_s_hex, 'hex');
    const amountKeyInput = Buffer.concat([H_s_bytes, amountPrefix]);
    const amountKeyHash = keccak256(amountKeyInput);
    const amountKey = amountKeyHash.substring(0, 16); // First 8 bytes
    
    console.log('   ECDH Amount (encrypted):', ecdhAmount_hex);
    console.log('   Amount Key:', amountKey);
    
    // XOR to decrypt
    const encrypted = BigInt('0x' + ecdhAmount_hex);
    const key = BigInt('0x' + amountKey);
    const decrypted = encrypted ^ key;
    
    const amountPiconero = Number(decrypted);
    const amountXMR = amountPiconero / 1e12;
    
    console.log('   ✅ Decrypted Amount:', amountPiconero, 'piconero');
    console.log('   ✅ Decrypted Amount:', amountXMR, 'XMR');
    console.log();
    
    return {
        amountPiconero,
        amountXMR,
        amountKey
    };
}

async function main() {
    console.log('🎯 COMPLETE PROOF GENERATION FOR MONERO TRANSACTION\n');
    console.log('═'.repeat(60));
    console.log('TX Hash:', TX_DATA.txHash);
    console.log('Block:', TX_DATA.blockHeight);
    console.log('Output Index:', TX_DATA.outputIndex);
    console.log('═'.repeat(60));
    
    // Load transaction data
    const txDataPath = path.join(__dirname, '../oracle/tx_data.json');
    if (!fs.existsSync(txDataPath)) {
        console.error('\n❌ Transaction data not found. Run fetch_tx_data.js first.');
        process.exit(1);
    }
    
    const txData = JSON.parse(fs.readFileSync(txDataPath, 'utf8'));
    const txJson = txData.txJson;
    const output = txJson.vout[TX_DATA.outputIndex];
    const ecdhInfo = txJson.rct_signatures.ecdhInfo[TX_DATA.outputIndex];
    const commitment = txJson.rct_signatures.outPk[TX_DATA.outputIndex];
    
    console.log('\n📦 Transaction Output Data:');
    console.log('   ECDH Amount:', ecdhInfo.amount);
    console.log('   Commitment:', commitment);
    
    // Step 1: Compute H_s
    const sharedSecret = await computeSharedSecret(TX_DATA.r, TX_DATA.lpViewKey);
    
    // Step 2: Decrypt amount
    const decrypted = decryptAmount(ecdhInfo.amount, sharedSecret.H_s_hex);
    
    // Step 3: Get LP spend key (need to decode from address)
    // For now, we'll need this separately
    console.log('\n⚠️  To complete proof generation, we need:');
    console.log('   1. ✅ H_s computed');
    console.log('   2. ✅ Amount decrypted');
    console.log('   3. ❌ LP public spend key (B) - need to decode from address');
    console.log('   4. ❌ Output public key (P) - missing from transaction data');
    console.log();
    
    console.log('💾 Saving intermediate data...');
    const intermediateData = {
        txHash: TX_DATA.txHash,
        blockHeight: TX_DATA.blockHeight,
        outputIndex: TX_DATA.outputIndex,
        r: TX_DATA.r,
        H_s: sharedSecret.H_s_hex,
        rA: sharedSecret.rA_hex,
        ecdhAmount: ecdhInfo.amount,
        amountPiconero: decrypted.amountPiconero,
        amountXMR: decrypted.amountXMR,
        commitment: commitment,
        amountKey: decrypted.amountKey
    };
    
    const outputPath = path.join(__dirname, '../proof_data.json');
    fs.writeFileSync(outputPath, JSON.stringify(intermediateData, null, 2));
    console.log('   ✅ Saved to:', outputPath);
    
    console.log('\n✅ Partial proof generation complete!');
    console.log('\nNext steps:');
    console.log('1. Decode LP address to get public spend key (B)');
    console.log('2. Extract output public key (P) from transaction');
    console.log('3. Run computeEd25519Operations() with all data');
    console.log('4. Generate witness');
    console.log('5. Generate PLONK proof with snarkjs');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    });
