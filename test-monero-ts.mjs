// test-monero-ts.mjs — loads the frontend monero-ts bundle in Node and
// exercises the daemon RPC against a proxy, printing raw request bytes.
import fs from 'fs';
import vm from 'vm';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ExtendedPoint } = require('./lp-server-js/node_modules/@noble/ed25519');
const { ethers } = require('./lp-server-js/node_modules/ethers');

// ─── Monero address derivation (base58 + keccak checksum) ────────────────────
const ED_L = 2n ** 252n + 27742317777372353535851937790883648493n;
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function leToScalar(hex) {
    const bytes = Buffer.from(hex, 'hex');
    const rev = Buffer.from(bytes).reverse();
    return BigInt('0x' + rev.toString('hex')) % ED_L;
}
function base58Encode(buf) {
    // Monero block-based base58: 8 bytes -> 11 chars, 7->10, 6->9, 5->7, 4->6, 3->5, 2->3, 1->2
    const BLOCK_SIZES = { 0: 0, 1: 2, 2: 3, 3: 5, 4: 6, 5: 7, 6: 9, 7: 10, 8: 11 };
    const encodeBlock = (block) => {
        let n = 0n;
        for (const b of block) n = n * 256n + BigInt(b);
        let out = '';
        while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
        const pad = BLOCK_SIZES[block.length] - out.length;
        return '1'.repeat(pad) + out;
    };
    let out = '';
    let i = 0;
    while (i < buf.length) {
        const size = Math.min(8, buf.length - i);
        out += encodeBlock(buf.subarray(i, i + size));
        i += size;
    }
    return out;
}
function addressFromKeys(spendHex, viewHex) {
    const pubSpend = ExtendedPoint.BASE.multiply(leToScalar(spendHex)).toRawBytes();
    const pubView = ExtendedPoint.BASE.multiply(leToScalar(viewHex)).toRawBytes();
    const payload = Buffer.concat([Buffer.from([0x12]), Buffer.from(pubSpend), Buffer.from(pubView)]);
    const checksum = ethers.keccak256(payload).slice(2, 10);
    return base58Encode(Buffer.concat([payload, Buffer.from(checksum, 'hex')]));
}
function moneroVarint(n) {
    const b = [];
    do { let x = n & 0x7f; n = Math.floor(n / 128); if (n) x |= 0x80; b.push(x); } while (n);
    return Buffer.from(b);
}
// Serialize an output in wallet2 export_outputs format:
// blob = varint(offset) + varint(count) + outputs
// output = varint(version=1) + pubkey(32) + varint(internalIdx) + varint(globalIdx)
//          + txPubkey(32) + flags(1) + varint(amount) + varint(extraKeysCount)
//          + varint(subaddrMajor) + varint(subaddrMinor)
function exportOutputsHex({ pubkey, internalIndex, globalIndex, txPubkey, flags, amount }) {
    const parts = [
        moneroVarint(0), moneroVarint(1), // offset, count
        moneroVarint(1), // version
        Buffer.from(pubkey, 'hex'),
        moneroVarint(internalIndex),
        moneroVarint(globalIndex),
        Buffer.from(txPubkey, 'hex'),
        Buffer.from([flags]),
        moneroVarint(amount),
        moneroVarint(0), // additional tx keys
        moneroVarint(0), moneroVarint(0), // subaddr major, minor
    ];
    return Buffer.concat(parts).toString('hex');
}

const code = fs.readFileSync(new URL('./frontend/js/monero-ts.js', import.meta.url), 'utf8');

// ─── Worker shim: runs monero.worker.js in a nested vm context ──────────────
class WorkerShim {
    constructor() {
        const workerCode = fs.readFileSync(new URL('./frontend/js/monero.worker.js', import.meta.url), 'utf8');
        const ws = {
            console,
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            fetch: globalThis.fetch,
            TextEncoder,
            TextDecoder,
            Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
            Float32Array, Float64Array, ArrayBuffer, DataView, WebAssembly,
            crypto: globalThis.crypto,
            performance,
            queueMicrotask,
            URL,
            URLSearchParams,
            Blob,
            navigator: { userAgent: 'node-worker' },
            importScripts: () => {},
            addEventListener: (type, handler) => { if (type === 'message') ws.onmessage = handler; },
            removeEventListener: (type, handler) => { if (type === 'message' && ws.onmessage === handler) ws.onmessage = null; },
            postMessage: (msg) => { if (this.onmessage) this.onmessage({ data: msg }); },
        };
        ws.self = ws;
        ws.globalThis = ws;
        ws.window = ws;
        ws.global = ws;
        ws.__dirname = '/';
        ws.process = { env: { NODE_ENV: 'production' }, platform: 'linux' };
        vm.createContext(ws);
        vm.runInContext(workerCode, ws, { filename: 'monero.worker.js' });
        this._ws = ws;
    }
    postMessage(msg) {
        const handler = this._ws.onmessage;
        if (handler) handler({ data: msg });
    }
    terminate() {}
}

