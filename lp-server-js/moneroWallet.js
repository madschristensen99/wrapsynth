// moneroWallet.js — monero-wallet-rpc client for the LP server
// Handles: scanning for deposits, sending XMR, wallet state queries

import crypto from 'crypto';
import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';

// ─── Config ─────────────────────────────────────────────────────────────────
const WALLET_RPC_URL = process.env.MONERO_WALLET_RPC_URL || null;
const WALLET_RPC_USER = process.env.MONERO_WALLET_RPC_USER || null;
const WALLET_RPC_PASSWORD = process.env.MONERO_WALLET_RPC_PASSWORD || null;
const WALLET_RPC_PORT = WALLET_RPC_URL ? new URL(WALLET_RPC_URL).port : '18082';
const WALLET_RPC_HOST = WALLET_RPC_URL ? new URL(WALLET_RPC_URL).hostname : '127.0.0.1';

// Fallback Monero daemon URLs for getDaemonHeight()
// Used in order until one succeeds
const DAEMON_URLS = (
  process.env.MONERO_DAEMON_URLS
    ? process.env.MONERO_DAEMON_URLS.split(',').map(s => s.trim()).filter(Boolean)
    : [
      'https://xmr-node.cakewallet.com:18081',
      'https://node.moneroworld.com:18081',
      'https://xmr-node-eu.cakewallet.com:18081',
      'https://monero.stackotus.com:18081',
    ]
);

// ─── Wallet Mutex ───────────────────────────────────────────────────────────
// monero-wallet-rpc only supports one open wallet at a time.
// Serialize operations that switch wallets (pollForDeposit, sendXmr) to prevent
// concurrent mint scanning + burn sending from corrupting wallet state.
let _walletLock = Promise.resolve();
function withWalletLock(fn) {
  const run = _walletLock.then(fn, fn);
  _walletLock = run.catch(() => {});
  return run;
}

// ─── RPC Helper ───────────────────────────────────────────────────────────────

function getAuthHeader() {
  if (!WALLET_RPC_USER) return undefined;
  const creds = WALLET_RPC_PASSWORD
    ? `${WALLET_RPC_USER}:${WALLET_RPC_PASSWORD}`
    : WALLET_RPC_USER;
  return 'Basic ' + Buffer.from(creds).toString('base64');
}

let _walletRpcHealthy = null; // null = unknown, true = healthy, false = unreachable

