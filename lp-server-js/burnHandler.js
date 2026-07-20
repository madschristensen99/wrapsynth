// burnHandler.js — LP-side burn operations for WrapSynth
// Handles: listen for BurnRequested → proposeHash → finalizeBurn

import crypto from 'crypto';
import * as ethers from 'ethers';
import { computeSecretHash } from './commitment.js';
import * as moneroWallet from './moneroWallet.js';
import * as moneroCrypto from './moneroCrypto.js';
import { updateOraclePricesManual } from './oracleUpdate.js';

// ─── Config ─────────────────────────────────────────────────────────────────
const AUTO_PROCESS_BURNS = (process.env.AUTO_PROCESS_BURNS || 'false').toLowerCase() === 'true';
const BURN_PROPOSE_DELAY_MS = parseInt(process.env.BURN_PROPOSE_DELAY_MS || '5000', 10);
const BURN_FINALIZE_DELAY_MS = parseInt(process.env.BURN_FINALIZE_DELAY_MS || '30000', 10);
const MONERO_WALLET_RPC_URL = process.env.MONERO_WALLET_RPC_URL || null;

// Default LP Ed25519 public keys (hex, 32 bytes, 0x prefix optional)
// If not set, keys must be supplied per-request via HTTP endpoints.
const DEFAULT_LP_PUBLIC_SPEND_KEY = process.env.BURN_LP_PUBLIC_SPEND_KEY || null;
const DEFAULT_LP_PUBLIC_VIEW_KEY = process.env.BURN_LP_PUBLIC_VIEW_KEY || null;

// ─── State ──────────────────────────────────────────────────────────────────
const pendingBurns = new Map(); // requestId -> burn state object
let hubContract = null;
let wallet = null;
let provider = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  hex = hex.replace(/^0x/, '');
  if (hex.length % 2 !== 0) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

function bytesToHex(bytes) {
  return '0x' + Buffer.from(bytes).toString('hex');
}

function normalizeHex32(val) {
  if (!val) return null;
  let h = val.toString().replace(/^0x/, '');
  if (h.length !== 64) return null;
  return '0x' + h;
}

/**
 * Send XMR via monero-wallet-rpc.
 * Delegates to moneroWallet module; returns placeholder if wallet not configured.
 */
async function sendXmr(destination, amountAtomic) {
  if (!moneroWallet.isWalletConfigured()) {
    console.warn('[Burn] MONERO_WALLET_RPC_URL not configured — XMR send skipped');
    return { txHash: null, sent: false };
  }
  return moneroWallet.sendXmr({ destination, amountAtomic });
}

// ─── Burn State Machine ─────────────────────────────────────────────────────

class BurnState {
  constructor(requestId, user, lpVault, wsxmrAmount, xmrAmount, claimCommitment, userPublicKey, userViewKey) {
    this.requestId = requestId;
    this.user = user;
    this.lpVault = lpVault;
    this.wsxmrAmount = wsxmrAmount.toString();
    this.xmrAmount = xmrAmount.toString();
    this.claimCommitment = claimCommitment;
    this.userPublicKey = userPublicKey;
    this.userViewKey = userViewKey;
    this.createdAt = Date.now();
    this.state = 'requested'; // requested | proposed | committed | finalized | slashed | cancelled
    this.secret = null;
    this.secretHash = null;
    this.lpPublicSpendKey = null;
    this.lpPublicViewKey = null;
    this.proposeTxHash = null;
    this.finalizeTxHash = null;
    this.moneroTxHash = null;
    this.sharedAddress = null;
    this.error = null;
  }
}

// ─── Core Operations ──────────────────────────────────────────────────────────

/**
 * Handle a BurnRequested event.
 * Generates secret, optionally sends XMR, calls proposeHash on-chain.
 */
