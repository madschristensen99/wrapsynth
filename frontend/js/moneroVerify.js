// moneroVerify.js — trustless daemon-level deposit verification for the browser.
// Decodes a Monero tx's outputs with the recipient's private view key to prove
// it pays a given address — no monero-wallet-rpc or WASM wallet required.
// Mirrors the LP server's scanDepositViaDaemon (verified live on-chain).
// Browser-safe: uses Uint8Array, no Node Buffer.

import { keccak256 as viemKeccak256 } from 'https://esm.sh/viem@2.7.0';

const ED_L = 2n ** 252n + 27742317777372353535851937790883648493n;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_BLOCK_SIZES = { 0: 0, 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 9: 6, 10: 7, 11: 8 };

let _ed = null;
async function ed() {
    if (!_ed) {
        _ed = await import('https://esm.sh/@noble/ed25519@2.0.0');
        if (!_ed.etc.sha512Sync) {
            const { sha512 } = await import('https://esm.sh/@noble/hashes@1.5.0/sha512');
            _ed.etc.sha512Sync = (...m) => sha512(concatBytes(...m));
        }
    }
    return _ed;
}

// ─── byte helpers (no Buffer) ────────────────────────────────────────────────
function hexToBytes(hex) {
    hex = hex.replace(/^0x/, '');
    const b = new Uint8Array(hex.length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
    return b;
}
function bytesToHex(b) {
    let s = '';
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
}
function concatBytes(...arrs) {
    let len = 0;
    for (const a of arrs) len += a.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
}
function utf8(s) { return new TextEncoder().encode(s); }
function reverseBytes(b) { const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b[b.length - 1 - i]; return o; }
function leBytesToBigInt(le) { return BigInt('0x' + bytesToHex(reverseBytes(le))); }
function bigIntToLe32(n) {
    const b = new Uint8Array(32);
    let t = n;
    for (let i = 0; i < 32; i++) { b[i] = Number(t & 0xffn); t >>= 8n; }
    return b;
}
function readBigUInt64LE(b, off = 0) {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
    return v;
}

function keccak(bytes) { return hexToBytes(viemKeccak256(bytes).slice(2)); }
function varint(n) {
    const b = []; do { let x = n & 0x7f; n >>= 7; if (n) x |= 0x80; b.push(x); } while (n);
    return new Uint8Array(b);
}
function readVarint(buf, off) {
    let v = 0, s = 0;
    while (true) { v |= (buf[off] & 0x7f) << s; if (!(buf[off] & 0x80)) return [v, off + 1]; s += 7; off++; }
}
function scReduce(leBytes) { return leBytesToBigInt(leBytes) % ED_L; }

// Monero block-base58 decode → { spendPub, viewPub } as 32-byte Uint8Arrays
function decodeMoneroAddress(addr) {
    const out = [];
    for (let i = 0; i < addr.length; i += 11) {
        const chunk = addr.slice(i, i + 11);
        let v = 0n;
        for (const c of chunk) v = v * 58n + BigInt(B58.indexOf(c));
        const n = B58_BLOCK_SIZES[chunk.length];
        if (n == null) throw new Error('bad base58 block size');
        const b = new Uint8Array(n);
        let t = v;
        for (let k = n - 1; k >= 0; k--) { b[k] = Number(t & 0xffn); t >>= 8n; }
        out.push(b);
    }
    const raw = concatBytes(...out);
    if (raw.length < 69) throw new Error('decoded address too short');
    return { spendPub: raw.slice(1, 33), viewPub: raw.slice(33, 65) };
}

// Extract tx pubkeys from tx_extra (tag 0x01 main, 0x04 additional).
// `extra` from the daemon's decode_as_json is a byte array (number[]).
function txPubkeys(extra) {
    const e = extra instanceof Uint8Array ? extra : new Uint8Array(extra || []);
    const pubs = [];
    let i = 0;
    while (i < e.length) {
        const tag = e[i++];
        if (tag === 0) continue;
        if (tag === 1) { pubs.push(e.slice(i, i + 32)); i += 32; }
        else if (tag === 2) { const [l, ni] = readVarint(e, i); i = ni + l; }
        else if (tag === 3) { const [l, ni] = readVarint(e, i); i = ni + l; }
        else if (tag === 4) { const [c, ni] = readVarint(e, i); i = ni; for (let k = 0; k < c; k++) { pubs.push(e.slice(i, i + 32)); i += 32; } }
        else break;
    }
    return pubs;
}

// Match a decoded tx's outputs against the recipient's spend pub + view key.
// Returns { amount, outputIndex } for the first matching output, or null.
function matchTxOutputs(txJson, viewKeyScalar, spendPubPoint, G) {
    const pubs = txPubkeys(txJson.extra);
    for (const R of pubs) {
        let Rpt;
        try { Rpt = edlib.ExtendedPoint.fromHex(R); } catch { continue; }
        const deriv = Rpt.multiply(viewKeyScalar).multiply(8n).toRawBytes();
        for (let o = 0; o < (txJson.vout || []).length; o++) {
            const tk = txJson.vout[o].target && txJson.vout[o].target.tagged_key;
            const target = tk ? tk.key : (txJson.vout[o].target && txJson.vout[o].target.key);
            if (!target) continue;
            if (tk && tk.view_tag != null) {
                const vt = keccak(concatBytes(utf8('view_tag'), deriv, varint(o)))[0];
                if (vt !== parseInt(tk.view_tag, 16)) continue;
            }
            const scalar1 = scReduce(keccak(concatBytes(deriv, varint(o))));
            const P = G.multiply(scalar1).add(spendPubPoint).toRawBytes();
            if (bytesToHex(P) !== target) continue;
            // Decode amount
            let amount = null;
            const ecdh = txJson.rct_signatures && txJson.rct_signatures.ecdhInfo && txJson.rct_signatures.ecdhInfo[o];
            if (ecdh && ecdh.amount) {
                const amtKey = keccak(concatBytes(utf8('amount'), bigIntToLe32(scalar1)));
                const enc = hexToBytes(ecdh.amount);
                const dec = new Uint8Array(8);
                for (let k = 0; k < 8; k++) dec[k] = enc[k] ^ amtKey[k];
                amount = readBigUInt64LE(dec);
            }
            return { amount, outputIndex: o };
        }
    }
    return null;
}

/**
 * Verify a Monero tx pays `address` an output decodable with `viewKeyLeHex`.
 * @param {string} daemonUrl - base daemon URL (e.g. https://xmr-node.cakewallet.com:18081)
 * @param {string} txid - 64-char hex tx hash
 * @param {string} address - destination address to check
 * @param {string} viewKeyLeHex - private view key, little-endian hex (no 0x)
 * @returns {Promise<{found, amount, confirmations, blockHeight, inPool, outputIndex}>}
 */
export async function verifyTxPaysAddress(daemonUrl, txid, address, viewKeyLeHex) {
    const edlib = await ed();
    const G = edlib.ExtendedPoint.BASE;

    const res = await fetch(`${daemonUrl}/get_transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txs_hashes: [txid], decode_as_json: true }),
    });
    const data = await res.json();
    if (data.status !== 'OK' || !data.txs || !data.txs.length) {
        return { found: false };
    }
    const tx = data.txs[0];
    const txJson = JSON.parse(tx.as_json);

    const { spendPub } = decodeMoneroAddress(address);
    const spendPubPoint = edlib.ExtendedPoint.fromHex(spendPub);
    const viewKeyScalar = scReduce(hexToBytes(viewKeyLeHex));

    // Confirmations
    let confirmations = 0;
    const inPool = !!tx.in_pool || !tx.block_height;
    if (!inPool) {
        const hRes = await fetch(`${daemonUrl}/json_rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_block_count' }),
        });
        const hData = await hRes.json();
        const tip = hData.result && hData.result.count;
        if (tip) confirmations = Math.max(0, tip - tx.block_height);
    }

    const match = matchTxOutputs(txJson, viewKeyScalar, spendPubPoint, G);
    if (match) {
        return { found: true, amount: match.amount, confirmations, blockHeight: tx.block_height, inPool, outputIndex: match.outputIndex };
    }
    return { found: false, confirmations, blockHeight: tx.block_height, inPool };
}

