// moneroWallet.js — monero-wallet-rpc client for the LP server
// Handles: scanning for deposits, sending XMR, wallet state queries

import crypto from 'crypto';

// ─── Config ─────────────────────────────────────────────────────────────────
const WALLET_RPC_URL = process.env.MONERO_WALLET_RPC_URL || null;
const WALLET_RPC_USER = process.env.MONERO_WALLET_RPC_USER || null;
const WALLET_RPC_PASSWORD = process.env.MONERO_WALLET_RPC_PASSWORD || null;

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

async function walletRpc(method, params = {}) {
  if (!WALLET_RPC_URL) {
    throw new Error('MONERO_WALLET_RPC_URL not configured');
  }

  const headers = { 'Content-Type': 'application/json' };
  const auth = getAuthHeader();
  if (auth) headers['Authorization'] = auth;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
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

    return data.result;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`wallet-rpc timeout: ${method} took >60s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Balance & Transfers ────────────────────────────────────────────────────

/**
 * Get wallet balance (unlocked only)
 */
export async function getBalance(accountIndex = 0) {
  const res = await walletRpc('get_balance', { account_index: accountIndex });
  return {
    balance: BigInt(res.balance),
    unlocked: BigInt(res.unlocked_balance),
  };
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

  console.log(`[Monero] Creating view-only wallet for deposit address: ${depositAddress.slice(0, 16)}...`);

  // Create or open a view-only wallet for this specific deposit address
  try {
    await walletRpc('close_wallet', {});
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
      // Wallet might already exist, try opening it
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
    const refreshRes = await walletRpc('refresh', {});
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
          await walletRpc('refresh', {});
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
 * Query monerod for current block height (uses wallet-rpc relay).
 */
export async function getDaemonHeight() {
  const res = await walletRpc('get_height');
  return Number(res.height);
}

// ─── Wallet Open ────────────────────────────────────────────────────────────

let walletOpened = false;

async function ensureWalletOpen() {
  if (walletOpened) return;
  const walletName = process.env.MONERO_WALLET_NAME || 'lp-wallet';
  const walletPass = process.env.MONERO_WALLET_PASSWORD || 'lp-wallet-password';
  const walletDir = process.env.MONERO_WALLET_DIR || '/home/remsee/wsFrontendOverhaul/lp-server-js/monero-wallets';

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
    // Delete both files before regenerating
    const fs = await import('fs');
    for (const ext of ['', '.keys', '.address.txt']) {
      const p = `${walletDir}/${walletName}${ext}`;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    await walletRpc('generate_from_keys', {
      filename: walletName,
      password: walletPass,
      address,
      spendkey: spendKey,
      viewkey: viewKey,
      restore_height: 3607954,
    });
    walletOpened = true;
    console.log('[Monero] Wallet regenerated from keys:', walletName);
  } catch (err) {
    console.error('[Monero] Failed to regenerate wallet from keys:', err.message);
    walletOpened = true; // Mark as opened to stop retrying
  }
}

// ─── Health Check ─────────────────────────────────────────────────────────────

export function isWalletConfigured() {
  return !!WALLET_RPC_URL;
}

// Auto-open wallet on first import if RPC URL is configured
if (WALLET_RPC_URL) {
  ensureWalletOpen().catch(err => {
    console.warn('[Monero] Failed to auto-open wallet:', err.message);
  });
}