const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: globalThis.fetch,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    DataView,
    WebAssembly,
    crypto: globalThis.crypto,
    performance,
    queueMicrotask,
    URL,
    URLSearchParams,
    Blob,
    Worker: WorkerShim,
    navigator: { userAgent: 'node-test' },
    self: undefined,
    window: undefined,
    location: { href: 'http://localhost:8000/' },
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.global = sandbox;
sandbox.__dirname = '/';
sandbox.process = { env: { NODE_ENV: 'production' }, platform: 'linux', versions: { node: '22' }, argv: [], argv0: 'node' };
sandbox.Buffer = Buffer;
sandbox.DecompressionStream = globalThis.DecompressionStream;
sandbox.CompressionStream = globalThis.CompressionStream;
sandbox.ReadableStream = globalThis.ReadableStream;
sandbox.WritableStream = globalThis.WritableStream;
sandbox.TransformStream = globalThis.TransformStream;
sandbox.Response = globalThis.Response;
sandbox.Request = globalThis.Request;
sandbox.Headers = globalThis.Headers;

vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'monero-ts.js' });

const monero_ts = sandbox.monero_ts;
if (!monero_ts) {
    console.error('FAILED: monero_ts not exposed');
    process.exit(1);
}
console.log('monero_ts loaded. keys:', Object.keys(monero_ts).filter(k => /daemon|Daemon|wallet|Wallet/i.test(k)).join(', '));

const proxyUrl = process.env.PROXY_URL || 'http://localhost:3001/monero-daemon';
console.log('proxy:', proxyUrl);

// ─── Test the C++ wallet sync path through the proxy ────────────────────────
// The wallet syncs via get_hashes.bin/get_blocks.bin through the proxy.
const fakeSpend = '01'.repeat(32);
const fakeView = '02'.repeat(32);
const fakeAddress = addressFromKeys(fakeSpend, fakeView);
console.log('derived address:', fakeAddress);

const wallet = await monero_ts.createWalletFull({
    networkType: 0,
    primaryAddress: fakeAddress,
    privateSpendKey: fakeSpend,
    privateViewKey: fakeView,
    restoreHeight: 3781890,
    server: proxyUrl,
    proxyToWorker: false,
});
console.log('wallet created with proxy server');
const walletAddress = await wallet.getAddress(0, 0);
console.log('wallet address:', walletAddress);

const connected = await wallet.isConnectedToDaemon();
console.log('connected to daemon:', connected);

// Debug the connection state.
try {
    const conn = await wallet.getDaemonConnection();
    console.log('daemon connection:', conn ? (conn.getUri ? conn.getUri() : JSON.stringify(conn)) : 'null');
} catch (e) {
    console.log('getDaemonConnection error:', e.message);
}
try {
    const height = await wallet.getHeight();
    console.log('wallet height:', height);
} catch (e) {
    console.log('getHeight error:', e.message);
}

// Sync a small range through the proxy.
try {
    const result = await wallet.sync(new monero_ts.MoneroWalletListener());
    console.log('sync result:', JSON.stringify(result));
} catch (e) {
    console.error('sync FAILED:', e.message || e);
    process.exit(1);
}

const height = await wallet.getHeight();
console.log('wallet height:', height);
const balance = await wallet.getBalance();
console.log('balance:', balance);

// Get the wallet's computed key image for the imported output.
const walletOutputs = await wallet.getOutputs();
console.log('wallet outputs:', walletOutputs.length);
const ki = walletOutputs[0]?.getKeyImage?.()?.getHex?.();
console.log('key image:', ki);
if (!ki) { console.error('no key image computed'); process.exit(1); }

try {
    const tx = await wallet.createTx({
        keyImage: ki,
        address: walletAddress,
        amount: 124380000n,
        relay: false,
    });
    console.log('createTx OK:', tx.getTxHash?.() || tx);
} catch (e) {
    console.error('createTx FAILED:', e.message);
    process.exit(1);
}