async function walletRpc(method, params = {}, retries = 3, timeoutMs = 60000) {
  if (!WALLET_RPC_URL) {
    throw new Error('MONERO_WALLET_RPC_URL not configured — start monero-wallet-rpc and set this in .env');
  }

  const headers = { 'Content-Type': 'application/json' };
  const auth = getAuthHeader();
  if (auth) headers['Authorization'] = auth;

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(WALLET_RPC_URL + '/json_rpc', {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`wallet-rpc HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.error) {
        throw new Error(`wallet-rpc error: ${JSON.stringify(data.error)}`);
      }

      _walletRpcHealthy = true;
      return data.result;
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') {
        lastErr = new Error(`wallet-rpc timeout: ${method} took >60s`);
      }
      // Only retry on connection errors, not application errors (already exists, file errors, etc.)
      const isConnectionError = lastErr.message.includes('fetch failed')
        || lastErr.message.includes('ECONNREFUSED')
        || lastErr.message.includes('timeout')
        || lastErr.name === 'AbortError';
      if (attempt < retries && isConnectionError) {
        const backoff = attempt * 1000;
        console.warn(`[Monero] walletRpc ${method} attempt ${attempt}/${retries} failed: ${lastErr.message}, retrying in ${backoff}ms...`);
        await new Promise(r => setTimeout(r, backoff));
      } else {
        break; // Don't retry on application errors
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  _walletRpcHealthy = false;
  throw new Error(
    `wallet-rpc unreachable after ${retries} attempts: ${lastErr.message}. ` +
    `Ensure monero-wallet-rpc is running at ${WALLET_RPC_URL}`
  );
}

// ─── Balance & Transfers ────────────────────────────────────────────────────

/**
 * Get wallet balance (unlocked only)
 */
export async function getBalance(accountIndex = 0) {
  const res = await walletRpc('get_balance', { account_index: accountIndex });
  return {
    balance: BigInt(res.balance),
    unlockedBalance: BigInt(res.unlocked_balance),
  };
}

/**
 * Refresh the wallet to sync with the blockchain.
 * Needed after wallet regeneration to detect incoming transactions.
 */
export async function refreshWallet() {
  try {
    const res = await walletRpc('refresh', {}, 3, 300000);
    console.log(`[Monero] Wallet refresh complete: blocks_fetched=${res.blocks_fetched || 0}`);
    return res;
  } catch (err) {
    console.warn('[Monero] Wallet refresh failed:', err.message);
    return null;
  }
}

/**
 * Get incoming transfers since a given block height.
 * Returns array of { txid, amount, address, subaddrIndex, height, timestamp }
 */
export async function getIncomingTransfers(opts = {}) {
  const {
    accountIndex = 0,
    subaddrIndices = null,
    minHeight = 0,
  } = opts;

  const params = {
    in: true,
    account_index: accountIndex,
  };

  if (minHeight > 0) {
    params.filter_by_height = true;
    params.min_height = minHeight;
  }

  if (subaddrIndices) {
    params.subaddr_indices = subaddrIndices;
  }

  const res = await walletRpc('get_transfers', params);
  const incoming = res.in || [];

  return incoming
    .filter(t => t.height >= minHeight)
    .map(t => ({
      txid: t.txid,
      amount: BigInt(t.amount),
      address: t.address,
      subaddrIndex: t.subaddr_index,
      height: t.height,
      timestamp: t.timestamp,
      confirmations: t.confirmations,
    }));
}

/**
 * Poll for an incoming transfer matching expected amount (within tolerance).
 * Creates a view-only wallet for the deposit address (combined address using LP's view key)
 * so the wallet can detect outputs sent to that address.
 * Retries every `intervalMs` up to `maxWaitMs`.
 */
export async function pollForDeposit(expectedAmountAtomic, opts = {}) {
  return withWalletLock(() => _pollForDeposit(expectedAmountAtomic, opts));
}

async function _pollForDeposit(expectedAmountAtomic, opts = {}) {
  const {
    depositAddress = null,
    restoreHeight = 0,
    toleranceBps = 50,           // 0.5% tolerance
    intervalMs = 10000,          // 10s
    maxWaitMs = 600000,          // 10 min
  } = opts;

  if (!depositAddress) {
    throw new Error('depositAddress is required for pollForDeposit');
  }

  const lpViewKey = process.env.MONERO_VIEW_KEY;
  if (!lpViewKey) {
    throw new Error('MONERO_VIEW_KEY not configured — needed to scan deposit address');
  }

  // Create a unique view-only wallet name for this deposit address
  const walletName = 'deposit-' + depositAddress.slice(0, 12).replace(/[^a-zA-Z0-9]/g, '');
  const walletPass = 'deposit-scan-password';
  const mainWalletName = process.env.MONERO_WALLET_NAME || 'lp-wallet';
  const mainWalletPass = process.env.MONERO_WALLET_PASSWORD || 'lp-wallet-password';
  const walletDir = process.env.MONERO_WALLET_DIR || '/home/remsee/wsFrontendOverhaul/lp-server-js/monero-wallets';

  console.log(`[Monero] Creating view-only wallet for deposit address: ${depositAddress.slice(0, 16)}...`);

  // Create or open a view-only wallet for this specific deposit address
  try {
    await walletRpc('close_wallet', {});
    // Clean up stale deposit wallet files from previous runs
    try {
      const fs = await import('fs');
      for (const ext of ['', '.keys', '.address.txt']) {
        const p = `${walletDir}/${walletName}${ext}`;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch {}
    try {
      await walletRpc('generate_from_keys', {
        filename: walletName,
        password: walletPass,
        address: depositAddress,
        viewkey: lpViewKey,
        restore_height: restoreHeight,
      });
      console.log('[Monero] View-only wallet created for deposit address');
    } catch (genErr) {
      // Wallet might already exist in the RPC's memory, try opening it
      if (genErr.message.includes('already exists') || genErr.message.includes('file_exists')) {
        await walletRpc('open_wallet', { filename: walletName, password: walletPass });
        console.log('[Monero] Opened existing view-only wallet for deposit address');
      } else {
        throw genErr;
      }
    }
  } catch (err) {
    console.error('[Monero] Failed to create/open view-only wallet:', err.message);
    // Try to reopen main wallet before throwing
    try { await walletRpc('open_wallet', { filename: mainWalletName, password: mainWalletPass }); } catch {}
    throw err;
  }

  // Refresh the view-only wallet to scan the blockchain
  try {
    console.log('[Monero] Refreshing view-only wallet (scanning blockchain)...');
    const refreshRes = await walletRpc('refresh', {}, 3, 300000);
    console.log(`[Monero] Refresh complete: blocks_fetched=${refreshRes.blocks_fetched || 0}`);
  } catch (err) {
    console.warn('[Monero] Refresh failed (continuing anyway):', err.message);
  }

  const start = Date.now();
  let found = null;

  try {
    while (Date.now() - start < maxWaitMs) {
      try {
        const txs = await getIncomingTransfers({ minHeight: restoreHeight });

        for (const tx of txs) {
          const diff = tx.amount > expectedAmountAtomic
            ? tx.amount - expectedAmountAtomic
            : expectedAmountAtomic - tx.amount;
          const diffBps = Number(diff * 10000n / expectedAmountAtomic);

          if (diffBps <= toleranceBps) {
            console.log(`[Monero] Deposit found: txid=${tx.txid} amount=${tx.amount} height=${tx.height}`);
            found = tx;
            break;
          }
        }

        if (found) break;

        // Refresh again to pick up any new blocks
        if (txs.length === 0) {
          await walletRpc('refresh', {}, 3, 300000);
        }
      } catch (err) {
        console.warn('[Monero] pollForDeposit error:', err.message);
      }

      await new Promise(r => setTimeout(r, intervalMs));
    }
  } finally {
    // Always restore the main wallet
    console.log('[Monero] Restoring main LP wallet...');
    try {
      await walletRpc('close_wallet', {});
      walletOpened = false; // Reset so ensureWalletOpen actually reopens
      await ensureWalletOpen();
    } catch (err) {
      console.warn('[Monero] Failed to restore main wallet:', err.message);
    }
  }

  if (found) return found;
  throw new Error(`Deposit not found within ${maxWaitMs}ms (expected ~${expectedAmountAtomic} atomic units)`);
}

// ─── Sending XMR ────────────────────────────────────────────────────────────

/**
 * Send XMR to a destination address via monero-wallet-rpc.
 */
export async function sendXmr({ destination, amountAtomic, priority = 1, accountIndex = 0 }) {
  if (!WALLET_RPC_URL) {
    console.warn('[Monero] MONERO_WALLET_RPC_URL not set — skipping XMR send');
    return { txHash: null, txKey: null, sent: false };
  }
  return withWalletLock(() => _sendXmr({ destination, amountAtomic, priority, accountIndex }));
}

async function _sendXmr({ destination, amountAtomic, priority = 1, accountIndex = 0 }) {

  // Pre-flight balance check for better error messaging
  try {
    const balRes = await walletRpc('get_balance', { account_index: accountIndex });
    const totalBalance = BigInt(balRes.balance || 0);
    const unlockedBalance = BigInt(balRes.unlocked_balance || 0);
    const needed = BigInt(amountAtomic);

    if (totalBalance < needed) {
      const totalXmr = Number(totalBalance) / 1e12;
      const neededXmr = Number(needed) / 1e12;
      throw new Error(`Insufficient XMR: wallet has ${totalXmr.toFixed(6)} XMR total, need ${neededXmr.toFixed(6)} XMR. Fund the LP wallet.`);
    }

    if (unlockedBalance < needed) {
      const unlockedXmr = Number(unlockedBalance) / 1e12;
      const neededXmr = Number(needed) / 1e12;
      const lockedXmr = (Number(totalBalance) - Number(unlockedBalance)) / 1e12;
      throw new Error(`XMR locked: wallet has ${unlockedXmr.toFixed(6)} XMR unlocked (need ${neededXmr.toFixed(6)} XMR). ${lockedXmr.toFixed(6)} XMR is locked waiting for confirmations. Retry shortly.`);
    }
  } catch (e) {
    // If the pre-flight check itself fails (e.g. wallet busy), proceed to transfer
    // and let the actual error surface
    if (e.message.includes('Insufficient XMR') || e.message.includes('XMR locked')) {
      throw e;
    }
    console.warn('[Monero] Pre-flight balance check failed, proceeding to transfer:', e.message);
  }

  const destinations = [{
    address: destination,
    amount: Number(amountAtomic),
  }];

  const params = {
    destinations,
    account_index: accountIndex,
    priority,
    get_tx_key: true,
    get_tx_hex: true,
  };

  console.log(`[Monero] Sending ${amountAtomic} atomic units to ${destination}`);

  const res = await walletRpc('transfer', params);

  console.log(`[Monero] Transfer broadcast: tx_hash=${res.tx_hash}`);
  return {
    txHash: res.tx_hash,
    txKey: res.tx_key,
    txBlob: res.tx_blob,
    fee: BigInt(res.fee),
    sent: true,
  };
}

/**
 * Sweep XMR from a mint deposit address to the LP's main wallet.
 * After MintFinalized, both secrets are known:
 *   - userSecret (revealed in MintFinalized event)
 *   - lpSecret (stored by LP server during setMintReady)
 * The full private spend key = (userSecret + lpSecret) mod l
 * The view key = LP's private view key (from env)
 *
 * @param {string} userSecretHex - user's secret from MintFinalized (0x-prefixed hex)
 * @param {string} lpSecretHex - LP's secret stored during setMintReady (0x-prefixed hex)
 * @param {string} lpViewKeyHex - LP's private view key (hex, no prefix)
 * @param {string} lpMainAddress - LP's main Monero address to sweep to
 * @param {number} restoreHeight - block height to start scanning from
 * @returns {Promise<{swept: boolean, txHashes: string[], amount: bigint}>}
 */
export async function sweepMintDeposit({ userSecretHex, lpSecretHex, lpViewKeyHex, lpMainAddress, restoreHeight = 0 }) {
  if (!WALLET_RPC_URL) {
    console.warn('[Monero] MONERO_WALLET_RPC_URL not set — skipping sweep');
    return { swept: false, txHashes: [], amount: 0n };
  }
  return withWalletLock(() => _sweepMintDeposit({ userSecretHex, lpSecretHex, lpViewKeyHex, lpMainAddress, restoreHeight }));
}

async function _sweepMintDeposit({ userSecretHex, lpSecretHex, lpViewKeyHex, lpMainAddress, restoreHeight }) {
  const ed = await import('@noble/ed25519');
  const { createHash } = await import('crypto');
  if (!ed.etc.sha512Sync) {
    ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
  }

  const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

  // Combine secrets: full_spend = (userSecret + lpSecret) mod l
  const userSecretBigInt = BigInt(userSecretHex) % ED25519_L;
  const lpSecretBigInt = BigInt(lpSecretHex) % ED25519_L;
  const combinedSpendScalar = (userSecretBigInt + lpSecretBigInt) % ED25519_L;

  // Convert scalar to little-endian hex for Monero
  const combinedSpendLe = combinedSpendScalar.toString(16).padStart(64, '0');
  // Monero expects little-endian byte order for keys
  const combinedSpendBytes = Buffer.from(combinedSpendLe, 'hex').reverse();
  const combinedSpendHex = combinedSpendBytes.toString('hex');

  // Derive the public spend key for address computation
  const G = ed.ExtendedPoint.BASE;
  const pubSpend = G.multiply(combinedSpendScalar);
  const pubSpendBytes = Buffer.from(pubSpend.toRawBytes());

  // Derive public view key from private view key
  const viewPrivBytes = Buffer.from(lpViewKeyHex, 'hex');
  const viewLe = BigInt('0x' + viewPrivBytes.reverse().toString('hex')) % ED25519_L;
  const pubView = G.multiply(viewLe);
  const pubViewBytes = Buffer.from(pubView.toRawBytes());

  // Compute Monero address
  const { ethers } = await import('ethers');
  const netByte = 0x12;
  const addrData = Buffer.concat([Buffer.from([netByte]), pubSpendBytes, pubViewBytes]);
  const checksum = Buffer.from(ethers.keccak256(addrData).slice(2), 'hex').slice(0, 4);

  // Base58 encode
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58Encode(data) {
    const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
    function encodeBlock(block) {
      let num = 0n;
      for (let i = 0; i < block.length; i++) num = num * 256n + BigInt(block[i]);
      let encoded = '';
      while (num > 0n) { encoded = ALPHABET[Number(num % 58n)] + encoded; num /= 58n; }
      while (encoded.length < ENCODED_BLOCK_SIZES[block.length]) encoded = '1' + encoded;
      return encoded;
    }
    let result = '';
    for (let i = 0; i < data.length; i += 8) result += encodeBlock(data.slice(i, i + 8));
    return result;
  }
  const depositAddress = base58Encode(Buffer.concat([addrData, checksum]));

  console.log(`[Monero] Sweep: deposit address ${depositAddress}`);
  console.log(`[Monero] Sweep: combined spend key (LE) = ${combinedSpendHex}`);

  // Create wallet from keys
  const walletName = 'sweep-tmp';
  const walletPass = 'sweep';
  const fs = await import('fs');
  const walletDir = process.env.MONERO_WALLET_DIR || '/home/remsee/wsFrontendOverhaul/lp-server-js/monero-wallets';

  // Fetch Monero daemon height for restore_height — the EVM block number
  // passed as restoreHeight is NOT a Monero block height.
  let moneroRestoreHeight = 0;
  try {
    const daemonHeight = await getDaemonHeight();
    moneroRestoreHeight = Math.max(0, daemonHeight - 200);
    console.log(`[Monero] generate_from_keys restore_height=${moneroRestoreHeight} (daemon: ${daemonHeight}, ignored EVM height: ${restoreHeight})`);
  } catch (e) {
    console.warn('[Monero] Could not fetch daemon height for wallet creation:', e.message);
  }

  // Delete old temp wallet files
  for (const ext of ['', '.keys', '.address.txt']) {
    const p = `${walletDir}/${walletName}${ext}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  try {
    try {
      await walletRpc('generate_from_keys', {
        filename: walletName,
        password: walletPass,
        address: depositAddress,
        spendkey: combinedSpendHex,
        viewkey: lpViewKeyHex,
        restore_height: moneroRestoreHeight,
      });
      walletOpened = true;
      console.log('[Monero] Sweep wallet created from keys');
    } catch (err) {
      if (err.message.includes('already exists') || err.message.includes('file_exists')) {
        await walletRpc('open_wallet', { filename: walletName, password: walletPass });
        walletOpened = true;
      } else {
        throw err;
      }
    }

    // Refresh to scan for incoming transactions using the Monero height
    console.log('[Monero] Refreshing sweep wallet...');
    try {
      await walletRpc('refresh', { start_height: moneroRestoreHeight });
    } catch (err) {
      console.warn('[Monero] Refresh error during sweep:', err.message);
    }

    // Check balance
    const balanceRes = await walletRpc('get_balance', { account_index: 0 });
    const balance = BigInt(balanceRes.balance);
    const unlockedBalance = BigInt(balanceRes.unlocked_balance || 0);
    console.log(`[Monero] Sweep wallet balance: ${balance} atomic (${unlockedBalance} unlocked)`);

    if (unlockedBalance === 0n) {
      console.log('[Monero] No unlocked balance to sweep — funds may still be confirming');
      return { swept: false, txHashes: [], amount: 0n, balance };
    }

    // Sweep all funds to LP main address
    console.log(`[Monero] Sweeping ${unlockedBalance} atomic units to ${lpMainAddress}`);
    const sweepRes = await walletRpc('sweep_all', {
      address: lpMainAddress,
      account_index: 0,
      priority: 1,
      get_tx_keys: true,
    });

    const txHashes = Array.isArray(sweepRes.tx_hash_list) ? sweepRes.tx_hash_list : [sweepRes.tx_hash];
    const amount = BigInt(sweepRes.amount_list?.[0] || 0);
    console.log(`[Monero] Sweep complete: ${txHashes.length} tx(s), total ${amount} atomic units`);

    return { swept: true, txHashes, amount };
  } finally {
    // Always restore the main LP wallet
    console.log('[Monero] Restoring main LP wallet after sweep...');
    try {
      await walletRpc('close_wallet', {});
      walletOpened = false;
      await ensureWalletOpen();
    } catch (err) {
      console.warn('[Monero] Failed to restore main wallet after sweep:', err.message);
    }
  }
}

// ─── Address Management ───────────────────────────────────────────────────────

/**
 * Get the primary address and list of subaddresses for an account.
 */
export async function getAddresses(accountIndex = 0) {
  const res = await walletRpc('get_address', { account_index: accountIndex });
  return {
    primary: res.address,
    addresses: res.addresses.map(a => ({
      address: a.address,
      label: a.label,
      index: a.address_index,
    })),
  };
}

/**
 * Create a new subaddress for receiving a deposit.
 * Returns { address, index }.
 */
export async function createSubaddress(accountIndex = 0, label = '') {
  const res = await walletRpc('create_address', {
    account_index: accountIndex,
    label,
  });
  return {
    address: res.address,
    index: res.address_index,
  };
}

// ─── Daemon Height ──────────────────────────────────────────────────────────

/**
 * Query monerod for current block height directly (bypasses wallet-rpc which
 * blocks while a wallet is loading/refreshing).
 */
export async function getDaemonHeight() {
  // First try via wallet RPC (uses the wallet's already-connected daemon)
  // Only trust it if the height is reasonable for Monero mainnet (> 1000000)
  // A freshly created unsynced wallet returns height 1
  try {
    const res = await walletRpc('get_height', {});
    const h = Number(res.height);
    if (h > 1000000) return h;
  } catch {}

  // Fall back to direct daemon queries
  for (const daemonUrl of DAEMON_URLS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${daemonUrl}/json_rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info', params: {} }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.error) throw new Error(`daemon error: ${JSON.stringify(data.error)}`);
      return Number(data.result.height);
    } catch (err) {
      console.warn(`[Monero] Daemon ${daemonUrl} failed: ${err.message}, trying next...`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('All Monero daemon URLs failed — check your internet connection or set MONERO_DAEMON_URLS in .env');
}

// ─── Wallet Open ────────────────────────────────────────────────────────────

let walletOpened = false;
let _walletRpcProcess = null;
let _ensureWalletPromise = null; // Mutex: prevents concurrent ensureWalletOpen calls

// ─── Auto-start monero-wallet-rpc ───────────────────────────────────────────

async function checkWalletRpcReachable() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(WALLET_RPC_URL + '/json_rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_version', params: {} }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function startWalletRpc() {
  if (_walletRpcProcess) {
    // Process already spawned — check if it's still alive
    if (_walletRpcProcess.exitCode === null && _walletRpcProcess.killed === false) {
      return true;
    }
    _walletRpcProcess = null;
  }

  const walletDir = process.env.MONERO_WALLET_DIR || '/home/remsee/wsFrontendOverhaul/lp-server-js/monero-wallets';
  const daemonAddr = process.env.MONERO_DAEMON_ADDRESS || DAEMON_URLS[0].replace('https://', '').replace('http://', '');

  console.log(`[Monero] Starting monero-wallet-rpc on ${WALLET_RPC_HOST}:${WALLET_RPC_PORT}...`);
  console.log(`[Monero]   wallet-dir: ${walletDir}`);
  console.log(`[Monero]   daemon:     ${daemonAddr}`);

  try {
    _walletRpcProcess = spawn('monero-wallet-rpc', [
      '--wallet-dir', walletDir,
      '--rpc-bind-port', String(WALLET_RPC_PORT),
      '--rpc-bind-ip', WALLET_RPC_HOST,
      '--daemon-address', daemonAddr,
      '--trusted-daemon',
      '--daemon-ssl', 'enabled',
      '--daemon-ssl-allow-any-cert',
      '--disable-rpc-login',
      '--non-interactive',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    _walletRpcProcess.stdout?.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.log(`[Monero RPC] ${line}`);
    });
    _walletRpcProcess.stderr?.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.log(`[Monero RPC] ${line}`);
    });
    _walletRpcProcess.on('exit', (code) => {
      console.warn(`[Monero] wallet-rpc process exited with code ${code}`);
      _walletRpcProcess = null;
      _walletRpcHealthy = false;
      walletOpened = false;
    });
  } catch (err) {
    console.error('[Monero] Failed to spawn monero-wallet-rpc:', err.message);
    console.error('[Monero] Is monero-wallet-rpc installed and in PATH?');
    return false;
  }

  // Wait for RPC to be ready (up to 30s)
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await checkWalletRpcReachable()) {
      console.log('[Monero] wallet-rpc is ready');
      return true;
    }
  }

  console.error('[Monero] wallet-rpc did not become ready within 30s');
  return false;
}