async function handleBurnRequest(requestId, user, lpVault, wsxmrAmount, xmrAmount, claimCommitment, userPublicKey, userViewKey) {
  const reqIdHex = ethers.hexlify(requestId);

  if (lpVault.toLowerCase() !== wallet.address.toLowerCase()) {
    console.log(`[Burn] BurnRequested ${reqIdHex} — not our vault, ignoring`);
    return;
  }

  console.log(`[Burn] BurnRequested ${reqIdHex}`);
  console.log(`  User: ${user}`);
  console.log(`  wsxmrAmount: ${wsxmrAmount.toString()}`);
  console.log(`  xmrAmount: ${xmrAmount.toString()}`);

  if (pendingBurns.has(reqIdHex)) {
    console.log(`[Burn] Already tracking ${reqIdHex}`);
    return;
  }

  const burn = new BurnState(reqIdHex, user, lpVault, wsxmrAmount, xmrAmount, claimCommitment, userPublicKey, userViewKey);
  pendingBurns.set(reqIdHex, burn);

  if (!AUTO_PROCESS_BURNS) {
    console.log(`[Burn] AUTO_PROCESS_BURNS is off — waiting for manual POST /burn/propose`);
    return;
  }

  try {
    await processPropose(reqIdHex);
  } catch (err) {
    console.error(`[Burn] Auto-propose failed for ${reqIdHex}:`, err.message);
    burn.error = err.message;
  }
}

/**
 * Execute proposeHash for a tracked burn request.
 */
