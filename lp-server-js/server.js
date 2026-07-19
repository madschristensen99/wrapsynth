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
  // Burn events
  'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral, bytes32 claimCommitment)',
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
const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, wallet);

console.log(`LP Server starting...`);
console.log(`Wallet / LP Vault: ${wallet.address}`);
console.log(`Hub: ${HUB_ADDRESS}`);
console.log(`RPC: ${RPC_URL}`);

// ─── In-memory tracking ─────────────────────────────────────────────────────
const pendingMints = new Map(); // requestId -> { initiatedAt, keyPostedAt }

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

// ─── Oracle Price Update (manual RedStone payload, bypasses WrapperBuilder) ──
async function updateOraclePricesManual() {
  const { DataServiceWrapper } = await import('@redstone-finance/evm-connector');
  const { getSignersForDataServiceId } = await import('@redstone-finance/oracles-smartweave-contracts');
  const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');

  const wrapper = new DataServiceWrapper({
    dataServiceId: 'redstone-primary-prod',
    uniqueSignersCount: 3,
    dataPackagesIds: ['XMR', 'DAI'],
    authorizedSigners,
  });

  console.log(`[Chain] Updating oracle prices before setMintReady...`);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Get raw RedStone payload hex (bypasses WrapperBuilder contract wrapping)
      const redstonePayload = await wrapper.getRedstonePayloadForManualUsage(hub);

      // Build updateOraclePrices([]) calldata and append RedStone payload
      const baseData = hub.interface.encodeFunctionData('updateOraclePrices', [[]]);
      const fullData = baseData + redstonePayload.slice(2);

      const updateTx = await wallet.sendTransaction({
        to: HUB_ADDRESS,
        data: fullData,
      });
      await updateTx.wait();
      console.log(`[Chain] Oracle prices updated (tx: ${updateTx.hash})`);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        const delay = 2000 * Math.pow(2, attempt);
        console.log(`[Chain] RedStone retry in ${delay/1000}s... (${attempt + 2}/3)`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

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
  let lastCheckedBlock = await provider.getBlockNumber();
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

      lastCheckedBlock = currentBlock;
    } catch (err) {
      console.error('[Event] Poll error:', err.message);
    }
  }, 15000);
}

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
  await startEventListener();
  // Ensure main wallet is open before recovery tries to create deposit wallets
  if (moneroWallet.isWalletConfigured()) {
    console.log('[Startup] Ensuring Monero wallet is open...');
    await moneroWallet.ensureWalletOpen();
    if (moneroWallet.isWalletRpcHealthy()) {
      console.log('[Startup] Monero wallet ready');
    } else {
      console.error('[Startup] Monero wallet RPC unreachable — mint scanning will fail until monero-wallet-rpc is started');
    }
  }
  await startupRecoverMints();
  await startupResolveStale();
  burnHandler.attachEventListeners(hub, wallet, provider);
});