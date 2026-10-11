// moneroDaemonProxy.js — translates binary daemon endpoints that restricted
// public Monero nodes block (get_outs.bin) into JSON-RPC calls that they allow.
// All other daemon requests are forwarded verbatim to the upstream node.
//
// The browser WASM wallet (monero-ts) needs get_outs.bin for ring members when
// building a sweep tx; restricted nodes 400 it. This proxy decodes the binary
// request, calls the upstream node's JSON-RPC /get_outs (allowed), and re-encodes
// the response in the binary format the wallet expects.

import express from 'express';
import fs from 'fs';
import path from 'path';

const router = express.Router();

// Upstream daemon — same node the LP wallet uses (deployment.json moneroDaemon).
const UPSTREAM = process.env.MONERO_DAEMON_URL || 'https://xmr-node.cakewallet.com:18081';

// ─── epee portable_storage binary helpers ────────────────────────────────────
// Header + version written by monerod for binary RPC payloads.
const EPEE_HEADER = Buffer.from('PORTABLE_STORAGE', 'ascii');
const EPEE_VERSION = 0x01;

// epee type bytes (portable_storage.h)
const T_OBJECT = 1;
const T_ARRAY = 2;
const T_STRING = 3;
const T_INTEGER = 4;
const T_UINT = 5;
const T_BOOL = 6;
const T_DOUBLE = 7;
const T_BLOB = 8;

/** Read an epee varint (flag bits in low 2 bits of first byte). */
function readVarint(buf, off) {
    const first = buf[off];
    const flags = first & 0x03;
    if (flags === 0) return [first >> 2, off + 1];
    if (flags === 1) return [(first >> 2) | (buf[off + 1] << 6), off + 2];
    if (flags === 2) return [(first >> 2) | (buf[off + 1] << 6) | (buf[off + 2] << 14), off + 3];
    // flags === 3: 64-bit value stored LE after the first byte
    let v = 0n;
    for (let i = 0; i < 8; i++) v |= BigInt(buf[off + i]) << BigInt(8 * i);
    return [Number(v >> 2n), off + 8];
}

/** Write an epee varint. */
function writeVarint(n) {
    if (n < 64) return Buffer.from([n << 2]);
    if (n < 16384) return Buffer.from([((n & 0x3f) << 2) | 0x01, n >> 6]);
    if (n < 4194304) return Buffer.from([((n & 0x3f) << 2) | 0x02, (n >> 6) & 0xff, (n >> 14) & 0xff]);
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE((BigInt(n) << 2n) | 0x03n, 0);
    return b;
}

/**
 * Parse an epee portable_storage object (the get_outs.bin request).
 * Returns { outputs: [{amount, index}], getTxid }.
 */
function parseGetOutsRequest(buf) {
    let off = 0;
    // Header + version
    if (buf.subarray(0, 16).toString('ascii') !== 'PORTABLE_STORAGE') {
        throw new Error('missing epee header');
    }
    off = 17; // 16-byte header + version byte

    // Root object: entry count
    const [rootCount, afterCount] = readVarint(buf, off);
    off = afterCount;
    let outputs = [];
    let getTxid = false;
    for (let e = 0; e < rootCount; e++) {
        const [klen, afterKlen] = readVarint(buf, off);
        off = afterKlen;
        const key = buf.subarray(off, off + klen).toString('ascii');
        off += klen;
        const type = buf[off++];
        if (key === 'outputs') {
            // array of objects
            const [arrLen, afterArr] = readVarint(buf, off);
            off = afterArr;
            for (let i = 0; i < arrLen; i++) {
                const [objCount, afterObj] = readVarint(buf, off);
                off = afterObj;
                const out = { amount: 0, index: 0 };
                for (let f = 0; f < objCount; f++) {
                    const [flen, afterFlen] = readVarint(buf, off);
                    off = afterFlen;
                    const fkey = buf.subarray(off, off + flen).toString('ascii');
                    off += flen;
                    const ftype = buf[off++];
                    if (fkey === 'amount') {
                        if (ftype === T_UINT) { out.amount = Number(buf.readBigUInt64LE(off)); off += 8; }
                        else { out.amount = buf[off]; off += 1; } // Uint8-style
                    } else if (fkey === 'index') {
                        out.index = Number(buf.readBigUInt64LE(off)); off += 8;
                    } else {
                        // skip unknown field by type
                        off = skipValue(buf, off, ftype);
                    }
                }
                outputs.push(out);
            }
        } else if (key === 'get_txid') {
            getTxid = buf[off++] === 1;
        } else {
            off = skipValue(buf, off, type);
        }
    }
    return { outputs, getTxid };
}