async function processPropose(reqIdHex, customKeys = {}) {
  const burn = pendingBurns.get(reqIdHex);
  if (!burn) throw new Error(`Unknown burn request: ${reqIdHex}`);
  if (burn.state !== 'requested') throw new Error(`Burn ${reqIdHex} is not in 'requested' state`);

  // ─── 1. Generate LP Ed25519 keys (fresh per request) ──────────────────────
  let lpPublicSpendKey, lpPublicViewKey;
  if (customKeys.lpPublicSpendKey && customKeys.lpPublicViewKey) {
    lpPublicSpendKey = normalizeHex32(customKeys.lpPublicSpendKey);
    lpPublicViewKey = normalizeHex32(customKeys.lpPublicViewKey);
  } else if (DEFAULT_LP_PUBLIC_SPEND_KEY && DEFAULT_LP_PUBLIC_VIEW_KEY) {
    lpPublicSpendKey = normalizeHex32(DEFAULT_LP_PUBLIC_SPEND_KEY);
    lpPublicViewKey = normalizeHex32(DEFAULT_LP_PUBLIC_VIEW_KEY);
  } else {
    const ed = await import('@noble/ed25519');
    const { createHash } = await import('crypto');
    if (!ed.etc.sha512Sync) {
      ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
    }
    const spendPriv = ed.utils.randomPrivateKey();
    // Use LP's wallet view key so the shared address is scannable by the LP
    const viewPriv = Buffer.from(process.env.MONERO_VIEW_KEY, 'hex');

    // Monero uses direct scalar multiplication (scalar * G), NOT ed.getPublicKey()
    const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const G = ed.ExtendedPoint.BASE;
    function scalarToPubKey(scalarBytes) {
      const le = Buffer.from(scalarBytes).reverse();
      const s = BigInt('0x' + le.toString('hex')) % ED25519_L;
      return Buffer.from(G.multiply(s).toRawBytes());
    }
    lpPublicSpendKey = '0x' + scalarToPubKey(spendPriv).toString('hex');
    lpPublicViewKey = '0x' + scalarToPubKey(viewPriv).toString('hex');
  }

  burn.lpPublicSpendKey = lpPublicSpendKey;
  burn.lpPublicViewKey = lpPublicViewKey;

  // ─── 2. Use user's public keys from the BurnRequested event ───────────────
  // The user's actual Ed25519 public spend key (not the commitment hash) and
  // public view key are needed to compute the shared Monero address.
  // The shared address uses the user's view key so the user can scan for it.
  if (!burn.userPublicKey || burn.userPublicKey === ethers.ZeroHash) {
    throw new Error(`User public key not available for ${reqIdHex} — must be passed in BurnRequested event`);
  }
  if (!burn.userViewKey || burn.userViewKey === ethers.ZeroHash) {
    throw new Error(`User view key not available for ${reqIdHex} — must be passed in BurnRequested event`);
  }
  const userPublicKeyHex = ethers.hexlify(burn.userPublicKey);
  const userViewKeyHex = ethers.hexlify(burn.userViewKey);
  console.log(`[Burn] User public spend key: ${userPublicKeyHex}`);
  console.log(`[Burn] User public view key: ${userViewKeyHex}`);

  // ─── 3. Compute shared Monero deposit address ──────────────────────────────
  // Combined spend key = user_pub_spend + LP_pub_spend (Ed25519 point addition)
  // View key = user's public view key (so user can scan with their private view key)
  let sharedAddress = null;
  try {
    sharedAddress = await moneroCrypto.computeBurnAddress(userPublicKeyHex, userViewKeyHex, lpPublicSpendKey);
    burn.sharedAddress = sharedAddress;
    console.log(`[Burn] Shared Monero address: ${sharedAddress}`);
  } catch (err) {
    console.warn(`[Burn] Could not compute shared address:`, err.message);
  }

  // ─── 4. Generate secret ──────────────────────────────────────────────────────
  const secret = crypto.randomBytes(32);
  const { secretHash } = await computeSecretHash(secret);

  console.log(`[Burn] Generated secret for ${reqIdHex}`);
  console.log(`[Burn] secretHash: ${secretHash}`);

  burn.secret = bytesToHex(secret);
  burn.secretHash = secretHash;

  // ─── 5. Send XMR to the shared Monero address ────────────────────────────────
  if (sharedAddress && moneroWallet.isWalletConfigured()) {
    try {
      const xmrAmountAtomic = BigInt(burn.xmrAmount);
      console.log(`[Burn] Sending XMR to shared address ${sharedAddress} ...`);
      const result = await sendXmr(sharedAddress, xmrAmountAtomic);
      burn.moneroTxHash = result.txHash;
      console.log(`[Burn] XMR send result: txHash=${result.txHash}, sent=${result.sent}`);
    } catch (xmrErr) {
      console.error(`[Burn] XMR send failed for ${reqIdHex}:`, xmrErr.message);
      burn.error = xmrErr.message;
      // If funds are locked (not insufficient), retry after a short delay
      if (xmrErr.message.includes('XMR locked') || xmrErr.message.includes('not enough money')) {
        console.log(`[Burn] Will retry XMR send for ${reqIdHex} in 30s...`);
        setTimeout(async () => {
          try {
            if (burn.state !== 'requested') return;
            console.log(`[Burn] Retrying XMR send for ${reqIdHex}...`);
            await processPropose(reqIdHex);
          } catch (retryErr) {
            console.error(`[Burn] Retry failed for ${reqIdHex}:`, retryErr.message);
          }
        }, 30000);
      }
      // Do NOT proceed with proposeHash if XMR send failed
      return;
    }
  } else if (moneroWallet.isWalletConfigured()) {
    console.warn(`[Burn] Shared address could not be computed — skipping XMR send`);
  } else {
    console.warn(`[Burn] MONERO_WALLET_RPC_URL not configured — skipping XMR send`);
  }

  // ─── 6. Delay then call proposeHash on-chain ─────────────────────────────────
  if (BURN_PROPOSE_DELAY_MS > 0) {
    console.log(`[Burn] Waiting ${BURN_PROPOSE_DELAY_MS}ms before proposeHash...`);
    await new Promise(r => setTimeout(r, BURN_PROPOSE_DELAY_MS));
  }

  console.log(`[Burn] Calling proposeHash(${reqIdHex}, ${secretHash}, ...)`);
  const tx = await hubContract.proposeHash(reqIdHex, secretHash, lpPublicSpendKey, lpPublicViewKey);
  console.log(`[Burn] proposeHash tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[Burn] proposeHash confirmed in block ${receipt.blockNumber}`);

  burn.state = 'proposed';
  burn.proposeTxHash = tx.hash;
}

