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
import { setHubWallet, updateOraclePricesManual } from './oracleUpdate.js';
import crypto from 'crypto';

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
  'event MintFinalized(bytes32 indexed requestId, bytes32 secret)',
  'event MintCancelled(bytes32 indexed requestId)',
  // Burn events
  'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral, bytes32 claimCommitment, bytes32 userPublicKey, bytes32 userViewKey)',
  'event HashProposed(bytes32 indexed requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey)',
  'event BurnCommitted(bytes32 indexed requestId, uint256 deadline)',
  'event BurnFinalized(bytes32 indexed requestId, bytes32 secret, uint256 rewardPaid)',
  'event BurnCancelled(bytes32 indexed requestId)',
  'event BurnAborted(bytes32 indexed requestId)',
  // Functions
  'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
  'function setMintReady(bytes32 requestId, bytes32 lpCommitment) external payable',
  'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps))',
  'function proposeHash(bytes32 requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
  'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
  'function claimSlashedCollateral(bytes32 requestId) external',
  'function resolveDeclinedProposal(bytes32 requestId) external',
  'function getBurnRequest(bytes32 requestId) external view returns (tuple(address user, address lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 feeAmount, uint256 collateralLocked, uint256 rewardCollateral, bytes32 claimCommitment, bytes32 secretHash, uint256 timeout, uint256 commitDeadline, uint256 state))',
  'function getMintRequest(bytes32 requestId) external view returns (tuple(bytes32 requestId, address initiator, address recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout, uint256 griefingDeposit, uint256 lpBond, uint256 normalizedDebtAmount, uint256 vaultMintNonce, uint8 status))',
  'function lpPublicKeys(bytes32 requestId) external view returns (bytes32)',
  'function lpPublicViewKeys(bytes32 requestId) external view returns (bytes32)',
  'function updateOraclePrices(bytes[] calldata updateData) external payable',
  'function cancelMint(bytes32 requestId) external',
];

// ─── Ethers Setup ───────────────────────────────────────────────────────────
const gnosisNetwork = new ethers.Network('gnosis', CHAIN_ID);
const provider = new ethers.JsonRpcProvider(RPC_URL, gnosisNetwork, { staticNetwork: true });
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, wallet);

console.log(`LP Server starting...`);
console.log(`Wallet / LP Vault: ${wallet.address}`);
console.log(`Hub: ${HUB_ADDRESS}`);
console.log(`RPC: ${RPC_URL}`);

// ─── In-memory tracking ─────────────────────────────────────────────────────
const pendingMints = new Map(); // requestId -> { initiatedAt, keyPostedAt }
let lpMoneroAddress = process.env.MONERO_LP_ADDRESS || null; // fetched from wallet at startup

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
  
  const spendPriv = ed.utils.randomPrivateKey();
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

  const spendPub = scalarToPubKey(spendPriv);
  const viewPub = scalarToPubKey(viewPriv);
  return {
    lpPublicSpendKey: '0x' + spendPub.toString('hex'),
    lpPublicViewKey: '0x' + viewPub.toString('hex'),
  };
}

// ─── Oracle Price Update: imported from oracleUpdate.js ────────────────────
// Initialize with hub and wallet instances
setHubWallet(hub, wallet, HUB_ADDRESS);