export async function ensureWalletOpen() {
  if (walletOpened) return;
  // Mutex: if another call is already running, wait for it
  if (_ensureWalletPromise) return _ensureWalletPromise;
  _ensureWalletPromise = _ensureWalletOpen().finally(() => { _ensureWalletPromise = null; });
  return _ensureWalletPromise;
}

async function _ensureWalletOpen() {
  if (walletOpened) return;
  const walletName = process.env.MONERO_WALLET_NAME || 'lp-wallet';
  const walletPass = process.env.MONERO_WALLET_PASSWORD || 'lp-wallet-password';
  const walletDir = process.env.MONERO_WALLET_DIR || '/home/remsee/wsFrontendOverhaul/lp-server-js/monero-wallets';

  // If wallet RPC is not reachable, try to start it automatically
  if (!(await checkWalletRpcReachable())) {
    console.warn('[Monero] Wallet RPC not reachable, auto-starting...');
    const started = await startWalletRpc();
    if (!started) {
      console.error('[Monero] Could not start wallet RPC. Mint scanning will fail.');
      return;
    }
  }

  // First check if a wallet is already open
  try {
    await walletRpc('get_balance', {});
    walletOpened = true;
    console.log('[Monero] Wallet already open');
    return;
  } catch (e) {
    // No wallet open, proceed to open one
  }

  // Try opening existing wallet
  try {
    await walletRpc('open_wallet', { filename: walletName, password: walletPass });
    walletOpened = true;
    console.log('[Monero] Wallet opened:', walletName);
    return;
  } catch (err) {
    console.warn('[Monero] open_wallet failed, trying to regenerate from keys...');
  }

  // open_wallet failed (cache corruption bug in 0.18.4.5)
  // Delete the cache file and retry
  try {
    const fs = await import('fs');
    const cachePath = `${walletDir}/${walletName}`;
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
      console.log('[Monero] Deleted corrupted wallet cache file');
    }
    await walletRpc('open_wallet', { filename: walletName, password: walletPass });
    walletOpened = true;
    console.log('[Monero] Wallet opened after cache deletion:', walletName);
    return;
  } catch (err) {
    console.warn('[Monero] open_wallet still failed after cache deletion, regenerating from keys...');
  }

  // Last resort: regenerate from keys
  const spendKey = process.env.MONERO_SPEND_KEY;
  const viewKey = process.env.MONERO_VIEW_KEY;
  if (!spendKey || !viewKey) {
    console.error('[Monero] Cannot regenerate wallet: MONERO_SPEND_KEY, MONERO_VIEW_KEY not set in .env');
    walletOpened = true; // Mark as opened to stop retrying
    return;
  }

  // Derive the correct Monero address from private keys using direct scalar multiplication
  const { createHash } = await import('crypto');
  const ed = await import('@noble/ed25519');
  if (!ed.etc.sha512Sync) {
    ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
  }
  const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const G = ed.ExtendedPoint.BASE;
  function scalarToPubKey(scalarHex) {
    const le = Buffer.from(scalarHex, 'hex').reverse();
    const s = BigInt('0x' + le.toString('hex')) % ED25519_L;
    return Buffer.from(G.multiply(s).toRawBytes());
  }
  const pubSpend = scalarToPubKey(spendKey);
  const pubView = scalarToPubKey(viewKey);
  const ethers = await import('ethers');
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
  function base58Encode(data) {
    function encodeBlock(block) {
      let num = 0n;
      for (let i = 0; i < block.length; i++) num = num * 256n + BigInt(block[i]);
      let encoded = '';
      while (num > 0n) { encoded = ALPHABET[Number(num % 58n)] + encoded; num /= 58n; }
      while (encoded.length < ENCODED_BLOCK_SIZES[block.length]) encoded = '1' + encoded;
      return encoded;
    }
    let result = '';
    for (let i = 0; i < data.length; i += 8) result += encodeBlock(data.slice(i, i + 8));
    return result;
  }
  const netByte = 0x12;
  const addrData = Buffer.concat([Buffer.from([netByte]), pubSpend, pubView]);
  const checksum = Buffer.from(ethers.keccak256(addrData).slice(2), 'hex').slice(0, 4);
  const address = base58Encode(Buffer.concat([addrData, checksum]));

  try {
    // Delete old wallet files before regenerating
    const fs = await import('fs');
    for (const ext of ['', '.keys', '.address.txt']) {
      const p = `${walletDir}/${walletName}${ext}`;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    // Get current height for a sensible restore_height (avoids scanning from genesis)
    let restoreHeight = 3607954;
    try {
      const daemonHeight = await getDaemonHeight();
      restoreHeight = Math.max(0, daemonHeight - 1000);
    } catch {}
    await walletRpc('generate_from_keys', {
      filename: walletName,
      password: walletPass,
      address,
      spendkey: spendKey,
      viewkey: viewKey,
      restore_height: restoreHeight,
    });
    walletOpened = true;
    console.log('[Monero] Wallet regenerated from keys:', walletName);
  } catch (err) {
    // "Wallet already exists" means a concurrent call already created it — just open it
    if (err.message.includes('already exists') || err.message.includes('file_exists')) {
      try {
        await walletRpc('open_wallet', { filename: walletName, password: walletPass });
        walletOpened = true;
        console.log('[Monero] Wallet opened (already existed):', walletName);
        return;
      } catch (openErr) {
        // Wallet might already be open in RPC — check if we can use it
        try {
          await walletRpc('get_balance', {});
          walletOpened = true;
          console.log('[Monero] Wallet already open in RPC:', walletName);
          return;
        } catch {}
        console.error('[Monero] Failed to open existing wallet:', openErr.message);
      }
    }
    console.error('[Monero] Failed to regenerate wallet from keys:', err.message);
    walletOpened = false; // Don't mark as opened — allow retry on next call
  }
}

// ─── Health Check ─────────────────────────────────────────────────────────────

export function isWalletConfigured() {
  return !!WALLET_RPC_URL;
}

export function isWalletRpcHealthy() {
  return _walletRpcHealthy === true;
}

// Auto-open wallet on first import if RPC URL is configured
if (WALLET_RPC_URL) {
  ensureWalletOpen().catch(err => {
    console.warn('[Monero] Failed to auto-open wallet:', err.message);
  });
}