/**
 * Handle BurnCommitted event (user called confirmMoneroLock).
 * Auto-finalize if enabled.
 */
async function handleBurnCommitted(requestId) {
  const reqIdHex = ethers.hexlify(requestId);
  console.log(`[Burn] BurnCommitted ${reqIdHex}`);

  const burn = pendingBurns.get(reqIdHex);
  if (!burn) {
    console.log(`[Burn] No tracked burn for ${reqIdHex} (may have missed BurnRequested event)`);
    return;
  }

  burn.state = 'committed';

  if (!AUTO_PROCESS_BURNS) {
    console.log(`[Burn] AUTO_PROCESS_BURNS is off — waiting for manual POST /burn/finalize`);
    return;
  }

  try {
    await processFinalize(reqIdHex);
  } catch (err) {
    console.error(`[Burn] Auto-finalize failed for ${reqIdHex}:`, err.message);
    burn.error = err.message;
  }
}

/**
 * Execute finalizeBurn for a tracked burn.
 */
async function processFinalize(reqIdHex) {
  const burn = pendingBurns.get(reqIdHex);
  if (!burn) throw new Error(`Unknown burn request: ${reqIdHex}`);
  if (burn.state !== 'proposed' && burn.state !== 'committed') {
    throw new Error(`Burn ${reqIdHex} must be in 'proposed' or 'committed' state`);
  }
  if (!burn.secret) throw new Error(`Secret not available for ${reqIdHex}`);

  // Update oracle prices before finalizeBurn (contract requires fresh price)
  try {
    await updateOraclePricesManual();
  } catch (priceErr) {
    console.warn(`[Burn] Oracle price update failed before finalize: ${priceErr.message}`);
    console.log('[Burn] Proceeding with finalizeBurn anyway (may revert with StalePrice)...');
  }

  console.log(`[Burn] Calling finalizeBurn(${reqIdHex}, ...) secret: ${burn.secret.slice(0, 10)}...`);

  let tx;
  try {
    tx = await hubContract.finalizeBurn(reqIdHex, burn.secret);
  } catch (err) {
    // If StalePrice, retry once more after price update
    if (err.message && (err.message.includes('0x19abf40e') || err.message.includes('StalePrice'))) {
      console.warn('[Burn] StalePrice on finalizeBurn, updating prices and retrying...');
      await updateOraclePricesManual();
      tx = await hubContract.finalizeBurn(reqIdHex, burn.secret);
    } else {
      throw err;
    }
  }

  console.log(`[Burn] finalizeBurn tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[Burn] finalizeBurn confirmed in block ${receipt.blockNumber}`);

  burn.state = 'finalized';
  burn.finalizeTxHash = tx.hash;
}

/**
 * Handle BurnFinalized event.
 */
async function handleBurnFinalized(requestId, secret, rewardPaid) {
  const reqIdHex = ethers.hexlify(requestId);
  console.log(`[Burn] BurnFinalized ${reqIdHex}`);
  console.log(`  Secret: ${secret.slice(0, 10)}...`);
  console.log(`  Reward: ${ethers.formatEther(rewardPaid)} ETH`);

  const burn = pendingBurns.get(reqIdHex);
  if (burn) {
    burn.state = 'finalized';
    burn.finalizeTxHash = 'event'; // we saw it via event
  }
}

/**
 * Handle BurnCancelled or BurnAborted event.
 */
async function handleBurnCancelled(requestId) {
  const reqIdHex = ethers.hexlify(requestId);
  console.log(`[Burn] BurnCancelled/Aborted ${reqIdHex}`);
  const burn = pendingBurns.get(reqIdHex);
  if (burn) burn.state = 'cancelled';
}