// ─── Core Mint Processing ───────────────────────────────────────────────────
async function processMint(reqIdHex, lpPublicSpendKey, lpPublicViewKey) {
  console.log(`[Mint] Processing ${reqIdHex}`);

  const mint = pendingMints.get(reqIdHex) || {};

  // 0. Check on-chain status to handle restarts gracefully
  let onChainStatus = -1;
  try {
    const mintReq = await hub.getMintRequest(reqIdHex);
    onChainStatus = Number(mintReq.status);
    console.log(`[Chain] Mint ${reqIdHex} on-chain status: ${onChainStatus} (1=PENDING, 2=KEY_PROVIDED, 3=READY, 4=COMPLETED, 5=CANCELLED)`);

    if (onChainStatus === 4 || onChainStatus === 5) {
      console.log(`[Mint] Mint already ${onChainStatus === 4 ? 'completed' : 'cancelled'}, skipping`);
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
  } catch (err) {
    console.warn(`[Chain] Could not query mint status, proceeding anyway:`, err.message);
  }

  // 1. Provide LP key on-chain (skip if already provided)
  if (onChainStatus < 2) {
    console.log(`[Chain] Calling provideLPKey(${reqIdHex})...`);
    const tx1 = await hub.provideLPKey(reqIdHex, lpPublicSpendKey, lpPublicViewKey);
    console.log(`[Chain] provideLPKey tx: ${tx1.hash}`);
    const receipt1 = await tx1.wait();
    console.log(`[Chain] provideLPKey confirmed in block ${receipt1.blockNumber}`);
  }

  mint.keyPostedAt = Date.now();
  mint.lpPublicSpendKey = lpPublicSpendKey;
  mint.lpPublicViewKey = lpPublicViewKey;
  pendingMints.set(reqIdHex, mint);

  // 2. Compute deposit address so the user knows where to send XMR
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

  // 3. Wait for the Monero deposit to arrive
  const expectedAmount = BigInt(mint.xmrAmount || '0');
  if (expectedAmount > 0n && moneroWallet.isWalletConfigured()) {
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
    try {
      const depositTx = await moneroWallet.pollForDeposit(expectedAmount, {
        depositAddress: mint.depositAddress,
        restoreHeight: scanHeight,
        toleranceBps: 200,   // 2% tolerance for fees / rounding
        intervalMs: 15000,   // 15s
        maxWaitMs: 600000,   // 10 min
      });
      mint.depositTx = depositTx;
      console.log(`[Mint] Deposit confirmed: ${depositTx.txid} (amount=${depositTx.amount})`);
    } catch (scanErr) {
      console.error(`[Mint] Deposit scan failed for ${reqIdHex}:`, scanErr.message);
      mint.autoProcessError = scanErr.message;
      pendingMints.set(reqIdHex, mint);
      return; // Do NOT call setMintReady if deposit was not found
    }
  } else if (expectedAmount > 0n) {
    console.warn(`[Mint] MONERO_WALLET_RPC_URL not configured — skipping deposit verification`);
    console.warn(`         To enable real scanning, set MONERO_WALLET_RPC_URL in .env`);
  }

  // 4. Update oracle prices before setMintReady (contract requires fresh price for collateral check)
  try {
    await updateOraclePricesManual();
  } catch (priceErr) {
    console.warn(`[Chain] Oracle price update failed: ${priceErr.message}`);
    console.warn(`[Chain] Proceeding with setMintReady anyway (may revert with StalePrice)...`);
  }

  // 5. Generate LP secret + commitment for the mint PTLC
  const lpSecret = crypto.randomBytes(32);
  const { secretHash: lpCommitment } = await computeSecretHash(lpSecret);
  mint.lpSecret = '0x' + lpSecret.toString('hex');
  mint.lpCommitment = lpCommitment;
  pendingMints.set(reqIdHex, mint);
  console.log(`[Mint] LP commitment for ${reqIdHex}: ${lpCommitment}`);

  // Persist lpSecret to disk so we can sweep XMR after finalization even if server restarts
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
    };
    fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
  } catch (err) {
    console.warn(`[Mint] Could not persist lpSecret for ${reqIdHex}:`, err.message);
  }

  // 6. Fetch required bond from vault config and call setMintReady
  const vault = await hub.getVault(wallet.address);
  const requiredBond = vault.mintReadyBond;
  console.log(`[Chain] Vault mintReadyBond: ${ethers.formatEther(requiredBond)} ETH`);

  console.log(`[Chain] Calling setMintReady(${reqIdHex}, ${lpCommitment}) with bond ${ethers.formatEther(requiredBond)} ETH...`);
  const tx2 = await hub.setMintReady(reqIdHex, lpCommitment, { value: requiredBond });
  console.log(`[Chain] setMintReady tx: ${tx2.hash}`);
  const receipt2 = await tx2.wait();
  console.log(`[Chain] setMintReady confirmed in block ${receipt2.blockNumber}`);
}

