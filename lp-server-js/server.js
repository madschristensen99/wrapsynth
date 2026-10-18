import 'dotenv/config';
import express from 'express';
import * as ethers from 'ethers';
import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createBurnHandler } from './burnHandler.js';
import * as moneroWallet from './moneroWallet.js';
import * as moneroCrypto from './moneroCrypto.js';
import { computeSecretHash } from './commitment.js';
import { createOracleUpdater } from './oracleUpdate.js';
import { createNonceManager, withTimeout } from './nonceManager.js';
import crypto from 'crypto';

// ─── Global Error Handlers ──────────────────────────────────────────────────
// Prevent process crash from uncaught async errors (e.g. RPC timeouts)
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message || err);
  if (err.stack) console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason?.message || reason);
  if (reason?.stack) console.error(reason.stack);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// CORS for frontend access
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// ─── RedStone oracle proxy ────────────────────────────────────────────────
// RedStone's public gateways are being sunset — the frontend must fetch
// signed data packages through an authenticated gateway, but API keys can't
// ship in browser JS. This route forwards /redstone/* to the gateway and
// attaches the server-side key. Point the frontend's dataServiceConfig.urls
// at http://localhost:<PORT>/redstone.
//
// Env:
//   REDSTONE_GATEWAY_URL — authenticated gateway base (required once keys are issued)
//   REDSTONE_API_KEY     — sent as x-api-key
//   Falls back to the public gateway when unset (works between rejection windows).
const REDSTONE_UPSTREAM = (process.env.REDSTONE_GATEWAY_URL || 'https://oracle-gateway-1.a.redstone.finance').replace(/\/+$/, '');
const redstoneCache = new Map(); // path -> { t, status, body }
const REDSTONE_CACHE_MS = 3000;
app.use('/redstone', async (req, res) => {
  try {
    const path = req.url; // e.g. /data-packages/latest/redstone-primary-prod
    const cached = redstoneCache.get(path);
    if (cached && Date.now() - cached.t < REDSTONE_CACHE_MS) {
      return res.status(cached.status).type('application/json').send(cached.body);
    }
    const headers = {};
    if (process.env.REDSTONE_API_KEY) headers['x-api-key'] = process.env.REDSTONE_API_KEY;
    const upstream = await fetch(REDSTONE_UPSTREAM + path, { headers });
    const body = await upstream.text();
    if (upstream.ok) redstoneCache.set(path, { t: Date.now(), status: upstream.status, body });
    res.status(upstream.status).type('application/json').send(body);
  } catch (e) {
    console.error('[redstone-proxy]', e.message);
    res.status(502).json({ error: 'redstone proxy failed', message: e.message });
  }
});

// ─── Multi-chain Config ────────────────────────────────────────────────────
// One LP service can monitor multiple independent wsXMR deployments. Chain
// contexts come from chains.json (lp-server-js/chains.json): each entry names a
// deployment manifest, its RPC env var, RedStone feeds, and log-scan settings.
// Backward compat: with no chains.json, fall back to ../deployment.json +
// RPC_URL/RPC_URLS env vars (the legacy single-chain mode).
//
// Shared across chains: the Monero wallet RPC (all wallet operations are
// serialized by moneroWallet's global wallet lock) and this express app.
// Per chain: provider, wallet binding, hub contract, nonce manager, oracle
// updater, ctx.pendingMints map, secrets file, event pollers.

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PORT = process.env.PORT || 3001;

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY env var is required');
  process.exit(1);
}

// Minimal ABI for the operations we need
const HUB_ABI = [
  // Mint events
  'event MintInitiated(bytes32 indexed requestId, address indexed initiator, address indexed recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout)',
  'event LPKeyProvided(bytes32 indexed requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey)',
  'event MintReady(bytes32 indexed requestId, bytes32 lpCommitment)',
  'event SecretRevealed(bytes32 indexed requestId, bytes32 secret)',
  'event MintFinalized(bytes32 indexed requestId, bytes32 secret)',
  'event MintCancelled(bytes32 indexed requestId)',
  'event MintKeyCancelled(bytes32 indexed requestId)',
  // Burn events
  'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral, bytes32 claimCommitment, bytes32 userPublicKey, bytes32 userViewKey)',
  'event HashProposed(bytes32 indexed requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey)',
  'event BurnCommitted(bytes32 indexed requestId, uint256 deadline)',
  'event BurnFinalized(bytes32 indexed requestId, bytes32 secret, uint256 rewardPaid)',
  'event BurnSecretRevealed(bytes32 indexed requestId, bytes32 secret)',
  'event BurnCancelled(bytes32 indexed requestId)',
  'event BurnAborted(bytes32 indexed requestId)',
  'event BurnProposalDeclined(bytes32 indexed requestId, bytes32 userSecret)',
  'event BurnSlashed(bytes32 indexed requestId, address indexed user, uint256 collateralSeized, bytes32 userSecret)',
  // Functions
  'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey, bytes32 lpCommitment) external',
  'function setMintReady(bytes32 requestId) external',
  'function revealSecret(bytes32 requestId, bytes32 secret) external',
  'function finalizeMint(bytes32 requestId) external',
  'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks, uint256 pendingMintCount))',
  'function proposeHash(bytes32 requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
  'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
  'function revealBurnSecret(bytes32 requestId, bytes32 secret) external',
  'function settleBurn(bytes32 requestId) external',
  'function claimSlashedCollateral(bytes32 requestId, bytes32 userSecret) external',
  'function resolveDeclinedProposal(bytes32 requestId, bytes32 userSecret) external',
  'function abandonProposedBurn(bytes32 requestId) external',
  'function getBurnRequest(bytes32 requestId) external view returns (tuple(bytes32 requestId, address user, address lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 lockedCollateral, uint256 rewardCollateral, bytes32 secretHash, uint256 deadline, uint256 vaultLiquidationNonce, uint256 normalizedDebtAmount, uint8 status, bytes32 userClaimCommitment, bytes32 userPublicKey, bytes32 userViewKey, uint256 xmrPriceAtRequest, bytes32 revealedSecret))',
  'function getMintRequest(bytes32 requestId) external view returns (tuple(bytes32 requestId, address initiator, address recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout, uint256 griefingDeposit, uint256 normalizedDebtAmount, uint256 vaultMintNonce, bytes32 lpCommitment, bytes32 revealedSecret, uint8 status))',
  'function lpPublicKeys(bytes32 requestId) external view returns (bytes32)',
  'function lpPublicViewKeys(bytes32 requestId) external view returns (bytes32)',
  'function updateOraclePrices(bytes[] calldata updateData) external payable',
  'function lastXmrPriceTimestamp() external view returns (uint256)',
  'function lastCollateralPriceTimestamp() external view returns (uint256)',
  'function cancelMint(bytes32 requestId, bytes32 userSecret) external',
  'function abandonKeyProvidedMint(bytes32 requestId, bytes32 lpSecret) external',
];

// ─── Chain registry ─────────────────────────────────────────────────────────
// chains.json entry shape:
//   {
//     "key": "bnb",                      // short label used in logs/files/API
//     "name": "BNB Chain",
//     "chainId": 56,
//     "manifest": "../frontend/deployment.bnb.json",   // path relative to lp-server-js/
//     "rpcEnv": "BNB_RPC_URLS",          // env var holding comma-separated RPCs
//     "rpcUrls": ["https://..."]          // fallback RPCs if env var unset
//     "redstoneFeeds": ["XMR"],          // feeds appended to updateOraclePrices
//     "logChunkSize": 900,               // eth_getLogs block-range cap
//     "secretsFile": "lp-secrets-bnb.json",       // optional override
//     "burnSecretsFile": "lp-burn-secrets-bnb.json"   // optional override
//   }
// Chains whose manifest file is missing are skipped (with a warning) so the
// config can list all targets ahead of their deployments.

function loadChainConfigs() {
  const cfgPath = path.join(__dirname, 'chains.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return cfg.chains || [];
  }
  // Legacy single-chain mode: root deployment.json + RPC_URL(S) env.
  const legacyManifest = path.join(__dirname, '..', 'deployment.json');
  if (fs.existsSync(legacyManifest)) {
    const d = JSON.parse(fs.readFileSync(legacyManifest, 'utf8'));
    return [{
      key: d.network ? d.network.toLowerCase().replace(/\s+/g, '-') : 'default',
      name: d.network || 'default',
      chainId: d.chainId,
      manifest: legacyManifest,
      rpcUrls: (process.env.RPC_URLS || process.env.RPC_URL || 'https://rpc.gnosischain.com')
        .split(',').map(u => u.trim()).filter(Boolean),
      redstoneFeeds: ['XMR', 'DAI'],
      logChunkSize: 900,
    }];
  }
  return [];
}

// Resolve a manifest's hub address — accepts curated {contracts:{...}} and
// raw flat forge-script output.
function manifestHubAddress(deployment) {
  return (deployment.contracts && deployment.contracts.wsXmrHub) || deployment.wsXmrHub;
}

/** Build the per-chain context: provider, wallet, hub, nonce mgr, oracle. */
function buildChainContext(chainCfg) {
  const manifestPath = path.isAbsolute(chainCfg.manifest)
    ? chainCfg.manifest
    : path.join(__dirname, chainCfg.manifest);
  const deployment = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const hubAddress = chainCfg.hubAddress || manifestHubAddress(deployment);
  const chainId = chainCfg.chainId || deployment.chainId;
  if (!hubAddress || !chainId) {
    throw new Error(`chain ${chainCfg.key}: manifest missing wsXmrHub or chainId`);
  }

  const rpcUrls = (chainCfg.rpcEnv && process.env[chainCfg.rpcEnv])
    ? process.env[chainCfg.rpcEnv].split(',').map(u => u.trim()).filter(Boolean)
    : (chainCfg.rpcUrls || []);
  if (rpcUrls.length === 0) {
    throw new Error(`chain ${chainCfg.key}: no RPC URLs (set ${chainCfg.rpcEnv || 'rpcUrls'})`);
  }

  // batchMaxCount: 1 disables JSON-RPC batching (each request sent individually).
  // NOTE: batchMaxCount: 0 would mean *unlimited* batching — every request in the
  // 10ms stall window gets bundled into one batch, and if the endpoint stalls on
  // the batch they all hang together. `timeout` is not a valid provider option.
  // Multiple RPCs configure a FallbackProvider so a single slow or rate-limiting
  // endpoint can't blind the poll loops — quorum 1 takes the first backend that
  // answers.
  const network = new ethers.Network(chainCfg.name || chainCfg.key, chainId);
  const rpcBackends = rpcUrls.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, network, { staticNetwork: true, batchMaxCount: 1 }),
    priority: i + 1,
    stallTimeout: 1500,
    weight: 1,
  }));
  const provider = rpcBackends.length === 1
    ? rpcBackends[0].provider
    : new ethers.FallbackProvider(rpcBackends, network, { quorum: 1 });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const hub = new ethers.Contract(hubAddress, HUB_ABI, wallet);

  const nonce = createNonceManager(provider, wallet.address);
  const ctx = {
    key: chainCfg.key,
    name: chainCfg.name || chainCfg.key,
    chainId,
    deployment,
    hubAddress,
    rpcUrls,
    logChunkSize: chainCfg.logChunkSize || 900,
    // Arbitrum Orbit chains: contracts see block.number == L1 block number while
    // eth_blockNumber returns the L2 number. On-chain deadlines live in the L1
    // domain — compare them via contractBlockNumber().
    usesL1BlockNumber: !!chainCfg.usesL1BlockNumber,
    provider,
    wallet,
    hub,
    nonce,
    pendingMints: new Map(),
    secretsFile: path.join(__dirname, chainCfg.secretsFile || `lp-secrets-${chainCfg.key}.json`),
    burnSecretsFile: path.join(__dirname, chainCfg.burnSecretsFile || `lp-burn-secrets-${chainCfg.key}.json`),
  };
  ctx.oracle = createOracleUpdater({
    hub, wallet, hubAddress, nonceMgr: nonce,
    dataFeeds: chainCfg.redstoneFeeds || ['XMR'],
    chainLabel: `${ctx.key}-oracle`,
  });
  ctx.burns = createBurnHandler(ctx);
  return ctx;
}