// ─── Event Listener Setup ───────────────────────────────────────────────────

function attachEventListeners(hub, _wallet, _provider) {
  hubContract = hub;
  wallet = _wallet;
  provider = _provider;

  // Extra ABI fragments the main server may not have included.
  // We create a new contract instance with the merged ABI so burn events decode properly.
  const burnAbi = [
    'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral, bytes32 claimCommitment, bytes32 userPublicKey, bytes32 userViewKey)',
    'event HashProposed(bytes32 indexed requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey)',
    'event BurnCommitted(bytes32 indexed requestId, uint256 deadline)',
    'event BurnFinalized(bytes32 indexed requestId, bytes32 secret, uint256 rewardPaid)',
    'event BurnCancelled(bytes32 indexed requestId)',
    'event BurnAborted(bytes32 indexed requestId)',
    'function proposeHash(bytes32 requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
    'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
    'function claimSlashedCollateral(bytes32 requestId) external',
    'function resolveDeclinedProposal(bytes32 requestId) external',
    'function getBurnRequest(bytes32 requestId) external view returns (tuple(address user, address lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 feeAmount, uint256 collateralLocked, uint256 rewardCollateral, bytes32 claimCommitment, bytes32 secretHash, uint256 timeout, uint256 commitDeadline, uint256 state))',
  ];

  const existingAbi = hub.interface.fragments.map(f => f.format('full'));
  const mergedAbi = Array.from(new Set([...existingAbi, ...burnAbi]));
  hubContract = new ethers.Contract(hub.target, mergedAbi, wallet);

  // Use polling instead of hub.on() to avoid filter issues with Base Sepolia RPC
  let lastCheckedBlock = 0;
  provider.getBlockNumber().then(b => { lastCheckedBlock = b; });

  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= lastCheckedBlock) return;

      // Helper to query with retry on rate limit
      async function safeQuery(filter, from, to) {
        let retries = 3;
        while (retries > 0) {
          try {
            return await hubContract.queryFilter(filter, from, to);
          } catch (err) {
            if (err.message?.includes('rate limit') || err.code === 'UNKNOWN_ERROR') {
              retries--;
              if (retries === 0) throw err;
              await new Promise(r => setTimeout(r, 5000));
            } else {
              throw err;
            }
          }
        }
        return [];
      }

      // Poll for BurnRequested
      const requested = await safeQuery(hubContract.filters.BurnRequested(), lastCheckedBlock + 1, currentBlock);
      for (const event of requested) {
        const { requestId, user, lpVault, wsxmrAmount, xmrAmount, rewardCollateral, claimCommitment, userPublicKey, userViewKey } = event.args;
        handleBurnRequest(requestId, user, lpVault, wsxmrAmount, xmrAmount, claimCommitment, userPublicKey, userViewKey);
      }

      // Poll for BurnCommitted
      const committed = await safeQuery(hubContract.filters.BurnCommitted(), lastCheckedBlock + 1, currentBlock);
      for (const event of committed) {
        handleBurnCommitted(event.args.requestId);
      }

      // Poll for BurnFinalized
      const finalized = await safeQuery(hubContract.filters.BurnFinalized(), lastCheckedBlock + 1, currentBlock);
      for (const event of finalized) {
        handleBurnFinalized(event.args.requestId, event.args.secret, event.args.rewardPaid);
      }

      // Poll for BurnCancelled / BurnAborted
      const cancelled = await safeQuery(hubContract.filters.BurnCancelled(), lastCheckedBlock + 1, currentBlock);
      for (const event of cancelled) {
        handleBurnCancelled(event.args.requestId);
      }
      const aborted = await safeQuery(hubContract.filters.BurnAborted(), lastCheckedBlock + 1, currentBlock);
      for (const event of aborted) {
        handleBurnCancelled(event.args.requestId);
      }

      lastCheckedBlock = currentBlock;
    } catch (err) {
      console.error('[Burn] Poll error:', err.message);
    }
  }, 15000);

  console.log('[Burn] Event listeners attached for burn operations');
}