// ─── Startup Recovery: Find active mints that need setMintReady ─────────────
async function startupRecoverMints() {
  console.log('[Recovery] Scanning for active mints needing setMintReady...');
  const currentBlock = await provider.getBlockNumber();
  // Scan last 10000 blocks (~3.5 days on Gnosis at 5s blocks)
  const fromBlock = Math.max(0, currentBlock - 10000);

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

      if (status === 4 || status === 5) {
        continue; // completed or cancelled
      }

      if (status === 2) {
        // KEY_PROVIDED — deposit may have arrived, need to update oracle + setMintReady
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
          processing: true,
        });

        (async () => {
          try {
            await serializeMint(() => processMint(reqIdHex, lpSpendKey, lpViewKey));
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
          processing: true,
        });

        (async () => {
          try {
            const keys = await generateEd25519Keys();
            console.log(`[Recovery] Generated Ed25519 keys for ${reqIdHex}`);
            await serializeMint(() => processMint(reqIdHex, keys.lpPublicSpendKey, keys.lpPublicViewKey));
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

      if (status === 5) {
        // Cancelled — no XMR to sweep
        console.log(`[Sweep] ${reqIdHex} was cancelled — marking swept (nothing to collect)`);
        entry.swept = true;
        continue;
      }

      if (status !== 4) {
        // Not yet finalized — skip
        console.log(`[Sweep] ${reqIdHex} status=${status} (not finalized) — skipping`);
        continue;
      }

      // Status is COMPLETED — need to find the MintFinalized event to get user's secret
      console.log(`[Sweep] ${reqIdHex} is COMPLETED — looking for MintFinalized event...`);

      // Scan recent blocks for the MintFinalized event
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 10000);
      const filter = hub.filters.MintFinalized(reqIdHex);
      const events = await hub.queryFilter(filter, fromBlock, currentBlock);

      if (events.length === 0) {
        console.warn(`[Sweep] Could not find MintFinalized event for ${reqIdHex} — skipping`);
        continue;
      }

      const userSecret = ethers.hexlify(events[0].args.secret);
      console.log(`[Sweep] Found MintFinalized for ${reqIdHex}, sweeping XMR...`);

      const result = await moneroWallet.sweepMintDeposit({
        userSecretHex: userSecret,
        lpSecretHex: entry.lpSecret,
        lpViewKeyHex: process.env.MONERO_VIEW_KEY,
        lpMainAddress: lpMoneroAddress,
        restoreHeight: entry.initiatedAtBlock || 0,
      });

      if (result.swept) {
        entry.swept = true;
        entry.sweepTxHashes = result.txHashes;
        entry.sweepAmount = result.amount.toString();
        console.log(`[Sweep] Successfully swept ${result.amount} atomic units for ${reqIdHex}`);
      } else {
        console.log(`[Sweep] Could not sweep ${reqIdHex} yet — funds may be confirming. Will retry on next poll.`);
        // Load into pendingMints so the event poller can retry
        pendingMints.set(reqIdHex, {
          requestId: reqIdHex,
          lpSecret: entry.lpSecret,
          initiatedAtBlock: entry.initiatedAtBlock || 0,
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
  const fromBlock = Math.max(0, currentBlock - 10000);
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
          const tx = await hub.cancelMint(reqIdHex);
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

  // ── Stale Burns: resolve declined proposals ──
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
      const state = Number(burnReq.state);
      const deadline = Number(burnReq.timeout);

      // State 2=PROPOSED — resolve if deadline passed (LP didn't commit or user didn't confirm)
      if (state === 2 && currentBlock >= deadline) {
        console.log(`[Resolve] Burn ${reqIdHex} is stale (PROPOSED, deadline=${deadline}, current=${currentBlock}), resolving...`);
        try {
          const tx = await hub.resolveDeclinedProposal(reqIdHex);
          await tx.wait();
          console.log(`[Resolve] Burn ${reqIdHex} resolved (tx: ${tx.hash})`);
        } catch (err) {
          console.warn(`[Resolve] Failed to resolve burn ${reqIdHex}:`, err.shortMessage || err.message);
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

      // Retry on rate limit
      let retries = 3;
      let events = [];
      while (retries > 0) {
        try {
          const filter = hub.filters.MintInitiated();
          events = await hub.queryFilter(filter, lastCheckedBlock + 1, currentBlock);
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
            await serializeMint(() => processMint(reqIdHex, keys.lpPublicSpendKey, keys.lpPublicViewKey));
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
        finalizedEvents = await hub.queryFilter(finalizedFilter, lastCheckedBlock + 1, currentBlock);
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
            const result = await moneroWallet.sweepMintDeposit({
              userSecretHex: ethers.hexlify(secret),
              lpSecretHex: mint.lpSecret,
              lpViewKeyHex: process.env.MONERO_VIEW_KEY,
              lpMainAddress: lpMoneroAddress,
              restoreHeight,
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
              console.log(`[Sweep] Could not sweep yet for ${reqIdHex} — funds may be confirming. Will retry on next poll.`);
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
        cancelledEvents = await hub.queryFilter(cancelledFilter, lastCheckedBlock + 1, currentBlock);
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

      lastCheckedBlock = currentBlock;
    } catch (err) {
      console.error('[Event] Poll error:', err.message);
    }
  }, 15000);
}

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
        if (status === 4 || status === 5) {
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

      serializeMint(async () => {
        try {
          await processMint(reqIdHex, lpSpendKey, lpViewKey);
        } catch (err) {
          console.error(`[Retry] Failed retry for mint ${reqIdHex}:`, err.message || err);
          const m = pendingMints.get(reqIdHex) || {};
          m.autoProcessError = err.message || String(err);
          m.processing = false;
          pendingMints.set(reqIdHex, m);
        }
      });
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

    await serializeMint(() => processMint(reqIdHex, lpPublicSpendKey, lpPublicViewKey));
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
    if (status === 4 || status === 5) {
      return res.json({ success: false, message: `Mint already ${status === 4 ? 'completed' : 'cancelled'}` });
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
    serializeMint(() => processMint(reqIdHex, lpSpendKey, lpViewKey)).catch(err => {
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
      console.log('[Startup] Monero wallet ready');
      // Fetch LP's main Monero address for sweeping
      if (!lpMoneroAddress) {
        try {
          const addrInfo = await moneroWallet.getAddresses(0);
          lpMoneroAddress = addrInfo.primary;
          console.log(`[Startup] LP Monero address: ${lpMoneroAddress}`);
        } catch (err) {
          console.warn('[Startup] Could not fetch LP Monero address:', err.message);
        }
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