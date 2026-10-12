// moneroDaemonProxy.js — translates binary daemon endpoints that restricted
// public Monero nodes block (get_outs.bin, get_hashes.bin, get_blocks.bin)
// into JSON-RPC calls that they allow. All other daemon requests are forwarded
// verbatim to the upstream node.
//
// The browser WASM wallet (monero-ts) needs these binary endpoints to sync and
// build sweep txs; restricted nodes 400 them. This proxy decodes the binary
// portable_storage request, calls the upstream node's JSON-RPC (allowed), and
// re-encodes the response in the binary format the wallet expects.
//
// Binary format (epee portable_storage):
//   header: 9 bytes = signature_a(0x01011101 LE) + signature_b(0x01020101 LE) + version(1)
//   section: varint(entry_count) + per entry: 1-byte keylen + key + type byte + value
//   types: INT64=1 INT32=2 INT16=3 INT8=4 UINT64=5 UINT32=6 UINT16=7 UINT8=8
//          DOUBLE=9 STRING=10 BOOL=11 OBJECT=12 ARRAY=13 (|0x80 for arrays)
//   varint: 2 flag bits in low bits of first byte (1/2/3/8 bytes)

import express from 'express';

const router = express.Router();

// Upstream daemon — same node the LP wallet uses (deployment.json moneroDaemon).
const UPSTREAM = process.env.MONERO_DAEMON_URL || 'https://xmr-node.cakewallet.com:18081';

// ─── portable_storage binary helpers ────────────────────────────────────────
const PS_HEADER = Buffer.from([0x01, 0x11, 0x01, 0x01, 0x01, 0x01, 0x02, 0x01, 0x01]);

const T_INT64 = 1, T_INT32 = 2, T_INT16 = 3, T_INT8 = 4;
const T_UINT64 = 5, T_UINT32 = 6, T_UINT16 = 7, T_UINT8 = 8;
const T_DOUBLE = 9, T_STRING = 10, T_BOOL = 11, T_OBJECT = 12, T_ARRAY = 13;
const T_FLAG = 0x80;