const chains = new Map(); // key -> chain context

/** Resolve which chain a manual HTTP call targets: body/query `chain` param,
 *  the only chain when one is running, or the chain tracking a requestId. */
function resolveCtx(req, reqIdHex = null) {
  const key = (req.body && req.body.chain) || req.query.chain;
  if (key && chains.has(key)) return chains.get(key);
  if (chains.size === 1) return chains.values().next().value;
  if (reqIdHex) {
    for (const c of chains.values()) {
      if (c.pendingMints.has(reqIdHex) || c.burns.pendingBurns.has(reqIdHex)) return c;
    }
  }
  return null;
}

/**
 * Block number in the domain the contracts see. On Arbitrum Orbit chains
 * (Robinhood), block.number inside contracts is the L1 block number while
 * eth_blockNumber returns the L2 number — read `l1BlockNumber` off the latest
 * L2 block for deadline comparisons. Event/log scanning stays on L2 numbers.
 */
async function contractBlockNumber(ctx) {
  if (!ctx.usesL1BlockNumber) return ctx.provider.getBlockNumber();
  const b = await ctx.provider.send('eth_getBlockByNumber', ['latest', false]);
  if (b && b.l1BlockNumber) return parseInt(b.l1BlockNumber, 16);
  return ctx.provider.getBlockNumber();
}

