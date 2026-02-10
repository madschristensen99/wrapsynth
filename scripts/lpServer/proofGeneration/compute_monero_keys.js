#!/usr/bin/env node

/**
 * compute_monero_keys.js - Proper Monero Key Derivation with LP Private View Key
 * 
 * This module implements proper Monero cryptography for amount decryption:
 * 1. Uses LP's private view key (a) to compute shared secret: 8*a*R
 * 2. Derives H_s from shared secret
 * 3. Decrypts amount using H_s
 * 
 * This enables the circuit to properly verify: decrypted.out === v
 */

const ed = require('@noble/ed25519');
const { keccak256 } = require('js-sha3');

/**
 * Compute shared secret: 8*a*R where a is private view key, R is tx public key
 * @param {string} privateViewKey - LP's private view key (32 bytes hex)
 * @param {string} txPublicKey - Transaction public key R (32 bytes hex)
 * @returns {Promise<string>} Shared secret point (32 bytes hex)
 */
async function computeSharedSecret(privateViewKey, txPublicKey) {
    // Remove 0x prefix if present
    const a_hex = privateViewKey.replace(/^0x/, '');
    const R_hex = txPublicKey.replace(/^0x/, '');
    
    // Monero uses LITTLE-ENDIAN for scalars
    // Convert hex to little-endian bytes
    const a_bytes = Buffer.from(a_hex, 'hex');
    const R_bytes = Buffer.from(R_hex, 'hex');
    
    // Read scalar as little-endian
    let a_scalar = 0n;
    for (let i = 0; i < 32; i++) {
        a_scalar |= BigInt(a_bytes[i]) << (BigInt(i) * 8n);
    }
    
    // Monero does: (a * R) * 8, NOT (a * 8) * R
    // First: a * R
    const aR = await ed.Point.fromHex(R_bytes).multiply(a_scalar);
    
    // Then: (a * R) * 8
    const sharedSecret = aR.multiply(8n);
    const sharedSecretBytes = sharedSecret.toRawBytes();
    
    return Buffer.from(sharedSecretBytes).toString('hex');
}

/**
 * Derive H_s scalar from shared secret
 * @param {string} sharedSecret - Shared secret point (32 bytes hex)
 * @param {number} outputIndex - Output index in transaction
 * @returns {string} H_s scalar (32 bytes hex) - THIS IS THE DERIVATION SCALAR
 */
function deriveHs(sharedSecret, outputIndex) {
    // Monero: derivation_to_scalar hashes (derivation_point || varint(output_index))
    // The shared secret IS the derivation point (32 bytes)
    const secret_bytes = Buffer.from(sharedSecret, 'hex');
    
    // Encode output index as varint
    const index_bytes = Buffer.alloc(1);
    index_bytes[0] = outputIndex;
    
    // Hash the derivation point + output index
    const input = Buffer.concat([secret_bytes, index_bytes]);
    const hash = keccak256(input);
    
    // sc_reduce32: reduce hash modulo curve order
    // The hash is 32 bytes, read as little-endian
    const hash_bytes = Buffer.from(hash, 'hex');
    let hash_int = 0n;
    for (let i = 0; i < 32; i++) {
        hash_int |= BigInt(hash_bytes[i]) << (BigInt(i) * 8n);
    }
    
    const H_s = hash_int % ed.CURVE.n;
    
    // Convert back to little-endian bytes
    const H_s_bytes = Buffer.alloc(32);
    let temp = H_s;
    for (let i = 0; i < 32; i++) {
        H_s_bytes[i] = Number(temp & 0xFFn);
        temp >>= 8n;
    }
    
    return H_s_bytes.toString('hex');
}

/**
 * Compute amount key from H_s
 * @param {string} H_s_hex - H_s scalar (32 bytes hex)
 * @returns {Buffer} Amount key (8 bytes)
 */
function computeAmountKey(H_s_hex) {
    const H_s_bytes = Buffer.from(H_s_hex, 'hex');
    const input = Buffer.concat([
        Buffer.from('amount', 'ascii'),
        H_s_bytes
    ]);
    const hash = keccak256(input);
    return Buffer.from(hash, 'hex').slice(0, 8);
}

/**
 * Decrypt amount using ECDH
 * @param {string} ecdhAmount - Encrypted amount (8 bytes hex)
 * @param {string} H_s_hex - H_s scalar (32 bytes hex)
 * @returns {bigint} Decrypted amount in piconero
 */
function decryptAmount(ecdhAmount, H_s_hex) {
    const amountKey = computeAmountKey(H_s_hex);
    const ecdhBytes = Buffer.from(ecdhAmount, 'hex');
    
    // XOR decryption
    const decrypted = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) {
        decrypted[i] = ecdhBytes[i] ^ amountKey[i];
    }
    
    return decrypted.readBigUInt64LE(0);
}

/**
 * Full Monero amount decryption pipeline
 * @param {Object} params
 * @param {string} params.privateViewKey - LP's private view key (32 bytes hex)
 * @param {string} params.txPublicKey - Transaction public key R (32 bytes hex)
 * @param {number} params.outputIndex - Output index in transaction
 * @param {string} params.ecdhAmount - Encrypted amount (8 bytes hex)
 * @returns {Promise<Object>} { H_s, amountPiconero }
 */
async function decryptMoneroAmount(params) {
    const { privateViewKey, txPublicKey, outputIndex, ecdhAmount } = params;
    
    console.log('\n🔐 Decrypting Monero amount with LP private view key...');
    console.log('   Private view key:', privateViewKey.slice(0, 16) + '...');
    console.log('   TX public key R:', txPublicKey.slice(0, 16) + '...');
    console.log('   Output index:', outputIndex);
    
    // Step 1: Compute shared secret
    const sharedSecret = await computeSharedSecret(privateViewKey, txPublicKey);
    console.log('   ✅ Shared secret:', sharedSecret.slice(0, 16) + '...');
    
    // Step 2: Derive H_s
    const H_s = deriveHs(sharedSecret, outputIndex);
    console.log('   ✅ H_s scalar:', H_s.slice(0, 16) + '...');
    
    // Step 3: Decrypt amount
    const amountKey = computeAmountKey(H_s);
    console.log('   🔑 Amount key:', amountKey.toString('hex'));
    const amountPiconero = decryptAmount(ecdhAmount, H_s);
    const amountXMR = Number(amountPiconero) / 1e12;
    console.log('   ✅ Decrypted amount:', amountPiconero.toString(), 'piconero');
    console.log('   ✅ Amount in XMR:', amountXMR);
    
    return {
        H_s,
        amountPiconero,
        amountXMR,
        sharedSecret
    };
}

module.exports = {
    computeSharedSecret,
    deriveHs,
    computeAmountKey,
    decryptAmount,
    decryptMoneroAmount
};