/** Read an epee varint (2 flag bits in low bits of first byte). */
function readVarint(buf, off) {
    const first = buf[off];
    const flags = first & 0x03;
    if (flags === 0) return [first >> 2, off + 1];
    if (flags === 1) return [(first >> 2) | (buf[off + 1] << 6), off + 2];
    if (flags === 2) return [(first >> 2) | (buf[off + 1] << 6) | (buf[off + 2] << 14), off + 3];
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

/** Decode a section (object): varint count + entries. Returns [obj, newOffset]. */
function decodeSection(buf, off) {
    const [count, o2] = readVarint(buf, off);
    off = o2;
    const obj = {};
    for (let i = 0; i < count; i++) {
        const klen = buf[off++];
        const key = buf.subarray(off, off + klen).toString('ascii');
        off += klen;
        const type = buf[off++];
        const [val, noff] = decodeValue(buf, off, type);
        obj[key] = val;
        off = noff;
    }
    return [obj, off];
}

/** Decode a typed value. Returns [value, newOffset]. */
function decodeValue(buf, off, type) {
    if (type === T_STRING) {
        const [len, o2] = readVarint(buf, off);
        return [buf.subarray(o2, o2 + len).toString('binary'), o2 + len];
    }
    if (type === T_UINT64) return [Number(buf.readBigUInt64LE(off)), off + 8];
    if (type === T_UINT32) return [buf.readUInt32LE(off), off + 4];
    if (type === T_UINT16) return [buf.readUInt16LE(off), off + 2];
    if (type === T_UINT8) return [buf[off], off + 1];
    if (type === T_INT64) return [Number(buf.readBigInt64LE(off)), off + 8];
    if (type === T_INT32) return [buf.readInt32LE(off), off + 4];
    if (type === T_INT16) return [buf.readInt16LE(off), off + 2];
    if (type === T_INT8) return [buf.readInt8(off), off + 1];
    if (type === T_DOUBLE) return [buf.readDoubleLE(off), off + 8];
    if (type === T_BOOL) return [buf[off] !== 0, off + 1];
    if (type === T_OBJECT) return decodeSection(buf, off);
    if (type === (T_OBJECT | T_FLAG)) {
        const [count, o2] = readVarint(buf, off);
        off = o2;
        const arr = [];
        for (let i = 0; i < count; i++) {
            const [obj, noff] = decodeSection(buf, off);
            arr.push(obj);
            off = noff;
        }
        return [arr, off];
    }
    if (type === (T_STRING | T_FLAG)) {
        const [count, o2] = readVarint(buf, off);
        off = o2;
        const arr = [];
        for (let i = 0; i < count; i++) {
            const [len, o3] = readVarint(buf, off);
            arr.push(buf.subarray(o3, o3 + len).toString('binary'));
            off = o3 + len;
        }
        return [arr, off];
    }
    if (type === (T_UINT64 | T_FLAG)) {
        const [count, o2] = readVarint(buf, off);
        off = o2;
        const arr = [];
        for (let i = 0; i < count; i++) {
            arr.push(Number(buf.readBigUInt64LE(off)));
            off += 8;
        }
        return [arr, off];
    }
    if (type === (T_UINT32 | T_FLAG)) {
        const [count, o2] = readVarint(buf, off);
        off = o2;
        const arr = [];
        for (let i = 0; i < count; i++) {
            arr.push(buf.readUInt32LE(off));
            off += 4;
        }
        return [arr, off];
    }
    if (type === (T_BOOL | T_FLAG)) {
        const [count, o2] = readVarint(buf, off);
        off = o2;
        const arr = [];
        for (let i = 0; i < count; i++) {
            arr.push(buf[off] !== 0);
            off += 1;
        }
        return [arr, off];
    }
    throw new Error('unknown portable_storage type: ' + type);
}

/** Decode a full portable_storage payload into a JS object. */
function decodePortableStorage(buf) {
    if (buf.length < 9 || !buf.subarray(0, 9).equals(PS_HEADER)) {
        throw new Error('missing portable_storage header');
    }
    const [obj] = decodeSection(buf, 9);
    return obj;
}

/** Encode a value of the given type. */
function encodeValue(type, value) {
    if (type === T_STRING) {
        const b = Buffer.from(value, 'binary');
        return Buffer.concat([writeVarint(b.length), b]);
    }
    if (type === T_UINT64) {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(value), 0);
        return b;
    }
    if (type === T_UINT8) return Buffer.from([value & 0xff]);
    if (type === T_BOOL) return Buffer.from([value ? 1 : 0]);
    if (type === T_OBJECT) return encodeSection(value);
    if (type === (T_OBJECT | T_FLAG)) {
        const parts = [writeVarint(value.length)];
        for (const o of value) parts.push(encodeSection(o));
        return Buffer.concat(parts);
    }
    if (type === (T_STRING | T_FLAG)) {
        const parts = [writeVarint(value.length)];
        for (const s of value) parts.push(encodeValue(T_STRING, s));
        return Buffer.concat(parts);
    }
    if (type === (T_UINT64 | T_FLAG)) {
        const parts = [writeVarint(value.length)];
        for (const v of value) {
            const b = Buffer.alloc(8);
            b.writeBigUInt64LE(BigInt(v), 0);
            parts.push(b);
        }
        return Buffer.concat(parts);
    }
    throw new Error('cannot encode type: ' + type);
}

/** Encode a section (object). Entries are sorted by key to match monerod. */
function encodeSection(obj) {
    const keys = Object.keys(obj).sort();
    const parts = [writeVarint(keys.length)];
    for (const k of keys) {
        const { type, value } = obj[k];
        parts.push(Buffer.from([k.length]), Buffer.from(k, 'ascii'), Buffer.from([type]));
        parts.push(encodeValue(type, value));
    }
    return Buffer.concat(parts);
}

/** Encode a full portable_storage payload. */
function encodePortableStorage(obj) {
    return Buffer.concat([PS_HEADER, encodeSection(obj)]);
}

// ─── JSON-RPC helpers ───────────────────────────────────────────────────────
async function rpc(method, params) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const res = await fetch(`${UPSTREAM}/json_rpc`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params: params || {} }),
                signal: controller.signal,
            });
            const j = await res.json();
            if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
            return j.result;
        } catch (e) {
            lastErr = e;
            if (attempt < 2) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr;
}