function loadJsonFile(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[Secrets] Could not load ${file}:`, err.message);
  }
  return {};
}

// ─── In-memory tracking (shared) ────────────────────────────────────────────
// pendingMints / pendingBurns live on each chain context — never shared.
let lpMoneroAddress = process.env.MONERO_LP_ADDRESS || null; // fetched from wallet at startup

// ─── Chunked event log scanning ─────────────────────────────────────────────
// Each chain's RPC caps eth_getLogs ranges differently — ctx.logChunkSize.
// Retries on rate-limit errors and paces chunks to stay under limits.
const LOG_CHUNK_DELAY_MS = 150;
async function queryFilterChunked(ctx, contract, filter, fromBlock, toBlock, opts = {}) {
  const { backwards = false, stopOnFirst = false } = opts;
  const chunkSize = ctx.logChunkSize || 900;
  const events = [];
  const bounds = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    bounds.push([start, Math.min(start + chunkSize - 1, toBlock)]);
  }
  if (backwards) bounds.reverse();
  for (const [start, end] of bounds) {
    let retries = 5;
    while (true) {
      try {
        events.push(...await contract.queryFilter(filter, start, end));
        break;
      } catch (err) {
        const rateLimited = err.message?.includes('rate limit')
          || err.code === 'UNKNOWN_ERROR' || err.code === 'BAD_DATA';
        if (!rateLimited || --retries === 0) throw err;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (stopOnFirst && events.length > 0) return events;
    await new Promise(r => setTimeout(r, LOG_CHUNK_DELAY_MS));
  }
  return events;
}

// ─── Secret persistence ─────────────────────────────────────────────────────
// lpSecret must hit disk IMMEDIATELY after generation — it is needed to sweep
// the deposit later, and a crash between provideLPKey and finalizeMint would
// otherwise lose it forever (this exact loss already happened once).
function persistMintSecret(ctx, reqIdHex, fields) {
  try {
    const secretsFile = ctx.secretsFile;
    let secrets = {};
    if (fs.existsSync(ctx.secretsFile)) {
      secrets = JSON.parse(fs.readFileSync(ctx.secretsFile, 'utf8'));
    }
    secrets[reqIdHex] = { ...(secrets[reqIdHex] || {}), ...fields };
    fs.writeFileSync(ctx.secretsFile, JSON.stringify(secrets, null, 2));
  } catch (err) {
    console.warn(`[Mint] Could not persist lpSecret for ${reqIdHex}:`, err.message);
  }
}

// ─── Mint sweep with view-key fallback ──────────────────────────────────────
// The deposit's private view key depends on which scheme keyed the mint:
//   new scheme (lpViewPub == lpSpendPub): view key = lpSecret
//   legacy + new frontend (view = lpViewPub): view key = MONERO_VIEW_KEY
//   legacy + old frontend (view = userPub):   view key = LE(userSecret)
// Try each candidate until one finds the deposit (balance > 0 or swept).
async function sweepMintWithViewKeyFallback(ctx, { reqIdHex, userSecretHex, lpSecretHex, lpMainAddress, restoreHeight = 0, depositHeight = 0, depositTxHash = null }) {
  // Resolve the deposit's Monero block height from its txid when it wasn't
  // persisted — the sweep scans depositHeight-10, and the daemon-1000 fallback
  // window can miss older deposits entirely.
  if (!depositHeight && depositTxHash) {
    try {
      depositHeight = await moneroWallet.getTxHeight(depositTxHash);
      if (depositHeight) {
        console.log(`[Sweep] Resolved deposit height ${depositHeight} from tx ${depositTxHash.slice(0, 16)}...`);
      }
    } catch (err) {
      console.warn(`[Sweep] Could not resolve deposit height for ${reqIdHex}:`, err.message);
    }
  }

  const candidates = [];
  try {
    const lpSpendPub = (await ctx.hub.lpPublicKeys(reqIdHex)).replace(/^0x/, '').toLowerCase();
    const lpViewPub = (await ctx.hub.lpPublicViewKeys(reqIdHex)).replace(/^0x/, '').toLowerCase();
    if (lpSpendPub === lpViewPub) {
      candidates.push({ key: lpSecretHex.replace(/^0x/, ''), label: 'lpSecret (new scheme)' });
    } else {
      if (process.env.MONERO_VIEW_KEY) {
        candidates.push({ key: process.env.MONERO_VIEW_KEY.replace(/^0x/, ''), label: 'MONERO_VIEW_KEY (legacy lpViewPub)' });
      }
      candidates.push({
        key: Buffer.from(userSecretHex.replace(/^0x/, ''), 'hex').reverse().toString('hex'),
        label: 'userSecret (legacy userPub)',
      });
    }
  } catch (err) {
    console.warn(`[Sweep] Could not read on-chain LP keys for ${reqIdHex}, trying all view-key candidates:`, err.message);
    candidates.push({ key: lpSecretHex.replace(/^0x/, ''), label: 'lpSecret' });
    if (process.env.MONERO_VIEW_KEY) {
      candidates.push({ key: process.env.MONERO_VIEW_KEY.replace(/^0x/, ''), label: 'MONERO_VIEW_KEY' });
    }
    candidates.push({
      key: Buffer.from(userSecretHex.replace(/^0x/, ''), 'hex').reverse().toString('hex'),
      label: 'userSecret',
    });
  }

  let lastResult = { swept: false, txHashes: [], amount: 0n };
  for (const cand of candidates) {
    console.log(`[Sweep] Trying view key: ${cand.label}`);
    const result = await moneroWallet.sweepMintDeposit({
      userSecretHex, lpSecretHex, lpMainAddress, restoreHeight, depositHeight,
      viewKeyLeHex: cand.key,
    });
    lastResult = result;
    if (result.swept || (result.balance && result.balance > 0n)) return result;
    console.log(`[Sweep] No deposit found with ${cand.label} — trying next candidate`);
  }
  return lastResult;
}

// Derive the Ed25519 public key (hex, no 0x) for a Monero private key whose
// bytes are the little-endian scalar encoding (same convention as lpSecret and
// MONERO_VIEW_KEY).
async function scalarHexToPubKeyHex(keyHex) {
  const ed = await import('@noble/ed25519');
  const { createHash } = await import('crypto');
  if (!ed.etc.sha512Sync) {
    ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
  }
  const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const le = Buffer.from(keyHex.replace(/^0x/, ''), 'hex').reverse();
  const s = BigInt('0x' + le.toString('hex')) % ED25519_L;
  return Buffer.from(ed.ExtendedPoint.BASE.multiply(s).toRawBytes()).toString('hex');
}

// ─── Mint Processing Mutex ──────────────────────────────────────────────────
// monero-wallet-rpc can only have one wallet open at a time, so mint processing
// (which creates/closes view-only deposit wallets) must be serialized.
let mintProcessingLock = Promise.resolve();
function serializeMint(fn) {
  const next = mintProcessingLock.then(fn, fn); // run even if previous rejected
  mintProcessingLock = next.catch(() => {});    // swallow errors to keep chain alive
  return next;
}

// ─── Ed25519 Key Generation ─────────────────────────────────────────────────
async function generateEd25519Keys() {
  const ed = await import('@noble/ed25519');
  const { createHash } = await import('crypto');
  
  // Set up SHA-512 sync for @noble/ed25519
  if (!ed.etc.sha512Sync) {
    ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
  }
  
  // Generate ONE secret that serves as the LP's PTLC secret, the LP's Monero
  // spend-key contribution, AND the deposit's private view key. Posting
  // lpPublicViewKey = lpSpendPub makes the deposit LP-viewable (view pub =
  // lpSecret·G), so the LP scans the chain for the deposit itself — no
  // user→LP messaging. When lpSecret is later revealed on-chain (claim/abandon
  // paths), the user gets both keys needed to sweep the deposit back.
  const lpSpendPriv = crypto.randomBytes(32);

  // Monero uses direct scalar multiplication (scalar * G), NOT ed.getPublicKey()
  // which uses SHA512-based Ed25519 key derivation.
  const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const G = ed.ExtendedPoint.BASE;

  function scalarToPubKey(scalarBytes) {
    // Monero stores scalars as little-endian
    const le = Buffer.from(scalarBytes).reverse();
    const s = BigInt('0x' + le.toString('hex')) % ED25519_L;
    const pub = G.multiply(s);
    return Buffer.from(pub.toRawBytes());
  }

  const spendPub = scalarToPubKey(lpSpendPriv);
  return {
    lpPublicSpendKey: '0x' + spendPub.toString('hex'),
    lpPublicViewKey: '0x' + spendPub.toString('hex'), // view pub = spend pub → private view key = lpSecret
    lpSpendPriv: '0x' + lpSpendPriv.toString('hex'),
  };
}

// ─── Commitment Binding Check ─────────────────────────────────────────────
// Verifies claimCommitment == keccak256(affine(decompress(userPublicKey))).
// The deposit address embeds userPublicKey, but revealSecret verifies against
// claimCommitment. If they bind different secrets, the revealed secret cannot
// complete the spend key — the LP would lock a bond for XMR it can never sweep.
async function verifyCommitmentBinding(claimCommitment, userPublicKey) {
  try {
    const ed = await import('@noble/ed25519');
    const { createHash } = await import('crypto');
    if (!ed.etc.sha512Sync) {
      ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
    }
    const point = ed.ExtendedPoint.fromHex(userPublicKey.replace(/^0x/, ''));
    const affine = point.toAffine();
    const computed = ethers.keccak256(ethers.solidityPacked(
      ['uint256', 'uint256'],
      [affine.x, affine.y]
    ));
    return computed.toLowerCase() === claimCommitment.toLowerCase();
  } catch (e) {
    console.warn(`[Mint] Commitment binding check could not compute: ${e.message}`);
    return false;
  }
}

// ─── Oracle Price Update: imported from oracleUpdate.js ────────────────────
// Initialize with hub and wallet instances
// ─── Core Mint Processing ───────────────────────────────────────────────────
async function processMint(ctx, reqIdHex, lpPublicSpendKey, lpPublicViewKey, lpSpendPriv) {
  console.log(`[Mint] Processing ${reqIdHex}`);

  const mint = ctx.pendingMints.get(reqIdHex) || {};

  // 0. Check on-chain status to handle restarts gracefully. Retry transient
  // RPC failures — proceeding with an unknown status risks a blind
  // provideLPKey call (reverts if keys are already posted).
  let onChainStatus = -1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const mintReq = await ctx.hub.getMintRequest(reqIdHex);
      onChainStatus = Number(mintReq.status);
      console.log(`[Chain] Mint ${reqIdHex} on-chain status: ${onChainStatus} (1=PENDING, 2=KEY_PROVIDED, 3=READY, 4=SECRET_REVEALED, 5=COMPLETED, 6=CANCELLED)`);
      break;
    } catch (err) {
      if (attempt < 3) {
        console.warn(`[Chain] Status read failed (attempt ${attempt}/3), retrying:`, err.message);
        await new Promise(r => setTimeout(r, 3000 * attempt));
      } else {
        console.warn(`[Chain] Could not query mint status after 3 attempts, proceeding anyway:`, err.message);
      }
    }
  }

  if (onChainStatus === 5 || onChainStatus === 6) {
    console.log(`[Mint] Mint already ${onChainStatus === 5 ? 'completed' : 'cancelled'}, skipping`);
    ctx.pendingMints.delete(reqIdHex);
    return;
  }

  // If keys already provided on-chain, use the existing keys instead of calling provideLPKey again
  if (onChainStatus >= 2) {
    try {
      const existingSpendKey = await ctx.hub.lpPublicKeys(reqIdHex);
      const existingViewKey = await ctx.hub.lpPublicViewKeys(reqIdHex);
      if (existingSpendKey !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
        console.log(`[Chain] LP keys already provided on-chain, skipping provideLPKey`);
        lpPublicSpendKey = existingSpendKey;
        lpPublicViewKey = existingViewKey;
      }
    } catch (err) {
      console.warn(`[Chain] Could not read existing LP keys, proceeding with provided keys:`, err.message);
    }
  }

  // Refuse to key a mint whose claimCommitment doesn't bind to userPublicKey —
  // the revealed secret would not complete the deposit spend key, so the XMR
  // could never be swept while wsXMR still mints against our vault.
  if (onChainStatus === 1) {
    try {
      const mintReq = await ctx.hub.getMintRequest(reqIdHex);
      const bound = await verifyCommitmentBinding(mintReq.claimCommitment, mintReq.userPublicKey);
      if (!bound) {
        console.error(`[Mint] ${reqIdHex}: claimCommitment does not match userPublicKey — refusing to key (deposit would be unspendable)`);
        mint.autoProcessError = 'commitment-pubkey mismatch';
        mint.processing = false;
        ctx.pendingMints.set(reqIdHex, mint);
        return;
      }
    } catch (err) {
      console.warn(`[Chain] Could not verify commitment binding, proceeding anyway:`, err.message);
    }
  }

  // 1. Compute LP secret and commitment (needed for provideLPKey)
  let lpSecret;
  if (lpSpendPriv) {
    lpSecret = Buffer.from(lpSpendPriv.replace(/^0x/, ''), 'hex');
  } else {
    // Recovery case: keys came from on-chain, check if lpSecret was already persisted
    try {
      const secretsFile = ctx.secretsFile;
      if (fs.existsSync(ctx.secretsFile)) {
        const secrets = JSON.parse(fs.readFileSync(ctx.secretsFile, 'utf8'));
        if (secrets[reqIdHex] && secrets[reqIdHex].lpSecret) {
          lpSecret = Buffer.from(secrets[reqIdHex].lpSecret.replace(/^0x/, ''), 'hex');
          console.log(`[Mint] Recovered lpSecret from persisted storage for ${reqIdHex}`);
        }
      }
    } catch (e) { /* ignore */ }
  }
  if (!lpSecret) {
    // Cannot recover — generate a new one (deposit address won't match if keys were already posted)
    lpSecret = crypto.randomBytes(32);
    console.warn(`[Mint] WARNING: Generated new lpSecret for ${reqIdHex} — if LP keys were already posted on-chain, sweep will fail!`);
  }
  const { secretHash: lpCommitment } = await computeSecretHash(lpSecret);
  mint.lpSecret = '0x' + lpSecret.toString('hex');
  mint.lpCommitment = lpCommitment;
  ctx.pendingMints.set(reqIdHex, mint);
  console.log(`[Mint] LP commitment for ${reqIdHex}: ${lpCommitment}`);

  // Persist IMMEDIATELY — the secret is needed to sweep the deposit and must
  // survive a crash anywhere in the rest of this flow.
  persistMintSecret(ctx, reqIdHex, {
    lpSecret: mint.lpSecret,
    lpCommitment,
    initiatedAtBlock: mint.initiatedAtBlock || 0,
    xmrAmount: mint.xmrAmount,
  });

  // 2. Provide LP key on-chain (skip if already provided)
  if (onChainStatus < 2) {
    // provideLPKey reads XMR + collateral prices from storage and reverts with
    // StalePrice if they're older than ~120s. Pipeline the oracle update and
    // provideLPKey with consecutive nonces: same-account txs execute in nonce
    // order, so provideLPKey always sees the fresh price no matter how slow
    // confirmation is — this avoids the StalePrice race that a confirmation
    // wait between the two txs would introduce.
    const oracleNonce = await ctx.nonce.getNextNonce();
    try {
      const otx = await ctx.oracle.broadcastOracleUpdate(oracleNonce);
      otx.wait()
        .then(r => console.log(`[Oracle] Update confirmed in block ${r.blockNumber}`))
        .catch(e => console.warn(`[Oracle] Update confirmation failed: ${e.shortMessage || e.message}`));
    } catch (priceErr) {
      console.warn(`[Chain] Oracle broadcast failed before provideLPKey: ${priceErr.message}`);
      // Oracle tx didn't broadcast — its reserved nonce went unused, so resync
      // to avoid leaving a gap that would stall the next transaction.
      ctx.nonce.resetNonceCache();
    }
    console.log(`[Chain] Calling provideLPKey(${reqIdHex})...`);
    const nonce = await ctx.nonce.getNextNonce(); // oracleNonce+1 if the update broadcast, else resynced
    // Explicit gasLimit skips estimateGas — estimation runs against the latest
    // (pre-oracle-update) block and would revert with StalePrice before the
    // pipelined oracle tx has a chance to mine. ~64k gas is actually used.
    const tx1 = await withTimeout(
      ctx.hub.provideLPKey(reqIdHex, lpPublicSpendKey, lpPublicViewKey, lpCommitment, { nonce, gasLimit: 500000n }),
      60000,
      'provideLPKey broadcast'
    );
    console.log(`[Chain] provideLPKey tx: ${tx1.hash}`);
    const receipt1 = await withTimeout(tx1.wait(), 120000, 'provideLPKey confirmation');
    console.log(`[Chain] provideLPKey confirmed in block ${receipt1.blockNumber}`);
  }

  mint.keyPostedAt = Date.now();
  mint.lpPublicSpendKey = lpPublicSpendKey;
  mint.lpPublicViewKey = lpPublicViewKey;
  ctx.pendingMints.set(reqIdHex, mint);

  // 3. Compute deposit address so the user knows where to send XMR
  const userPublicKey = mint.userPublicKey;
  const keysDiffer = lpPublicViewKey && lpPublicSpendKey &&
    lpPublicViewKey.toLowerCase() !== lpPublicSpendKey.toLowerCase();
  if (userPublicKey) {
    try {
      const depositAddress = await moneroCrypto.computeDepositAddress(userPublicKey, lpPublicSpendKey, lpPublicViewKey);
      mint.depositAddress = depositAddress;
      console.log(`[Mint] Deposit address for ${reqIdHex}: ${depositAddress}`);
      // Legacy mints (lpViewPub != lpSpendPub, keyed by the old server) may have
      // had the deposit sent to the OLD-scheme address (view = userPub) if the
      // user's frontend predates the LP-viewable change. Track it for reference.
      if (keysDiffer) {
        mint.legacyDepositAddress = await moneroCrypto.computeDepositAddress(userPublicKey, lpPublicSpendKey, userPublicKey);
        console.log(`[Mint] Legacy deposit address (view=userPub) for ${reqIdHex}: ${mint.legacyDepositAddress}`);
      }
    } catch (err) {
      console.warn(`[Mint] Could not compute deposit address:`, err.message);
    }
  }

  // 4. Wait for the XMR deposit. New-scheme deposits are LP-VIEWABLE (view pub =
  //    lpSpendPub, private view key = lpSecret) and scanned directly. Legacy
  //    mints posted lpPublicViewKey = the LP main wallet's view pub, so the
  //    deposit is scannable with MONERO_VIEW_KEY instead. If neither key fits
  //    (e.g. lost lpSecret), the deposit cannot be verified.
  let scanViewKey = null;
  const lpSecretMatchesChain = lpPublicSpendKey &&
    (await scalarHexToPubKeyHex(mint.lpSecret)) === lpPublicSpendKey.replace(/^0x/, '').toLowerCase();
  if (!lpSecretMatchesChain) {
    console.warn(`[Mint] lpSecret does NOT match on-chain lpSpendPub for ${reqIdHex} — deposit will be unsweepable (secret was lost before persistence)`);
  }
  if (!keysDiffer) {
    if (lpSecretMatchesChain) {
      scanViewKey = mint.lpSecret.replace(/^0x/, '');
    } else {
      console.warn(`[Mint] Cannot scan deposit — lpSecret doesn't derive on-chain lpSpendPub; deposit cannot be verified`);
    }
  } else if (process.env.MONERO_VIEW_KEY) {
    const mainViewPub = await scalarHexToPubKeyHex(process.env.MONERO_VIEW_KEY);
    if (mainViewPub === lpPublicViewKey.replace(/^0x/, '').toLowerCase()) {
      scanViewKey = process.env.MONERO_VIEW_KEY.replace(/^0x/, '');
      console.log(`[Mint] Legacy mint — scanning deposit address with MONERO_VIEW_KEY (view pub = lpPublicViewKey)`);
    } else {
      console.warn(`[Mint] Legacy mint — lpPublicViewKey is not our wallet view pub; cannot scan, deposit cannot be verified`);
    }
  }

  const expectedAmount = BigInt(mint.xmrAmount || '0');
  if (expectedAmount > 0n && moneroWallet.isWalletConfigured() && mint.depositAddress) {
    if (scanViewKey) {
      // Fetch current height before pollForDeposit closes the main wallet
      let scanHeight = 0;
      try {
        const height = await moneroWallet.getDaemonHeight();
        // How far back can the deposit be? The deposit address is only
        // public once provideLPKey lands. If this run is about to post the
        // keys itself (status 1 = PENDING), the deposit can't predate now —
        // 40 blocks (~80 min) is a generous shallow window that scans in
        // seconds. If keys were already posted at an unknown earlier time
        // (KEY_PROVIDED+, recovery/manual-scan path, or unknown status), keep
        // the deep window: deposits may be hours old. 1000 blocks ≈ 33h,
        // covering any mint inside its timeout. (initiatedAtBlock is an EVM
        // block number, NOT a Monero height — cannot be used here.)
        const lookback = onChainStatus === 1 ? 40 : 1000;
        scanHeight = Math.max(0, height - lookback);
        console.log(`[Mint] Current Monero height: ${height}, scanning from ${scanHeight}`);
      } catch (err) {
        console.warn(`[Mint] Could not get daemon height, scanning from 0:`, err.message);
      }
      console.log(`[Mint] Scanning for XMR deposit of ${expectedAmount} atomic units...`);
      try {
        const depositTx = await moneroWallet.pollForDeposit(expectedAmount, {
          depositAddress: mint.depositAddress,
          viewKeyHex: scanViewKey,
          restoreHeight: scanHeight,
          toleranceBps: 300,   // 3% tolerance for fees / rounding
          intervalMs: 15000,   // 15s
          maxWaitMs: 2 * 60 * 60 * 1000, // 2 hours — deposit scan window
        });
        mint.depositTx = depositTx;
        ctx.pendingMints.set(reqIdHex, mint);
        console.log(`[Mint] Deposit verified: ${depositTx.txid} (received=${depositTx.amount})`);
      } catch (waitErr) {
        console.error(`[Mint] Deposit wait failed for ${reqIdHex}:`, waitErr.message);
        mint.autoProcessError = waitErr.message;
        ctx.pendingMints.set(reqIdHex, mint);
        return; // Do NOT call setMintReady if deposit was not verified
      }
    } else {
      console.warn(`[Mint] Cannot scan deposit for ${reqIdHex} — no view key matches on-chain keys; skipping deposit verification`);
    }
  } else if (expectedAmount > 0n) {
    console.warn(`[Mint] MONERO_WALLET_RPC_URL not configured or no deposit address — skipping deposit verification`);
  }

  // 5-7. Oracle update, persist lpSecret, setMintReady
  await finalizeMint(ctx, reqIdHex, mint, lpCommitment);
}

