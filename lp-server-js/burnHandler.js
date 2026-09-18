// burnHandler.js — LP-side burn operations for WrapSynth
// Handles: listen for BurnRequested → proposeHash → finalizeBurn

import crypto from 'crypto';
import * as ethers from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeSecretHash } from './commitment.js';
import * as moneroWallet from './moneroWallet.js';
import { sweepBurnShared } from './moneroWallet.js';
import * as moneroCrypto from './moneroCrypto.js';
import { updateOraclePricesManual } from './oracleUpdate.js';
import { getNextNonce, resetNonceCache } from './nonceManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BURN_SECRETS_FILE = path.join(__dirname, 'lp-burn-secrets.json');

// ─── Config ─────────────────────────────────────────────────────────────────
const AUTO_PROCESS_BURNS = (process.env.AUTO_PROCESS_BURNS || 'false').toLowerCase() === 'true';
const BURN_PROPOSE_DELAY_MS = parseInt(process.env.BURN_PROPOSE_DELAY_MS || '5000', 10);
const BURN_FINALIZE_DELAY_MS = parseInt(process.env.BURN_FINALIZE_DELAY_MS || '30000', 10);
const MONERO_WALLET_RPC_URL = process.env.MONERO_WALLET_RPC_URL || null;

// Default LP Ed25519 public keys (hex, 32 bytes, 0x prefix optional)
// If not set, keys must be supplied per-request via HTTP endpoints.
const DEFAULT_LP_PUBLIC_SPEND_KEY = process.env.BURN_LP_PUBLIC_SPEND_KEY || null;
const DEFAULT_LP_PUBLIC_VIEW_KEY = process.env.BURN_LP_PUBLIC_VIEW_KEY || null;
const DEFAULT_LP_PRIVATE_SPEND_KEY = process.env.BURN_LP_PRIVATE_SPEND_KEY || null;

// ─── State ──────────────────────────────────────────────────────────────────
const pendingBurns = new Map(); // requestId -> burn state object
let hubContract = null;
let wallet = null;
let provider = null;

// ─── Burn Secret Persistence ─────────────────────────────────────────────────

function loadBurnSecrets() {
  try {
    if (fs.existsSync(BURN_SECRETS_FILE)) {
      return JSON.parse(fs.readFileSync(BURN_SECRETS_FILE, 'utf8'));
    }
  } catch (err) {
    console.warn('[Burn] Could not load lp-burn-secrets.json:', err.message);
  }
  return {};
}

function saveBurnSecrets(secrets) {
  try {
    fs.writeFileSync(BURN_SECRETS_FILE, JSON.stringify(secrets, null, 2));
  } catch (err) {
    console.warn('[Burn] Could not save lp-burn-secrets.json:', err.message);
  }
}

function persistBurnSecret(reqIdHex, burn) {
  const secrets = loadBurnSecrets();
  secrets[reqIdHex] = {
    secret: burn.secret,
    secretHash: burn.secretHash,
    lpPublicSpendKey: burn.lpPublicSpendKey,
    lpPublicViewKey: burn.lpPublicViewKey,
    sharedAddress: burn.sharedAddress,
    moneroTxHash: burn.moneroTxHash,
    xmrAmount: burn.xmrAmount,
    wsxmrAmount: burn.wsxmrAmount,
    user: burn.user,
    lpVault: burn.lpVault,
    state: burn.state,
    proposeTxHash: burn.proposeTxHash,
    finalizeTxHash: burn.finalizeTxHash,
    createdAt: burn.createdAt,
    updatedAt: Date.now(),
  };
  saveBurnSecrets(secrets);
}

