import 'dotenv/config';
import express from 'express';
import * as ethers from 'ethers';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as burnHandler from './burnHandler.js';
import * as moneroWallet from './moneroWallet.js';
import * as moneroCrypto from './moneroCrypto.js';
import { computeSecretHash } from './commitment.js';
import { setHubWallet, updateOraclePricesManual, broadcastOracleUpdate } from './oracleUpdate.js';
import { moneroDaemonProxyRouter } from './moneroDaemonProxy.js';
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

// ─── Config ─────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL || 'https://rpc.gnosischain.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PORT = process.env.PORT || 3001;

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY env var is required');
  process.exit(1);
}

const deploymentPath = path.join(__dirname, '..', 'deployment.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

const HUB_ADDRESS = deployment.contracts.wsXmrHub;
const CHAIN_ID = deployment.chainId || 84532;

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
  'function cancelMint(bytes32 requestId, bytes32 userSecret) external',
  'function abandonKeyProvidedMint(bytes32 requestId, bytes32 lpSecret) external',
];

// ─── Ethers Setup ───────────────────────────────────────────────────────────
const gnosisNetwork = new ethers.Network('gnosis', CHAIN_ID);
// batchMaxCount: 1 disables JSON-RPC batching (each request sent individually).
// NOTE: batchMaxCount: 0 would mean *unlimited* batching — every request in the
// 10ms stall window gets bundled into one batch, and if the endpoint stalls on
// the batch they all hang together. `timeout` is not a valid provider option.
const provider = new ethers.JsonRpcProvider(RPC_URL, gnosisNetwork, { staticNetwork: true, batchMaxCount: 1 });
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, wallet);

// HyperEVM RPC caps eth_getLogs at 1000-block ranges — chunk wide scans.
// Retries on rate-limit errors (-32005 surfaces as UNKNOWN_ERROR or BAD_DATA
// 'missing response') and paces chunks to stay under the public RPC's limit.
const LOG_QUERY_CHUNK = 900;
const LOG_CHUNK_DELAY_MS = 150;
async function queryFilterChunked(contract, filter, fromBlock, toBlock) {
  const events = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_QUERY_CHUNK) {
    const end = Math.min(start + LOG_QUERY_CHUNK - 1, toBlock);
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
    await new Promise(r => setTimeout(r, LOG_CHUNK_DELAY_MS));
  }
  return events;
}

// ─── Nonce Manager ──────────────────────────────────────────────────────────
import { initNonceManager, getNextNonce, withNonceLock, resetNonceCache, withTimeout } from './nonceManager.js';
initNonceManager(provider, wallet.address);

console.log(`LP Server starting...`);
console.log(`Wallet / LP Vault: ${wallet.address}`);
console.log(`Hub: ${HUB_ADDRESS}`);
console.log(`RPC: ${RPC_URL}`);

// ─── In-memory tracking ─────────────────────────────────────────────────────
const pendingMints = new Map(); // requestId -> { initiatedAt, keyPostedAt }
let lpMoneroAddress = process.env.MONERO_LP_ADDRESS || null; // fetched from wallet at startup