// ─── Finalize a verified mint ───────────────────────────────────────────────
// Runs the oracle update, persists lpSecret, and calls setMintReady. Invoked by
// processMint after the deposit scan succeeds. Guarded against double-invocation.
async function finalizeMint(ctx, reqIdHex, mint, lpCommitment) {
  if (mint.finalizeStarted) {
    console.log(`[Mint] finalizeMint already in progress for ${reqIdHex}, skipping`);
    return;
  }
  mint.finalizeStarted = true;
  ctx.pendingMints.set(reqIdHex, mint);

  // 5. Update oracle prices before setMintReady (contract requires fresh price for collateral check)
  try {
    await ctx.oracle.updateOraclePricesManual();
  } catch (priceErr) {
    console.warn(`[Chain] Oracle price update failed: ${priceErr.message}`);
    console.warn(`[Chain] Proceeding with setMintReady anyway (may revert with StalePrice)...`);
  }

  // 6. Update persisted lpSecret with deposit info (secret itself was already
  //    persisted right after generation in processMint).
  persistMintSecret(ctx, reqIdHex, {
    lpSecret: mint.lpSecret,
    lpCommitment: lpCommitment,
    initiatedAtBlock: mint.initiatedAtBlock || 0,
    xmrAmount: mint.xmrAmount,
    depositTxHash: mint.depositTx ? mint.depositTx.txid : undefined,
    depositHeight: mint.depositTx ? mint.depositTx.height : undefined,
  });

  // 7. Call setMintReady (non-payable — bond is tracked in vault config, not sent as ETH)
  const mintNonce = await ctx.nonce.getNextNonce();
  console.log(`[Chain] Calling setMintReady(${reqIdHex})... nonce: ${mintNonce}`);
  let tx2;
  try {
    tx2 = await ctx.hub.setMintReady(reqIdHex, { gasLimit: 500000n, nonce: mintNonce });
  } catch (gasErr) {
    console.warn(`[Chain] setMintReady with manual gas failed: ${gasErr.message}`);
    const retryNonce = await ctx.nonce.getNextNonce();
    tx2 = await ctx.hub.setMintReady(reqIdHex, { nonce: retryNonce });
  }
  console.log(`[Chain] setMintReady tx: ${tx2.hash}`);
  const receipt2 = await tx2.wait();
  console.log(`[Chain] setMintReady confirmed in block ${receipt2.blockNumber}`);
}

// ─── Mint Auto-Process Retry ────────────────────────────────────────────────
// A transient failure (RPC timeout, wallet busy) must not permanently stall a
// mint — the event poller only scans new blocks, so a failed MintInitiated is
// never re-seen. Retry while the mint is still PENDING/KEY_PROVIDED on-chain.
const MINT_RETRY_MS = 60000;
const MINT_RETRY_MAX = 50; // ~50 min ≈ mint timeout window

async function retryProcessMint(ctx, reqIdHex) {
  const mintReq = await ctx.hub.getMintRequest(reqIdHex);
  const status = Number(mintReq.status);
  if (status === 2) {
    // KEY_PROVIDED — must reuse the on-chain keys (new keys would mismatch)
    const lpSpendKey = await ctx.hub.lpPublicKeys(reqIdHex);
    const lpViewKey = await ctx.hub.lpPublicViewKeys(reqIdHex);
    await processMint(ctx, reqIdHex, lpSpendKey, lpViewKey);
  } else if (status === 1) {
    // PENDING — keys never posted, safe to generate fresh ones
    const keys = await generateEd25519Keys();
    await processMint(ctx, reqIdHex, keys.lpPublicSpendKey, keys.lpPublicViewKey, keys.lpSpendPriv);
  }
  // Any other status (READY/COMPLETED/CANCELLED/…) — nothing to retry
}

function scheduleMintProcessRetry(ctx, reqIdHex, attempt = 1) {
  setTimeout(async () => {
    const mint = ctx.pendingMints.get(reqIdHex);
    if (!mint || mint.processing || mint.keyPostedAt) return;
    try {
      console.log(`[Mint] Retrying auto-process for ${reqIdHex} (attempt ${attempt}/${MINT_RETRY_MAX})...`);
      mint.processing = true;
      ctx.pendingMints.set(reqIdHex, mint);
      await retryProcessMint(ctx, reqIdHex);
    } catch (err) {
      console.error(`[Mint] Retry ${attempt} failed for ${reqIdHex}:`, err.message || err);
      const m = ctx.pendingMints.get(reqIdHex) || {};
      m.autoProcessError = err.message || String(err);
      m.processing = false;
      ctx.pendingMints.set(reqIdHex, m);
      if (!m.keyPostedAt && attempt < MINT_RETRY_MAX) {
        scheduleMintProcessRetry(ctx, reqIdHex, attempt + 1);
      } else if (attempt >= MINT_RETRY_MAX) {
        console.error(`[Mint] Gave up auto-processing ${reqIdHex} after ${MINT_RETRY_MAX} attempts`);
      }
    }
  }, MINT_RETRY_MS);
}