async function directPost(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const res = await fetch(`${UPSTREAM}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        return res.json();
    } finally {
        clearTimeout(timer);
    }
}

/** Run async tasks with limited concurrency. */
async function mapConcurrent(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }
    const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
    await Promise.all(workers);
    return results;
}

// ─── Chain supplement logic ─────────────────────────────────────────────────
const MAX_HASHES_PER_REQUEST = 10000;
const MAX_BLOCKS_PER_REQUEST = 30; // keep responses fast; wallet iterates chunks
const MAX_TXS_PER_REQUEST = 10000;
const RPC_CONCURRENCY = 8;
const TX_BATCH_CONCURRENCY = 4;

/** blob (binary string of 32-byte hashes) -> array of hex hashes */
function blobToHashes(blob) {
    const hashes = [];
    for (let i = 0; i + 32 <= blob.length; i += 32) {
        hashes.push(Buffer.from(blob.slice(i, i + 32), 'binary').toString('hex'));
    }
    return hashes;
}

/** hashes (hex) -> blob (binary string of 32-byte hashes) */
function hashesToBlob(hashes) {
    return hashes.map(h => Buffer.from(h, 'hex').toString('binary')).join('');
}

/**
 * Find the common ancestor between the wallet's known chain (newest-first)
 * and the node's chain. Returns {height, hash} or null.
 */
async function findCommonAncestor(blockIds) {
    for (const hash of blockIds) {
        try {
            console.log('[MoneroProxy] checking ancestor hash:', hash.slice(0, 16), '...');
            const r = await rpc('get_block_header_by_hash', { hash });
            if (r && r.block_header) {
                console.log('[MoneroProxy] ancestor found at height', r.block_header.height);
                return { height: r.block_header.height, hash };
            }
        } catch (e) {
            // unknown hash — keep looking
        }
    }
    return null;
}

// ─── Response encoders ──────────────────────────────────────────────────────
/**
 * get_hashes.bin response.
 * hashes: array of hex hashes; startHeight: height of first hash;
 * currentHeight: tip+1; topHash: tip hash hex.
 */
function encodeGetHashesResponse(hashes, startHeight, currentHeight, topHash) {
    return encodePortableStorage({
        credits: { type: T_UINT64, value: 0 },
        current_height: { type: T_UINT64, value: currentHeight },
        m_block_ids: { type: T_STRING, value: hashesToBlob(hashes) },
        start_height: { type: T_UINT64, value: startHeight },
        status: { type: T_STRING, value: 'OK' },
        top_hash: { type: T_STRING, value: Buffer.from(topHash, 'hex').toString('binary') },
        untrusted: { type: T_BOOL, value: false },
    });
}

/**
 * get_blocks.bin response.
 * blocks: [{block: hex blob, txs: [hex blobs]}]; outputIndices: [[[uint64]]];
 * startHeight: height of first block; currentHeight: tip+1; topHash: tip hash hex.
 */
function encodeGetBlocksResponse(blocks, outputIndices, startHeight, currentHeight, topHash) {
    return encodePortableStorage({
        blocks: {
            type: T_OBJECT | T_FLAG,
            value: blocks.map(b => ({
                block: { type: T_STRING, value: Buffer.from(b.block, 'hex').toString('binary') },
                pruned: { type: T_BOOL, value: true },
                txs: {
                    type: T_OBJECT | T_FLAG,
                    value: b.txs.map(t => ({
                        blob: { type: T_STRING, value: Buffer.from(t.blob, 'hex').toString('binary') },
                        prunable_hash: { type: T_STRING, value: Buffer.from(t.prunableHash || '00'.repeat(32), 'hex').toString('binary') },
                    })),
                },
            })),
        },
        credits: { type: T_UINT64, value: 0 },
        current_height: { type: T_UINT64, value: currentHeight },
        daemon_time: { type: T_UINT64, value: Math.floor(Date.now() / 1000) },
        output_indices: {
            type: T_OBJECT | T_FLAG,
            value: outputIndices.map(blockIdx => ({
                indices: {
                    type: T_OBJECT | T_FLAG,
                    value: blockIdx.map(txIdx => ({
                        indices: { type: T_UINT64 | T_FLAG, value: txIdx },
                    })),
                },
            })),
        },
        start_height: { type: T_UINT64, value: startHeight },
        status: { type: T_STRING, value: 'OK' },
        top_hash: { type: T_STRING, value: Buffer.from(topHash, 'hex').toString('binary') },
        untrusted: { type: T_BOOL, value: false },
        pool_info_extent: { type: T_UINT8, value: 0 },
    });
}

// ─── Routes ─────────────────────────────────────────────────────────────────
// CORS: the browser WASM wallet needs cross-origin access to these endpoints.
function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

router.options('*', (req, res) => {
    setCors(res);
    res.sendStatus(204);
});

/** Forward the request to the upstream node and pass through the response. */
async function forwardRaw(req, res) {
    const target = `${UPSTREAM}${req.originalUrl.replace(/^\/monero-daemon/, '')}`;
    const upstream = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' },
        body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    setCors(res);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.status(upstream.status);
    res.send(buf);
    return upstream.status;
}

// get_hashes.bin — forward to the node (it serves these); translate only if blocked.
router.post(['/get_hashes.bin', '/gethashes.bin'], async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
        const status = await forwardRaw(req, res);
        if (status < 400) return;
        console.log('[MoneroProxy] get_hashes.bin blocked upstream (' + status + '), translating');
    } catch (e) {
        console.warn('[MoneroProxy] get_hashes.bin forward failed:', e.message);
    }
    // Fallback: translate via JSON-RPC.
    let parsed;
    try {
        parsed = decodePortableStorage(raw);
    } catch (e) {
        console.warn('[MoneroProxy] get_hashes.bin parse failed:', e.message);
        return res.status(400).send('bad request');
    }
    try {
        const blockIds = blobToHashes(parsed.block_ids || '');
        const startHeight = parsed.start_height || 0;
        const info = await rpc('get_info', {});
        const tip = info.height - 1;
        const topHash = info.top_block_hash;

        // noop: wallet is already at the tip
        if (startHeight > tip || (blockIds.length > 0 && blockIds[0] === topHash)) {
            return res.send(encodeGetHashesResponse([], 0, tip + 1, topHash));
        }

        const ancestor = await findCommonAncestor(blockIds);
        let fromHeight;
        if (ancestor) fromHeight = ancestor.height + 1;
        else if (startHeight > 0) fromHeight = startHeight;
        else return res.send(encodeGetHashesResponse([], 0, tip + 1, topHash));

        const toHeight = Math.min(tip, fromHeight + MAX_HASHES_PER_REQUEST - 1);
        const headers = await rpc('get_block_headers_range', {
            start_height: fromHeight,
            end_height: toHeight,
        });
        const hashes = (headers.headers || []).map(h => h.hash);
        setCors(res);
        res.send(encodeGetHashesResponse(hashes, fromHeight, tip + 1, topHash));
    } catch (e) {
        console.warn('[MoneroProxy] get_hashes.bin translate failed:', e.message);
        res.status(502).send('upstream failed');
    }
});

// get_blocks.bin — forward to the node; translate only if blocked.
router.post(['/get_blocks.bin', '/getblocks.bin'], async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
        const status = await forwardRaw(req, res);
        if (status < 400) return;
        console.log('[MoneroProxy] get_blocks.bin blocked upstream (' + status + '), translating');
    } catch (e) {
        console.warn('[MoneroProxy] get_blocks.bin forward failed:', e.message);
    }
    let parsed;
    try {
        parsed = decodePortableStorage(raw);
    } catch (e) {
        console.warn('[MoneroProxy] get_blocks.bin parse failed:', e.message);
        return res.status(400).send('bad request');
    }
    try {
        const blockIds = blobToHashes(parsed.block_ids || '');
        const startHeight = parsed.start_height || 0;
        const noMinerTx = !!parsed.no_miner_tx;
        console.log('[MoneroProxy] get_blocks.bin blockIds:', blockIds.length, 'startHeight:', startHeight);
        const info = await rpc('get_info', {});
        console.log('[MoneroProxy] get_blocks.bin tip:', info.height);
        const tip = info.height - 1;
        const topHash = info.top_block_hash;

        // noop: wallet is already at the tip
        if (startHeight > tip || (blockIds.length > 0 && blockIds[0] === topHash)) {
            console.log('[MoneroProxy] get_blocks.bin noop');
            return res.send(encodeGetBlocksResponse([], [], 0, tip + 1, topHash));
        }

        const ancestor = await findCommonAncestor(blockIds);
        let fromHeight;
        if (ancestor) fromHeight = ancestor.height + 1;
        else if (startHeight > 0) fromHeight = startHeight;
        else return res.send(encodeGetBlocksResponse([], [], 0, tip + 1, topHash));

        const toHeight = Math.min(tip, fromHeight + MAX_BLOCKS_PER_REQUEST - 1);

        // Fetch blocks in parallel (get_block returns the full binary block blob).
        const heights = [];
        for (let h = fromHeight; h <= toHeight; h++) heights.push(h);
        const blks = await mapConcurrent(heights, RPC_CONCURRENCY, async (h) => {
            const blk = await rpc('get_block', { height: h });
            return {
                blob: blk.blob,
                txHashes: blk.tx_hashes || [],
                minerTxHash: blk.miner_tx_hash,
                blockWeight: blk.block_header ? blk.block_header.block_weight || 0 : 0,
            };
        });
        const blocks = [];
        const txHashesToFetch = [];
        for (const b of blks) {
            blocks.push(b);
            if (!noMinerTx && b.minerTxHash) txHashesToFetch.push(b.minerTxHash);
            txHashesToFetch.push(...b.txHashes);
        }

        // Fetch tx blobs + output indices in parallel batches.
        const txMap = {};
        const batches = [];
        for (let i = 0; i < txHashesToFetch.length; i += 50) {
            batches.push(txHashesToFetch.slice(i, i + 50));
        }
        const batchResults = await mapConcurrent(batches, TX_BATCH_CONCURRENCY, async (batch) => {
            const txs = await directPost('/get_transactions', { txs_hashes: batch });
            return txs.txs || [];
        });
        for (const txs of batchResults) {
            for (const t of txs) txMap[t.tx_hash] = t;
        }

        const blockEntries = [];
        const outputIndices = [];
        for (const b of blocks) {
            const txs = [];
            const blockIdx = [];
            if (!noMinerTx && b.minerTxHash) {
                const miner = txMap[b.minerTxHash];
                blockIdx.push(miner ? miner.output_indices || [] : []);
            }
            for (const h of b.txHashes) {
                const t = txMap[h];
                txs.push({
                    blob: t ? (t.pruned_as_hex || t.as_hex || '') : '',
                    prunableHash: t ? (t.prunable_hash || '') : '',
                });
                blockIdx.push(t ? t.output_indices || [] : []);
            }
            blockEntries.push({ block: b.blob, txs, blockWeight: b.blockWeight || 0 });
            outputIndices.push(blockIdx);
        }

        console.log('[MoneroProxy] get_blocks.bin responding:', blockEntries.length, 'blocks from', fromHeight, 'txs:', txHashesToFetch.length);
        res.send(encodeGetBlocksResponse(blockEntries, outputIndices, fromHeight, tip + 1, topHash));
    } catch (e) {
        console.warn('[MoneroProxy] get_blocks.bin failed:', e.message, e.stack);
        res.status(502).send('upstream failed');
    }
});

// get_outs.bin — forward to the node; translate only if blocked.
router.post('/get_outs.bin', async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
        const status = await forwardRaw(req, res);
        if (status < 400) return;
        console.log('[MoneroProxy] get_outs.bin blocked upstream (' + status + '), translating');
    } catch (e) {
        console.warn('[MoneroProxy] get_outs.bin forward failed:', e.message);
    }
    let parsed;
    try {
        parsed = decodePortableStorage(raw);
    } catch (e) {
        console.warn('[MoneroProxy] get_outs.bin parse failed:', e.message);
        return res.status(400).send('bad request');
    }
    const outputs = (parsed.outputs || []).map(o => ({ amount: o.amount, index: o.index }));
    const getTxid = !!parsed.get_txid;
    try {
        const data = await directPost('/get_outs', { outputs, get_txid: getTxid });
        if (data.status !== 'OK') throw new Error('upstream status: ' + data.status);
        // outs: [{key, mask, unlocked, height, txid?}]
        const bin = encodePortableStorage({
            outs: {
                type: T_OBJECT | T_FLAG,
                value: (data.outs || []).map(o => ({
                    height: { type: T_UINT64, value: o.height },
                    key: { type: T_STRING, value: Buffer.from(o.key, 'hex').toString('binary') },
                    mask: { type: T_STRING, value: Buffer.from(o.mask, 'hex').toString('binary') },
                    txid: { type: T_STRING, value: Buffer.from(o.txid || '00'.repeat(32), 'hex').toString('binary') },
                    unlocked: { type: T_BOOL, value: !!o.unlocked },
                })),
            },
            status: { type: T_STRING, value: 'OK' },
            untrusted: { type: T_BOOL, value: false },
        });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.send(bin);
    } catch (e) {
        console.warn('[MoneroProxy] get_outs.bin failed:', e.message);
        res.status(502).send('upstream failed');
    }
});

// Everything else — forward verbatim to the upstream daemon with CORS.
router.post('*', async (req, res) => {
    try {
        await forwardRaw(req, res);
    } catch (e) {
        console.warn('[MoneroProxy] forward failed:', e.message);
        setCors(res);
        res.status(502).send('upstream failed');
    }
});

export { router as moneroDaemonProxyRouter };
export { decodePortableStorage, encodePortableStorage, blobToHashes, hashesToBlob };