/** Skip a value of the given epee type, returning the new offset. */
function skipValue(buf, off, type) {
    if (type === T_OBJECT) {
        const [count, after] = readVarint(buf, off);
        off = after;
        for (let i = 0; i < count; i++) {
            const [klen, afterK] = readVarint(buf, off);
            off = afterK + klen;
            const t = buf[off++];
            off = skipValue(buf, off, t);
        }
        return off;
    }
    if (type === T_ARRAY) {
        const [count, after] = readVarint(buf, off);
        off = after;
        for (let i = 0; i < count; i++) off = skipValue(buf, off, buf[off]);
        return off;
    }
    if (type === T_STRING || type === T_BLOB) {
        const [len, after] = readVarint(buf, off);
        return after + len;
    }
    if (type === T_UINT || type === T_INTEGER || type === T_DOUBLE) return off + 8;
    if (type === T_BOOL) return off + 1;
    return off;
}

/**
 * Serialize a get_outs.bin response in epee portable_storage format.
 * outs: [{ key (hex), mask (hex), unlocked (bool), height (number), txid (hex|null) }]
 */
function encodeGetOutsResponse(outs, getTxid) {
    const parts = [EPEE_HEADER, Buffer.from([EPEE_VERSION])];
    // Root object with 3 entries: outs, status, untrusted
    parts.push(writeVarint(3));

    // "outs" array
    parts.push(writeVarint(7), Buffer.from('outs', 'ascii'), Buffer.from([T_ARRAY]), writeVarint(outs.length));
    for (const o of outs) {
        const fields = [];
        fields.push(writeVarint(6)); // 6 fields per output
        fields.push(writeVarint(6), Buffer.from('height', 'ascii'), Buffer.from([T_UINT]));
        const h = Buffer.alloc(8); h.writeBigUInt64LE(BigInt(o.height), 0); fields.push(h);
        fields.push(writeVarint(3), Buffer.from('key', 'ascii'), Buffer.from([T_STRING]), writeVarint(32), Buffer.from(o.key, 'hex'));
        fields.push(writeVarint(4), Buffer.from('mask', 'ascii'), Buffer.from([T_STRING]), writeVarint(32), Buffer.from(o.mask, 'hex'));
        fields.push(writeVarint(4), Buffer.from('txid', 'ascii'), Buffer.from([T_STRING]), writeVarint(32), Buffer.from(o.txid || '00'.repeat(32), 'hex'));
        fields.push(writeVarint(8), Buffer.from('unlocked', 'ascii'), Buffer.from([T_BOOL]), Buffer.from([o.unlocked ? 1 : 0]));
        parts.push(writeVarint(1), Buffer.from([T_OBJECT]), ...fields);
    }

    // "status" string
    parts.push(writeVarint(6), Buffer.from('status', 'ascii'), Buffer.from([T_STRING]), writeVarint(2), Buffer.from('OK', 'ascii'));
    // "untrusted" bool
    parts.push(writeVarint(9), Buffer.from('untrusted', 'ascii'), Buffer.from([T_BOOL]), Buffer.from([0]));

    return Buffer.concat(parts);
}

// ─── Routes ──────────────────────────────────────────────────────────────────
// Binary get_outs.bin — translate to JSON-RPC get_outs and back.
router.post('/get_outs.bin', async (req, res) => {
    const raw = Buffer.from(req.body || []);
    console.log(`[MoneroProxy] get_outs.bin request (${raw.length} bytes): ${raw.toString('hex').slice(0, 200)}`);
    let parsed;
    try {
        parsed = parseGetOutsRequest(raw);
    } catch (e) {
        console.warn('[MoneroProxy] parse failed:', e.message);
        return res.status(400).send('bad request');
    }
    console.log('[MoneroProxy] parsed:', JSON.stringify(parsed));
    try {
        const rpcRes = await fetch(`${UPSTREAM}/get_outs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outputs: parsed.outputs, get_txid: parsed.getTxid }),
        });
        const data = await rpcRes.json();
        if (data.status !== 'OK') throw new Error('upstream status: ' + data.status);
        const bin = encodeGetOutsResponse(data.outs, parsed.getTxid);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(bin);
    } catch (e) {
        console.warn('[MoneroProxy] upstream get_outs failed:', e.message);
        res.status(502).send('upstream failed');
    }
});

// Everything else — forward verbatim to the upstream daemon.
router.post('*', async (req, res) => {
    const target = `${UPSTREAM}${req.originalUrl.replace(/^\/monero-daemon/, '')}`;
    try {
        const upstream = await fetch(target, {
            method: 'POST',
            headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
            body: Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body || {}),
        });
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
        res.status(upstream.status);
        res.send(buf);
    } catch (e) {
        console.warn('[MoneroProxy] forward failed:', target, e.message);
        res.status(502).send('upstream failed');
    }
});

export { router as moneroDaemonProxyRouter };