// ─── Startup Recovery: Find active mints that need setMintReady ─────────────
async function startupRecoverMints(ctx) {
  console.log(`[${ctx.key}][Recovery] Scanning for active mints needing setMintReady...`);
  // Secrets are consulted below for KEY_CANCELLED claim-window sweeps and
  // finalized-mint XMR sweeps — load them up front (previously referenced
  // without loading, silently breaking those recovery paths).
  const secrets = loadJsonFile(ctx.secretsFile);
  const currentBlock = await ctx.provider.getBlockNumber();       // L2 domain — event scan ranges
  const contractBlock = await contractBlockNumber(ctx);          // contract domain — deadline compares
  // Scan last ~10000 blocks (~3.5 days on Gnosis at 5s blocks)
  // Use 9999 to stay within RPC's 10000-block max range
  const fromBlock = Math.max(ctx.deployment.deployedAtBlock || 0, currentBlock - 9999);

  let events;
  try {
    const filter = ctx.hub.filters.MintInitiated();
    events = await queryFilterChunked(ctx, ctx.hub, filter, fromBlock, currentBlock);
  } catch (err) {
    console.warn('[Recovery] Could not query MintInitiated events:', err.message);
    return;
  }

  // Filter to mints for our vault
  const ourMints = events.filter(
    e => e.args.lpVault.toLowerCase() === ctx.wallet.address.toLowerCase()
  );

  if (ourMints.length === 0) {
    console.log('[Recovery] No mints found for this vault in recent blocks');
    return;
  }

  console.log(`[Recovery] Found ${ourMints.length} mint(s) for this vault, checking status...`);

  for (const event of ourMints) {
    const reqIdHex = ethers.hexlify(event.args.requestId);

    try {
      const mintReq = await ctx.hub.getMintRequest(reqIdHex);
      const status = Number(mintReq.status);

      if (status === 5 || status === 6) {
        continue; // completed or cancelled
      }

      if (status === 8) {
        // KEY_CANCELLED — deposit parked. If still inside the LP claim window,
        // claim it via abandonKeyProvidedMint (publishes lpSecret for user sweep).
        const timeout = Number(mintReq.timeout);
        const entry = secrets[reqIdHex];
        if (contractBlock < timeout && entry && entry.lpSecret) {
          console.log(`[Recovery] Mint ${reqIdHex} is KEY_CANCELLED within claim window, claiming parked deposit...`);
          try {
            const abandonNonce = await ctx.nonce.getNextNonce();
            const tx = await ctx.hub.abandonKeyProvidedMint(reqIdHex, entry.lpSecret, { nonce: abandonNonce });
            await tx.wait();
            console.log(`[Recovery] Mint ${reqIdHex} parked deposit claimed (tx: ${tx.hash})`);
          } catch (err) {
            console.warn(`[Recovery] abandonKeyProvidedMint failed for ${reqIdHex}:`, err.shortMessage || err.message);
          }
        } else {
          console.log(`[Recovery] Mint ${reqIdHex} is KEY_CANCELLED — claim window expired or no lpSecret; user may reclaimParkedDeposit`);
        }
        continue;
      }

      if (status === 3) {
        // READY — mint is waiting for user to reveal secret. If timeout passed, cancel it.
        const timeout = Number(mintReq.timeout);
        const currentBlock = await contractBlockNumber(ctx);
        if (currentBlock >= timeout) {
          console.log(`[Recovery] Mint ${reqIdHex} is READY but timed out (timeout=${timeout}, current=${currentBlock}), cancelling...`);
          try {
            const cancelNonce = await ctx.nonce.getNextNonce();
            const tx = await ctx.hub.cancelMint(reqIdHex, '0x0000000000000000000000000000000000000000000000000000000000000000', { nonce: cancelNonce });
            await tx.wait();
            console.log(`[Recovery] Mint ${reqIdHex} cancelled (tx: ${tx.hash})`);
          } catch (err) {
            console.warn(`[Recovery] Failed to cancel timed-out READY mint ${reqIdHex}:`, err.shortMessage || err.message);
          }
        } else {
          console.log(`[Recovery] Mint ${reqIdHex} is READY, waiting for user to reveal secret (timeout=${timeout}, current=${currentBlock})`);
        }
        continue;
      }

      if (status === 2) {
        // KEY_PROVIDED — if the mint timed out, abandon it: claim the parked
        // griefing deposit and publish lpSecret on-chain so the user can sweep
        // their XMR back. Otherwise re-process (deposit may have arrived).
        const timeout = Number(mintReq.timeout);
        if (contractBlock >= timeout) {
          const entry = secrets[reqIdHex];
          if (entry && entry.lpSecret) {
            console.log(`[Recovery] Mint ${reqIdHex} timed out at KEY_PROVIDED, abandoning (claim parked deposit + publish lpSecret)...`);
            try {
              const abandonNonce = await ctx.nonce.getNextNonce();
              const tx = await ctx.hub.abandonKeyProvidedMint(reqIdHex, entry.lpSecret, { nonce: abandonNonce });
              await tx.wait();
              console.log(`[Recovery] Mint ${reqIdHex} abandoned — deposit claimed, lpSecret published (tx: ${tx.hash})`);
            } catch (err) {
              console.warn(`[Recovery] abandonKeyProvidedMint failed for ${reqIdHex}:`, err.shortMessage || err.message);
            }
          } else {
            console.warn(`[Recovery] Mint ${reqIdHex} timed out at KEY_PROVIDED but no lpSecret persisted — cannot abandon`);
          }
          continue;
        }

        console.log(`[Recovery] Mint ${reqIdHex} is KEY_PROVIDED, attempting setMintReady...`);

        const lpSpendKey = await ctx.hub.lpPublicKeys(reqIdHex);
        const lpViewKey = await ctx.hub.lpPublicViewKeys(reqIdHex);

        ctx.pendingMints.set(reqIdHex, {
          requestId: reqIdHex,
          initiator: mintReq.initiator,
          recipient: mintReq.recipient,
          xmrAmount: mintReq.xmrAmount.toString(),
          userPublicKey: ethers.hexlify(mintReq.userPublicKey),
          timeoutBlock: Number(mintReq.timeout),
          lpPublicSpendKey: lpSpendKey,
          lpPublicViewKey: lpViewKey,
          keyPostedAt: Date.now(),
          initiatedAtBlock: event.blockNumber || 0,
          processing: true,
        });

        (async () => {
          try {
            await processMint(ctx, reqIdHex, lpSpendKey, lpViewKey);
          } catch (err) {
            console.error(`[Recovery] Failed to process mint ${reqIdHex}:`, err.message || err);
            const m = ctx.pendingMints.get(reqIdHex) || {};
            m.autoProcessError = err.message || String(err);
            m.processing = false;
            ctx.pendingMints.set(reqIdHex, m);
            scheduleMintProcessRetry(ctx, reqIdHex);
          }
        })();
      } else if (status === 1) {
        // PENDING — LP keys not yet provided
        console.log(`[Recovery] Mint ${reqIdHex} is PENDING (keys not provided), auto-processing...`);

        ctx.pendingMints.set(reqIdHex, {
          requestId: reqIdHex,
          initiator: mintReq.initiator,
          recipient: mintReq.recipient,
          xmrAmount: mintReq.xmrAmount.toString(),
          userPublicKey: ethers.hexlify(mintReq.userPublicKey),
          timeoutBlock: Number(mintReq.timeout),
          initiatedAt: Date.now(),
          initiatedAtBlock: event.blockNumber || 0,
          processing: true,
        });

        (async () => {
          try {
            const keys = await generateEd25519Keys();
            console.log(`[Recovery] Generated Ed25519 keys for ${reqIdHex}`);
            await processMint(ctx, reqIdHex, keys.lpPublicSpendKey, keys.lpPublicViewKey, keys.lpSpendPriv);
          } catch (err) {
            console.error(`[Recovery] Failed to process mint ${reqIdHex}:`, err.message || err);
            const m = ctx.pendingMints.get(reqIdHex) || {};
            m.autoProcessError = err.message || String(err);
            m.processing = false;
            ctx.pendingMints.set(reqIdHex, m);
            scheduleMintProcessRetry(ctx, reqIdHex);
          }
        })();
      }
    } catch (err) {
      console.warn(`[Recovery] Could not check mint ${reqIdHex}:`, err.message);
    }
  }
}

// ─── Startup Sweep: Collect XMR from finalized mints ───────────────────────
async function startupSweepFinalizedMints(ctx) {
  const secretsFile = ctx.secretsFile;
  if (!fs.existsSync(ctx.secretsFile)) {
    console.log('[Sweep] No persisted lpSecrets found — skipping startup sweep');
    return;
  }

  let secrets;
  try {
    secrets = JSON.parse(fs.readFileSync(ctx.secretsFile, 'utf8'));
  } catch (err) {
    console.warn('[Sweep] Could not parse lp-secrets.json:', err.message);
    return;
  }

  const reqIds = Object.keys(secrets);
  if (reqIds.length === 0) {
    console.log('[Sweep] No persisted secrets — skipping startup sweep');
    return;
  }

  console.log(`[Sweep] Checking ${reqIds.length} persisted mint(s) for sweeping...`);

  if (!lpMoneroAddress) {
    console.warn('[Sweep] LP Monero address not available — cannot sweep');
    return;
  }

  for (const reqIdHex of reqIds) {
    const entry = secrets[reqIdHex];
    if (entry.swept) {
      console.log(`[Sweep] ${reqIdHex} already swept — skipping`);
      continue;
    }
    if (entry.unrecoverable) {
      console.log(`[Sweep] ${reqIdHex} marked unrecoverable (lpSecret doesn't match on-chain keys) — skipping`);
      continue;
    }

    try {
      // Check on-chain status
      const mintReq = await ctx.hub.getMintRequest(reqIdHex);
      const status = Number(mintReq.status);

      if (status === 6) {
        // Cancelled — no XMR to sweep
        console.log(`[Sweep] ${reqIdHex} was cancelled — marking swept (nothing to collect)`);
        entry.swept = true;
        continue;
      }

      if (status !== 5) {
        // Not yet finalized — skip
        console.log(`[Sweep] ${reqIdHex} status=${status} (not finalized) — skipping`);
        continue;
      }

      // Status is COMPLETED — need to find the SecretRevealed event to get user's secret
      console.log(`[Sweep] ${reqIdHex} is COMPLETED — looking for SecretRevealed event...`);
      if (entry.depositTxHash) {
        console.log(`[Sweep]   deposit tx: ${entry.depositTxHash}, height: ${entry.depositHeight || 'N/A'}`);
      }

      // Prefer getMintRequest().revealedSecret — a plain eth_call, immune to
      // eth_getLogs rate/archive limits that plague the event scans.
      let userSecret;
      try {
        const req = await ctx.hub.getMintRequest(reqIdHex);
        if (req.revealedSecret && req.revealedSecret !== ethers.ZeroHash) {
          userSecret = req.revealedSecret;
          console.log(`[Sweep] Got user secret from mint request (no event scan needed)`);
        }
      } catch (e) {
        console.warn(`[Sweep] getMintRequest failed, falling back to event scan:`, e.message);
      }

      // Backwards scans below resolve a just-finalized mint in the newest
      // chunk, inside free RPCs' non-archive window, instead of 403ing on a
      // full-range scan.
      const currentBlock = await ctx.provider.getBlockNumber();
      const fromBlock = Math.max(ctx.deployment.deployedAtBlock || 0, currentBlock - 100000);

      if (!userSecret) {
        const filter = ctx.hub.filters.SecretRevealed(reqIdHex);
        const events = await queryFilterChunked(ctx, ctx.hub, filter, fromBlock, currentBlock, { backwards: true, stopOnFirst: true });

        if (events.length > 0) {
          userSecret = ethers.hexlify(events[0].args.secret);
        }
      }

      if (!userSecret) {
        // Fall back to MintFinalized event (same secret, emitted at finalization)
        const finalizeFilter = ctx.hub.filters.MintFinalized(reqIdHex);
        const finalizeEvents = await queryFilterChunked(ctx, ctx.hub, finalizeFilter, fromBlock, currentBlock, { backwards: true, stopOnFirst: true });
        if (finalizeEvents.length === 0) {
          console.warn(`[Sweep] Could not find SecretRevealed or MintFinalized event for ${reqIdHex} — skipping`);
          continue;
        }
        userSecret = ethers.hexlify(finalizeEvents[0].args.secret);
      }

      // If the persisted lpSecret doesn't derive the on-chain lpSpendPub, the
      // deposit's spend key can never be reconstructed (original secret was
      // lost before persistence) — mark unrecoverable instead of rescanning
      // 1000 blocks on every poll forever.
      try {
        const onChainSpendPub = (await ctx.hub.lpPublicKeys(reqIdHex)).replace(/^0x/, '').toLowerCase();
        const derivedPub = await scalarHexToPubKeyHex(entry.lpSecret);
        if (derivedPub !== onChainSpendPub) {
          console.warn(`[Sweep] ${reqIdHex}: persisted lpSecret does NOT match on-chain lpSpendPub — deposit is unrecoverable, marking and skipping`);
          entry.unrecoverable = true;
          continue;
        }
      } catch (keyErr) {
        console.warn(`[Sweep] Could not verify lpSecret against chain for ${reqIdHex} (proceeding):`, keyErr.message);
      }

      console.log(`[Sweep] Found secret for ${reqIdHex}, sweeping XMR...`);

      const result = await sweepMintWithViewKeyFallback(ctx, {
        reqIdHex,
        userSecretHex: userSecret,
        lpSecretHex: entry.lpSecret,
        lpMainAddress: lpMoneroAddress,
        restoreHeight: entry.initiatedAtBlock || 0,
        depositHeight: entry.depositHeight || 0,
        depositTxHash: entry.depositTxHash,
      });

      if (result.swept) {
        entry.swept = true;
        entry.sweepTxHashes = result.txHashes;
        entry.sweepAmount = result.amount.toString();
        console.log(`[Sweep] Successfully swept ${result.amount} atomic units for ${reqIdHex}`);
      } else {
        console.log(`[Sweep] Not yet sweepable for ${reqIdHex} — see Monero log for details. Will retry on next poll.`);
        // Load into ctx.pendingMints so the event poller can retry
        ctx.pendingMints.set(reqIdHex, {
          requestId: reqIdHex,
          lpSecret: entry.lpSecret,
          initiatedAtBlock: entry.initiatedAtBlock || 0,
          depositHeight: entry.depositHeight || 0,
          sweepAttempted: false,
          processing: false,
        });
      }
    } catch (err) {
      console.error(`[Sweep] Failed for ${reqIdHex}:`, err.message || err);
      // Load into ctx.pendingMints for retry by event poller
      ctx.pendingMints.set(reqIdHex, {
        requestId: reqIdHex,
        lpSecret: entry.lpSecret,
        initiatedAtBlock: entry.initiatedAtBlock || 0,
        depositHeight: entry.depositHeight || 0,
        sweepAttempted: false,
        processing: false,
      });
    }
  }

  // Persist updated state
  try {
    fs.writeFileSync(ctx.secretsFile, JSON.stringify(secrets, null, 2));
  } catch (err) {
    console.warn('[Sweep] Could not save updated lp-secrets.json:', err.message);
  }
}

