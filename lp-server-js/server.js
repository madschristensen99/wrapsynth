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
  'function claimSlashedCollateral(bytes32 requestId) external',
  'function resolveDeclinedProposal(bytes32 requestId, bytes32 userSecret) external',
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

// ─── Deposit-proof coordination (check_tx_key flow) ─────────────────────────
// Mint deposits are user-viewable, so the LP cannot scan them. processMint parks
// on a waiter in depositWaiters until the user submits txid+txKey via /mint/deposit,
// which verifies via check_tx_key and resolves the waiter. depositProofs stores the
// verified result so a proof submitted before processMint starts waiting still counts.
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
  
  // Generate ONE secret that serves as both the LP's PTLC secret AND the LP's
  // Monero spend key contribution. The deposit address is derived from this,
  // and the sweep uses the same value to reconstruct the private key.
  const lpSpendPriv = crypto.randomBytes(32);
  // Use LP's wallet view key so we can scan deposit addresses with a view-only wallet
  const viewPriv = Buffer.from(process.env.MONERO_VIEW_KEY, 'hex');

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
  const viewPub = scalarToPubKey(viewPriv);
  return {
    lpPublicSpendKey: '0x' + spendPub.toString('hex'),
    lpPublicViewKey: '0x' + viewPub.toString('hex'),
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
  if (userPublicKey) {
    try {
      const depositAddress = await moneroCrypto.computeDepositAddress(userPublicKey, lpPublicSpendKey, lpPublicViewKey);
      mint.depositAddress = depositAddress;
      console.log(`[Mint] Deposit address for ${reqIdHex}: ${depositAddress}`);
    } catch (err) {
      console.warn(`[Mint] Could not compute deposit address:`, err.message);
    }
  }

  // 4. Wait for the user to submit the deposit proof (txid + tx key) via /mint/deposit.
  //    The deposit is USER-VIEWABLE (view pub = user's key), so the LP cannot scan it.
  //    The user proves the payment with the tx secret key and the LP verifies via
  //    check_tx_key — this is what makes the deposit recoverable by the user if the
  //    LP later ghosts.
  const expectedAmount = BigInt(mint.xmrAmount || '0');
  if (expectedAmount > 0n && moneroWallet.isWalletConfigured()) {
    console.log(`[Mint] Waiting for deposit proof (txid + tx key) for ${expectedAmount} atomic units...`);
    try {
      const depositTx = await waitForDepositProof(reqIdHex, { maxWaitMs: DEPOSIT_PROOF_TIMEOUT_MS });
      mint.depositTx = depositTx;
      pendingMints.set(reqIdHex, mint);
      console.log(`[Mint] Deposit verified: ${depositTx.txid} (received=${depositTx.amount})`);
    } catch (waitErr) {
      console.error(`[Mint] Deposit proof wait failed for ${reqIdHex}:`, waitErr.message);
      mint.autoProcessError = waitErr.message;
      pendingMints.set(reqIdHex, mint);
      return; // Do NOT call setMintReady if deposit was not verified
    }
  } else if (expectedAmount > 0n) {
    console.warn(`[Mint] MONERO_WALLET_RPC_URL not configured — skipping deposit verification`);
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

  // 6. Persist lpSecret to disk so we can sweep XMR after finalization even if server restarts
  try {
    const secretsFile = path.join(__dirname, 'lp-secrets.json');
    let secrets = {};
    if (fs.existsSync(secretsFile)) {
      secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
    }
    secrets[reqIdHex] = {
      lpSecret: mint.lpSecret,
      lpCommitment: lpCommitment,
      initiatedAtBlock: mint.initiatedAtBlock || 0,
      xmrAmount: mint.xmrAmount,
      depositTxHash: mint.depositTx ? mint.depositTx.txid : undefined,
      depositHeight: mint.depositTx ? mint.depositTx.height : undefined,
    };
    fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
  } catch (err) {
    console.warn(`[Mint] Could not persist lpSecret for ${reqIdHex}:`, err.message);
  }

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
    events = await hub.queryFilter(filter, fromBlock, currentBlock);
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

  if (!process.env.MONERO_VIEW_KEY || !lpMoneroAddress) {
    console.warn('[Sweep] MONERO_VIEW_KEY or LP Monero address not available — cannot sweep');
    return;
  }

  for (const reqIdHex of reqIds) {
    const entry = secrets[reqIdHex];
    if (entry.swept) {
      console.log(`[Sweep] ${reqIdHex} already swept — skipping`);
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
      const events = await hub.queryFilter(filter, fromBlock, currentBlock);

      let userSecret;
      if (events.length > 0) {
        userSecret = ethers.hexlify(events[0].args.secret);
      } else {
        // Fall back to MintFinalized event (same secret, emitted at finalization)
        const finalizeFilter = hub.filters.MintFinalized(reqIdHex);
        const finalizeEvents = await hub.queryFilter(finalizeFilter, fromBlock, currentBlock);
        if (finalizeEvents.length === 0) {
          console.warn(`[Sweep] Could not find SecretRevealed or MintFinalized event for ${reqIdHex} — skipping`);
          continue;
        }
        userSecret = ethers.hexlify(finalizeEvents[0].args.secret);
      }

      console.log(`[Sweep] Found secret for ${reqIdHex}, sweeping XMR...`);

      const result = await moneroWallet.sweepMintDeposit({
        userSecretHex: userSecret,
        lpSecretHex: entry.lpSecret,
        lpViewKeyHex: process.env.MONERO_VIEW_KEY,
        lpMainAddress: lpMoneroAddress,
        restoreHeight: entry.initiatedAtBlock || 0,
        depositHeight: entry.depositHeight || 0,
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
    mintEvents = await hub.queryFilter(hub.filters.MintInitiated(), fromBlock, currentBlock);
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
    burnEvents = await hub.queryFilter(hub.filters.BurnRequested(), fromBlock, currentBlock);
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

      // State 2=PROPOSED — log if deadline passed, waiting for user to resolve
      if (state === 2 && currentBlock >= deadline) {
        console.log(`[Resolve] Burn ${reqIdHex} is stale (PROPOSED, deadline=${deadline}, current=${currentBlock}) — waiting for user to call resolveDeclinedProposal with their userSecret`);
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
          events = await hub.queryFilter(filter, fromBlock, currentBlock);
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
          }
        })();
      }

      // Poll for MintFinalized — sweep XMR from deposit address to LP wallet
      let finalizedEvents = [];
      try {
        const finalizedFilter = hub.filters.MintFinalized();
        finalizedEvents = await hub.queryFilter(finalizedFilter, fromBlock, currentBlock);
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
            if (!process.env.MONERO_VIEW_KEY || !lpMoneroAddress) {
              console.warn(`[Sweep] MONERO_VIEW_KEY or LP Monero address not available — skipping sweep for ${reqIdHex}`);
              return;
            }

            // Use the block number from the MintInitiated event as restore height
            const restoreHeight = mint.initiatedAtBlock || 0;
            console.log(`[Sweep] Sweeping XMR for ${reqIdHex}...`);
            if (mint.depositTx) {
              console.log(`[Sweep]   deposit tx: ${mint.depositTx.txid}, height: ${mint.depositTx.height}`);
            }
            const result = await moneroWallet.sweepMintDeposit({
              userSecretHex: ethers.hexlify(secret),
              lpSecretHex: mint.lpSecret,
              lpViewKeyHex: process.env.MONERO_VIEW_KEY,
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
        cancelledEvents = await hub.queryFilter(cancelledFilter, fromBlock, currentBlock);
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
        keyCancelledEvents = await hub.queryFilter(keyCancelledFilter, fromBlock, currentBlock);
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
// The LP cannot call resolveDeclinedProposal (requires userSecret which only the user knows).
// Instead, we just log stale burns and wait for the user to resolve.
// When the user resolves, BurnProposalDeclined is emitted and the LP's burnHandler
// will sweep the shared XMR back to the LP's wallet.
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
          console.log(`[Resolve] Burn ${reqIdHex} is stale (PROPOSED, deadline=${deadline}, current=${currentBlock}) — waiting for user to resolve`);
          burn.state = 'stale';
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

// ─── Submit deposit proof (check_tx_key) ────────────────────────────────────
// Mint deposits are user-viewable, so the LP cannot scan them. After sending XMR
// the user submits the txid + transaction secret key (r) here; the LP runs
// check_tx_key against the deposit address to confirm how much was received, then
// proceeds to setMintReady. Body: { requestId, txid, txKey }.
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
    const result = await moneroWallet.checkTxKey(txid, txKey, mint.depositAddress);
    const expected = BigInt(mint.xmrAmount || '0');
    // 3% tolerance for fees / rounding (matches previous scan tolerance)
    const minReceived = expected - (expected * 300n / 10000n);
    if (result.received < minReceived) {
      return res.status(402).json({
        verified: false,
        error: `Insufficient deposit to ${mint.depositAddress}: received ${result.received} < expected ${expected}`,
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