// ─── Secret persistence ─────────────────────────────────────────────────────
// lpSecret must hit disk IMMEDIATELY after generation — it is needed to sweep
// the deposit later, and a crash between provideLPKey and finalizeMint would
// otherwise lose it forever (this exact loss already happened once).
function persistMintSecret(reqIdHex, fields) {
  try {
    const secretsFile = path.join(__dirname, 'lp-secrets.json');
    let secrets = {};
    if (fs.existsSync(secretsFile)) {
      secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
    }
    secrets[reqIdHex] = { ...(secrets[reqIdHex] || {}), ...fields };
    fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
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
async function sweepMintWithViewKeyFallback({ reqIdHex, userSecretHex, lpSecretHex, lpMainAddress, restoreHeight = 0, depositHeight = 0, depositTxHash = null }) {
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
    const lpSpendPub = (await hub.lpPublicKeys(reqIdHex)).replace(/^0x/, '').toLowerCase();
    const lpViewPub = (await hub.lpPublicViewKeys(reqIdHex)).replace(/^0x/, '').toLowerCase();
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

// ─── Deposit-proof coordination (check_tx_key fallback) ─────────────────────
// Mint deposits are LP-viewable (view pub = lpSpendPub, private view key =
// lpSecret), so processMint scans the chain directly via pollForDeposit. The
// /mint/deposit endpoint remains as an OPTIONAL fallback: if a user submits
// txid+txKey, we verify via check_tx_key and resolve the waiter / drive
// finalization directly. depositProofs stores the verified result so a proof
// submitted before processMint starts waiting still counts.
const depositWaiters = new Map(); // requestId -> resolve(depositTx)
const depositProofs = new Map();  // requestId -> { verified, depositTx }
// Generous window — the user must send XMR, then submit txid + tx key. check_tx_key
// works on in-pool (0-conf) txs so they can submit right after broadcasting.
const DEPOSIT_PROOF_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

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
setHubWallet(hub, wallet, HUB_ADDRESS);

// ─── Core Mint Processing ───────────────────────────────────────────────────
async function processMint(reqIdHex, lpPublicSpendKey, lpPublicViewKey, lpSpendPriv) {
  console.log(`[Mint] Processing ${reqIdHex}`);

  const mint = pendingMints.get(reqIdHex) || {};

  // 0. Check on-chain status to handle restarts gracefully
  let onChainStatus = -1;
  try {
    const mintReq = await hub.getMintRequest(reqIdHex);
    onChainStatus = Number(mintReq.status);
    console.log(`[Chain] Mint ${reqIdHex} on-chain status: ${onChainStatus} (1=PENDING, 2=KEY_PROVIDED, 3=READY, 4=SECRET_REVEALED, 5=COMPLETED, 6=CANCELLED)`);

    if (onChainStatus === 5 || onChainStatus === 6) {
      console.log(`[Mint] Mint already ${onChainStatus === 5 ? 'completed' : 'cancelled'}, skipping`);
      pendingMints.delete(reqIdHex);
      return;
    }

    // If keys already provided on-chain, use the existing keys instead of calling provideLPKey again
    if (onChainStatus >= 2) {
      const existingSpendKey = await hub.lpPublicKeys(reqIdHex);
      const existingViewKey = await hub.lpPublicViewKeys(reqIdHex);
      if (existingSpendKey !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
        console.log(`[Chain] LP keys already provided on-chain, skipping provideLPKey`);
        lpPublicSpendKey = existingSpendKey;
        lpPublicViewKey = existingViewKey;
      }
    }

    // Refuse to key a mint whose claimCommitment doesn't bind to userPublicKey —
    // the revealed secret would not complete the deposit spend key, so the XMR
    // could never be swept while wsXMR still mints against our vault.
    if (onChainStatus === 1) {
      const bound = await verifyCommitmentBinding(mintReq.claimCommitment, mintReq.userPublicKey);
      if (!bound) {
        console.error(`[Mint] ${reqIdHex}: claimCommitment does not match userPublicKey — refusing to key (deposit would be unspendable)`);
        mint.autoProcessError = 'commitment-pubkey mismatch';
        mint.processing = false;
        pendingMints.set(reqIdHex, mint);
        return;
      }
    }
  } catch (err) {
    console.warn(`[Chain] Could not query mint status, proceeding anyway:`, err.message);
  }

  // 1. Compute LP secret and commitment (needed for provideLPKey)
  let lpSecret;
  if (lpSpendPriv) {
    lpSecret = Buffer.from(lpSpendPriv.replace(/^0x/, ''), 'hex');
  } else {
    // Recovery case: keys came from on-chain, check if lpSecret was already persisted
    try {
      const secretsFile = path.join(__dirname, 'lp-secrets.json');
      if (fs.existsSync(secretsFile)) {
        const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
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
  pendingMints.set(reqIdHex, mint);
  console.log(`[Mint] LP commitment for ${reqIdHex}: ${lpCommitment}`);

  // Persist IMMEDIATELY — the secret is needed to sweep the deposit and must
  // survive a crash anywhere in the rest of this flow.
  persistMintSecret(reqIdHex, {
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
    const oracleNonce = await getNextNonce();
    try {
      const otx = await broadcastOracleUpdate(oracleNonce);
      otx.wait()
        .then(r => console.log(`[Oracle] Update confirmed in block ${r.blockNumber}`))
        .catch(e => console.warn(`[Oracle] Update confirmation failed: ${e.shortMessage || e.message}`));
    } catch (priceErr) {
      console.warn(`[Chain] Oracle broadcast failed before provideLPKey: ${priceErr.message}`);
      // Oracle tx didn't broadcast — its reserved nonce went unused, so resync
      // to avoid leaving a gap that would stall the next transaction.
      resetNonceCache();
    }
    console.log(`[Chain] Calling provideLPKey(${reqIdHex})...`);
    const nonce = await getNextNonce(); // oracleNonce+1 if the update broadcast, else resynced
    // Explicit gasLimit skips estimateGas — estimation runs against the latest
    // (pre-oracle-update) block and would revert with StalePrice before the
    // pipelined oracle tx has a chance to mine. ~64k gas is actually used.
    const tx1 = await withTimeout(
      hub.provideLPKey(reqIdHex, lpPublicSpendKey, lpPublicViewKey, lpCommitment, { nonce, gasLimit: 500000n }),
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
  pendingMints.set(reqIdHex, mint);

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
      // user's frontend predates the LP-viewable change. Compute it so
      // /mint/deposit can verify proofs against both candidates.
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
  //    (e.g. lost lpSecret), we rely solely on the /mint/deposit fallback.
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
      console.warn(`[Mint] Cannot scan deposit — lpSecret doesn't derive on-chain lpSpendPub; relying on /mint/deposit fallback`);
    }
  } else if (process.env.MONERO_VIEW_KEY) {
    const mainViewPub = await scalarHexToPubKeyHex(process.env.MONERO_VIEW_KEY);
    if (mainViewPub === lpPublicViewKey.replace(/^0x/, '').toLowerCase()) {
      scanViewKey = process.env.MONERO_VIEW_KEY.replace(/^0x/, '');
      console.log(`[Mint] Legacy mint — scanning deposit address with MONERO_VIEW_KEY (view pub = lpPublicViewKey)`);
    } else {
      console.warn(`[Mint] Legacy mint — lpPublicViewKey is not our wallet view pub; cannot scan, relying on /mint/deposit fallback`);
    }
  }

  const expectedAmount = BigInt(mint.xmrAmount || '0');
  if (expectedAmount > 0n && moneroWallet.isWalletConfigured() && mint.depositAddress) {
    const waiters = [waitForDepositProof(reqIdHex, { maxWaitMs: DEPOSIT_PROOF_TIMEOUT_MS })];
    if (scanViewKey) {
      // Fetch current height before pollForDeposit closes the main wallet
      let scanHeight = 0;
      try {
        const height = await moneroWallet.getDaemonHeight();
        scanHeight = Math.max(0, height - 100);
        console.log(`[Mint] Current Monero height: ${height}, scanning from ${scanHeight}`);
      } catch (err) {
        console.warn(`[Mint] Could not get daemon height, scanning from 0:`, err.message);
      }
      console.log(`[Mint] Scanning for XMR deposit of ${expectedAmount} atomic units...`);
      waiters.unshift(moneroWallet.pollForDeposit(expectedAmount, {
        depositAddress: mint.depositAddress,
        viewKeyHex: scanViewKey,
        restoreHeight: scanHeight,
        toleranceBps: 300,   // 3% tolerance for fees / rounding
        intervalMs: 15000,   // 15s
        maxWaitMs: DEPOSIT_PROOF_TIMEOUT_MS,
        shouldAbort: () => !!depositProofs.get(reqIdHex)?.verified,
      }));
    } else {
      console.log(`[Mint] Not scanning — waiting for /mint/deposit proof only`);
    }
    try {
      const depositTx = await Promise.race(waiters)
        || await waitForDepositProof(reqIdHex, { maxWaitMs: 60000 });
      // ^ pollForDeposit returns null when aborted because a /mint/deposit proof
      //   landed mid-scan — depositProofs is already set, so this resolves fast.
      mint.depositTx = depositTx;
      pendingMints.set(reqIdHex, mint);
      console.log(`[Mint] Deposit verified: ${depositTx.txid} (received=${depositTx.amount})`);
    } catch (waitErr) {
      console.error(`[Mint] Deposit wait failed for ${reqIdHex}:`, waitErr.message);
      mint.autoProcessError = waitErr.message;
      pendingMints.set(reqIdHex, mint);
      return; // Do NOT call setMintReady if deposit was not verified
    }
  } else if (expectedAmount > 0n) {
    console.warn(`[Mint] MONERO_WALLET_RPC_URL not configured or no deposit address — skipping deposit verification`);
  }

  // 5-7. Oracle update, persist lpSecret, setMintReady
  await finalizeMint(reqIdHex, mint, lpCommitment);
}

// ─── Deposit-proof wait ─────────────────────────────────────────────────────
// Parks until /mint/deposit verifies a check_tx_key proof and resolves the waiter.
// Returns the verified depositTx. If the proof was submitted before we started
// waiting, depositProofs already holds it and we return immediately.
function waitForDepositProof(reqIdHex, { maxWaitMs = DEPOSIT_PROOF_TIMEOUT_MS } = {}) {
  const existing = depositProofs.get(reqIdHex);
  if (existing && existing.verified) {
    return Promise.resolve(existing.depositTx);
  }
  return new Promise((resolve, reject) => {
    const finish = (fn, arg) => {
      clearTimeout(timer);
      clearInterval(statusPoll);
      depositWaiters.delete(reqIdHex);
      fn(arg);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error('Timed out waiting for deposit proof (txid + tx key) via /mint/deposit'));
    }, maxWaitMs);
    // Watch on-chain status — if the mint leaves KEY_PROVIDED (cancelled/expired)
    // while we're parked, abort early instead of waiting the full timeout.
    const statusPoll = setInterval(async () => {
      try {
        const mintReq = await hub.getMintRequest(reqIdHex);
        const status = Number(mintReq.status);
        if (status !== 2) { // not KEY_PROVIDED anymore
          finish(reject, new Error(`Mint left KEY_PROVIDED (status=${status}) while waiting for deposit proof — aborting`));
        }
      } catch (e) {
        // Ignore transient read failures — keep waiting.
      }
    }, 15000);
    depositWaiters.set(reqIdHex, (depositTx) => {
      finish(resolve, depositTx);
    });
  });
}

// ─── Finalize a verified mint ───────────────────────────────────────────────
// Runs the oracle update, persists lpSecret, and calls setMintReady. Invoked by
// processMint after the deposit proof arrives, or directly by /mint/deposit when
// processMint is no longer parked (timed out / restarted). Guarded against
// double-invocation.
async function finalizeMint(reqIdHex, mint, lpCommitment) {
  if (mint.finalizeStarted) {
    console.log(`[Mint] finalizeMint already in progress for ${reqIdHex}, skipping`);
    return;
  }
  mint.finalizeStarted = true;
  pendingMints.set(reqIdHex, mint);

  // 5. Update oracle prices before setMintReady (contract requires fresh price for collateral check)
  try {
    await updateOraclePricesManual();
  } catch (priceErr) {
    console.warn(`[Chain] Oracle price update failed: ${priceErr.message}`);
    console.warn(`[Chain] Proceeding with setMintReady anyway (may revert with StalePrice)...`);
  }

  // 6. Update persisted lpSecret with deposit info (secret itself was already
  //    persisted right after generation in processMint).
  persistMintSecret(reqIdHex, {
    lpSecret: mint.lpSecret,
    lpCommitment: lpCommitment,
    initiatedAtBlock: mint.initiatedAtBlock || 0,
    xmrAmount: mint.xmrAmount,
    depositTxHash: mint.depositTx ? mint.depositTx.txid : undefined,
    depositHeight: mint.depositTx ? mint.depositTx.height : undefined,
  });

  // 7. Call setMintReady (non-payable — bond is tracked in vault config, not sent as ETH)
  const mintNonce = await getNextNonce();
  console.log(`[Chain] Calling setMintReady(${reqIdHex})... nonce: ${mintNonce}`);
  let tx2;
  try {
    tx2 = await hub.setMintReady(reqIdHex, { gasLimit: 500000n, nonce: mintNonce });
  } catch (gasErr) {
    console.warn(`[Chain] setMintReady with manual gas failed: ${gasErr.message}`);
    const retryNonce = await getNextNonce();
    tx2 = await hub.setMintReady(reqIdHex, { nonce: retryNonce });
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

async function retryProcessMint(reqIdHex) {
  const mintReq = await hub.getMintRequest(reqIdHex);
  const status = Number(mintReq.status);
  if (status === 2) {
    // KEY_PROVIDED — must reuse the on-chain keys (new keys would mismatch)
    const lpSpendKey = await hub.lpPublicKeys(reqIdHex);
    const lpViewKey = await hub.lpPublicViewKeys(reqIdHex);
    await processMint(reqIdHex, lpSpendKey, lpViewKey);
  } else if (status === 1) {
    // PENDING — keys never posted, safe to generate fresh ones
    const keys = await generateEd25519Keys();
    await processMint(reqIdHex, keys.lpPublicSpendKey, keys.lpPublicViewKey, keys.lpSpendPriv);
  }
  // Any other status (READY/COMPLETED/CANCELLED/…) — nothing to retry
}

function scheduleMintProcessRetry(reqIdHex, attempt = 1) {
  setTimeout(async () => {
    const mint = pendingMints.get(reqIdHex);
    if (!mint || mint.processing || mint.keyPostedAt) return;
    try {
      console.log(`[Mint] Retrying auto-process for ${reqIdHex} (attempt ${attempt}/${MINT_RETRY_MAX})...`);
      mint.processing = true;
      pendingMints.set(reqIdHex, mint);
      await retryProcessMint(reqIdHex);
    } catch (err) {
      console.error(`[Mint] Retry ${attempt} failed for ${reqIdHex}:`, err.message || err);
      const m = pendingMints.get(reqIdHex) || {};
      m.autoProcessError = err.message || String(err);
      m.processing = false;
      pendingMints.set(reqIdHex, m);
      if (!m.keyPostedAt && attempt < MINT_RETRY_MAX) {
        scheduleMintProcessRetry(reqIdHex, attempt + 1);
      } else if (attempt >= MINT_RETRY_MAX) {
        console.error(`[Mint] Gave up auto-processing ${reqIdHex} after ${MINT_RETRY_MAX} attempts`);
      }
    }
  }, MINT_RETRY_MS);
}

// ─── Startup Recovery: Find active mints that need setMintReady ─────────────
async function startupRecoverMints() {
  console.log('[Recovery] Scanning for active mints needing setMintReady...');
  const currentBlock = await provider.getBlockNumber();
  // Scan last ~10000 blocks (~3.5 days on Gnosis at 5s blocks)
  // Use 9999 to stay within RPC's 10000-block max range
  const fromBlock = Math.max(0, currentBlock - 9999);

  let events;
  try {
    const filter = hub.filters.MintInitiated();
    events = await queryFilterChunked(hub, filter, fromBlock, currentBlock);
  } catch (err) {
    console.warn('[Recovery] Could not query MintInitiated events:', err.message);
    return;
  }

  // Filter to mints for our vault
  const ourMints = events.filter(
    e => e.args.lpVault.toLowerCase() === wallet.address.toLowerCase()
  );

  if (ourMints.length === 0) {
    console.log('[Recovery] No mints found for this vault in recent blocks');
    return;
  }

  console.log(`[Recovery] Found ${ourMints.length} mint(s) for this vault, checking status...`);

  for (const event of ourMints) {
    const reqIdHex = ethers.hexlify(event.args.requestId);

    try {
      const mintReq = await hub.getMintRequest(reqIdHex);
      const status = Number(mintReq.status);

      if (status === 5 || status === 6) {
        continue; // completed or cancelled
      }

      if (status === 8) {
        // KEY_CANCELLED — deposit parked. If still inside the LP claim window,
        // claim it via abandonKeyProvidedMint (publishes lpSecret for user sweep).
        const timeout = Number(mintReq.timeout);
        const entry = secrets[reqIdHex];
        if (currentBlock < timeout && entry && entry.lpSecret) {
          console.log(`[Recovery] Mint ${reqIdHex} is KEY_CANCELLED within claim window, claiming parked deposit...`);
          try {
            const abandonNonce = await getNextNonce();
            const tx = await hub.abandonKeyProvidedMint(reqIdHex, entry.lpSecret, { nonce: abandonNonce });
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
        const currentBlock = await provider.getBlockNumber();
        if (currentBlock >= timeout) {
          console.log(`[Recovery] Mint ${reqIdHex} is READY but timed out (timeout=${timeout}, current=${currentBlock}), cancelling...`);
          try {
            const cancelNonce = await getNextNonce();
            const tx = await hub.cancelMint(reqIdHex, '0x0000000000000000000000000000000000000000000000000000000000000000', { nonce: cancelNonce });
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
        if (currentBlock >= timeout) {
          const entry = secrets[reqIdHex];
          if (entry && entry.lpSecret) {
            console.log(`[Recovery] Mint ${reqIdHex} timed out at KEY_PROVIDED, abandoning (claim parked deposit + publish lpSecret)...`);
            try {
              const abandonNonce = await getNextNonce();
              const tx = await hub.abandonKeyProvidedMint(reqIdHex, entry.lpSecret, { nonce: abandonNonce });
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

        const lpSpendKey = await hub.lpPublicKeys(reqIdHex);
        const lpViewKey = await hub.lpPublicViewKeys(reqIdHex);

        pendingMints.set(reqIdHex, {
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
            await processMint(reqIdHex, lpSpendKey, lpViewKey);
          } catch (err) {
            console.error(`[Recovery] Failed to process mint ${reqIdHex}:`, err.message || err);
            const m = pendingMints.get(reqIdHex) || {};
            m.autoProcessError = err.message || String(err);
            m.processing = false;
            pendingMints.set(reqIdHex, m);
            scheduleMintProcessRetry(reqIdHex);
          }
        })();
      } else if (status === 1) {
        // PENDING — LP keys not yet provided
        console.log(`[Recovery] Mint ${reqIdHex} is PENDING (keys not provided), auto-processing...`);

        pendingMints.set(reqIdHex, {
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
            await processMint(reqIdHex, keys.lpPublicSpendKey, keys.lpPublicViewKey, keys.lpSpendPriv);
          } catch (err) {
            console.error(`[Recovery] Failed to process mint ${reqIdHex}:`, err.message || err);
            const m = pendingMints.get(reqIdHex) || {};
            m.autoProcessError = err.message || String(err);
            m.processing = false;
            pendingMints.set(reqIdHex, m);
            scheduleMintProcessRetry(reqIdHex);
          }
        })();
      }
    } catch (err) {
      console.warn(`[Recovery] Could not check mint ${reqIdHex}:`, err.message);
    }
  }
}

// ─── Startup Sweep: Collect XMR from finalized mints ───────────────────────
async function startupSweepFinalizedMints() {
  const secretsFile = path.join(__dirname, 'lp-secrets.json');
  if (!fs.existsSync(secretsFile)) {
    console.log('[Sweep] No persisted lpSecrets found — skipping startup sweep');
    return;
  }

  let secrets;
  try {
    secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
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
      const mintReq = await hub.getMintRequest(reqIdHex);
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

      // Scan recent blocks for the SecretRevealed event
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 100000);
      const filter = hub.filters.SecretRevealed(reqIdHex);
      const events = await queryFilterChunked(hub, filter, fromBlock, currentBlock);

      let userSecret;
      if (events.length > 0) {
        userSecret = ethers.hexlify(events[0].args.secret);
      } else {
        // Fall back to MintFinalized event (same secret, emitted at finalization)
        const finalizeFilter = hub.filters.MintFinalized(reqIdHex);
        const finalizeEvents = await queryFilterChunked(hub, finalizeFilter, fromBlock, currentBlock);
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
        const onChainSpendPub = (await hub.lpPublicKeys(reqIdHex)).replace(/^0x/, '').toLowerCase();
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

      const result = await sweepMintWithViewKeyFallback({
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
        // Load into pendingMints so the event poller can retry
        pendingMints.set(reqIdHex, {
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
      // Load into pendingMints for retry by event poller
      pendingMints.set(reqIdHex, {
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
    fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
  } catch (err) {
    console.warn('[Sweep] Could not save updated lp-secrets.json:', err.message);
  }
}

// ─── Startup Resolution: Cancel stale mints & resolve stale burns ───────────
async function startupResolveStale() {
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - 9999);
  console.log('[Resolve] Checking for stale mints and burns...');

  // ── Stale Mints: cancel if timeout passed ──
  let mintEvents;
  try {
    mintEvents = await queryFilterChunked(hub, hub.filters.MintInitiated(), fromBlock, currentBlock);
  } catch (err) {
    console.warn('[Resolve] Could not query MintInitiated events:', err.message);
    mintEvents = [];
  }

  const ourMints = mintEvents.filter(
    e => e.args.lpVault.toLowerCase() === wallet.address.toLowerCase()
  );

  for (const event of ourMints) {
    const reqIdHex = ethers.hexlify(event.args.requestId);
    try {
      const mintReq = await hub.getMintRequest(reqIdHex);
      const status = Number(mintReq.status);
      const timeout = Number(mintReq.timeout);

      // Status 1=PENDING, 2=KEY_PROVIDED, 3=READY — cancel if timeout passed
      if ((status === 1 || status === 2 || status === 3) && currentBlock >= timeout) {
        console.log(`[Resolve] Mint ${reqIdHex} is stale (status=${status}, timeout=${timeout}, current=${currentBlock}), cancelling...`);
        try {
          const cancelNonce = await getNextNonce();
          const tx = await hub.cancelMint(reqIdHex, '0x0000000000000000000000000000000000000000000000000000000000000000', { nonce: cancelNonce });
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
    burnEvents = await queryFilterChunked(hub, hub.filters.BurnRequested(), fromBlock, currentBlock);
  } catch (err) {
    console.warn('[Resolve] Could not query BurnRequested events:', err.message);
    burnEvents = [];
  }

  const ourBurns = burnEvents.filter(
    e => e.args.lpVault.toLowerCase() === wallet.address.toLowerCase()
  );

  for (const event of ourBurns) {
    const reqIdHex = ethers.hexlify(event.args.requestId);
    try {
      const burnReq = await hub.getBurnRequest(reqIdHex);
      const state = Number(burnReq.status);
      const deadline = Number(burnReq.deadline);

      // State 2=PROPOSED — abandon post-deadline to release locked collateral.
      // The user can still late-claim wsXMR via resolveDeclinedProposal (which
      // reveals userSecret → lets us sweep the shared XMR).
      if (state === 2 && currentBlock >= deadline) {
        console.log(`[Resolve] Burn ${reqIdHex} is stale (PROPOSED, deadline=${deadline}, current=${currentBlock}) — abandoning to release collateral...`);
        try {
          const abandonNonce = await getNextNonce();
          const tx = await hub.abandonProposedBurn(reqIdHex, { nonce: abandonNonce });
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
async function startEventListener() {
  let lastCheckedBlock;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      lastCheckedBlock = await provider.getBlockNumber();
      break;
    } catch (err) {
      console.error(`[Event] Failed to get block number (attempt ${attempt}/5):`, err.message);
      if (attempt === 5) throw err;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log(`Listening for MintInitiated from block ${lastCheckedBlock}`);

  // Poll every 15 seconds using getLogs instead of hub.on() to avoid filter issues
  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= lastCheckedBlock) return;
      const fromBlock = lastCheckedBlock + 1;
      if (fromBlock > currentBlock) return;

      // Retry on rate limit
      let retries = 3;
      let events = [];
      while (retries > 0) {
        try {
          const filter = hub.filters.MintInitiated();
          events = await queryFilterChunked(hub, filter, fromBlock, currentBlock);
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
        if (lpVault.toLowerCase() !== wallet.address.toLowerCase()) {
          continue;
        }

        // Skip if already processing or already processed
        const existing = pendingMints.get(reqIdHex);
        if (existing && (existing.processing || existing.keyPostedAt)) {
          continue;
        }

        console.log(`[Event] MintInitiated ${reqIdHex}`);
        console.log(`  Initiator: ${initiator}`);
        console.log(`  xmrAmount: ${xmrAmount.toString()}`);
        pendingMints.set(reqIdHex, {
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
            await processMint(reqIdHex, keys.lpPublicSpendKey, keys.lpPublicViewKey, keys.lpSpendPriv);
          } catch (err) {
            console.error(`[Mint] Auto-process failed for ${reqIdHex}:`, err.message || err);
            const mint = pendingMints.get(reqIdHex) || {};
            mint.autoProcessError = err.message || String(err);
            mint.processing = false;
            pendingMints.set(reqIdHex, mint);
            // Transient failures (RPC timeout etc.) — retry while keys remain unposted
            if (!mint.keyPostedAt) scheduleMintProcessRetry(reqIdHex);
          }
        })();
      }

      // Poll for MintFinalized — sweep XMR from deposit address to LP wallet
      let finalizedEvents = [];
      try {
        const finalizedFilter = hub.filters.MintFinalized();
        finalizedEvents = await queryFilterChunked(hub, finalizedFilter, fromBlock, currentBlock);
      } catch (err) {
        console.warn('[Event] Could not query MintFinalized events:', err.message);
      }

      for (const event of finalizedEvents) {
        const { requestId, secret } = event.args;
        const reqIdHex = ethers.hexlify(requestId);
        const mint = pendingMints.get(reqIdHex);
        if (!mint || mint.swept || mint.sweepAttempted) continue;

        console.log(`[Event] MintFinalized ${reqIdHex} — user secret revealed`);
        mint.sweepAttempted = true;
        pendingMints.set(reqIdHex, mint);

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
            const result = await sweepMintWithViewKeyFallback({
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
              pendingMints.set(reqIdHex, mint);
              console.log(`[Sweep] Successfully swept ${result.amount} atomic units for ${reqIdHex}`);
              // Persist swept state
              try {
                const secretsFile = path.join(__dirname, 'lp-secrets.json');
                if (fs.existsSync(secretsFile)) {
                  const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
                  if (secrets[reqIdHex]) {
                    secrets[reqIdHex].swept = true;
                    secrets[reqIdHex].sweepTxHashes = result.txHashes;
                    secrets[reqIdHex].sweepAmount = result.amount.toString();
                    fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
                  }
                }
              } catch (persistErr) {
                console.warn(`[Sweep] Could not persist swept state for ${reqIdHex}:`, persistErr.message);
              }
            } else {
              console.log(`[Sweep] Not yet sweepable for ${reqIdHex} — see Monero log for details. Will retry on next poll.`);
              mint.sweepAttempted = false; // allow retry
              pendingMints.set(reqIdHex, mint);
            }
          } catch (err) {
            console.error(`[Sweep] Failed for ${reqIdHex}:`, err.message || err);
            mint.sweepAttempted = false; // allow retry
            pendingMints.set(reqIdHex, mint);
          }
        })();
      }

      // Poll for MintCancelled — cleanup
      let cancelledEvents = [];
      try {
        const cancelledFilter = hub.filters.MintCancelled();
        cancelledEvents = await queryFilterChunked(hub, cancelledFilter, fromBlock, currentBlock);
      } catch (err) {
        // Non-critical
      }

      for (const event of cancelledEvents) {
        const { requestId } = event.args;
        const reqIdHex = ethers.hexlify(requestId);
        if (pendingMints.has(reqIdHex)) {
          console.log(`[Event] MintCancelled ${reqIdHex} — cleaning up`);
          pendingMints.delete(reqIdHex);
        }
      }

      // Poll for MintKeyCancelled — a KEY_PROVIDED mint timed out into KEY_CANCELLED.
      // The parked griefing deposit is now claimable: abandonKeyProvidedMint pays it
      // to the LP and publishes lpSecret on-chain so the user can sweep their XMR.
      let keyCancelledEvents = [];
      try {
        const keyCancelledFilter = hub.filters.MintKeyCancelled();
        keyCancelledEvents = await queryFilterChunked(hub, keyCancelledFilter, fromBlock, currentBlock);
      } catch (err) {
        // Non-critical
      }

      for (const event of keyCancelledEvents) {
        const { requestId } = event.args;
        const reqIdHex = ethers.hexlify(requestId);
        // Load persisted lpSecret from disk (same pattern as the sweep path)
        let entry = null;
        try {
          const secretsFile = path.join(__dirname, 'lp-secrets.json');
          if (fs.existsSync(secretsFile)) {
            const secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
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
            const abandonNonce = await getNextNonce();
            const tx = await hub.abandonKeyProvidedMint(reqIdHex, entry.lpSecret, { nonce: abandonNonce });
            await tx.wait();
            console.log(`[Event] MintKeyCancelled ${reqIdHex} — deposit claimed, lpSecret published (tx: ${tx.hash})`);
            pendingMints.delete(reqIdHex);
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

// ─── Periodic Stale Burn Check ──────────────────────────────────────────────
// Checks tracked burns every 60s for PROPOSED burns with expired deadlines.
// Abandoning releases the LP's locked collateral; the user can still late-claim
// wsXMR via resolveDeclinedProposal, which reveals userSecret so the LP can
// sweep the shared XMR back.
setInterval(async () => {
  try {
    const currentBlock = await provider.getBlockNumber();
    const { pendingBurns } = await import('./burnHandler.js');
    for (const [reqIdHex, burn] of pendingBurns.entries()) {
      if (burn.state !== 'proposed') continue;
      try {
        const burnReq = await hub.getBurnRequest(reqIdHex);
        const status = Number(burnReq.status);
        const deadline = Number(burnReq.deadline);
        if (status === 2 && currentBlock >= deadline) {
          console.log(`[Resolve] Burn ${reqIdHex} deadline passed — abandoning to release collateral...`);
          try {
            const abandonNonce = await getNextNonce();
            const tx = await hub.abandonProposedBurn(reqIdHex, { nonce: abandonNonce });
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
    console.warn('[Resolve] Periodic stale burn check failed:', err.message);
  }
}, 60000);

// ─── Mint Deposit Scan Auto-Retry ───────────────────────────────────────────
// Periodically retry mints that failed auto-processing (e.g. deposit scan timeout).
// Re-runs processMint for mints in KEY_PROVIDED status with autoProcessError set.
// Limits to 3 retries per mint to avoid infinite loops.

setInterval(async () => {
  for (const [reqIdHex, mint] of pendingMints.entries()) {
    if (!mint.autoProcessError) continue;
    if (mint.processing) continue;
    if (mint.retryCount >= 3) continue;

    try {
      const mintReq = await hub.getMintRequest(reqIdHex);
      const status = Number(mintReq.status);
      // Only retry if still KEY_PROVIDED (2) — deposit may have arrived since last attempt
      if (status !== 2) {
        if (status === 5 || status === 6) {
          pendingMints.delete(reqIdHex);
        }
        continue;
      }

      mint.retryCount = (mint.retryCount || 0) + 1;
      mint.processing = true;
      mint.autoProcessError = null;
      pendingMints.set(reqIdHex, mint);

      console.log(`[Retry] Re-attempting mint ${reqIdHex} (retry ${mint.retryCount}/3)`);

      const lpSpendKey = await hub.lpPublicKeys(reqIdHex);
      const lpViewKey = await hub.lpPublicViewKeys(reqIdHex);

      (async () => {
        try {
          await processMint(reqIdHex, lpSpendKey, lpViewKey);
        } catch (err) {
          console.error(`[Retry] Failed retry for mint ${reqIdHex}:`, err.message || err);
          const m = pendingMints.get(reqIdHex) || {};
          m.autoProcessError = err.message || String(err);
          m.processing = false;
          pendingMints.set(reqIdHex, m);
        }
      })();
    } catch (err) {
      console.warn(`[Retry] Could not check mint ${reqIdHex} for retry:`, err.message);
    }
  }
}, 300000); // 5 minutes

// ─── HTTP Routes ────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', wallet: wallet.address, hub: HUB_ADDRESS });
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
  console.log(`[HTTP] Received LP key for ${reqIdHex}`);

  try {
    // Kick off processing without blocking the response
    res.json({
      success: true,
      requestId: reqIdHex,
      message: 'Processing started. provideLPKey then setMintReady will follow.',
    });

    await processMint(reqIdHex, lpPublicSpendKey, lpPublicViewKey);
  } catch (err) {
    console.error(`[Error] Failed processing /mint/key for ${reqIdHex}:`, err.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || String(err), requestId: reqIdHex });
    }
  }
});

// List tracked mints
app.get('/mints', (_req, res) => {
  const list = Array.from(pendingMints.values());
  res.json({ mints: list, count: list.length });
});

// Burn status — lets the frontend show the real Monero txid without waiting
// for the browser WASM scan. Falls back to persisted secrets file.
app.get('/burn/:requestId', (req, res) => {
  const reqId = req.params.requestId;
  if (!/^0x[0-9a-fA-F]{64}$/.test(reqId)) {
    return res.status(400).json({ error: 'Invalid requestId — must be 0x + 64 hex chars' });
  }
  const burn = burnHandler.pendingBurns.get(reqId);
  if (burn) {
    return res.json({
      requestId: reqId,
      state: burn.state,
      moneroTxHash: burn.moneroTxHash || null,
      sharedAddress: burn.sharedAddress || null,
      error: burn.error || null,
    });
  }
  try {
    const secrets = JSON.parse(fs.readFileSync(path.join(__dirname, 'lp-burn-secrets.json'), 'utf8'));
    const saved = secrets[reqId];
    if (saved) {
      return res.json({
        requestId: reqId,
        state: saved.state || null,
        moneroTxHash: saved.moneroTxHash || null,
        sharedAddress: saved.sharedAddress || null,
        error: saved.error || null,
      });
    }
  } catch {}
  res.status(404).json({ error: 'Burn not tracked by this LP' });
});

// Manually trigger deposit scan for a mint (useful when LP keys were already provided)
app.post('/mint/scan', async (req, res) => {
  const { requestId } = req.body;
  if (!requestId) {
    return res.status(400).json({ error: 'requestId required' });
  }
  const reqIdHex = ethers.hexlify(requestId);

  try {
    // Get on-chain status and LP keys
    const mintReq = await hub.getMintRequest(reqIdHex);
    const status = Number(mintReq.status);
    if (status === 5 || status === 6) {
      return res.json({ success: false, message: `Mint already ${status === 5 ? 'completed' : 'cancelled'}` });
    }

    const lpSpendKey = await hub.lpPublicKeys(reqIdHex);
    const lpViewKey = await hub.lpPublicViewKeys(reqIdHex);
    if (lpSpendKey === '0x0000000000000000000000000000000000000000000000000000000000000000') {
      return res.status(400).json({ error: 'LP keys not yet provided for this mint' });
    }

    // Store in pendingMints if not already there
    const mint = pendingMints.get(reqIdHex) || {
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
    pendingMints.set(reqIdHex, mint);

    res.json({
      success: true,
      requestId: reqIdHex,
      message: 'Deposit scan started. Will call setMintReady when deposit is found.',
      depositAddress: mint.depositAddress || 'computing...',
      xmrAmount: mint.xmrAmount,
    });

    // Run processMint async (it will skip provideLPKey since status >= 2)
    processMint(reqIdHex, lpSpendKey, lpViewKey).catch(err => {
      console.error(`[Mint] Manual scan failed for ${reqIdHex}:`, err.message);
    });
  } catch (err) {
    console.error(`[Error] /mint/scan failed for ${reqIdHex}:`, err.message);
    res.status(500).json({ error: err.message, requestId: reqIdHex });
  }
});

// ─── Submit deposit proof (check_tx_key) — OPTIONAL FALLBACK ────────────────
// DEPRECATED: deposits are LP-viewable and scanned directly by pollForDeposit.
// This endpoint remains for compatibility — if a user submits txid + txKey, we
// verify via check_tx_key against the deposit address and proceed to
// setMintReady. Body: { requestId, txid, txKey }.
app.post('/mint/deposit', async (req, res) => {
  const { requestId, txid, txKey } = req.body || {};
  if (!requestId || !txid || !txKey) {
    return res.status(400).json({ error: 'requestId, txid and txKey required' });
  }
  if (!/^[0-9a-fA-F]{64}$/.test(txid) || !/^[0-9a-fA-F]{64}$/.test(txKey)) {
    return res.status(400).json({ error: 'txid and txKey must be 64-char hex' });
  }

  const reqIdHex = ethers.hexlify(requestId);
  const mint = pendingMints.get(reqIdHex);
  if (!mint || !mint.depositAddress) {
    return res.status(409).json({
      error: 'Mint deposit address not computed yet — retry shortly',
      requestId: reqIdHex,
    });
  }

  // On-chain status guard — only KEY_PROVIDED can still reach setMintReady.
  // If the mint already died (timed out / cancelled), check_tx_key would still
  // succeed (the XMR is really there) but setMintReady would revert — so tell the
  // user to recover instead of returning a misleading 'verified'.
  // MintStatus: 0=INVALID,1=PENDING,2=KEY_PROVIDED,3=READY,4=SECRET_REVEALED,5=COMPLETED,6=CANCELLED,7=EXPIRED_READY,8=KEY_CANCELLED
  try {
    const mintReq = await hub.getMintRequest(reqIdHex);
    const status = Number(mintReq.status);
    if (status === 3 || status === 4 || status === 5) {
      // Already past the deposit step — nothing to verify.
      return res.json({ verified: true, alreadyReady: true, status, requestId: reqIdHex });
    }
    if (status !== 2) {
      // Terminal/dead mint — the deposit can't be attested. User should recover.
      return res.status(409).json({
        verified: false,
        deadMint: true,
        status,
        error: 'Mint is no longer active on-chain — recover your XMR via the lpSecret reveal instead of submitting a deposit proof.',
        requestId: reqIdHex,
      });
    }
  } catch (statusErr) {
    // Don't block the happy path on a flaky status read — proceed to check_tx_key.
    console.warn(`[Mint] Could not read on-chain status for ${reqIdHex} (proceeding):`, statusErr.message);
  }

  if (!moneroWallet.isWalletConfigured()) {
    return res.status(503).json({ error: 'MONERO_WALLET_RPC_URL not configured on LP', requestId: reqIdHex });
  }

  try {
    // Legacy mints may have received the deposit at the OLD-scheme address
    // (view=userPub) — check every candidate address until one reports received.
    const candidateAddresses = [mint.depositAddress];
    if (mint.legacyDepositAddress && mint.legacyDepositAddress !== mint.depositAddress) {
      candidateAddresses.push(mint.legacyDepositAddress);
    }
    let result = null;
    let matchedAddress = mint.depositAddress;
    for (const addr of candidateAddresses) {
      const r = await moneroWallet.checkTxKey(txid, txKey, addr);
      if (r.received > 0n) {
        result = r;
        matchedAddress = addr;
        break;
      }
      if (!result) result = r;
    }
    const expected = BigInt(mint.xmrAmount || '0');
    // 3% tolerance for fees / rounding (matches previous scan tolerance)
    const minReceived = expected - (expected * 300n / 10000n);
    if (result.received < minReceived) {
      return res.status(402).json({
        verified: false,
        error: `Insufficient deposit to ${matchedAddress}: received ${result.received} < expected ${expected}`,
        received: result.received.toString(),
        expected: expected.toString(),
        requestId: reqIdHex,
      });
    }

    const depositTx = {
      txid,
      amount: result.received,
      confirmations: result.confirmations,
      inPool: result.inPool,
    };
    mint.depositTx = depositTx;
    pendingMints.set(reqIdHex, mint);
    depositProofs.set(reqIdHex, { verified: true, depositTx });
    console.log(`[Mint] Deposit proof accepted for ${reqIdHex}: txid=${txid} received=${result.received} conf=${result.confirmations}`);

    res.json({
      success: true,
      verified: true,
      requestId: reqIdHex,
      received: result.received.toString(),
      confirmations: result.confirmations,
      inPool: result.inPool,
    });

    // Unblock the parked processMint if it's waiting; otherwise drive finalization
    // directly (processMint timed out or the server restarted).
    const waiter = depositWaiters.get(reqIdHex);
    if (waiter) {
      depositWaiters.delete(reqIdHex);
      waiter(depositTx);
    } else {
      finalizeMint(reqIdHex, mint, mint.lpCommitment).catch(err =>
        console.error(`[Mint] finalizeMint after /mint/deposit failed for ${reqIdHex}:`, err.message));
    }
  } catch (err) {
    console.error(`[Mint] check_tx_key failed for ${reqIdHex}:`, err.message);
    res.status(502).json({ verified: false, error: err.message, requestId: reqIdHex });
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

// ─── Burn Handler Integration ───────────────────────────────────────────────
burnHandler.registerRoutes(app);

// Monero daemon proxy — translates binary endpoints restricted nodes block
// (get_outs.bin) into JSON-RPC calls. Raw body parser: binary + JSON forwarded
// verbatim to the upstream daemon.
app.use('/monero-daemon', express.raw({ type: () => true, limit: '10mb' }), moneroDaemonProxyRouter);

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`HTTP server listening on http://localhost:${PORT}`);
  try {
    await startEventListener();
  } catch (err) {
    console.error('[Startup] Event listener failed after retries:', err.message);
    console.error('[Startup] Server will continue but event polling may be delayed.');
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
  try {
    await startupRecoverMints();
  } catch (err) {
    console.error('[Startup] Mint recovery failed:', err.message);
  }
  try {
    await startupResolveStale();
  } catch (err) {
    console.error('[Startup] Stale resolution failed:', err.message);
  }
  try {
    await startupSweepFinalizedMints();
  } catch (err) {
    console.error('[Startup] Sweep finalized mints failed:', err.message);
  }
  try {
    burnHandler.attachEventListeners(hub, wallet, provider);
  } catch (err) {
    console.error('[Startup] Burn handler attach failed:', err.message);
  }
  try {
    await burnHandler.startupRecoverBurns();
  } catch (err) {
    console.error('[Startup] Burn recovery failed:', err.message);
  }
  console.log('[Startup] All startup tasks attempted. Server is running.');
});