// ─── Startup Resolution: Cancel stale mints & resolve stale burns ───────────
async function startupResolveStale(ctx) {
  const currentBlock = await ctx.provider.getBlockNumber();        // L2 domain — event scan ranges
  const contractBlock = await contractBlockNumber(ctx);           // contract domain — deadline compares
  const fromBlock = Math.max(ctx.deployment.deployedAtBlock || 0, currentBlock - 9999);
  console.log('[Resolve] Checking for stale mints and burns...');

  // ── Stale Mints: cancel if timeout passed ──
  let mintEvents;
  try {
    mintEvents = await queryFilterChunked(ctx, ctx.hub, ctx.hub.filters.MintInitiated(), fromBlock, currentBlock);
  } catch (err) {
    console.warn('[Resolve] Could not query MintInitiated events:', err.message);
    mintEvents = [];
  }

  const ourMints = mintEvents.filter(
    e => e.args.lpVault.toLowerCase() === ctx.wallet.address.toLowerCase()
  );

  for (const event of ourMints) {
    const reqIdHex = ethers.hexlify(event.args.requestId);
    try {
      const mintReq = await ctx.hub.getMintRequest(reqIdHex);
      const status = Number(mintReq.status);
      const timeout = Number(mintReq.timeout);

      // Status 1=PENDING, 2=KEY_PROVIDED, 3=READY — cancel if timeout passed
      if ((status === 1 || status === 2 || status === 3) && contractBlock >= timeout) {
        console.log(`[Resolve] Mint ${reqIdHex} is stale (status=${status}, timeout=${timeout}, current=${currentBlock}), cancelling...`);
        try {
          const cancelNonce = await ctx.nonce.getNextNonce();
          const tx = await ctx.hub.cancelMint(reqIdHex, '0x0000000000000000000000000000000000000000000000000000000000000000', { nonce: cancelNonce });
          await tx.wait();
          console.log(`[Resolve] Mint ${reqIdHex} cancelled (tx: ${tx.hash})`);
        } catch (err) {
          console.warn(`[Resolve] Failed to cancel mint ${reqIdHex}:`, err.shortMessage || err.message);
        }
      }
    } catch (err) {
      console.warn(`[Resolve] Could not check mint ${reqIdHex}:`, err.message);
    }
  }

  // ── Stale Burns: log and wait for user to resolve ──
  // The LP cannot call resolveDeclinedProposal anymore because it requires the
  // user's private spend key (userSecret) which only the user knows.
  // Instead, we just log stale burns and wait for the user to resolve.
  // When the user resolves, BurnProposalDeclined is emitted and the LP's
  // burnHandler will sweep the shared XMR.
  let burnEvents;
  try {
    burnEvents = await queryFilterChunked(ctx, ctx.hub, ctx.hub.filters.BurnRequested(), fromBlock, currentBlock);
  } catch (err) {
    console.warn('[Resolve] Could not query BurnRequested events:', err.message);
    burnEvents = [];
  }

  const ourBurns = burnEvents.filter(
    e => e.args.lpVault.toLowerCase() === ctx.wallet.address.toLowerCase()
  );

  for (const event of ourBurns) {
    const reqIdHex = ethers.hexlify(event.args.requestId);
    try {
      const burnReq = await ctx.hub.getBurnRequest(reqIdHex);
      const state = Number(burnReq.status);
      const deadline = Number(burnReq.deadline);

      // State 2=PROPOSED — abandon post-deadline to release locked collateral.
      // The user can still late-claim wsXMR via resolveDeclinedProposal (which
      // reveals userSecret → lets us sweep the shared XMR).
      if (state === 2 && contractBlock >= deadline) {
        console.log(`[Resolve] Burn ${reqIdHex} is stale (PROPOSED, deadline=${deadline}, current=${currentBlock}) — abandoning to release collateral...`);
        try {
          const abandonNonce = await ctx.nonce.getNextNonce();
          const tx = await ctx.hub.abandonProposedBurn(reqIdHex, { nonce: abandonNonce });
          console.log(`[Resolve] abandonProposedBurn tx: ${tx.hash}`);
          await tx.wait();
          console.log(`[Resolve] Burn ${reqIdHex} abandoned — collateral released`);
        } catch (err) {
          console.warn(`[Resolve] abandonProposedBurn failed for ${reqIdHex}:`, err.shortMessage || err.message);
        }
      }
    } catch (err) {
      console.warn(`[Resolve] Could not check burn ${reqIdHex}:`, err.message);
    }
  }

  console.log('[Resolve] Stale check complete');
}

// ─── On-chain Event Listener ────────────────────────────────────────────────
async function startEventListener(ctx) {
  let lastCheckedBlock;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      lastCheckedBlock = await ctx.provider.getBlockNumber();
      break;
    } catch (err) {
      console.error(`[Event] Failed to get block number (attempt ${attempt}/5):`, err.message);
      if (attempt === 5) throw err;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log(`Listening for MintInitiated from block ${lastCheckedBlock}`);

  // Poll every 15 seconds using getLogs instead of ctx.hub.on() to avoid filter issues
  setInterval(async () => {
    try {
      const currentBlock = await ctx.provider.getBlockNumber();
      if (currentBlock <= lastCheckedBlock) return;
      const fromBlock = lastCheckedBlock + 1;
      if (fromBlock > currentBlock) return;

      // Retry on rate limit
      let retries = 3;
      let events = [];
      while (retries > 0) {
        try {
          const filter = ctx.hub.filters.MintInitiated();
          events = await queryFilterChunked(ctx, ctx.hub, filter, fromBlock, currentBlock);
          break;
        } catch (err) {
          if (err.message?.includes('rate limit') || err.code === 'UNKNOWN_ERROR') {
            retries--;
            if (retries === 0) throw err;
            console.log('[Event] Rate limited, waiting 5s before retry...');
            await new Promise(r => setTimeout(r, 5000));
          } else {
            throw err;
          }
        }
      }

      for (const event of events) {
        const { requestId, initiator, recipient, lpVault, xmrAmount, wsxmrAmount, feeAmount, claimCommitment, userPublicKey, timeout } = event.args;
        const reqIdHex = ethers.hexlify(requestId);
        if (lpVault.toLowerCase() !== ctx.wallet.address.toLowerCase()) {
          continue;
        }

        // Skip if already processing or already processed
        const existing = ctx.pendingMints.get(reqIdHex);
        if (existing && (existing.processing || existing.keyPostedAt)) {
          continue;
        }

        console.log(`[Event] MintInitiated ${reqIdHex}`);
        console.log(`  Initiator: ${initiator}`);
        console.log(`  xmrAmount: ${xmrAmount.toString()}`);
        ctx.pendingMints.set(reqIdHex, {
          requestId: reqIdHex,
          initiator,
          recipient,
          xmrAmount: xmrAmount.toString(),
          timeoutBlock: Number(timeout),
          userPublicKey: ethers.hexlify(userPublicKey),
          claimCommitment: ethers.hexlify(claimCommitment),
          initiatedAt: Date.now(),
          initiatedAtBlock: event.blockNumber || 0,
          processing: true,
        });

        // Auto-process: generate keys, provideLPKey, wait, setMintReady
        // Run async so we don't block the event loop
        (async () => {
          try {
            const keys = await generateEd25519Keys();
            console.log(`[Mint] Generated Ed25519 keys for ${reqIdHex}`);
            await processMint(ctx, reqIdHex, keys.lpPublicSpendKey, keys.lpPublicViewKey, keys.lpSpendPriv);
          } catch (err) {
            console.error(`[Mint] Auto-process failed for ${reqIdHex}:`, err.message || err);
            const mint = ctx.pendingMints.get(reqIdHex) || {};
            mint.autoProcessError = err.message || String(err);
            mint.processing = false;
            ctx.pendingMints.set(reqIdHex, mint);
            // Transient failures (RPC timeout etc.) — retry while keys remain unposted
            if (!mint.keyPostedAt) scheduleMintProcessRetry(ctx, reqIdHex);
          }
        })();
      }

      // Poll for MintFinalized — sweep XMR from deposit address to LP wallet
      let finalizedEvents = [];
      try {
        const finalizedFilter = ctx.hub.filters.MintFinalized();
        finalizedEvents = await queryFilterChunked(ctx, ctx.hub, finalizedFilter, fromBlock, currentBlock);
      } catch (err) {
        console.warn('[Event] Could not query MintFinalized events:', err.message);
      }

      for (const event of finalizedEvents) {
        const { requestId, secret } = event.args;
        const reqIdHex = ethers.hexlify(requestId);
        const mint = ctx.pendingMints.get(reqIdHex);
        if (!mint || mint.swept || mint.sweepAttempted) continue;

        console.log(`[Event] MintFinalized ${reqIdHex} — user secret revealed`);
        mint.sweepAttempted = true;
        ctx.pendingMints.set(reqIdHex, mint);

        // Sweep async so we don't block the event loop
        (async () => {
          try {
            if (!mint.lpSecret) {
              console.warn(`[Sweep] No lpSecret stored for ${reqIdHex} — cannot sweep`);
              return;
            }
            if (!lpMoneroAddress) {
              console.warn(`[Sweep] LP Monero address not available — skipping sweep for ${reqIdHex}`);
              return;
            }

            // Use the block number from the MintInitiated event as restore height
            const restoreHeight = mint.initiatedAtBlock || 0;
            console.log(`[Sweep] Sweeping XMR for ${reqIdHex}...`);
            if (mint.depositTx) {
              console.log(`[Sweep]   deposit tx: ${mint.depositTx.txid}, height: ${mint.depositTx.height}`);
            }
            const result = await sweepMintWithViewKeyFallback(ctx, {
              reqIdHex,
              userSecretHex: ethers.hexlify(secret),
              depositTxHash: mint.depositTx ? mint.depositTx.txid : null,
              lpSecretHex: mint.lpSecret,
              lpMainAddress: lpMoneroAddress,
              restoreHeight,
              depositHeight: mint.depositTx ? mint.depositTx.height : 0,
            });

            if (result.swept) {
              mint.swept = true;
              mint.sweepTxHashes = result.txHashes;
              mint.sweepAmount = result.amount.toString();
              ctx.pendingMints.set(reqIdHex, mint);
              console.log(`[Sweep] Successfully swept ${result.amount} atomic units for ${reqIdHex}`);
              // Persist swept state
              try {
                const secretsFile = ctx.secretsFile;
                if (fs.existsSync(ctx.secretsFile)) {
                  const secrets = JSON.parse(fs.readFileSync(ctx.secretsFile, 'utf8'));
                  if (secrets[reqIdHex]) {
                    secrets[reqIdHex].swept = true;
                    secrets[reqIdHex].sweepTxHashes = result.txHashes;
                    secrets[reqIdHex].sweepAmount = result.amount.toString();
                    fs.writeFileSync(ctx.secretsFile, JSON.stringify(secrets, null, 2));
                  }
                }
              } catch (persistErr) {
                console.warn(`[Sweep] Could not persist swept state for ${reqIdHex}:`, persistErr.message);
              }
            } else {
              console.log(`[Sweep] Not yet sweepable for ${reqIdHex} — see Monero log for details. Will retry on next poll.`);
              mint.sweepAttempted = false; // allow retry
              ctx.pendingMints.set(reqIdHex, mint);
            }
          } catch (err) {
            console.error(`[Sweep] Failed for ${reqIdHex}:`, err.message || err);
            mint.sweepAttempted = false; // allow retry
            ctx.pendingMints.set(reqIdHex, mint);
          }
        })();
      }

      // Poll for MintCancelled — cleanup
      let cancelledEvents = [];
      try {
        const cancelledFilter = ctx.hub.filters.MintCancelled();
        cancelledEvents = await queryFilterChunked(ctx, ctx.hub, cancelledFilter, fromBlock, currentBlock);
      } catch (err) {
        // Non-critical
      }

      for (const event of cancelledEvents) {
        const { requestId } = event.args;
        const reqIdHex = ethers.hexlify(requestId);
        if (ctx.pendingMints.has(reqIdHex)) {
          console.log(`[Event] MintCancelled ${reqIdHex} — cleaning up`);
          ctx.pendingMints.delete(reqIdHex);
        }
      }

      // Poll for MintKeyCancelled — a KEY_PROVIDED mint timed out into KEY_CANCELLED.
      // The parked griefing deposit is now claimable: abandonKeyProvidedMint pays it
      // to the LP and publishes lpSecret on-chain so the user can sweep their XMR.
      let keyCancelledEvents = [];
      try {
        const keyCancelledFilter = ctx.hub.filters.MintKeyCancelled();
        keyCancelledEvents = await queryFilterChunked(ctx, ctx.hub, keyCancelledFilter, fromBlock, currentBlock);
      } catch (err) {
        // Non-critical
      }

      for (const event of keyCancelledEvents) {
        const { requestId } = event.args;
        const reqIdHex = ethers.hexlify(requestId);
        // Load persisted lpSecret from disk (same pattern as the sweep path)
        let entry = null;
        try {
          const secretsFile = ctx.secretsFile;
          if (fs.existsSync(ctx.secretsFile)) {
            const secrets = JSON.parse(fs.readFileSync(ctx.secretsFile, 'utf8'));
            entry = secrets[reqIdHex];
          }
        } catch (err) {
          console.warn(`[Event] Could not read lp-secrets.json for ${reqIdHex}:`, err.message);
        }
        if (!entry || !entry.lpSecret) {
          console.log(`[Event] MintKeyCancelled ${reqIdHex} — no lpSecret persisted, cannot claim parked deposit`);
          continue;
        }
        console.log(`[Event] MintKeyCancelled ${reqIdHex} — claiming parked deposit via abandonKeyProvidedMint`);
        (async () => {
          try {
            const abandonNonce = await ctx.nonce.getNextNonce();
            const tx = await ctx.hub.abandonKeyProvidedMint(reqIdHex, entry.lpSecret, { nonce: abandonNonce });
            await tx.wait();
            console.log(`[Event] MintKeyCancelled ${reqIdHex} — deposit claimed, lpSecret published (tx: ${tx.hash})`);
            ctx.pendingMints.delete(reqIdHex);
          } catch (err) {
            console.warn(`[Event] abandonKeyProvidedMint failed for ${reqIdHex}:`, err.shortMessage || err.message);
          }
        })();
      }

      lastCheckedBlock = currentBlock;
    } catch (err) {
      console.error('[Event] Poll error:', err.message);
    }
  }, 15000);
}