// ─── HTTP Routes ────────────────────────────────────────────────────────────

function registerRoutes(app) {
  // List tracked burns
  app.get('/burns', (_req, res) => {
    const list = Array.from(pendingBurns.values());
    res.json({ burns: list, count: list.length });
  });

  // Get single burn
  app.get('/burns/:requestId', (req, res) => {
    const burn = pendingBurns.get(req.params.requestId);
    if (!burn) return res.status(404).json({ error: 'Burn not found' });
    res.json(burn);
  });

  // Manually propose hash for a burn request
  app.post('/burn/propose', async (req, res) => {
    const { requestId, lpPublicSpendKey, lpPublicViewKey } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });

    const reqIdHex = ethers.hexlify(requestId);

    try {
      await processPropose(reqIdHex, { lpPublicSpendKey, lpPublicViewKey });
      res.json({
        success: true,
        requestId: reqIdHex,
        state: pendingBurns.get(reqIdHex).state,
        proposeTxHash: pendingBurns.get(reqIdHex).proposeTxHash,
        moneroTxHash: pendingBurns.get(reqIdHex).moneroTxHash,
        sharedAddress: pendingBurns.get(reqIdHex).sharedAddress,
      });
    } catch (err) {
      console.error(`[Burn] POST /burn/propose error:`, err);
      res.status(500).json({ error: err.message, requestId: reqIdHex });
    }
  });

  // Manually finalize a burn
  app.post('/burn/finalize', async (req, res) => {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });

    const reqIdHex = ethers.hexlify(requestId);

    try {
      await processFinalize(reqIdHex);
      res.json({
        success: true,
        requestId: reqIdHex,
        state: pendingBurns.get(reqIdHex).state,
        finalizeTxHash: pendingBurns.get(reqIdHex).finalizeTxHash,
      });
    } catch (err) {
      console.error(`[Burn] POST /burn/finalize error:`, err);
      res.status(500).json({ error: err.message, requestId: reqIdHex });
    }
  });

  // Claim slashed collateral (permissionless, if LP failed to reveal)
  app.post('/burn/slash', async (req, res) => {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });

    const reqIdHex = ethers.hexlify(requestId);

    try {
      console.log(`[Burn] Calling claimSlashedCollateral(${reqIdHex})`);
      const tx = await hubContract.claimSlashedCollateral(reqIdHex);
      console.log(`[Burn] claimSlashedCollateral tx: ${tx.hash}`);
      const receipt = await tx.wait();

      const burn = pendingBurns.get(reqIdHex);
      if (burn) burn.state = 'slashed';

      res.json({
        success: true,
        requestId: reqIdHex,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
      });
    } catch (err) {
      console.error(`[Burn] POST /burn/slash error:`, err);
      res.status(500).json({ error: err.message, requestId: reqIdHex });
    }
  });

  // Resolve a declined proposal (permissionless)
  app.post('/burn/resolve-declined', async (req, res) => {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });

    const reqIdHex = ethers.hexlify(requestId);

    try {
      console.log(`[Burn] Calling resolveDeclinedProposal(${reqIdHex})`);
      const tx = await hubContract.resolveDeclinedProposal(reqIdHex);
      console.log(`[Burn] resolveDeclinedProposal tx: ${tx.hash}`);
      const receipt = await tx.wait();

      res.json({
        success: true,
        requestId: reqIdHex,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
      });
    } catch (err) {
      console.error(`[Burn] POST /burn/resolve-declined error:`, err);
      res.status(500).json({ error: err.message, requestId: reqIdHex });
    }
  });
}

// ─── Module Export ──────────────────────────────────────────────────────────

export {
  attachEventListeners,
  registerRoutes,
  pendingBurns,
};