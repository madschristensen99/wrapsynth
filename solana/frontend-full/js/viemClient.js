// Solana client — drop-in replacement for the EVM viemClient.js.
// Same export surface (readHub/writeHub/readWsxmr/events/wallet); underneath
// everything routes through the WrapSynth Anchor program via Phantom.
//
// Conventions:
//   - "addresses" are base58 Solana pubkeys; lpVault = the vault PDA.
//   - bytes32 args arrive/return as '0x'-hex.
//   - u64/u128 amounts are BigInt, matching viem.
//   - "blocks" are unix seconds — the program stores timestamps, and
//     getBlockNumber() returns now() so existing timeout math works.

import {
    web3, Program, AnchorProvider, BN, spl,
    pdas, accounts as acct,
    keccak_256,
    fetchRetry, makeConnection, DEFAULT_COMMITMENT,
} from './vendor/solana.js';
import { NETWORKS, CONTRACTS } from './config.js?v=3.22';

const { Connection, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } = web3;

export const hyperevm = NETWORKS.hyperevm; // alias — actually Solana devnet
export const parsedABIs = { hub: [], wsxmr: [], liquidityRouter: [] };

let connection = null;
let program = null;
let wallet = null;         // window.solana (Phantom)
let userAddress = null;    // base58

const ZERO32 = '0x' + '0'.repeat(64);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b58 = (pk) => (pk instanceof PublicKey ? pk.toBase58() : String(pk));
const toPubkey = (a) => (a instanceof PublicKey ? a : new PublicKey(a));
const hexToBytes32 = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
const bytesToHex32 = (b) => '0x' + Buffer.from(b).toString('hex');
const arr32 = (h) => Array.from(hexToBytes32(h));
// The UI passes scalars as big-endian hex ('0x'+bigint.toString(16)); the
// program reads them little-endian (Scalar::from_bytes_mod_order). Reverse.
const arr32le = (h) => Array.from(hexToBytes32(h).reverse());

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function splATA(owner, mint = WSXMR_MINT()) {
    const [ata] = PublicKey.findProgramAddressSync(
        [owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
    return ata;
}

// Status enums: anchor decodes to {variant:{}} — map name → EVM int.
const MINT_STATUS_TO_EVM = {
    invalid: 0, pending: 1, keyProvided: 2, ready: 3, secretRevealed: 4,
    completed: 5, cancelled: 6, expiredReady: 7, keyCancelled: 8,
};
const BURN_STATUS_TO_EVM = {
    invalid: 0, requested: 1, proposed: 2, committed: 3,
    completed: 4, slashed: 5, cancelled: 6,
};
const statusIdx = (enumObj, map) => {
    const name = acct.statusName(enumObj);
    return map[name] ?? 0;
};

// ── Setup ───────────────────────────────────────────────────────────────────

const readOnlyWallet = {
    publicKey: new PublicKey('11111111111111111111111111111111'),
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
};

export async function initializeClients() {
    if (!window.DEPLOYMENT) {
        const res = await fetch('./devnet-config.json?t=' + Date.now());
        window.DEPLOYMENT = await res.json();
    }
    const cfg = window.DEPLOYMENT;
    // makeConnection routes getProgramAccounts to cfg.gpaRpc/public devnet —
    // Alchemy free tier rejects GPA, public devnet doesn't.
    connection = makeConnection(cfg.rpc || NETWORKS.solanaDevnet.rpcUrls[0], cfg.gpaRpc);
    // Frontend UX: GPA must fail fast — request data comes from localStorage +
    // LP-server endpoints anyway. 2 tries instead of the server-side 12×4s loop.
    const gpaConn = new web3.Connection(cfg.gpaRpc || 'https://api.devnet.solana.com', DEFAULT_COMMITMENT);
    const gpaRaw = gpaConn.getProgramAccounts.bind(gpaConn);
    connection.getProgramAccounts = async (...a) => {
        let last;
        for (let i = 0; i < 2; i++) {
            try { return await gpaRaw(...a); } catch (e) { last = e; await sleep(1500); }
        }
        throw last;
    };
    const idlRes = await fetch('./idl.json?t=' + Date.now());
    const idl = await idlRes.json();
    const provider = new AnchorProvider(connection, readOnlyWallet, { commitment: DEFAULT_COMMITMENT });
    program = new Program(idl, provider);
    if (!wallet && typeof window.solana !== 'undefined' && window.solana.isPhantom) {
        wallet = window.solana;
        if (wallet.isConnected && wallet.publicKey) userAddress = wallet.publicKey.toBase58();
    }
    return { publicClient: getPublicClient(), walletClient: getWalletClient() };
}

// ── Wallet ──────────────────────────────────────────────────────────────────

export async function connectWallet() {
    if (!connection) await initializeClients();
    if (typeof window.solana === 'undefined' || !window.solana.isPhantom) {
        throw new Error('Phantom wallet not found. Install Phantom and switch it to Devnet.');
    }
    wallet = window.solana;
    const res = await wallet.connect();
    userAddress = res.publicKey.toBase58();
    return userAddress;
}

export async function disconnectWallet() {
    try { await wallet?.disconnect(); } catch (_) {}
    userAddress = null;
}

export function getUserAddress() { return userAddress; }

export async function ensureConnected() {
    if (!userAddress) await connectWallet();
    return userAddress;
}

export async function ensureAuthorizedAccount() {
    if (!wallet || !userAddress) await connectWallet();
    return toPubkey(userAddress);
}

export function getPublicClient() {
    if (!connection) throw new Error('Client not initialized — call initializeClients()');
    return publicClientShim;
}
export function getWalletClient() { return walletClientShim; }

export function onAccountsChanged(cb) {
    wallet?.on?.('accountChanged', (pk) => {
        userAddress = pk ? pk.toBase58() : null;
        cb(pk ? [pk.toBase58()] : []);
    });
}
export function onChainChanged() { /* single chain */ }
export function removeAllListeners() {}

// ── Configured addresses ────────────────────────────────────────────────────

const cfgPk = (k) => toPubkey(window.DEPLOYMENT[k]);
const GLOBAL_STATE = () => cfgPk('globalState');
const WSXMR_MINT = () => cfgPk('wsxmrMint');
const COLLATERAL_MINT = () => cfgPk('collateralMint');
const PROGRAM_COLLATERAL_ATA = () => cfgPk('programCollateralAta');
const SOL_ESCROW = () => cfgPk('solEscrow');
const PYTH_XMR = () => toPubkey(window.DEPLOYMENT.oracle.xmr);
const PYTH_QQQX = () => toPubkey(window.DEPLOYMENT.oracle.qqqx);

const nowSecs = () => BigInt(Math.floor(Date.now() / 1000));
export const getBlockNumber = async () => nowSecs();

async function fetchAcc(name, pk) {
    return fetchRetry(() => program.account[name].fetchNullable(pk), 5, 1500);
}

// Resolve a vault arg — accepts the vault PDA itself or the LP owner pubkey.
async function resolveVaultPda(arg) {
    const pk = toPubkey(arg);
    const info = await fetchRetry(() => connection.getAccountInfo(pk), 4, 1200).catch(() => null);
    if (info && info.owner.equals(program.programId)) return pk;
    return pdas.vaultPda(pk, program.programId);
}

// ── Oracle ──────────────────────────────────────────────────────────────────

function decodePythPrice(raw) {
    // 200-byte mock PriceUpdateV2: price i64 @74, conf @82, expo i32 @90, publishTs @94
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const price = data.readBigInt64LE(74);
    const expo = data.readInt32LE(90);
    const publishTime = Number(data.readBigInt64LE(94));
    const scaled = expo >= 0 ? price * 10n ** BigInt(expo + 18) : (price * 10n ** 18n) / 10n ** BigInt(-expo);
    return { price: scaled, priceRaw: price, publishTime };
}

function pythBlob(feedIdHex, priceRaw, emaRaw, publishTs, confRaw) {
    const b = Buffer.alloc(200, 0);
    Buffer.from([0xc8, 0x8c, 0x29, 0x47, 0x6e, 0x23, 0x15, 0x1c]).copy(b, 0);
    Buffer.from(feedIdHex.replace(/^0x/, ''), 'hex').copy(b, 42);
    b.writeBigInt64LE(BigInt(priceRaw), 74);
    b.writeBigUInt64LE(BigInt(confRaw ?? BigInt(priceRaw) / 1000n), 82);
    b.writeInt32LE(-8, 90);
    b.writeBigInt64LE(BigInt(publishTs), 94);
    b.writeBigInt64LE(BigInt(publishTs) - 10n, 102);
    b.writeBigInt64LE(BigInt(emaRaw), 110);
    b.writeBigUInt64LE(BigInt(emaRaw) / 1000n, 118);
    return b;
}

async function readOracle(accPk, maxAge = 120) {
    const info = await fetchRetry(() => connection.getAccountInfo(accPk), 5, 1500);
    if (!info) throw new Error('oracle account missing');
    const { price, priceRaw, publishTime } = decodePythPrice(info.data);
    const age = Math.floor(Date.now() / 1000) - publishTime;
    if (age > maxAge) {
        const err = new Error('StalePrice: oracle data too old');
        throw err;
    }
    return { price, priceRaw, age };
}

// ── Shape mappers ───────────────────────────────────────────────────────────

function mintReqToEvm(requestIdHex, r) {
    if (!r) return { requestId: requestIdHex, status: 0n, initiator: '0x0', lpVault: '0x0', timeout: 0n };
    return {
        requestId: requestIdHex,
        initiator: b58(r.initiator),
        recipient: b58(r.recipient),
        lpVault: b58(r.lpVault),
        xmrAmount: BigInt(r.xmrAmount.toString()),
        wsxmrAmount: BigInt(r.wsxmrAmount.toString()),
        feeAmount: BigInt(r.feeAmount.toString()),
        claimCommitment: bytesToHex32(r.claimCommitment),
        userPublicKey: bytesToHex32(r.userPublicKey),
        timeout: BigInt(r.timeout.toString()),
        griefingDeposit: BigInt(r.griefingDeposit.toString()),
        normalizedDebtAmount: BigInt(r.normalizedDebtAmount.toString()),
        vaultMintNonce: BigInt(r.vaultMintNonce.toString()),
        lpCommitment: bytesToHex32(r.lpCommitment),
        revealedSecret: bytesToHex32(r.revealedSecret),
        status: BigInt(statusIdx(r.status, MINT_STATUS_TO_EVM)),
        lockedCollateral: BigInt(r.lockedCollateral.toString()),
        xmrPriceAtReady: BigInt(r.xmrPriceAtReady.toString()),
        lpPublicSpendKey: bytesToHex32(r.lpPublicSpendKey),
        lpPublicViewKey: bytesToHex32(r.lpPublicViewKey),
    };
}

function burnReqToEvm(requestIdHex, r) {
    if (!r) return { requestId: requestIdHex, status: 0n, user: '0x0', lpVault: '0x0', deadline: 0n };
    return {
        requestId: requestIdHex,
        user: b58(r.user),
        lpVault: b58(r.lpVault),
        wsxmrAmount: BigInt(r.wsxmrAmount.toString()),
        xmrAmount: BigInt(r.xmrAmount.toString()),
        lockedCollateral: BigInt(r.lockedCollateral.toString()),
        rewardCollateral: BigInt(r.rewardCollateral.toString()),
        secretHash: bytesToHex32(r.secretHash),
        deadline: BigInt(r.deadline.toString()),
        vaultLiquidationNonce: BigInt(r.vaultLiquidationNonce.toString()),
        normalizedDebtAmount: BigInt(r.normalizedDebtAmount.toString()),
        status: BigInt(statusIdx(r.status, BURN_STATUS_TO_EVM)),
        userClaimCommitment: bytesToHex32(r.userClaimCommitment),
        userPublicKey: bytesToHex32(r.userPublicKey),
        userViewKey: bytesToHex32(r.userViewKey),
        xmrPriceAtRequest: BigInt(r.xmrPriceAtRequest.toString()),
        revealedSecret: bytesToHex32(r.revealedSecret),
        lpPublicSpendKey: bytesToHex32(r.lpPublicSpendKey),
        lpPublicViewKey: bytesToHex32(r.lpPublicViewKey),
        abandoned: !!r.abandoned,
    };
}

async function vaultToEvm(vaultPdaKey, v) {
    const coll = BigInt(v.collateralAmount.toString());
    const debt = BigInt(v.normalizedDebt.toString());
    let xmrPrice = 0, collPrice = 0, maxMintCapacityXmr, capacityEstimated = false;
    try {
        const [x, c] = await Promise.all([readOracle(PYTH_XMR()), readOracle(PYTH_QQQX())]);
        xmrPrice = Number(x.price) / 1e18;
        collPrice = Number(c.price) / 1e18;
        const bps = Number(v.maxMintBps) || 10000; // 0 = uncapped on-chain
        const collUsd = Number(coll) / 1e9 * collPrice;
        const maxDebtUsd = (collUsd * bps / 10000) / 1.5;
        const curDebtUsd = Number(debt) / 1e8 * xmrPrice;
        maxMintCapacityXmr = Math.max(0, maxDebtUsd - curDebtUsd) / xmrPrice;
        capacityEstimated = true;
    } catch (_) { maxMintCapacityXmr = undefined; }
    // EVM collateral was 18-dec USDe; QQQx is 9-dec — scale ×1e9 so the UI's
    // /1e18 display math produces correct values. Write paths divide back.
    const S = 10n ** 9n;
    return {
        lpAddress: b58(v.lpAddress),
        vaultPda: b58(vaultPdaKey),
        collateralShares: coll * S,
        collateralAmount: coll * S,
        lockedCollateral: BigInt(v.lockedCollateral.toString()) * S,
        normalizedDebt: debt,
        pendingDebt: BigInt(v.pendingDebt.toString()),
        actualDebt: debt,
        maxMintBps: BigInt(v.maxMintBps),
        mintGriefingDeposit: BigInt(v.mintGriefingDeposit.toString()) * S,
        mintFeeBps: BigInt(v.mintFeeBps),
        burnRewardBps: BigInt(v.burnRewardBps),
        liquidationNonce: BigInt(v.liquidationNonce.toString()),
        mintNonce: BigInt(v.mintNonce.toString()),
        minBurnAmount: BigInt(v.minBurnAmount.toString()),
        active: v.active,
        deployedUSDeShares: BigInt(v.deployedCollateral.toString()) * S,
        maxCoLPRangeBps: BigInt(v.maxCoLpRangeBps ?? 0),
        // UI converts blocks→time via ×5s — return secs/5 so the math lands right.
        mintTimeoutBlocks: BigInt(v.mintTimeoutSeconds.toString()) / 5n,
        burnTimeoutBlocks: BigInt(v.burnTimeoutSeconds.toString()) / 5n,
        pendingMintCount: BigInt(v.pendingMintCount),
        xmrPrice, collPrice, maxMintCapacityXmr, capacityEstimated,
        capacityAvailable: capacityEstimated,
    };
}

// ── Discovery helpers (GPA-free paths for Alchemy free tier) ────────────────
// getProgramAccounts is a paid-tier call on Alchemy — these helpers fall back
// to localStorage requestIds (fetched directly by PDA) and LP-server scans.

function storedRequestIds(type /* 'mint'|'burn' */) {
    const ids = new Set();
    try {
        for (const key of ['wrapsynth_active_swaps_v2', 'phantom_swap_history']) {
            const arr = JSON.parse(localStorage.getItem(key) || '[]');
            for (const s of arr) {
                const match = (s.type || '').toLowerCase().includes(type) || (type === 'mint' && !s.type);
                if (s.requestId && match) ids.add(s.requestId);
            }
        }
    } catch (_) {}
    return [...ids];
}

// Fetch request PDAs directly (getMultipleAccountsInfo — allowed on free tier),
// verify ownership, return still-existent request ids.
async function knownRequestIds(type, owner) {
    const ids = storedRequestIds(type);
    if (!ids.length) return [];
    const pdaFn = type === 'mint' ? pdas.mintRequestPda : pdas.burnRequestPda;
    const pdaList = ids.map(id => pdaFn(hexToBytes32(id), program.programId));
    const infos = await connection.getMultipleAccountsInfo(pdaList);
    const out = [];
    for (let i = 0; i < ids.length; i++) {
        const info = infos[i];
        if (!info) continue;
        const r = program.coder.accounts.decode(type === 'mint' ? 'mintRequest' : 'burnRequest', info.data);
        const ownerField = type === 'mint' ? (b58(r.initiator) === owner || b58(r.recipient) === owner) : b58(r.user) === owner;
        if (ownerField) out.push(bytesToHex32(r.requestId));
    }
    return out;
}

let _vaultCache = null;
let _vaultCacheAt = 0;
async function discoveredVaults() {
    if (_vaultCache && Date.now() - _vaultCacheAt < 60_000) return _vaultCache;
    const out = [];
    // LP-server vault first — that's the one users should mint against.
    if (CONTRACTS.defaultLpVault) out.push(CONTRACTS.defaultLpVault);
    else {
        try {
            const h = await fetchRetry(() => fetch(CONTRACTS.lpServerUrl + '/health').then(r => r.json()), 2, 500);
            if (h.vault) { CONTRACTS.defaultLpVault = h.vault; out.push(h.vault); }
        } catch (_) {}
    }
    // Persisted discoveries + GPA sweep when the public RPC cooperates.
    try {
        const cached = JSON.parse(localStorage.getItem('wrapsynth_vaults') || '[]');
        for (const v of cached) if (!out.includes(v)) out.push(v);
    } catch (_) {}
    _vaultCache = out;
    _vaultCacheAt = Date.now();
    // GPA in background — never block the dropdown on a throttled RPC.
    (async () => {
        try {
            const vaults = await program.account.vault.all();
            let changed = false;
            for (const { publicKey } of vaults) {
                const s = b58(publicKey);
                if (!_vaultCache.includes(s)) { _vaultCache.push(s); changed = true; }
            }
            if (changed) localStorage.setItem('wrapsynth_vaults', JSON.stringify(_vaultCache));
        } catch (_) { /* GPA unavailable — whatever we have is fine */ }
    })();
    return out;
}

// ── Event synthesis ─────────────────────────────────────────────────────────
// No logs on Solana — request state IS the event.

function synthLog(eventName, args, blockTime) {
    return {
        eventName, args,
        blockNumber: BigInt(blockTime || Math.floor(Date.now() / 1000)),
        transactionHash: '0x' + '0'.repeat(64),
        logIndex: 0, removed: false,
    };
}

function requestArgsCommon(idHex, r) {
    return {
        requestId: idHex,
        initiator: r.initiator ? b58(r.initiator) : undefined,
        recipient: r.recipient ? b58(r.recipient) : undefined,
        user: r.user ? b58(r.user) : (r.initiator ? b58(r.initiator) : undefined),
        lpVault: b58(r.lpVault),
        xmrAmount: r.xmrAmount != null ? BigInt(r.xmrAmount.toString()) : undefined,
        wsxmrAmount: r.wsxmrAmount != null ? BigInt(r.wsxmrAmount.toString()) : undefined,
        timeout: r.timeout != null ? BigInt(r.timeout.toString()) : undefined,
        deadline: r.deadline != null ? BigInt(r.deadline.toString()) : undefined,
        secret: r.revealedSecret ? bytesToHex32(r.revealedSecret) : undefined,
        lpSecret: r.revealedSecret ? bytesToHex32(r.revealedSecret) : undefined,
        secretHash: r.secretHash ? bytesToHex32(r.secretHash) : undefined,
    };
}

const MINT_EVENTS_BY_STATUS = (s) => {
    const evs = ['MintInitiated'];
    if (s >= 2 && s !== 6) evs.push('LPKeyProvided');
    if ((s >= 3 && s <= 5) || s === 8) evs.push('MintReady');
    if (s === 4 || s === 5) evs.push('SecretRevealed');
    if (s === 5) evs.push('MintFinalized');
    if (s === 6) evs.push('MintCancelled');
    if (s === 7) evs.push('MintKeyCancelled');
    return evs;
};
const BURN_EVENTS_BY_STATUS = (s) => {
    const evs = ['BurnRequested'];
    if (s >= 2) evs.push('HashProposed');
    if (s >= 3) evs.push('BurnCommitted');
    if (s === 4) evs.push('BurnFinalized');
    if (s === 5) evs.push('BurnSlashed');
    if (s === 6) evs.push('BurnCancelled');
    return evs;
};

async function allSynthesizedEvents() {
    const out = [];
    const pid = program.programId;
    let rawMints = null, rawBurns = null;
    try {
        [rawMints, rawBurns] = await Promise.all([
            connection.getProgramAccounts(pid, { filters: [{ memcmp: { offset: 0, bytes: bs58enc(acct.DISCRIMINATORS.mintRequest) } }] }),
            connection.getProgramAccounts(pid, { filters: [{ memcmp: { offset: 0, bytes: bs58enc(acct.DISCRIMINATORS.burnRequest) } }] }),
        ]);
    } catch (_) { /* GPA unavailable — fall back to localStorage requestIds */ }
    if (rawMints) {
        for (const { account } of rawMints) {
            const r = program.coder.accounts.decode('mintRequest', account.data);
            const idHex = bytesToHex32(r.requestId);
            for (const name of MINT_EVENTS_BY_STATUS(statusIdx(r.status, MINT_STATUS_TO_EVM)))
                out.push(synthLog(name, requestArgsCommon(idHex, r), Number(r.timeout) - 7200));
        }
        for (const { account } of rawBurns) {
            const r = program.coder.accounts.decode('burnRequest', account.data);
            const idHex = bytesToHex32(r.requestId);
            for (const name of BURN_EVENTS_BY_STATUS(statusIdx(r.status, BURN_STATUS_TO_EVM)))
                out.push(synthLog(name, requestArgsCommon(idHex, r), Number(r.deadline) - 7200));
        }
    } else {
        // Fallback: fetch only the request PDAs this browser has tracked.
        for (const type of ['mint', 'burn']) {
            const ids = storedRequestIds(type);
            if (!ids.length) continue;
            const pdaFn = type === 'mint' ? pdas.mintRequestPda : pdas.burnRequestPda;
            const pdasList = ids.map(id => pdaFn(hexToBytes32(id), pid));
            const infos = await connection.getMultipleAccountsInfo(pdasList).catch(() => []);
            for (const info of infos) {
                if (!info) continue;
                const r = program.coder.accounts.decode(type === 'mint' ? 'mintRequest' : 'burnRequest', info.data);
                const idHex = bytesToHex32(r.requestId);
                const evNames = type === 'mint' ? MINT_EVENTS_BY_STATUS(statusIdx(r.status, MINT_STATUS_TO_EVM)) : BURN_EVENTS_BY_STATUS(statusIdx(r.status, BURN_STATUS_TO_EVM));
                for (const name of evNames) out.push(synthLog(name, requestArgsCommon(idHex, r)));
            }
        }
    }
    for (const v of await discoveredVaults()) {
        try {
            const acc = await fetchAcc('vault', toPubkey(v));
            if (acc) out.push(synthLog('VaultCreated', { vault: v, lpAddress: b58(acc.lpAddress) }));
        } catch (_) {}
    }
    return out;
}

let _bs58mod = null;
function bs58enc(bytes) {
    // minimal base58 encoder for memcmp filters (Buffer→base58)
    const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let x = BigInt('0x' + Buffer.from(bytes).toString('hex'));
    let s = '';
    while (x > 0n) { s = ALPH[Number(x % 58n)] + s; x /= 58n; }
    for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
    return s;
}

function argEq(a, b) {
    if (a === undefined || b === undefined || b === null) return a !== undefined;
    const sa = String(a).toLowerCase(), sb = String(b).toLowerCase();
    if (sa === sb) return true;
    // allow comparing base58 ↔ hex pubkey
    try {
        if (sb.startsWith('0x') && sb.length === 66) return sa === new PublicKey(hexToBytes32(sb)).toBase58().toLowerCase();
        if (sa.startsWith('0x') && sa.length === 66) return sb === new PublicKey(hexToBytes32(sa)).toBase58().toLowerCase();
    } catch (_) {}
    return false;
}

function eventMatches(ev, eventName, filter) {
    if (eventName && ev.eventName !== eventName) return false;
    if (!filter) return true;
    for (const [k, v] of Object.entries(filter)) {
        if (v === undefined || v === null) continue;
        if (!argEq(ev.args?.[k], v)) return false;
    }
    return true;
}

export async function getPastEvents(address, abi, eventName, fromBlock, toBlock, filterArgs = {}) {
    if (eventName === 'Transfer' && address && b58(address) === b58(WSXMR_MINT())) {
        return wsxmrTransferEvents(filterArgs);
    }
    const all = await allSynthesizedEvents();
    return all.filter(ev => eventMatches(ev, eventName, filterArgs));
}

export async function getContractEventsChunked({ address, abi, eventName, fromBlock, toBlock, args: filterArgs }) {
    return getPastEvents(address, abi, eventName, fromBlock, toBlock, filterArgs);
}
export const getLogsChunked = getContractEventsChunked;

async function wsxmrTransferEvents(filter = {}) {
    const user = filter.from || filter.to;
    if (!user) return [];
    try {
        const info = await connection.getAccountInfo(splATA(toPubkey(user)));
        if (!info) return [];
        const amount = Buffer.from(info.data).readBigUInt64LE(64);
        if (amount === 0n) return [];
        return [synthLog('Transfer', {
            from: filter.to ? '0x0000000000000000000000000000000000000000' : user,
            to: filter.from ? '0x0000000000000000000000000000000000000000' : user,
            value: amount,
        })];
    } catch (_) { return []; }
}

async function synthEventForRequest(eventName, requestIdHex) {
    const reqBytes = hexToBytes32(requestIdHex);
    const m = await fetchAcc('mintRequest', pdas.mintRequestPda(reqBytes, program.programId));
    if (m && MINT_EVENTS_BY_STATUS(statusIdx(m.status, MINT_STATUS_TO_EVM)).includes(eventName)) {
        return synthLog(eventName, requestArgsCommon(requestIdHex, m));
    }
    const b = await fetchAcc('burnRequest', pdas.burnRequestPda(reqBytes, program.programId));
    if (b && BURN_EVENTS_BY_STATUS(statusIdx(b.status, BURN_STATUS_TO_EVM)).includes(eventName)) {
        return synthLog(eventName, requestArgsCommon(requestIdHex, b));
    }
    return null;
}

export function watchContractEvent(address, abi, eventName, filterArgs, onLogs) {
    let stopped = false;
    const seen = new Set();
    const emitIf = (evs) => {
        const fresh = evs.filter(ev => {
            const key = ev.eventName + '|' + (ev.args?.requestId || '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        if (fresh.length && !stopped) onLogs(fresh);
    };
    const timer = setInterval(async () => {
        if (stopped) return;
        try {
            if (eventName === 'Transfer' && address && b58(address) === b58(WSXMR_MINT())) {
                emitIf(await wsxmrTransferEvents(filterArgs));
            } else if (filterArgs?.requestId) {
                const ev = await synthEventForRequest(eventName, filterArgs.requestId);
                if (ev) emitIf([ev]);
            } else {
                emitIf(await getPastEvents(address, abi, eventName, 0n, 'latest', filterArgs));
            }
        } catch (e) { console.warn(`watch ${eventName}:`, e.message || e); }
    }, 8000);
    return () => { stopped = true; clearInterval(timer); };
}

// ── viem-shaped client shims ────────────────────────────────────────────────

const publicClientShim = {
    getBlockNumber: async () => nowSecs(),
    getBlock: async ({ blockNumber } = {}) => ({
        number: BigInt(blockNumber ?? Math.floor(Date.now() / 1000)),
        timestamp: BigInt(blockNumber ?? Math.floor(Date.now() / 1000)),
    }),
    getBalance: async ({ address }) => BigInt(await connection.getBalance(toPubkey(address))),
    readContract: async ({ functionName, args = [] }) => readHub(functionName, args),
    simulateContract: async ({ functionName, args = [] }) => ({
        result: await readHub(functionName, args),
        request: { functionName, args },
    }),
    waitForTransactionReceipt: async ({ hash }) => {
        await httpConfirm(hash);
        return { status: 'success', transactionHash: hash, logs: [] };
    },
    getTransactionCount: async () => 0n,
    getLogs: async ({ event } = {}) => {
        const evs = await allSynthesizedEvents();
        return evs.filter(e => !event?.eventName || e.eventName === event.eventName);
    },
    watchContractEvent: ({ address, abi, eventName, args: filterArgs, onLogs }) =>
        watchContractEvent(address, abi, eventName, filterArgs, onLogs),
    call: async () => { throw new Error('eth_call not supported on Solana'); },
    estimateGas: async () => 0n,
    chain: hyperevm,
};

const walletClientShim = {
    account: null,
    writeContract: async ({ functionName, args = [], value }) =>
        (await writeHub(functionName, args, value)).transactionHash,
    requestAddresses: async () => [await connectWallet()],
    chain: hyperevm,
};

// ── Transactions ────────────────────────────────────────────────────────────

async function httpConfirm(sig, timeoutMs = 90_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const st = await connection.getSignatureStatuses([sig]).catch(() => null);
        const s = st?.value?.[0];
        if (s?.err) {
            const e = new Error(`Transaction failed: ${JSON.stringify(s.err)}`);
            e.signature = sig;
            throw e;
        }
        if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return s;
        await sleep(1500);
    }
    throw new Error(`Transaction confirmation timeout: ${sig}`);
}

async function signSendIxs(ixs, { computeUnits = 250_000 } = {}) {
    await ensureAuthorizedAccount();
    const payer = toPubkey(userAddress);
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
    for (const ix of ixs) tx.add(ix);
    tx.feePayer = payer;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const signed = await wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await httpConfirm(sig);
    await sleep(1200); // public-RPC pacing
    return sig;
}

function makeReceipt(sig, logs = []) {
    return {
        transactionHash: sig, status: 'success', logs,
        wait: async () => ({ status: 'success', transactionHash: sig, logs }),
    };
}

const evmEventTopic = (sig) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig))).toString('hex');
const MINT_INIT_SIG = 'MintInitiated(bytes32,address,address,address,uint256,uint256,uint256,bytes32,bytes32,uint256)';
const BURN_REQ_SIG = 'BurnRequested(bytes32,address,address,uint256,uint256,uint256,bytes32,bytes32,bytes32)';

async function nextNonce() {
    const gs = await program.account.globalState.fetch(GLOBAL_STATE());
    return BigInt(gs.requestNonce.toString()) + 1n;
}

async function ensurePendingReturnsIxs(owner) {
    const prPda = pdas.pendingReturnsPda(owner, program.programId);
    const info = await connection.getAccountInfo(prPda);
    if (info) return { prPda, ixs: [] };
    const ix = await program.methods.initializePendingReturns()
        .accountsStrict({ owner, pendingReturns: prPda, systemProgram: SystemProgram.programId })
        .instruction();
    return { prPda, ixs: [ix] };
}

// ── readHub ─────────────────────────────────────────────────────────────────

export async function readHub(functionName, args = []) {
    if (!program) await initializeClients();

    switch (functionName) {
        case 'getMintRequest': {
            const r = await fetchAcc('mintRequest', pdas.mintRequestPda(hexToBytes32(args[0]), program.programId));
            return mintReqToEvm(args[0], r);
        }
        case 'getBurnRequest': {
            const r = await fetchAcc('burnRequest', pdas.burnRequestPda(hexToBytes32(args[0]), program.programId));
            return burnReqToEvm(args[0], r);
        }
        case 'getVault': {
            const pda = await resolveVaultPda(args[0]);
            const v = await fetchAcc('vault', pda);
            if (!v) throw new Error(`No vault for ${args[0]}`);
            return vaultToEvm(pda, v);
        }
        case 'hasActiveVault': {
            const v = await fetchAcc('vault', pdas.vaultPda(toPubkey(args[0]), program.programId));
            return !!(v && v.active);
        }
        case 'getPendingReturns': {
            const pr = await fetchAcc('pendingReturns', pdas.pendingReturnsPda(toPubkey(args[0]), program.programId));
            if (!pr) return 0n;
            const token = args[1];
            const isSol = !token || token === '0x0000000000000000000000000000000000000000' ||
                token === '0x0000000000000000000000000000000000000000000000000000000000000000';
            const raw = isSol ? BigInt(pr.solAmount.toString()) : BigInt(pr.collateralAmount.toString());
            return raw * (10n ** 9n); // 9-dec → 18-dec so /1e18 displays correctly
        }
        case 'getXmrPrice': return (await readOracle(PYTH_XMR())).price;
        case 'getCollateralPrice': return (await readOracle(PYTH_QQQX())).price;
        case 'getXmrPriceWithAge': { const { price, age } = await readOracle(PYTH_XMR(), Number(args[0] ?? 1e9)); return { price, age: BigInt(age) }; }
        case 'getCollateralPriceWithAge': { const { price, age } = await readOracle(PYTH_QQQX(), Number(args[0] ?? 1e9)); return { price, age: BigInt(age) }; }
        case 'lastXmrPrice': return (await readOracle(PYTH_XMR(), 1e9)).priceRaw; // 8-dec, matching EVM int192
        case 'lastCollateralPrice': return (await readOracle(PYTH_QQQX(), 1e9)).priceRaw;
        case 'lpPublicKeys': return (await readHub('getMintRequest', [args[0]])).lpPublicSpendKey || ZERO32;
        case 'lpPublicViewKeys': return (await readHub('getMintRequest', [args[0]])).lpPublicViewKey || ZERO32;
        case 'burnLpPublicKeys': return (await readHub('getBurnRequest', [args[0]])).lpPublicSpendKey || ZERO32;
        case 'burnLpPublicViewKeys': return (await readHub('getBurnRequest', [args[0]])).lpPublicViewKey || ZERO32;
        case 'abandonedBurns': return !!(await readHub('getBurnRequest', [args[0]])).abandoned;
        case 'globalDebtIndex': return 10n ** 18n;
        case 'totalGlobalDebt': {
            const gs = await fetchAcc('globalState', GLOBAL_STATE());
            return BigInt(gs?.totalNormalizedDebt?.toString() ?? 0);
        }
        case 'getVaultDebt': {
            const v = await fetchAcc('vault', await resolveVaultPda(args[0]));
            return v ? BigInt(v.normalizedDebt.toString()) : 0n;
        }
        case 'getVaultCount': {
            const vaults = await discoveredVaults();
            return BigInt(vaults.length);
        }
        case 'vaultList': {
            const vaults = await discoveredVaults();
            const i = Number(args[0]);
            return vaults[i] || '0x0000000000000000000000000000000000000000';
        }
        case 'getUserMintRequests': {
            const owner = args[0] ? b58(toPubkey(args[0])) : userAddress;
            const out = await knownRequestIds('mint', owner);
            // Opportunistic GPA merge — works when public RPC isn't saturated.
            try {
                const raws = await connection.getProgramAccounts(program.programId, {
                    filters: [{ memcmp: { offset: 0, bytes: bs58enc(acct.DISCRIMINATORS.mintRequest) } }],
                });
                for (const r of raws) {
                    const d = program.coder.accounts.decode('mintRequest', r.account.data);
                    if (b58(d.initiator) === owner || b58(d.recipient) === owner) {
                        const id = bytesToHex32(d.requestId);
                        if (!out.includes(id)) out.push(id);
                    }
                }
            } catch (_) { /* GPA down — localStorage set is enough */ }
            return out;
        }
        case 'getUserBurnRequests': {
            const owner = args[0] ? b58(toPubkey(args[0])) : userAddress;
            const out = await knownRequestIds('burn', owner);
            try {
                const raws = await connection.getProgramAccounts(program.programId, {
                    filters: [{ memcmp: { offset: 0, bytes: bs58enc(acct.DISCRIMINATORS.burnRequest) } }],
                });
                for (const r of raws) {
                    const d = program.coder.accounts.decode('burnRequest', r.account.data);
                    if (b58(d.user) === owner) {
                        const id = bytesToHex32(d.requestId);
                        if (!out.includes(id)) out.push(id);
                    }
                }
            } catch (_) {}
            return out;
        }
        case 'getVaultPendingMints': {
            const vault = b58(await resolveVaultPda(args[0]));
            // Prefer the LP server's own scan — no GPA needed.
            try {
                const r = await fetch(CONTRACTS.lpServerUrl + '/mints');
                const list = await r.json();
                const mine = (Array.isArray(list) ? list : list.mints || [])
                    .filter(m => (m.lpVault || '') === vault || m.vault === vault)
                    .map(m => m.requestId || m.id)
                    .filter(Boolean);
                if (mine.length) return mine;
            } catch (_) {}
            try {
                const mints = await acct.scanMintRequests(connection, program, toPubkey(vault), null);
                return mints.filter(m => statusIdx(m.request.status, MINT_STATUS_TO_EVM) < 5)
                    .map(m => bytesToHex32(m.request.requestId));
            } catch (_) { return []; }
        }
        case 'getVaultBurnRequests': {
            const vault = b58(await resolveVaultPda(args[0]));
            try {
                const r = await fetch(CONTRACTS.lpServerUrl + '/burns');
                const list = await r.json();
                const mine = (Array.isArray(list) ? list : list.burns || [])
                    .filter(b => (b.lpVault || '') === vault || b.vault === vault)
                    .map(b => b.requestId || b.id)
                    .filter(Boolean);
                if (mine.length) return mine;
            } catch (_) {}
            try {
                const burns = await acct.scanBurnRequests(connection, program, toPubkey(vault), null);
                return burns.map(b => bytesToHex32(b.request.requestId));
            } catch (_) { return []; }
        }
        case 'calculateWsxmrAmount': return BigInt(args[0]) / 10_000n;
        case 'getVaultHealth': {
            const v = await fetchAcc('vault', await resolveVaultPda(args[0]));
            if (!v) return 0n;
            const coll = BigInt(v.collateralAmount.toString());
            const debt = BigInt(v.normalizedDebt.toString());
            if (debt === 0n) return 10n ** 22n;
            try {
                const [x, c] = await Promise.all([readOracle(PYTH_XMR()), readOracle(PYTH_QQQX())]);
                const collUsd = coll * c.price / 10n ** 9n;
                const debtUsd = debt * x.price / 10n ** 8n;
                return debtUsd === 0n ? 10n ** 22n : collUsd * 10n ** 18n / debtUsd;
            } catch (_) { return 0n; }
        }
        case 'getMintCapacity': {
            const v = await readHub('getVault', [args[0]]);
            return v.maxMintCapacityXmr === undefined ? 0n : BigInt(Math.floor(v.maxMintCapacityXmr * 1e8));
        }
        case 'calculateBurnCollateral': {
            // EVM returns [baseLock, rewardLock]; callsites index [1].
            // Scaled to 18-dec so /1e18 displays right (raw collateral is 9-dec).
            const wsxmr = BigInt(args[1] ?? args[0]);
            const vaultKey = args.length > 1 ? args[0] : (CONTRACTS.defaultLpVault || null);
            try {
                const [x, c] = await Promise.all([readOracle(PYTH_XMR()), readOracle(PYTH_QQQX())]);
                const v = vaultKey ? await fetchAcc('vault', await resolveVaultPda(vaultKey)) : null;
                const rewardBps = v ? BigInt(v.burnRewardBps.toString()) : 50n;
                // base lock: wsxmr(8dec)*xmrUsd/qqqxUsd → collateral raw(9dec)
                const base = wsxmr * x.price * 10n / c.price;
                const reward = base * rewardBps / 10_000n;
                const S = 10n ** 9n;
                return [base * S, reward * S];
            } catch (_) { return [0n, 0n]; }
        }
        // ── EVM co-LP / pool reads — no Solana equivalent yet ─────────────
        case 'getPositionMetadata':
            return { vaultOwner: '0x0', user: '0x0', sDAISharesOriginal: 0n, wsxmrOriginal: 0n, tickLower: 0, tickUpper: 0, liquidity: 0n, createdAt: 0n };
        case 'getUserPositions': return [];
        case 'userOpenCoLP': return false;
        case 'getUserAvailableWsxmr': return userAddress ? await getWsXmrBalance(userAddress) : 0n;
        case 'getLpAvailableLiquidity': return 0n;
        case 'getCoLPCapacity': return 0n;
        case 'getPendingFees': return 0n;
        case 'convertToAssets': return BigInt(args[0] ?? 0n);
        case 'slot0': return { sqrtPriceX96: 0n, tick: 0 };
        default:
            throw new Error(`readHub: '${functionName}' not mapped on Solana`);
    }
}

// ── writeHub ────────────────────────────────────────────────────────────────

export async function writeHub(functionName, args = [], value = 0n, gas = undefined) {
    return _writeHub(functionName, args, value);
}
export async function writeHubUnsafe(functionName, args = [], value = 0n, gas = undefined) {
    return _writeHub(functionName, args, value);
}

async function _writeHub(functionName, args, value) {
    if (!program) await initializeClients();
    await ensureAuthorizedAccount();
    const payer = toPubkey(userAddress);

    switch (functionName) {
        case 'initiateMint': {
            // EVM args: (lpVault, recipient, xmrAmount, claimCommitment, userPublicKey)
            const [lpVault, recipient, xmrAmount, , userPublicKey] = args;
            const vault = await resolveVaultPda(lpVault);
            const nonce = await nextNonce();
            // Solana binds claim_commitment = keccak256(user_public_key) — the UI's
            // commitment is EVM-style keccak(abi.encodePacked(px,py)); recompute.
            const claimCommitment = '0x' + Buffer.from(keccak_256(hexToBytes32(userPublicKey))).toString('hex');
            const requestId = pdas.mintRequestId(payer, vault, xmrAmount, hexToBytes32(claimCommitment), nonce);
            const mintReqPda = pdas.mintRequestPda(requestId, program.programId);
            const { prPda, ixs: prIxs } = await ensurePendingReturnsIxs(payer);
            const ix = await program.methods.initiateMint(
                new BN(xmrAmount.toString()),
                arr32(claimCommitment),
                arr32(userPublicKey),
                Array.from(requestId),
            ).accountsStrict({
                initiator: payer,
                recipient: toPubkey(recipient),
                vault,
                globalState: GLOBAL_STATE(),
                mintRequest: mintReqPda,
                griefingEscrow: payer, // any funded account; program checks lamports only
                initiatorPendingReturns: prPda,
                pythXmr: PYTH_XMR(),
                pythCollateral: PYTH_QQQX(),
                systemProgram: SystemProgram.programId,
            }).instruction();
            const sig = await signSendIxs([...prIxs, ix], { computeUnits: 350_000 });
            return makeReceipt(sig, [{
                topics: [evmEventTopic(MINT_INIT_SIG), bytesToHex32(requestId)],
                args: { requestId: bytesToHex32(requestId) },
                eventName: 'MintInitiated', logIndex: 0,
            }]);
        }

        case 'requestBurn': {
            // EVM args: (wsxmrAmount, lpVault, user, claimCommitment, userPublicKey, userViewKey)
            const [wsxmrAmount, lpVault, , , userPublicKey, userViewKey] = args;
            const vault = await resolveVaultPda(lpVault);
            // Same binding convention as mints: keccak256(user_public_key).
            const claimCommitment = '0x' + Buffer.from(keccak_256(hexToBytes32(userPublicKey))).toString('hex');
            const buildIx = async (rid) => program.methods.requestBurn(
                new BN(wsxmrAmount.toString()),
                arr32(claimCommitment),
                arr32(userPublicKey),
                arr32(userViewKey),
                Array.from(rid),
            ).accountsStrict({
                user: payer,
                vault,
                globalState: GLOBAL_STATE(),
                burnRequest: pdas.burnRequestPda(rid, program.programId),
                wsxmrMint: WSXMR_MINT(),
                userWsxmrAta: splATA(payer),
                pythXmr: PYTH_XMR(),
                pythCollateral: PYTH_QQQX(),
                tokenProgram: TOKEN_2022,
                systemProgram: SystemProgram.programId,
            }).instruction();
            let requestId = pdas.burnRequestId(payer, vault, wsxmrAmount, await nextNonce());
            let sig;
            try {
                sig = await signSendIxs([await buildIx(requestId)], { computeUnits: 300_000 });
            } catch (e) {
                if (/InvalidBurnRequest|0x1778/.test(e.message || '')) {
                    requestId = pdas.burnRequestId(payer, vault, wsxmrAmount, await nextNonce());
                    sig = await signSendIxs([await buildIx(requestId)], { computeUnits: 300_000 });
                } else throw e;
            }
            return makeReceipt(sig, [{
                topics: [evmEventTopic(BURN_REQ_SIG), bytesToHex32(requestId)],
                args: { requestId: bytesToHex32(requestId) },
                eventName: 'BurnRequested', logIndex: 0,
            }]);
        }

        case 'revealSecret': {
            const reqPda = pdas.mintRequestPda(hexToBytes32(args[0]), program.programId);
            const ix = await program.methods.revealSecret(arr32le(args[1]))
                .accountsStrict({ caller: payer, mintRequest: reqPda }).instruction();
            return makeReceipt(await signSendIxs([ix], { computeUnits: 400_000 }));
        }

        case 'confirmMoneroLock': {
            const reqPda = pdas.burnRequestPda(hexToBytes32(args[0]), program.programId);
            const ix = await program.methods.confirmMoneroLock()
                .accountsStrict({ user: payer, burnRequest: reqPda }).instruction();
            return makeReceipt(await signSendIxs([ix]));
        }

        case 'cancelMint': {
            const reqPda = pdas.mintRequestPda(hexToBytes32(args[0]), program.programId);
            const mr = await program.account.mintRequest.fetch(reqPda);
            const v = await program.account.vault.fetch(mr.lpVault);
            const vaultCollAta = pdas.vaultCollateralAtaPda(mr.lpVault, program.programId);
            const ix = await program.methods.cancelMint()
                .accountsStrict({
                    caller: payer,
                    vault: mr.lpVault,
                    globalState: GLOBAL_STATE(),
                    mintRequest: reqPda,
                    initiatorReturns: pdas.pendingReturnsPda(toPubkey(b58(mr.initiator)), program.programId),
                    lpReturns: pdas.pendingReturnsPda(toPubkey(b58(v.lpAddress)), program.programId),
                    wsxmrMint: WSXMR_MINT(),
                    recipientWsxmrAta: splATA(toPubkey(b58(mr.recipient))),
                    lpWsxmrAta: splATA(toPubkey(b58(v.lpAddress))),
                    collateralMint: COLLATERAL_MINT(),
                    vaultCollateralAta: vaultCollAta,
                    programCollateralAta: PROGRAM_COLLATERAL_ATA(),
                    tokenProgram: TOKEN_2022,
                    systemProgram: SystemProgram.programId,
                }).instruction();
            return makeReceipt(await signSendIxs([ix], { computeUnits: 400_000 }));
        }

        case 'abortBurn': {
            const reqPda = pdas.burnRequestPda(hexToBytes32(args[0]), program.programId);
            const ix = await program.methods.abortBurn()
                .accountsStrict({
                    caller: payer,
                    vault: (await program.account.burnRequest.fetch(reqPda)).lpVault,
                    globalState: GLOBAL_STATE(),
                    burnRequest: reqPda,
                    wsxmrMint: WSXMR_MINT(),
                    userWsxmrAta: splATA(payer),
                    tokenProgram: TOKEN_2022,
                    systemProgram: SystemProgram.programId,
                }).instruction();
            return makeReceipt(await signSendIxs([ix]));
        }

        case 'resolveDeclinedProposal': {
            const reqPda = pdas.burnRequestPda(hexToBytes32(args[0]), program.programId);
            const br = await program.account.burnRequest.fetch(reqPda);
            const ix = await program.methods.resolveDeclinedProposal(arr32le(args[1]))
                .accountsStrict({
                    caller: payer,
                    vault: br.lpVault,
                    globalState: GLOBAL_STATE(),
                    burnRequest: reqPda,
                    wsxmrMint: WSXMR_MINT(),
                    userWsxmrAta: splATA(payer),
                    tokenProgram: TOKEN_2022,
                    systemProgram: SystemProgram.programId,
                }).instruction();
            return makeReceipt(await signSendIxs([ix], { computeUnits: 400_000 }));
        }

        case 'settleBurn': {
            const reqPda = pdas.burnRequestPda(hexToBytes32(args[0]), program.programId);
            const br = await program.account.burnRequest.fetch(reqPda);
            const v = await program.account.vault.fetch(br.lpVault);
            const ix = await program.methods.settleBurn()
                .accountsStrict({
                    caller: payer,
                    vaultLp: toPubkey(b58(v.lpAddress)),
                    vault: br.lpVault,
                    globalState: GLOBAL_STATE(),
                    burnRequest: reqPda,
                    userPendingReturns: pdas.pendingReturnsPda(toPubkey(b58(br.user)), program.programId),
                    pythXmr: PYTH_XMR(),
                    pythCollateral: PYTH_QQQX(),
                    collateralMint: COLLATERAL_MINT(),
                    vaultCollateralAta: pdas.vaultCollateralAtaPda(br.lpVault, program.programId),
                    programCollateralAta: PROGRAM_COLLATERAL_ATA(),
                    tokenProgram: TOKEN_2022,
                    systemProgram: SystemProgram.programId,
                }).instruction();
            return makeReceipt(await signSendIxs([ix]));
        }

        case 'claimSlashedCollateral': {
            const reqPda = pdas.burnRequestPda(hexToBytes32(args[0]), program.programId);
            const br = await program.account.burnRequest.fetch(reqPda);
            const v = await program.account.vault.fetch(br.lpVault);
            const ix = await program.methods.claimSlashedCollateral(arr32le(args[1]))
                .accountsStrict({
                    user: payer,
                    vaultLp: toPubkey(b58(v.lpAddress)),
                    vault: br.lpVault,
                    globalState: GLOBAL_STATE(),
                    burnRequest: reqPda,
                    userPendingReturns: pdas.pendingReturnsPda(payer, program.programId),
                    pythXmr: PYTH_XMR(),
                    pythCollateral: PYTH_QQQX(),
                    collateralMint: COLLATERAL_MINT(),
                    vaultCollateralAta: pdas.vaultCollateralAtaPda(br.lpVault, program.programId),
                    programCollateralAta: PROGRAM_COLLATERAL_ATA(),
                    tokenProgram: TOKEN_2022,
                    systemProgram: SystemProgram.programId,
                }).instruction();
            return makeReceipt(await signSendIxs([ix], { computeUnits: 400_000 }));
        }

        case 'sweepUnclaimedExpiredMint': {
            const reqPda = pdas.mintRequestPda(hexToBytes32(args[0]), program.programId);
            const mr = await program.account.mintRequest.fetch(reqPda);
            const ix = await program.methods.sweepUnclaimedExpiredMint()
                .accountsStrict({
                    caller: payer,
                    vault: mr.lpVault,
                    globalState: GLOBAL_STATE(),
                    mintRequest: reqPda,
                    initiatorReturns: pdas.pendingReturnsPda(toPubkey(b58(mr.initiator)), program.programId),
                    collateralMint: COLLATERAL_MINT(),
                    vaultCollateralAta: pdas.vaultCollateralAtaPda(mr.lpVault, program.programId),
                    programCollateralAta: PROGRAM_COLLATERAL_ATA(),
                    tokenProgram: TOKEN_2022,
                    systemProgram: SystemProgram.programId,
                }).instruction();
            return makeReceipt(await signSendIxs([ix]));
        }

        case 'reclaimParkedDeposit': {
            const reqPda = pdas.mintRequestPda(hexToBytes32(args[0]), program.programId);
            const mr = await program.account.mintRequest.fetch(reqPda);
            const ix = await program.methods.reclaimParkedDeposit()
                .accountsStrict({
                    caller: payer,
                    vault: mr.lpVault,
                    globalState: GLOBAL_STATE(),
                    mintRequest: reqPda,
                    initiatorReturns: pdas.pendingReturnsPda(toPubkey(b58(mr.initiator)), program.programId),
                    collateralMint: COLLATERAL_MINT(),
                    vaultCollateralAta: pdas.vaultCollateralAtaPda(mr.lpVault, program.programId),
                    programCollateralAta: PROGRAM_COLLATERAL_ATA(),
                    tokenProgram: TOKEN_2022,
                    systemProgram: SystemProgram.programId,
                }).instruction();
            return makeReceipt(await signSendIxs([ix]));
        }

        case 'withdrawReturns': {
            const token = args[0];
            const prPda = pdas.pendingReturnsPda(payer, program.programId);
            const isSol = !token || token === '0x0000000000000000000000000000000000000000';
            if (isSol) {
                const ix = await program.methods.withdrawSolReturns()
                    .accountsStrict({
                        owner: payer, pendingReturns: prPda,
                        globalState: GLOBAL_STATE(), solEscrow: SOL_ESCROW(),
                        systemProgram: SystemProgram.programId,
                    }).instruction();
                return makeReceipt(await signSendIxs([ix]));
            }
            const { ata: userCollAta, ixs: ataPre } = await ensureAtaIxs(COLLATERAL_MINT(), payer);
            const ix = await program.methods.withdrawCollateralReturns()
                .accountsStrict({
                    owner: payer,
                    pendingReturns: prPda,
                    globalState: GLOBAL_STATE(),
                    collateralMint: COLLATERAL_MINT(),
                    programCollateralAta: PROGRAM_COLLATERAL_ATA(),
                    userCollateralAta: userCollAta,
                    tokenProgram: TOKEN_2022,
                }).instruction();
            return makeReceipt(await signSendIxs([...ataPre, ix]));
        }

        case 'createVault': {
            const vaultPda = pdas.vaultPda(payer, program.programId);
            const ix = await program.methods.createVault()
                .accountsStrict({
                    lp: payer, vault: vaultPda,
                    globalState: GLOBAL_STATE(),
                    systemProgram: SystemProgram.programId,
                }).instruction();
            return makeReceipt(await signSendIxs([ix]));
        }

        case 'depositCollateral': {
            const vaultPda = pdas.vaultPda(payer, program.programId);
            const { ata: lpCollAta, ixs: ataPre } = await ensureAtaIxs(COLLATERAL_MINT(), payer);
            // UI passes 18-dec-scaled value → scale down to raw 9-dec
            const amt = BigInt(args[0].toString()) / (10n ** 9n);
            const ix = await program.methods.depositCollateral(new BN(amt.toString()))
                .accountsStrict({
                    lp: payer, vault: vaultPda, globalState: GLOBAL_STATE(),
                    collateralMint: COLLATERAL_MINT(),
                    lpCollateralAta: lpCollAta,
                    vaultCollateralAta: pdas.vaultCollateralAtaPda(vaultPda, program.programId),
                    tokenProgram: TOKEN_2022,
                    systemProgram: SystemProgram.programId,
                }).instruction();
            return makeReceipt(await signSendIxs([...ataPre, ix]));
        }

        case 'withdrawCollateral': {
            const vaultPda = pdas.vaultPda(payer, program.programId);
            const { ata: lpCollAta, ixs: ataPre } = await ensureAtaIxs(COLLATERAL_MINT(), payer);
            const amt = BigInt(args[0].toString()) / (10n ** 9n);
            const ix = await program.methods.withdrawCollateral(new BN(amt.toString()))
                .accountsStrict({
                    lp: payer, vault: vaultPda, globalState: GLOBAL_STATE(),
                    collateralMint: COLLATERAL_MINT(),
                    lpCollateralAta: lpCollAta,
                    vaultCollateralAta: pdas.vaultCollateralAtaPda(vaultPda, program.programId),
                    pythXmr: PYTH_XMR(), pythCollateral: PYTH_QQQX(),
                    tokenProgram: TOKEN_2022,
                    systemProgram: SystemProgram.programId,
                }).instruction();
            return makeReceipt(await signSendIxs([...ataPre, ix]));
        }

        case 'setVaultMarketMetrics':
        case 'setMintGriefingDeposit':
        case 'setMaxMintBps':
        case 'setMinBurnAmount':
        case 'setMaxCoLPRange': {
            const vaultPda = pdas.vaultPda(payer, program.programId);
            const mk = {
                setVaultMarketMetrics: () => program.methods.setVaultMarketMetrics(Number(args[0]), Number(args[1])),
                setMintGriefingDeposit: () => program.methods.setMintGriefingDeposit(new BN((BigInt(args[0].toString()) / (10n ** 9n)).toString())),
                setMaxMintBps: () => program.methods.setMaxMintBps(Number(args[0])),
                setMinBurnAmount: () => program.methods.setMinBurnAmount(new BN(args[0].toString())),
                setMaxCoLPRange: () => program.methods.setMaxCoLpRange(Number(args[0])),
            }[functionName]();
            const ix = await mk.accountsStrict({ lp: payer, vault: vaultPda }).instruction();
            return makeReceipt(await signSendIxs([ix]));
        }

        case 'deactivateVault': {
            const vaultPda = pdas.vaultPda(payer, program.programId);
            const ix = await program.methods.deactivateVault()
                .accountsStrict({ lp: payer, vault: vaultPda, globalState: GLOBAL_STATE() }).instruction();
            return makeReceipt(await signSendIxs([ix]));
        }

        case 'updateOraclePrices': {
            const oracleProgram = await loadOracleProgram();
            const ts = BigInt(Math.floor(Date.now() / 1000));
            const O = window.DEPLOYMENT.oracle;
            const ixs = [];
            for (const [feed, feedId] of [[PYTH_XMR(), O.xmrFeedId], [PYTH_QQQX(), O.qqqxFeedId]]) {
                // Preserve the current mock price — just bump publish_time.
                const info = await connection.getAccountInfo(feed);
                if (!info) throw new Error('oracle feed account missing');
                const priceRaw = info.data.readBigInt64LE(74);
                const blob = pythBlob(feedId, priceRaw, priceRaw, ts);
                ixs.push(await oracleProgram.methods.writeAccount(new BN(0), blob)
                    .accountsStrict({ target: feed, payer }).instruction());
            }
            return makeReceipt(await signSendIxs(ixs));
        }

        default:
            throw new Error(`writeHub: '${functionName}' not supported on Solana yet`);
    }
}

async function ensureAtaIxs(mint, owner) {
    const ata = splATA(owner, mint);
    const info = await connection.getAccountInfo(ata);
    if (info) return { ata, ixs: [] };
    return {
        ata,
        ixs: [{
            programId: ATA_PROGRAM,
            keys: [
                { pubkey: toPubkey(userAddress), isSigner: true, isWritable: true },
                { pubkey: ata, isSigner: false, isWritable: true },
                { pubkey: owner, isSigner: false, isWritable: false },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
            ],
            data: Buffer.alloc(0),
        }],
    };
}

let _oracleProgram = null;
async function loadOracleProgram() {
    if (_oracleProgram) return _oracleProgram;
    const res = await fetch('./oracle-idl.json?t=' + Date.now());
    const oracleIdl = await res.json();
    const provider = new AnchorProvider(connection, readOnlyWallet, { commitment: DEFAULT_COMMITMENT });
    _oracleProgram = new Program(oracleIdl, provider);
    return _oracleProgram;
}

// ── wsXMR token surface ─────────────────────────────────────────────────────

export async function readWsxmr(functionName, args = []) {
    if (!connection) await initializeClients();
    switch (functionName) {
        case 'balanceOf': return await getWsXmrBalance(args[0]);
        case 'totalSupply': return BigInt((await connection.getTokenSupply(WSXMR_MINT())).value.amount);
        case 'allowance': return 10n ** 30n; // owner signs directly — no allowances
        case 'decimals': return 8;
        case 'symbol': return 'wsXMR';
        case 'name': return 'Wrapped Monero (Solana)';
        default: throw new Error(`readWsxmr: '${functionName}' not mapped`);
    }
}

export async function writeWsxmr(functionName, args = [], value = 0n) {
    switch (functionName) {
        case 'approve': return makeReceipt('0x' + '0'.repeat(64)); // no-op on Solana
        case 'transfer': {
            const ix = spl.createTransferCheckedInstruction(
                splATA(toPubkey(userAddress)), WSXMR_MINT(), splATA(toPubkey(args[0])),
                toPubkey(userAddress), BigInt(args[1]), 8, [], TOKEN_2022);
            return makeReceipt(await signSendIxs([ix]));
        }
        default: throw new Error(`writeWsxmr: '${functionName}' not mapped`);
    }
}
export const writeWsxmrUnsafe = writeWsxmr;

export async function getWsXmrBalance(addr) {
    if (!connection) await initializeClients();
    try {
        const info = await connection.getAccountInfo(splATA(toPubkey(addr)));
        if (!info) return 0n;
        return Buffer.from(info.data).readBigUInt64LE(64);
    } catch (_) { return 0n; }
}

export async function getNativeBalance(addr) {
    if (!connection) await initializeClients();
    return BigInt(await connection.getBalance(toPubkey(addr)));
}