/**
 * Scan a range of Monero blocks for any tx paying `address` an output
 * decodable with `viewKeyLeHex`. Mirrors the LP server's scanDepositViaDaemon.
 * @param {string} daemonUrl - base daemon URL
 * @param {number} fromHeight - first block to scan (inclusive)
 * @param {number} toHeight - last block to scan (inclusive)
 * @param {string} address - shared/destination address to check
 * @param {string} viewKeyLeHex - private view key, little-endian hex (no 0x)
 * @returns {Promise<Array<{txid, height, amount, outputIndex}>>}
 */
export async function scanBlocksForPayment(daemonUrl, fromHeight, toHeight, address, viewKeyLeHex) {
    const edlib = await ed();
    const G = edlib.ExtendedPoint.BASE;
    const { spendPub } = decodeMoneroAddress(address);
    const spendPubPoint = edlib.ExtendedPoint.fromHex(spendPub);
    const viewKeyScalar = scReduce(hexToBytes(viewKeyLeHex));
    const found = [];

    const from = Math.max(0, fromHeight);
    const to = Math.max(from, toHeight);

    // Collect tx hashes across the block range
    const txJobs = [];
    for (let h = from; h <= to; h++) {
        const blkRes = await fetch(`${daemonUrl}/json_rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_block', params: { height: h } }),
        });
        const blk = await blkRes.json();
        const hashes = (blk.result && blk.result.tx_hashes) || [];
        for (const txid of hashes) txJobs.push({ txid, height: h });
    }

    // Fetch txs in batches and decode outputs
    for (let i = 0; i < txJobs.length; i += 50) {
        const batch = txJobs.slice(i, i + 50);
        const res = await fetch(`${daemonUrl}/get_transactions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txs_hashes: batch.map(t => t.txid), decode_as_json: true }),
        });
        const data = await res.json();
        for (let j = 0; j < (data.txs || []).length; j++) {
            const t = data.txs[j];
            let txJson;
            try { txJson = JSON.parse(t.as_json); } catch { continue; }
            const match = matchTxOutputs(txJson, viewKeyScalar, spendPubPoint, G);
            if (match) {
                found.push({ txid: batch[j].txid, height: batch[j].height, amount: match.amount, outputIndex: match.outputIndex });
            }
        }
    }
    return found;
}
