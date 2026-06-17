// moneroWallet.js — monero-wallet-rpc client for the LP server
// Handles: scanning for deposits, sending XMR, wallet state queries

import crypto from 'crypto';

// ─── Config ─────────────────────────────────────────────────────────────────
const WALLET_RPC_URL = process.env.MONERO_WALLET_RPC_URL || null;
const WALLET_RPC_USER = process.env.MONERO_WALLET_RPC_USER || null;
const WALLET_RPC_PASSWORD = process.env.MONERO_WALLET_RPC_PASSWORD || null;

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

  const res = await fetch(WALLET_RPC_URL + '/json_rpc', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
  });

  if (!res.ok) {
    throw new Error(`wallet-rpc HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`wallet-rpc error: ${JSON.stringify(data.error)}`);
  }

  return data.result;
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
    transfer_type: 'all',
    account_index: accountIndex,
  };

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
 * Retries every `intervalMs` up to `maxWaitMs`.
 */
export async function pollForDeposit(expectedAmountAtomic, opts = {}) {
  const {
    minHeight = 0,
    toleranceBps = 50,           // 0.5% tolerance
    intervalMs = 10000,          // 10s
    maxWaitMs = 600000,          // 10 min
  } = opts;

  const start = Date.now();
  let lastHeight = minHeight;

  while (Date.now() - start < maxWaitMs) {
    try {
      const txs = await getIncomingTransfers({ minHeight: lastHeight });

      for (const tx of txs) {
        const diff = tx.amount > expectedAmountAtomic
          ? tx.amount - expectedAmountAtomic
          : expectedAmountAtomic - tx.amount;
        const diffBps = Number(diff * 10000n / expectedAmountAtomic);

        if (diffBps <= toleranceBps) {
          console.log(`[Monero] Deposit found: txid=${tx.txid} amount=${tx.amount} height=${tx.height}`);
          return tx;
        }
      }

      if (txs.length > 0) {
        lastHeight = Math.max(lastHeight, ...txs.map(t => t.height)) + 1;
      }
    } catch (err) {
      console.warn('[Monero] pollForDeposit error:', err.message);
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

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

// ─── Health Check ─────────────────────────────────────────────────────────────

export function isWalletConfigured() {
  return !!WALLET_RPC_URL;
}