function updateBurnSecretState(reqIdHex, state, extra = {}) {
  const secrets = loadBurnSecrets();
  if (secrets[reqIdHex]) {
    secrets[reqIdHex].state = state;
    secrets[reqIdHex].updatedAt = Date.now();
    Object.assign(secrets[reqIdHex], extra);
    saveBurnSecrets(secrets);
  }
}

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

  // ─── 1. Generate LP Ed25519 secret (used for both spend key and EVM commitment) ─
  // The same secret serves as:
  //   - LP's Ed25519 private spend key → lpPublicSpendKey = secret · G
  //   - EVM secret → secretHash = keccak256(secret · G), revealed in finalizeBurn
  // This ensures combineSpendKeys(userSecret, lpSecret) produces the correct
  // combined private key for the shared Monero address.
  const ed = await import('@noble/ed25519');
  const { createHash } = await import('crypto');
  if (!ed.etc.sha512Sync) {
    ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
  }
  const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const G = ed.ExtendedPoint.BASE;

  // Read scalar as big-endian (matching EVM/Solidity uint256 and computeSecretHash)
  function scalarToPubKeyBE(scalarBytes) {
    const s = BigInt('0x' + Buffer.from(scalarBytes).toString('hex')) % ED25519_L;
    return Buffer.from(G.multiply(s).toRawBytes());
  }

  let secret, lpPublicSpendKey, lpPublicViewKey;
  if (customKeys.lpPrivateSpendKey) {
    secret = hexToBytes(customKeys.lpPrivateSpendKey);
    lpPublicSpendKey = '0x' + scalarToPubKeyBE(secret).toString('hex');
    if (customKeys.lpPublicViewKey) {
      lpPublicViewKey = normalizeHex32(customKeys.lpPublicViewKey);
    } else if (process.env.MONERO_VIEW_KEY) {
      const viewPriv = Buffer.from(process.env.MONERO_VIEW_KEY, 'hex');
      lpPublicViewKey = '0x' + scalarToPubKeyBE(viewPriv).toString('hex');
    } else {
      throw new Error('LP view key not available — set MONERO_VIEW_KEY or provide lpPublicViewKey');
    }
  } else if (DEFAULT_LP_PRIVATE_SPEND_KEY) {
    secret = hexToBytes(DEFAULT_LP_PRIVATE_SPEND_KEY);
    lpPublicSpendKey = '0x' + scalarToPubKeyBE(secret).toString('hex');
    if (DEFAULT_LP_PUBLIC_VIEW_KEY) {
      lpPublicViewKey = normalizeHex32(DEFAULT_LP_PUBLIC_VIEW_KEY);
    } else if (process.env.MONERO_VIEW_KEY) {
      const viewPriv = Buffer.from(process.env.MONERO_VIEW_KEY, 'hex');
      lpPublicViewKey = '0x' + scalarToPubKeyBE(viewPriv).toString('hex');
    } else {
      throw new Error('LP view key not available — set BURN_LP_PUBLIC_VIEW_KEY or MONERO_VIEW_KEY');
    }
    if (DEFAULT_LP_PUBLIC_SPEND_KEY && normalizeHex32(DEFAULT_LP_PUBLIC_SPEND_KEY) !== lpPublicSpendKey) {
      console.warn('[Burn] BURN_LP_PUBLIC_SPEND_KEY does not match derived key from BURN_LP_PRIVATE_SPEND_KEY — using derived key');
    }
  } else {
    secret = crypto.randomBytes(32);
    lpPublicSpendKey = '0x' + scalarToPubKeyBE(secret).toString('hex');
    if (process.env.MONERO_VIEW_KEY) {
      const viewPriv = Buffer.from(process.env.MONERO_VIEW_KEY, 'hex');
      lpPublicViewKey = '0x' + scalarToPubKeyBE(viewPriv).toString('hex');
    } else {
      const viewSecret = crypto.randomBytes(32);
      lpPublicViewKey = '0x' + scalarToPubKeyBE(viewSecret).toString('hex');
    }
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

  // ─── 4. Compute EVM commitment from the same secret ──────────────────────────
  const { secretHash } = await computeSecretHash(secret);

  console.log(`[Burn] Generated secret for ${reqIdHex}`);
  console.log(`[Burn] secretHash: ${secretHash}`);

  burn.secret = bytesToHex(secret);
  burn.secretHash = secretHash;

  // ─── 5. Call proposeHash on-chain FIRST (before sending XMR) ───────────────
  // This ensures if the tx reverts, no XMR is sent to an unproposed shared address.
  console.log(`[Burn] Calling proposeHash(${reqIdHex}, ${secretHash}, ...)`);
  const proposeNonce = await getNextNonce();
  const tx = await hubContract.proposeHash(reqIdHex, secretHash, lpPublicSpendKey, lpPublicViewKey, { nonce: proposeNonce });
  console.log(`[Burn] proposeHash tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[Burn] proposeHash confirmed in block ${receipt.blockNumber}`);

  burn.state = 'proposed';
  burn.proposeTxHash = tx.hash;

  // Persist burn secret immediately after proposeHash confirms
  persistBurnSecret(reqIdHex, burn);

  // ─── 6. Send XMR to the shared Monero address (after proposeHash confirms) ──
  if (sharedAddress && moneroWallet.isWalletConfigured()) {
    try {
      const xmrAmountAtomic = BigInt(burn.xmrAmount);
      console.log(`[Burn] Sending XMR to shared address ${sharedAddress} ...`);
      const result = await sendXmr(sharedAddress, xmrAmountAtomic);
      burn.moneroTxHash = result.txHash;
      console.log(`[Burn] XMR send result: txHash=${result.txHash}, sent=${result.sent}`);
      updateBurnSecretState(reqIdHex, 'proposed', { moneroTxHash: result.txHash });
    } catch (xmrErr) {
      console.error(`[Burn] XMR send failed for ${reqIdHex}:`, xmrErr.message);
      burn.error = xmrErr.message;
      updateBurnSecretState(reqIdHex, 'proposed', { error: xmrErr.message });
      // If funds are locked (not insufficient), retry after a short delay
      if (xmrErr.message.includes('XMR locked') || xmrErr.message.includes('not enough money') || xmrErr.message.includes('Insufficient XMR') || xmrErr.message.includes('0.000000 XMR')) {
        console.log(`[Burn] Will retry XMR send for ${reqIdHex} in 30s...`);
        setTimeout(async () => {
          try {
            if (burn.state !== 'proposed') return;
            console.log(`[Burn] Retrying XMR send for ${reqIdHex}...`);
            const xmrAmountAtomic = BigInt(burn.xmrAmount);
            const result = await sendXmr(sharedAddress, xmrAmountAtomic);
            burn.moneroTxHash = result.txHash;
            updateBurnSecretState(reqIdHex, 'proposed', { moneroTxHash: result.txHash });
            console.log(`[Burn] XMR retry send succeeded: txHash=${result.txHash}`);
          } catch (retryErr) {
            console.error(`[Burn] XMR retry failed for ${reqIdHex}:`, retryErr.message);
          }
        }, 30000);
      }
      // XMR send failed but proposeHash already confirmed — the burn is proposed on-chain
      // LP's XMR is not sent yet; user will not confirm lock and burn will eventually be resolved
      return;
    }
  } else if (moneroWallet.isWalletConfigured()) {
    console.warn(`[Burn] Shared address could not be computed — skipping XMR send`);
  } else {
    console.warn(`[Burn] MONERO_WALLET_RPC_URL not configured — skipping XMR send`);
  }
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
  updateBurnSecretState(reqIdHex, 'committed');

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
 * Execute the burn reveal+settle for a tracked burn.
 *
 * Uses the two-transaction split (revealBurnSecret → settleBurn) instead of the
 * combined finalizeBurn: the secret only appears in calldata of a tx that cannot
 * revert on vault accounting, so a settlement failure can never leak it. If the
 * secret was already revealed on-chain (e.g. restart between the two txs), the
 * reveal step is skipped and we go straight to settleBurn.
 */
async function processFinalize(reqIdHex) {
  const burn = pendingBurns.get(reqIdHex);
  if (!burn) throw new Error(`Unknown burn request: ${reqIdHex}`);
  if (burn.state !== 'proposed' && burn.state !== 'committed' && burn.state !== 'revealed') {
    throw new Error(`Burn ${reqIdHex} must be in 'proposed', 'committed' or 'revealed' state`);
  }
  if (!burn.secret) throw new Error(`Secret not available for ${reqIdHex}`);

  // Check on-chain state — skip the reveal if the secret is already stored.
  let alreadyRevealed = false;
  try {
    const burnReq = await hubContract.getBurnRequest(reqIdHex);
    alreadyRevealed = burnReq.revealedSecret && burnReq.revealedSecret !== ethers.ZeroHash;
  } catch (err) {
    console.warn(`[Burn] Could not read burn state for ${reqIdHex}: ${err.shortMessage || err.message}`);
  }

  if (!alreadyRevealed) {
    // Step 1: reveal the secret. This tx only checks status/deadline/secret — it
    // cannot revert on vault accounting, so the secret is never stranded in a
    // failed settlement tx.
    const revealNonce = await getNextNonce();
    console.log(`[Burn] Calling revealBurnSecret(${reqIdHex}, ...) nonce: ${revealNonce}`);
    const revealTx = await hubContract.revealBurnSecret(reqIdHex, burn.secret, { nonce: revealNonce });
    console.log(`[Burn] revealBurnSecret tx: ${revealTx.hash}`);
    const revealReceipt = await revealTx.wait();
    console.log(`[Burn] revealBurnSecret confirmed in block ${revealReceipt.blockNumber}`);
    burn.state = 'revealed';
  } else {
    console.log(`[Burn] ${reqIdHex} already revealed on-chain — skipping to settleBurn`);
  }

  // Step 2: update oracle prices, then settle (settlement touches vault
  // accounting and requires a fresh price).
  try {
    await updateOraclePricesManual();
  } catch (priceErr) {
    console.warn(`[Burn] Oracle price update failed before settle: ${priceErr.message}`);
    console.log('[Burn] Proceeding with settleBurn anyway (may revert with StalePrice)...');
  }

  const settleNonce = await getNextNonce();
  console.log(`[Burn] Calling settleBurn(${reqIdHex}) nonce: ${settleNonce}`);

  let tx;
  try {
    tx = await hubContract.settleBurn(reqIdHex, { nonce: settleNonce });
  } catch (err) {
    // If StalePrice, retry once more after price update
    if (err.message && (err.message.includes('0x19abf40e') || err.message.includes('StalePrice'))) {
      console.warn('[Burn] StalePrice on settleBurn, updating prices and retrying...');
      await updateOraclePricesManual();
      const retryNonce = await getNextNonce();
      tx = await hubContract.settleBurn(reqIdHex, { nonce: retryNonce });
    } else {
      throw err;
    }
  }

  console.log(`[Burn] settleBurn tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[Burn] settleBurn confirmed in block ${receipt.blockNumber}`);

  burn.state = 'finalized';
  burn.finalizeTxHash = tx.hash;
  updateBurnSecretState(reqIdHex, 'finalized', { finalizeTxHash: tx.hash });
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
  updateBurnSecretState(reqIdHex, 'finalized');
}

/**
 * Handle BurnCancelled or BurnAborted event.
 */
async function handleBurnCancelled(requestId) {
  const reqIdHex = ethers.hexlify(requestId);
  console.log(`[Burn] BurnCancelled/Aborted ${reqIdHex}`);
  const burn = pendingBurns.get(reqIdHex);
  if (burn) burn.state = 'cancelled';
  updateBurnSecretState(reqIdHex, 'cancelled');
}

/**
 * Handle BurnProposalDeclined event.
 * The user has called resolveDeclinedProposal with their userSecret (private spend key)
 * to recover their wsXMR. The userSecret is emitted in the event.
 * The LP can now combine userSecret with their own lpSecret to sweep the shared XMR.
 */
async function handleBurnProposalDeclined(requestId, userSecret) {
  const reqIdHex = ethers.hexlify(requestId);
  console.log(`[Burn] BurnProposalDeclined ${reqIdHex}`);
  console.log(`  userSecret: ${userSecret.slice(0, 10)}...`);

  // Look up the burn in pendingBurns or persisted secrets
  let burn = pendingBurns.get(reqIdHex);
  if (!burn) {
    // Try to load from persisted secrets
    const secrets = loadBurnSecrets();
    const saved = secrets[reqIdHex];
    if (saved) {
      burn = saved;
      console.log(`[Burn] Found persisted burn secret for ${reqIdHex}`);
    }
  }

  if (!burn || !burn.secret) {
    console.warn(`[Burn] No LP secret found for ${reqIdHex} — cannot sweep shared XMR`);
    return;
  }

  // Mark as cancelled in state
  if (pendingBurns.has(reqIdHex)) {
    pendingBurns.get(reqIdHex).state = 'cancelled';
  }
  updateBurnSecretState(reqIdHex, 'declined', { userSecret: userSecret });

  // Sweep the shared XMR back to the LP's main wallet
  if (!moneroWallet.isWalletConfigured()) {
    console.warn(`[Burn] MONERO_WALLET_RPC_URL not configured — cannot sweep shared XMR for ${reqIdHex}`);
    return;
  }

  try {
    const lpMainAddress = process.env.MONERO_LP_ADDRESS || (await moneroWallet.getAddresses()).primary;
    if (!lpMainAddress) {
      console.error(`[Burn] Could not determine LP main address for sweep`);
      return;
    }

    console.log(`[Burn] Sweeping shared XMR for ${reqIdHex} to ${lpMainAddress}...`);
    const result = await sweepBurnShared({
      userSecretHex: userSecret,
      lpSecretHex: burn.secret,
      lpMainAddress,
      restoreHeight: 0, // Will scan from 1000 blocks back
    });

    if (result.swept) {
      console.log(`[Burn] XMR sweep succeeded for ${reqIdHex}: ${result.txHashes.length} tx(s), ${result.amount} atomic units`);
      updateBurnSecretState(reqIdHex, 'swept', {
        sweepTxHashes: result.txHashes,
        sweepAmount: result.amount.toString(),
      });
    } else {
      console.warn(`[Burn] XMR sweep not completed for ${reqIdHex} — may need manual sweep later`);
      // Retry after 2 minutes (XMR may need more confirmations)
      setTimeout(async () => {
        console.log(`[Burn] Retrying XMR sweep for ${reqIdHex}...`);
        try {
          const retryResult = await sweepBurnShared({
            userSecretHex: userSecret,
            lpSecretHex: burn.secret,
            lpMainAddress,
            restoreHeight: 0,
          });
          if (retryResult.swept) {
            console.log(`[Burn] XMR retry sweep succeeded for ${reqIdHex}`);
            updateBurnSecretState(reqIdHex, 'swept', {
              sweepTxHashes: retryResult.txHashes,
              sweepAmount: retryResult.amount.toString(),
            });
          } else {
            console.warn(`[Burn] XMR retry sweep still not ready for ${reqIdHex}`);
          }
        } catch (retryErr) {
          console.error(`[Burn] XMR retry sweep failed for ${reqIdHex}:`, retryErr.message);
        }
      }, 120000);
    }
  } catch (err) {
    console.error(`[Burn] XMR sweep failed for ${reqIdHex}:`, err.message);
    updateBurnSecretState(reqIdHex, 'declined', { sweepError: err.message });
  }
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
    'event BurnSecretRevealed(bytes32 indexed requestId, bytes32 secret)',
    'event BurnCancelled(bytes32 indexed requestId)',
    'event BurnAborted(bytes32 indexed requestId)',
    'event BurnProposalDeclined(bytes32 indexed requestId, bytes32 userSecret)',
    'function proposeHash(bytes32 requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
    'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
    'function revealBurnSecret(bytes32 requestId, bytes32 secret) external',
    'function settleBurn(bytes32 requestId) external',
    'function claimSlashedCollateral(bytes32 requestId) external',
    'function resolveDeclinedProposal(bytes32 requestId, bytes32 userSecret) external',
    'function getBurnRequest(bytes32 requestId) external view returns (tuple(bytes32 requestId, address user, address lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 lockedCollateral, uint256 rewardCollateral, bytes32 secretHash, uint256 deadline, uint256 vaultLiquidationNonce, uint256 normalizedDebtAmount, uint8 status, bytes32 userClaimCommitment, bytes32 userPublicKey, bytes32 userViewKey, uint256 xmrPriceAtRequest, bytes32 revealedSecret))',
  ];

  const existingAbi = hub.interface.fragments.map(f => f.format('full'));
  const mergedAbi = Array.from(new Set([...existingAbi, ...burnAbi]));
  hubContract = new ethers.Contract(hub.target, mergedAbi, wallet);

  // Use polling instead of hub.on() to avoid filter issues with Base Sepolia RPC
  let lastCheckedBlock = 0;
  let lastPollError = '';
  provider.getBlockNumber().then(b => { lastCheckedBlock = b; });

  setInterval(async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock <= lastCheckedBlock) return;
      const fromBlock = lastCheckedBlock + 1;
      if (fromBlock > currentBlock) return;

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
      const requested = await safeQuery(hubContract.filters.BurnRequested(), fromBlock, currentBlock);
      for (const event of requested) {
        const { requestId, user, lpVault, wsxmrAmount, xmrAmount, rewardCollateral, claimCommitment, userPublicKey, userViewKey } = event.args;
        handleBurnRequest(requestId, user, lpVault, wsxmrAmount, xmrAmount, claimCommitment, userPublicKey, userViewKey);
      }

      // Poll for BurnCommitted
      const committed = await safeQuery(hubContract.filters.BurnCommitted(), fromBlock, currentBlock);
      for (const event of committed) {
        handleBurnCommitted(event.args.requestId);
      }

      // Poll for BurnFinalized
      const finalized = await safeQuery(hubContract.filters.BurnFinalized(), fromBlock, currentBlock);
      for (const event of finalized) {
        handleBurnFinalized(event.args.requestId, event.args.secret, event.args.rewardPaid);
      }

      // Poll for BurnCancelled / BurnAborted
      const cancelled = await safeQuery(hubContract.filters.BurnCancelled(), fromBlock, currentBlock);
      for (const event of cancelled) {
        handleBurnCancelled(event.args.requestId);
      }
      const aborted = await safeQuery(hubContract.filters.BurnAborted(), fromBlock, currentBlock);
      for (const event of aborted) {
        handleBurnCancelled(event.args.requestId);
      }

      // Poll for BurnProposalDeclined (user resolved — LP should sweep shared XMR)
      const declined = await safeQuery(hubContract.filters.BurnProposalDeclined(), fromBlock, currentBlock);
      for (const event of declined) {
        handleBurnProposalDeclined(event.args.requestId, event.args.userSecret);
      }

      lastCheckedBlock = currentBlock;
      lastPollError = '';
    } catch (err) {
      const msg = err.message || String(err);
      if (msg !== lastPollError) {
        console.error('[Burn] Poll error:', msg);
        lastPollError = msg;
      }
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
    const { requestId, lpPrivateSpendKey, lpPublicViewKey } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });

    const reqIdHex = ethers.hexlify(requestId);

    try {
      await processPropose(reqIdHex, { lpPrivateSpendKey, lpPublicViewKey });
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
      const slashNonce = await getNextNonce();
      const tx = await hubContract.claimSlashedCollateral(reqIdHex, { nonce: slashNonce });
      console.log(`[Burn] claimSlashedCollateral tx: ${tx.hash}`);
      const receipt = await tx.wait();

      const burn = pendingBurns.get(reqIdHex);
      if (burn) burn.state = 'slashed';
      updateBurnSecretState(reqIdHex, 'slashed');

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

  // Resolve a declined proposal (requires userSecret — the user's private spend key)
  app.post('/burn/resolve-declined', async (req, res) => {
    const { requestId, userSecret } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });
    if (!userSecret) return res.status(400).json({ error: 'userSecret required (user\'s private spend key)' });

    const reqIdHex = ethers.hexlify(requestId);

    try {
      console.log(`[Burn] Calling resolveDeclinedProposal(${reqIdHex}, userSecret...)`);
      const resolveNonce = await getNextNonce();
      const tx = await hubContract.resolveDeclinedProposal(reqIdHex, userSecret, { nonce: resolveNonce });
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

// ─── Startup Recovery ─────────────────────────────────────────────────────

/**
 * Recover burn state after server restart.
 * Loads persisted burn secrets, queries on-chain status, and rehydrates
 * the pendingBurns Map. Resumes processing for active burns.
 * Must be called after attachEventListeners so hubContract is set.
 */
async function startupRecoverBurns() {
  if (!hubContract) {
    console.warn('[Burn Recovery] hubContract not set — skipping');
    return;
  }

  const secrets = loadBurnSecrets();
  const reqIds = Object.keys(secrets);
  if (reqIds.length === 0) {
    console.log('[Burn Recovery] No persisted burn secrets found');
    return;
  }

  console.log(`[Burn Recovery] Found ${reqIds.length} persisted burn(s), checking on-chain status...`);

  for (const reqIdHex of reqIds) {
    const saved = secrets[reqIdHex];
    try {
      const burnReq = await hubContract.getBurnRequest(reqIdHex);
      const status = Number(burnReq.status);

      // BurnStatus: 0=INVALID, 1=REQUESTED, 2=PROPOSED, 3=COMMITTED, 4=COMPLETED, 5=CANCELLED, 6=SLASHED
      if (status === 4 || status === 5 || status === 6) {
        console.log(`[Burn Recovery] ${reqIdHex} is terminal (status=${status}), skipping`);
        continue;
      }

      // Rehydrate BurnState in pendingBurns
      const burn = new BurnState(
        reqIdHex, saved.user, saved.lpVault,
        saved.wsxmrAmount, saved.xmrAmount,
        saved.claimCommitment || ethers.ZeroHash,
        saved.userPublicKey || ethers.ZeroHash,
        saved.userViewKey || ethers.ZeroHash
      );
      burn.secret = saved.secret;
      burn.secretHash = saved.secretHash;
      burn.lpPublicSpendKey = saved.lpPublicSpendKey;
      burn.lpPublicViewKey = saved.lpPublicViewKey;
      burn.sharedAddress = saved.sharedAddress;
      burn.moneroTxHash = saved.moneroTxHash;
      burn.proposeTxHash = saved.proposeTxHash;
      burn.finalizeTxHash = saved.finalizeTxHash;
      burn.createdAt = saved.createdAt || Date.now();

      if (status === 1) {
        // REQUESTED — LP never proposed (may have crashed before proposeHash)
        burn.state = 'requested';
        pendingBurns.set(reqIdHex, burn);
        console.log(`[Burn Recovery] ${reqIdHex} is REQUESTED — re-running processPropose`);
        if (AUTO_PROCESS_BURNS) {
          (async () => {
            try { await processPropose(reqIdHex); }
            catch (err) { console.error(`[Burn Recovery] processPropose failed for ${reqIdHex}:`, err.message); }
          })();
        }
      } else if (status === 2) {
        // PROPOSED — waiting for user to confirmMoneroLock
        burn.state = 'proposed';
        pendingBurns.set(reqIdHex, burn);
        console.log(`[Burn Recovery] ${reqIdHex} is PROPOSED — waiting for BurnCommitted event`);
        // Recompute sharedAddress if missing (e.g. secret was saved manually)
        if (!burn.sharedAddress && burn.userPublicKey && burn.userViewKey && burn.lpPublicSpendKey) {
          try {
            burn.sharedAddress = await moneroCrypto.computeBurnAddress(
              ethers.hexlify(burn.userPublicKey),
              ethers.hexlify(burn.userViewKey),
              burn.lpPublicSpendKey
            );
            console.log(`[Burn Recovery] Recomputed shared address for ${reqIdHex}: ${burn.sharedAddress}`);
          } catch (err) {
            console.warn(`[Burn Recovery] Could not recompute shared address:`, err.message);
          }
        }
        // Retry XMR send if it was never sent (e.g. wallet was empty at first attempt)
        if (!burn.moneroTxHash && burn.sharedAddress && moneroWallet.isWalletConfigured()) {
          console.log(`[Burn Recovery] ${reqIdHex} has no moneroTxHash — refreshing wallet and retrying XMR send...`);
          (async () => {
            try {
              await moneroWallet.refreshWallet();
              const xmrAmountAtomic = BigInt(burn.xmrAmount);
              const result = await sendXmr(burn.sharedAddress, xmrAmountAtomic);
              burn.moneroTxHash = result.txHash;
              updateBurnSecretState(reqIdHex, 'proposed', { moneroTxHash: result.txHash, error: null });
              console.log(`[Burn Recovery] XMR retry send succeeded for ${reqIdHex}: txHash=${result.txHash}`);
            } catch (retryErr) {
              console.error(`[Burn Recovery] XMR retry failed for ${reqIdHex}:`, retryErr.message);
              updateBurnSecretState(reqIdHex, 'proposed', { error: retryErr.message });
            }
          })();
        }
      } else if (status === 3) {
        // COMMITTED — user confirmed, LP needs to finalize
        burn.state = 'committed';
        burn.finalizeRetries = (saved.finalizeRetries || 0);
        pendingBurns.set(reqIdHex, burn);
        if (burn.finalizeRetries >= 3) {
          console.log(`[Burn Recovery] ${reqIdHex} is COMMITTED but already failed ${burn.finalizeRetries}x — giving up`);
          continue;
        }
        console.log(`[Burn Recovery] ${reqIdHex} is COMMITTED — finalizing now (attempt ${burn.finalizeRetries + 1}/3)`);
        if (AUTO_PROCESS_BURNS) {
          (async () => {
            try {
              await processFinalize(reqIdHex);
            } catch (err) {
              burn.finalizeRetries = (burn.finalizeRetries || 0) + 1;
              updateBurnSecretState(reqIdHex, 'committed', { finalizeRetries: burn.finalizeRetries });
              console.error(`[Burn Recovery] processFinalize failed for ${reqIdHex} (${burn.finalizeRetries}/3):`, err.message);
            }
          })();
        }
      }
    } catch (err) {
      console.warn(`[Burn Recovery] Could not check burn ${reqIdHex}:`, err.message);
    }
  }

  // Also scan recent BurnRequested events for our vault that aren't in persisted secrets
  try {
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 9999);
    const burnEvents = await hubContract.queryFilter(hubContract.filters.BurnRequested(), fromBlock, currentBlock);
    const ourBurns = burnEvents.filter(
      e => e.args.lpVault.toLowerCase() === wallet.address.toLowerCase()
    );

    for (const event of ourBurns) {
      const reqIdHex = ethers.hexlify(event.args.requestId);
      if (pendingBurns.has(reqIdHex) || secrets[reqIdHex]) continue;

      try {
        const burnReq = await hubContract.getBurnRequest(reqIdHex);
        const status = Number(burnReq.status);
        if (status === 4 || status === 5 || status === 6) continue;

        console.log(`[Burn Recovery] Found untracked active burn ${reqIdHex} (status=${status}) — rehydrating`);
        const burn = new BurnState(
          reqIdHex, event.args.user, event.args.lpVault,
          event.args.wsxmrAmount, event.args.xmrAmount,
          event.args.claimCommitment, event.args.userPublicKey, event.args.userViewKey
        );

        if (status === 1) {
          burn.state = 'requested';
          pendingBurns.set(reqIdHex, burn);
          if (AUTO_PROCESS_BURNS) {
            (async () => {
              try { await processPropose(reqIdHex); }
              catch (err) { console.error(`[Burn Recovery] processPropose failed for ${reqIdHex}:`, err.message); }
            })();
          }
        } else if (status === 2) {
          burn.state = 'proposed';
          pendingBurns.set(reqIdHex, burn);
        } else if (status === 3) {
          // COMMITTED but no persisted secret — can't finalize without LP secret
          burn.state = 'committed';
          burn.error = 'LP secret lost — cannot finalize';
          pendingBurns.set(reqIdHex, burn);
          console.error(`[Burn Recovery] ${reqIdHex} is COMMITTED but LP secret not persisted — CANNOT FINALIZE`);
        }
      } catch (err) {
        console.warn(`[Burn Recovery] Could not check untracked burn ${reqIdHex}:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[Burn Recovery] Could not scan recent BurnRequested events:', err.message);
  }

  console.log('[Burn Recovery] Recovery complete');
}

// ─── Module Export ──────────────────────────────────────────────────────────

export {
  attachEventListeners,
  registerRoutes,
  startupRecoverBurns,
  pendingBurns,
};