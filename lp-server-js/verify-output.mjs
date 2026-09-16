// Manually verify if a Monero transaction output belongs to a given key pair.
// Monero output key: P_i = Hs(aR || index_le64) * G + B
// Usage: node verify-output.mjs <txPubKey> <output1Hex> <output2Hex|-> <privateViewKey> <combinedPubSpendKey>
// Or:    node verify-output.mjs <txPubKey> <output1Hex> <output2Hex|-> <privateViewKey> <privateSpendKey> --priv

import { keccak_256 } from '@noble/hashes/sha3';
import { ed25519 } from '@noble/curves/ed25519';

const L = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;
const G = ed25519.ExtendedPoint.BASE;

function hexToBytes(hex) {
    const clean = hex.replace(/^0x/, '');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToScalarLE(hex) {
    const bytes = Buffer.from(hexToBytes(hex));
    return BigInt('0x' + bytes.reverse().toString('hex')) % L;
}

function hexToScalarBE(hex) {
    return BigInt('0x' + hex.replace(/^0x/, '')) % L;
}

// Monero hash-to-scalar with output index: Hs(data || index_le64)
function hashToScalar(data, index) {
    const idxBytes = Buffer.alloc(8);
    idxBytes.writeBigUInt64LE(BigInt(index));
    const input = Buffer.concat([Buffer.from(data), idxBytes]);
    const hash = keccak_256(input);
    // Interpret as little-endian scalar, reduce mod L
    let h = 0n;
    for (let i = 31; i >= 0; i--) {
        h = (h << 8n) | BigInt(hash[i]);
    }
    return h % L;
}

// Decode public spend + view keys from a Monero address
function decodeAddress(addr) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const indexes = {};
    for (let i = 0; i < ALPHABET.length; i++) indexes[ALPHABET[i]] = i;

    // Monero base58: 8-byte blocks encode as 11 chars; partial block at end.
    // 95-char address = 8 full blocks (88 chars → 64 bytes) + 1 partial (7 chars → 5 bytes) = 69 bytes.
    // Bytes: [0]=netByte, [1..32]=pubSpend, [33..64]=pubView, [65..68]=checksum
    function decodeBlock(block, targetBytes) {
        let num = 0n;
        for (const ch of block) {
            num = num * 58n + BigInt(indexes[ch]);
        }
        const bytes = [];
        while (num > 0n) { bytes.unshift(Number(num % 256n)); num /= 256n; }
        while (bytes.length < targetBytes) bytes.unshift(0);
        return bytes;
    }

    const full = [];
    // 8 full blocks of 11 chars each
    for (let i = 0; i < 88; i += 11) {
        full.push(...decodeBlock(addr.slice(i, i + 11), 8));
    }
    // Last partial block: 7 chars → 5 bytes
    full.push(...decodeBlock(addr.slice(88, 95), 5));

    const buf = Buffer.from(full);
    return {
        netByte: buf[0],
        pubSpend: bytesToHex(buf.slice(1, 33)),
        pubView: bytesToHex(buf.slice(33, 65))
    };
}

const txPubKeyHex = process.argv[2];
const output1Hex = process.argv[3];
const output2Hex = process.argv[4];
const viewKeyOrAddr = process.argv[5];
const spendKeyOrPriv = process.argv[6];
const isPrivMode = process.argv.includes('--priv');

if (!txPubKeyHex || !output1Hex || !viewKeyOrAddr || !spendKeyOrPriv) {
    console.log('Usage: node verify-output.mjs <txPubKey> <out1> <out2|-> <viewKey|sharedAddr> <pubSpendKey|privSpendKey> [--priv]');
    process.exit(1);
}

let privateViewKeyHex, B_point;

if (isPrivMode) {
    // Mode: private view key + private spend key — derive public spend key
    privateViewKeyHex = viewKeyOrAddr;
    const spendScalar = hexToScalarLE(spendKeyOrPriv);
    B_point = G.multiply(spendScalar);
    console.log('Mode: private keys (LE)');
    console.log('Derived public spend key:', bytesToHex(B_point.toRawBytes()));
} else if (viewKeyOrAddr.startsWith('49') && viewKeyOrAddr.length === 95) {
    // Mode: shared address — decode public keys from it
    const decoded = decodeAddress(viewKeyOrAddr);
    privateViewKeyHex = spendKeyOrPriv === '-' ? null : spendKeyOrPriv; // second arg is the private view key
    B_point = ed25519.ExtendedPoint.fromHex(Buffer.from(hexToBytes(decoded.pubSpend)));
    console.log('Mode: address decode');
    console.log('Public spend key from address:', decoded.pubSpend);
    console.log('Public view key from address: ', decoded.pubView);
    // Verify the private view key derives to the address's public view key
    if (privateViewKeyHex) {
        const a = hexToScalarLE(privateViewKeyHex);
        const A = G.multiply(a);
        console.log('Derived pub view from priv:  ', bytesToHex(A.toRawBytes()));
        console.log('View key match:', bytesToHex(A.toRawBytes()) === decoded.pubView);
    }
} else {
    // Mode: private view key + public spend key (hex)
    privateViewKeyHex = viewKeyOrAddr;
    B_point = ed25519.ExtendedPoint.fromHex(Buffer.from(hexToBytes(spendKeyOrPriv)));
    console.log('Mode: view key + public spend key');
}

console.log('Tx public key:  ', txPubKeyHex);
console.log('Output 1:       ', output1Hex);
if (output2Hex && output2Hex !== '-') console.log('Output 2:       ', output2Hex);

if (!privateViewKeyHex) {
    console.error('Need private view key to compute ownership check');
    process.exit(1);
}

const R_point = ed25519.ExtendedPoint.fromHex(Buffer.from(hexToBytes(txPubKeyHex)));
const outputs = [output1Hex];
if (output2Hex && output2Hex !== '-') outputs.push(output2Hex);

let found = false;

for (const viewEndian of ['LE', 'BE']) {
    const a = viewEndian === 'BE' ? hexToScalarBE(privateViewKeyHex) : hexToScalarLE(privateViewKeyHex);
    const label = `view=${viewEndian}`;
    try {
        const aR = R_point.multiply(a);
        for (let idx = 0; idx < outputs.length; idx++) {
            const hs = hashToScalar(aR.toRawBytes(), idx);
            const P = G.multiply(hs).add(B_point);
            const P_hex = bytesToHex(P.toRawBytes());
            const match = P_hex === outputs[idx].replace(/^0x/, '');
            console.log(`[${label}][out ${idx}] expected P=${P_hex.slice(0, 20)}... actual=${outputs[idx].slice(0, 20)}... ${match ? '✓ MATCH!' : ''}`);
            if (match) found = true;
        }
    } catch (e) {
        console.log(`[${label}] failed: ${e.message}`);
    }
}

console.log(found ? '\n✓ FUNDS CONFIRMED: an output belongs to these keys' : '\n✗ NO MATCH');