// ─── Per-chain periodic jobs ────────────────────────────────────────────────
// Stale burn check (every 60s): PROPOSED burns with expired deadlines get
// abandoned to release the LP's locked collateral; the user can still
// late-claim wsXMR via resolveDeclinedProposal.
// Mint auto-retry (every 5min): KEY_PROVIDED mints that failed auto-processing
// get re-scanned for deposits, up to 3 retries.
function startPeriodicJobs(ctx) {
setInterval(async () => {
  try {
    const currentBlock = await contractBlockNumber(ctx);
    for (const [reqIdHex, burn] of ctx.burns.pendingBurns.entries()) {
      if (burn.state !== 'proposed') continue;
      try {
        const burnReq = await ctx.hub.getBurnRequest(reqIdHex);
        const status = Number(burnReq.status);
        const deadline = Number(burnReq.deadline);
        if (status === 2 && currentBlock >= deadline) {
          console.log(`[Resolve] Burn ${reqIdHex} deadline passed — abandoning to release collateral...`);
          try {
            const abandonNonce = await ctx.nonce.getNextNonce();
            const tx = await ctx.hub.abandonProposedBurn(reqIdHex, { nonce: abandonNonce });
            console.log(`[Resolve] abandonProposedBurn tx: ${tx.hash}`);
            await tx.wait();
            console.log(`[Resolve] Burn ${reqIdHex} abandoned — collateral released`);
            burn.state = 'abandoned';
          } catch (err) {
            console.warn(`[Resolve] abandonProposedBurn failed for ${reqIdHex}:`, err.shortMessage || err.message);
            burn.state = 'stale';
          }
        }
      } catch (err) {
        console.warn(`[Resolve] Periodic check failed for ${reqIdHex}:`, err.shortMessage || err.message);
      }
    }
  } catch (err) {
    console.warn(`[${ctx.key}][Resolve] Periodic stale burn check failed:`, err.message);
  }
}, 60000);

setInterval(async () => {
  for (const [reqIdHex, mint] of ctx.pendingMints.entries()) {
    if (!mint.autoProcessError) continue;
    if (mint.processing) continue;
    if (mint.retryCount >= 3) continue;

    try {
      const mintReq = await ctx.hub.getMintRequest(reqIdHex);
      const status = Number(mintReq.status);
      // Only retry if still KEY_PROVIDED (2) — deposit may have arrived since last attempt
      if (status !== 2) {
        if (status === 5 || status === 6) {
          ctx.pendingMints.delete(reqIdHex);
        }
        continue;
      }

      mint.retryCount = (mint.retryCount || 0) + 1;
      mint.processing = true;
      mint.autoProcessError = null;
      ctx.pendingMints.set(reqIdHex, mint);

      console.log(`[Retry] Re-attempting mint ${reqIdHex} (retry ${mint.retryCount}/3)`);

      const lpSpendKey = await ctx.hub.lpPublicKeys(reqIdHex);
      const lpViewKey = await ctx.hub.lpPublicViewKeys(reqIdHex);

      (async () => {
        try {
          await processMint(ctx, reqIdHex, lpSpendKey, lpViewKey);
        } catch (err) {
          console.error(`[Retry] Failed retry for mint ${reqIdHex}:`, err.message || err);
          const m = ctx.pendingMints.get(reqIdHex) || {};
          m.autoProcessError = err.message || String(err);
          m.processing = false;
          ctx.pendingMints.set(reqIdHex, m);
        }
      })();
    } catch (err) {
      console.warn(`[${ctx.key}][Retry] Could not check mint ${reqIdHex} for retry:`, err.message);
    }
  }
}, 300000); // 5 minutes
}

// Start all per-chain background work: mint event poller, burn event
// listeners, periodic jobs. Each chain is independent — a stalled chain
// must not block the others, so callers run these without awaiting all.
async function startChain(ctx) {
  try {
    await startEventListener(ctx);
  } catch (err) {
    console.error(`[${ctx.key}][Startup] Event listener failed after retries:`, err.message);
    console.error(`[${ctx.key}][Startup] Chain will continue but event polling may be delayed.`);
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await startupRecoverMints(ctx);
      break;
    } catch (err) {
      console.error(`[${ctx.key}][Startup] Mint recovery failed (attempt ${attempt}/3):`, err.message || err);
      if (attempt < 3) await new Promise(r => setTimeout(r, 10000 * attempt));
    }
  }
  try {
    await startupResolveStale(ctx);
  } catch (err) {
    console.error(`[${ctx.key}][Startup] Stale resolution failed:`, err.message);
  }
  try {
    await startupSweepFinalizedMints(ctx);
  } catch (err) {
    console.error(`[${ctx.key}][Startup] Sweep finalized mints failed:`, err.message);
  }
  try {
    ctx.burns.attachEventListeners();
  } catch (err) {
    console.error(`[${ctx.key}][Startup] Burn handler attach failed:`, err.message);
  }
  try {
    await ctx.burns.startupRecoverBurns();
  } catch (err) {
    console.error(`[${ctx.key}][Startup] Burn recovery failed:`, err.message);
  }
  startPeriodicJobs(ctx);
  console.log(`[${ctx.key}][Startup] Chain startup complete`);
}

// ─── HTTP Routes ────────────────────────────────────────────────────────────

// Health check — per-chain status. ?chain=<key> filters to one chain.
app.get('/health', (req, res) => {
  const want = req.query.chain;
  const report = {};
  for (const [key, c] of chains) {
    if (want && want !== key) continue;
    report[key] = {
      status: 'ok',
      chainId: c.chainId,
      wallet: c.wallet.address,
      hub: c.hubAddress,
      trackedMints: c.pendingMints.size,
      trackedBurns: c.burns.pendingBurns.size,
    };
  }
  if (want && !report[want]) {
    return res.status(404).json({ error: `unknown chain '${want}'`, chains: [...chains.keys()] });
  }
  res.json({ status: 'ok', chains: report });
});

// Monero tx checker — queries public daemon for tx status
app.get('/monero/tx/:txHash', async (req, res) => {
  const txHash = req.params.txHash;
  if (!txHash || !/^[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ error: 'Invalid tx hash — must be 64 hex chars' });
  }

  const DAEMON_URLS = (process.env.MONERO_DAEMON_URLS
    ? process.env.MONERO_DAEMON_URLS.split(',').map(s => s.trim()).filter(Boolean)
    : [
      'https://xmr-node.cakewallet.com:18081',
      'https://node.moneroworld.com:18081',
      'https://node.xmr.rocks:18081',
    ]
  );

  for (const daemonUrl of DAEMON_URLS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(`${daemonUrl}/get_transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txs_hashes: [txHash],
          decode_as_json: false,
          prune: true,
        }),
        signal: controller.signal,
      });
      const data = await resp.json();
      clearTimeout(timeout);

      if (data.error) throw new Error(`daemon error: ${JSON.stringify(data.error)}`);

      const txs = data.txs || [];
      if (txs.length === 0 || txs[0].in_pool === undefined && !txs[0].block_height) {
        return res.json({ found: false, inPool: false, confirmations: 0 });
      }

      const tx = txs[0];
      const currentHeight = data.height || 0;
      const inPool = tx.in_pool || false;
      const blockHeight = inPool ? 0 : (tx.block_height || 0);
      const confirmations = inPool ? 0 : Math.max(0, currentHeight - blockHeight);

      return res.json({
        found: true,
        inPool,
        blockHeight,
        currentHeight,
        confirmations,
        requiredConfirmations: 10,
        txHash: tx.tx_hash || txHash,
      });
    } catch (err) {
      clearTimeout(timeout);
      console.warn(`[Monero] Tx checker daemon ${daemonUrl} failed: ${err.message}`);
    }
  }

  res.status(503).json({ error: 'All Monero daemons failed' });
});

// Post LP key for a mint request manually (auto-processing is the default)
app.post('/mint/key', async (req, res) => {
  const { requestId, lpPublicSpendKey, lpPublicViewKey } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: 'requestId required' });
  }
  if (!lpPublicSpendKey || !lpPublicViewKey) {
    return res.status(400).json({ error: 'lpPublicSpendKey and lpPublicViewKey required' });
  }

  const reqIdHex = ethers.hexlify(requestId);
  const ctx = resolveCtx(req, reqIdHex);
  if (!ctx) {
    return res.status(400).json({ error: 'chain required (body.chain) — multiple chains running', chains: [...chains.keys()] });
  }
  console.log(`[${ctx.key}][HTTP] Received LP key for ${reqIdHex}`);

  try {
    // Kick off processing without blocking the response
    res.json({
      success: true,
      requestId: reqIdHex,
      message: 'Processing started. provideLPKey then setMintReady will follow.',
    });

    await processMint(ctx, reqIdHex, lpPublicSpendKey, lpPublicViewKey);
  } catch (err) {
    console.error(`[Error] Failed processing /mint/key for ${reqIdHex}:`, err.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || String(err), requestId: reqIdHex });
    }
  }
});

// List tracked mints — merged across chains (each entry tagged with `chain`),
// or filtered with ?chain=<key>.
app.get('/mints', (req, res) => {
  const want = req.query.chain;
  const list = [];
  for (const c of chains.values()) {
    if (want && want !== c.key) continue;
    for (const m of c.pendingMints.values()) list.push({ chain: c.key, ...m });
  }
  res.json(JSON.parse(JSON.stringify({ mints: list, count: list.length }, (k, v) => typeof v === 'bigint' ? v.toString() : v)));
});


// Manually trigger deposit scan for a mint (useful when LP keys were already provided)
app.post('/mint/scan', async (req, res) => {
  const { requestId } = req.body;
  if (!requestId) {
    return res.status(400).json({ error: 'requestId required' });
  }
  const reqIdHex = ethers.hexlify(requestId);
  const ctx = resolveCtx(req, reqIdHex);
  if (!ctx) {
    return res.status(400).json({ error: 'chain required (body.chain) — multiple chains running', chains: [...chains.keys()] });
  }

  try {
    // Get on-chain status and LP keys
    const mintReq = await ctx.hub.getMintRequest(reqIdHex);
    const status = Number(mintReq.status);
    if (status === 5 || status === 6) {
      return res.json({ success: false, message: `Mint already ${status === 5 ? 'completed' : 'cancelled'}` });
    }

    const lpSpendKey = await ctx.hub.lpPublicKeys(reqIdHex);
    const lpViewKey = await ctx.hub.lpPublicViewKeys(reqIdHex);
    if (lpSpendKey === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      return res.status(400).json({ error: 'LP keys not yet provided for this mint' });
    }

    // Store in ctx.pendingMints if not already there
    const mint = ctx.pendingMints.get(reqIdHex) || {
      requestId: reqIdHex,
      initiator: mintReq.initiator,
      recipient: mintReq.recipient,
      xmrAmount: mintReq.xmrAmount.toString(),
      userPublicKey: ethers.hexlify(mintReq.userPublicKey),
      timeoutBlock: Number(mintReq.timeout),
    };
    mint.lpPublicSpendKey = lpSpendKey;
    mint.lpPublicViewKey = lpViewKey;
    mint.keyPostedAt = mint.keyPostedAt || Date.now();
    ctx.pendingMints.set(reqIdHex, mint);

    res.json({
      success: true,
      requestId: reqIdHex,
      message: 'Deposit scan started. Will call setMintReady when deposit is found.',
      depositAddress: mint.depositAddress || 'computing...',
      xmrAmount: mint.xmrAmount,
    });

    // Run processMint async (it will skip provideLPKey since status >= 2)
    processMint(ctx, reqIdHex, lpSpendKey, lpViewKey).catch(err => {
      console.error(`[Mint] Manual scan failed for ${reqIdHex}:`, err.message);
    });
  } catch (err) {
    console.error(`[Error] /mint/scan failed for ${reqIdHex}:`, err.message);
    res.status(500).json({ error: err.message, requestId: reqIdHex });
  }
});


// ─── Chainlink Data Streams Report Proxy ────────────────────────────────────
// Serves signed fullReport blobs to the frontend so the API secret never
// reaches the browser. Mirrors frontend/report-proxy/server.js behaviour.

const PROXY_DIR = path.join(__dirname, '..', 'frontend', 'report-proxy');

function fetchReport(feedId) {
  const out = execSync(`node "${path.join(PROXY_DIR, 'fetchReportHex.js')}" ${feedId}`, {
    cwd: PROXY_DIR,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' }
  });
  return out.trim();
}

app.options('/reports', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.get('/reports', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  const feedIDs = (req.query.feedIDs || '').split(',').filter(Boolean);
  if (feedIDs.length === 0) {
    return res.status(400).json({ error: 'Missing feedIDs query parameter' });
  }

  try {
    const reports = await Promise.all(
      feedIDs.map(async (id) => {
        const fullReport = fetchReport(id);
        return { feedID: id, fullReport };
      })
    );
    res.json({ reports });
  } catch (e) {
    console.error('Report fetch failed:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── Burn Handler Routes ────────────────────────────────────────────────────
// Each chain's burn routes are mounted at /chains/<key>/... when contexts are
// built (see startup). With a single chain they're also mounted un-prefixed
// for backward compatibility with existing clients.

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`HTTP server listening on http://localhost:${PORT}`);

  // Spawn dedicated deposit-scan monero-wallet-rpc — hosts ONLY per-mint
  // view-only wallets, so refresh+get_transfers can run every poll cycle
  // without evicting the main LP wallet or hitting the reopen-corruption
  // bug. daemon-scan remains as fallback if this can't start.
  const DEPOSIT_RPC_PORT = process.env.DEPOSIT_WALLET_RPC_PORT || '18083';
  const DEPOSIT_WALLET_DIR = process.env.DEPOSIT_WALLET_DIR || path.join(__dirname, 'monero-wallets-deposit');
  try {
    fs.mkdirSync(DEPOSIT_WALLET_DIR, { recursive: true });
    const depositRpcLog = fs.openSync(path.join(__dirname, 'monero-wallet-rpc-deposit.log'), 'a');
    const depositRpcProc = spawn('monero-wallet-rpc', [
      '--wallet-dir', DEPOSIT_WALLET_DIR,
      '--rpc-bind-port', String(DEPOSIT_RPC_PORT),
      '--rpc-bind-ip', '127.0.0.1',
      '--daemon-address', process.env.MONERO_DAEMON_ADDRESS || 'xmr-node.cakewallet.com:18081',
      '--trusted-daemon',
      '--daemon-ssl', 'enabled',
      '--daemon-ssl-allow-any-cert',
      '--disable-rpc-login',
      '--non-interactive',
    ], { stdio: ['ignore', 'ignore', depositRpcLog], detached: true });
    depositRpcProc.unref();
    console.log(`[Startup] Deposit-scan wallet-rpc spawned on :${DEPOSIT_RPC_PORT} (dir: ${DEPOSIT_WALLET_DIR})`);
  } catch (err) {
    console.warn('[Startup] Could not spawn deposit wallet-rpc — daemon-scan fallback will be used:', err.message);
  }

  // Ensure main wallet is open before recovery tries to create deposit wallets
  if (moneroWallet.isWalletConfigured()) {
    console.log('[Startup] Ensuring Monero wallet is open...');
    await moneroWallet.ensureWalletOpen();
    if (moneroWallet.isWalletRpcHealthy()) {
      console.log('[Startup] Monero wallet ready — syncing wallet to chain tip...');
      try {
        const refreshRes = await moneroWallet.refreshWallet();
        console.log(`[Startup] Wallet sync complete: blocks_fetched=${refreshRes?.blocks_fetched || 0}`);
      } catch (err) {
        console.warn('[Startup] Initial wallet sync failed (will continue):', err.message);
      }
      // Fetch LP's main Monero address for sweeping
      // Always re-fetch — a leftover view-only wallet from a previous operation
      // may have been open when we first called getAddresses, giving us the wrong address.
      try {
        const addrInfo = await moneroWallet.getAddresses(0);
        const fetchedAddr = addrInfo.primary;
        // Sanity check: LP main address must start with '4' (mainnet primary)
        // and differ from any known deposit address
        if (fetchedAddr && fetchedAddr.startsWith('4')) {
          lpMoneroAddress = fetchedAddr;
          console.log(`[Startup] LP Monero address: ${lpMoneroAddress}`);
        } else {
          console.warn(`[Startup] Unexpected address format: ${fetchedAddr} — not setting as LP address`);
        }
      } catch (err) {
        console.warn('[Startup] Could not fetch LP Monero address:', err.message);
      }
    } else {
      console.error('[Startup] Monero wallet RPC unreachable — mint scanning will fail until monero-wallet-rpc is started');
    }
  }
  // ── Build chain contexts & start each chain ──────────────────────────────
  const cfgs = loadChainConfigs();
  if (cfgs.length === 0) {
    console.error('[Startup] No chains configured — create lp-server-js/chains.json or provide ../deployment.json + RPC_URL');
    return;
  }
  for (const cfg of cfgs) {
    try {
      const ctx = buildChainContext(cfg);
      chains.set(ctx.key, ctx);
      console.log(`[Startup] Chain ${ctx.key} (${ctx.name}, id ${ctx.chainId}): hub=${ctx.hubAddress}, rpcs=${ctx.rpcUrls.length}`);
    } catch (err) {
      console.error(`[Startup] Skipping chain '${cfg.key || cfg.name}': ${err.message}`);
    }
  }
  if (chains.size === 0) {
    console.error('[Startup] No chain contexts could be built — check manifests and RPC env vars');
    return;
  }

  // Mount per-chain burn routes under /chains/<key>/…
  for (const ctx of chains.values()) {
    ctx.burns.registerRoutes(app, `/chains/${ctx.key}`);
  }
  // Legacy unprefixed routes when only one chain is running
  if (chains.size === 1) {
    chains.values().next().value.burns.registerRoutes(app);
  }

  // Start each chain's listeners/recovery independently — a stalled chain
  // must not delay the others.
  for (const ctx of chains.values()) {
    startChain(ctx).catch(err =>
      console.error(`[${ctx.key}][Startup] Chain startup failed:`, err.message));
  }

  console.log(`[Startup] ${chains.size} chain(s) active: ${[...chains.keys()].join(', ')}. Server is running.`);
});