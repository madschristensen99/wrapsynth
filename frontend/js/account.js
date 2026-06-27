// Account page: balances + on-chain history
import {
  initializeClients,
  connectWallet,
  ensureConnected,
  getPublicClient,
  getUserAddress,
  getWsXmrBalance,
  getNativeBalance,
  readHub,
  getPastEvents,
  onAccountsChanged
} from './viemClient.js';
import { CONTRACTS, DECIMALS, NETWORKS } from './config.js';
import { parseAbi, formatUnits } from 'https://esm.sh/viem@2.7.0';

const EXPLORER = NETWORKS.gnosis.blockExplorer;
const TRANSFER_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];

let allHistory = [];
let currentFilter = 'all';

/* ── Init ── */
async function init() {
  await initializeClients();
  const address = await ensureConnected();

  if (address) {
    await loadAccount(address);
  } else {
    showConnectPrompt();
  }

  // Listen for account changes
  onAccountsChanged(async (newAddr) => {
    if (newAddr) {
      await loadAccount(newAddr);
    } else {
      showConnectPrompt();
    }
  });

  // Connect button
  const connectBtn = document.getElementById('connect-wallet');
  if (connectBtn) {
    connectBtn.addEventListener('click', async () => {
      try {
        const addr = await connectWallet();
        await loadAccount(addr);
      } catch (e) {
        console.error('Connect failed:', e);
      }
    });
  }

  // Copy address
  const copyBtn = document.getElementById('copy-address');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const addr = document.getElementById('acct-address').textContent;
      navigator.clipboard.writeText(addr).then(() => {
        const old = copyBtn.textContent;
        copyBtn.textContent = 'Copied';
        setTimeout(() => (copyBtn.textContent = old), 1200);
      });
    });
  }

  // History tabs
  document.querySelectorAll('.history-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.history-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      renderHistory();
    });
  });
}

/* ── UI helpers ── */
function showConnectPrompt() {
  document.getElementById('connect-prompt').classList.remove('hidden');
  document.getElementById('account-content').classList.add('hidden');
}

function showAccountContent() {
  document.getElementById('connect-prompt').classList.add('hidden');
  document.getElementById('account-content').classList.remove('hidden');
}

function formatAddr(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatToken(value, decimals = 8) {
  if (!value) return '0';
  const str = value.toString().padStart(decimals + 1, '0');
  const whole = str.slice(0, -decimals) || '0';
  const frac = str.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function formatXDai(value) {
  if (!value) return '0';
  return parseFloat(formatUnits(value, 18)).toFixed(4);
}

function tsLabel(ts) {
  if (!ts) return 'Unknown';
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

const MINT_STATUS = {
  0: { label: 'Initiated', class: 'status-initiated' },
  1: { label: 'Ready', class: 'status-proposed' },
  2: { label: 'Finalized', class: 'status-completed' },
  3: { label: 'Cancelled', class: 'status-cancelled' }
};

const BURN_STATUS = {
  0: { label: 'Requested', class: 'status-initiated' },
  1: { label: 'Hash Proposed', class: 'status-proposed' },
  2: { label: 'Committed', class: 'status-committed' },
  3: { label: 'Finalized', class: 'status-completed' },
  4: { label: 'Cancelled', class: 'status-cancelled' },
  5: { label: 'Slashed', class: 'status-slashed' }
};

/* ── Load account ── */
async function loadAccount(address) {
  showAccountContent();
  document.getElementById('acct-address').textContent = address;

  // Balances
  try {
    const wsxmr = await getWsXmrBalance(address);
    document.getElementById('acct-wsxmr').textContent = formatToken(wsxmr, DECIMALS.wsXMR) + ' wsXMR';
  } catch (e) {
    document.getElementById('acct-wsxmr').textContent = '--';
  }

  try {
    const xdai = await getNativeBalance(address);
    document.getElementById('acct-xdai').textContent = formatXDai(xdai) + ' xDAI';
  } catch (e) {
    document.getElementById('acct-xdai').textContent = '--';
  }

  // History
  await loadHistory(address);
}

/* ── Load history ── */
async function loadHistory(address) {
  const list = document.getElementById('history-list');
  list.innerHTML = '<div class="history-empty">Loading history...</div>';
  allHistory = [];

  try {
    const [mints, burns, transfers] = await Promise.all([
      fetchMintHistory(address).catch((e) => { console.warn('Mints failed:', e); return []; }),
      fetchBurnHistory(address).catch((e) => { console.warn('Burns failed:', e); return []; }),
      fetchTransferHistory(address).catch((e) => { console.warn('Transfers failed:', e); return []; })
    ]);

    allHistory = [...mints, ...burns, ...transfers];
    allHistory.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    renderHistory();
  } catch (e) {
    console.error('History load failed:', e);
    list.innerHTML = '<div class="history-empty">Failed to load history. Try refreshing.</div>';
  }
}

/* ── Mint history ── */
async function fetchMintHistory(address) {
  const requestIds = await readHub('getUserMintRequests', [address]);
  if (!requestIds || requestIds.length === 0) return [];

  const items = [];
  for (const id of requestIds) {
    try {
      const req = await readHub('getMintRequest', [id]);
      const status = Number(req.status);
      const statusInfo = MINT_STATUS[status] || { label: `Status ${status}`, class: 'status-unknown' };
      items.push({
        kind: 'mint',
        type: 'Mint',
        requestId: id,
        amount: formatToken(req.xmrAmount, DECIMALS.XMR),
        amountLabel: `${formatToken(req.xmrAmount, DECIMALS.XMR)} XMR → ${formatToken(req.wsxmrAmount, DECIMALS.wsXMR)} wsXMR`,
        vault: req.lpVault,
        status: statusInfo.label,
        statusClass: statusInfo.class,
        timestamp: Number(req.timeout) ? 0 : 0, // timeout is deadline, not timestamp
        timestampLabel: '—',
        details: [
          { label: 'Request ID', value: formatAddr(id) },
          { label: 'LP Vault', value: formatAddr(req.lpVault) },
          { label: 'Fee', value: formatToken(req.feeAmount, DECIMALS.wsXMR) + ' wsXMR' }
        ]
      });
    } catch (e) {
      console.warn('Failed to fetch mint request', id, e);
    }
  }
  return items;
}

/* ── Burn history ── */
async function fetchBurnHistory(address) {
  const requestIds = await readHub('getUserBurnRequests', [address]);
  if (!requestIds || requestIds.length === 0) return [];

  const items = [];
  for (const id of requestIds) {
    try {
      const req = await readHub('getBurnRequest', [id]);
      const status = Number(req.status);
      const statusInfo = BURN_STATUS[status] || { label: `Status ${status}`, class: 'status-unknown' };
      items.push({
        kind: 'burn',
        type: 'Burn',
        requestId: id,
        amount: formatToken(req.wsxmrAmount, DECIMALS.wsXMR),
        amountLabel: `${formatToken(req.wsxmrAmount, DECIMALS.wsXMR)} wsXMR → ${formatToken(req.xmrAmount, DECIMALS.XMR)} XMR`,
        vault: req.lpVault,
        status: statusInfo.label,
        statusClass: statusInfo.class,
        timestamp: Number(req.deadline) ? 0 : 0,
        timestampLabel: '—',
        details: [
          { label: 'Request ID', value: formatAddr(id) },
          { label: 'LP Vault', value: formatAddr(req.lpVault) },
          { label: 'Locked Collateral', value: formatToken(req.lockedCollateral, 18) + ' sDAI' }
        ]
      });
    } catch (e) {
      console.warn('Failed to fetch burn request', id, e);
    }
  }
  return items;
}

/* ── Transfer history ── */
async function fetchTransferHistory(address) {
  const client = getPublicClient();
  const currentBlock = await client.getBlockNumber();
  const fromBlock = currentBlock > 50000n ? currentBlock - 50000n : 0n;

  const [outEvents, inEvents] = await Promise.all([
    getPastEvents(CONTRACTS.wsxmrToken, TRANSFER_ABI, 'Transfer', fromBlock, 'latest', { from: address }).catch(() => []),
    getPastEvents(CONTRACTS.wsxmrToken, TRANSFER_ABI, 'Transfer', fromBlock, 'latest', { to: address }).catch(() => [])
  ]);

  // Fetch block timestamps
  const blockNumbers = new Set();
  for (const ev of [...outEvents, ...inEvents]) {
    blockNumbers.add(ev.blockNumber);
  }
  const blockTimestamps = new Map();
  for (const bn of blockNumbers) {
    try {
      const block = await client.getBlock({ blockNumber: bn });
      blockTimestamps.set(bn, Number(block.timestamp));
    } catch (e) {
      blockTimestamps.set(bn, 0);
    }
  }

  const items = [];
  for (const ev of outEvents) {
    items.push({
      kind: 'transfer',
      type: 'Sent wsXMR',
      requestId: ev.transactionHash,
      amount: formatToken(ev.args.value, DECIMALS.wsXMR),
      amountLabel: `-${formatToken(ev.args.value, DECIMALS.wsXMR)} wsXMR`,
      vault: ev.args.to,
      status: 'Confirmed',
      statusClass: 'status-completed',
      timestamp: blockTimestamps.get(ev.blockNumber) || 0,
      timestampLabel: tsLabel(blockTimestamps.get(ev.blockNumber) || 0),
      details: [
        { label: 'To', value: formatAddr(ev.args.to) },
        { label: 'Tx', value: `<a href="${EXPLORER}/tx/${ev.transactionHash}" target="_blank" rel="noopener">${formatAddr(ev.transactionHash)} ↗</a>` }
      ]
    });
  }
  for (const ev of inEvents) {
    items.push({
      kind: 'transfer',
      type: 'Received wsXMR',
      requestId: ev.transactionHash,
      amount: formatToken(ev.args.value, DECIMALS.wsXMR),
      amountLabel: `+${formatToken(ev.args.value, DECIMALS.wsXMR)} wsXMR`,
      vault: ev.args.from,
      status: 'Confirmed',
      statusClass: 'status-completed',
      timestamp: blockTimestamps.get(ev.blockNumber) || 0,
      timestampLabel: tsLabel(blockTimestamps.get(ev.blockNumber) || 0),
      details: [
        { label: 'From', value: formatAddr(ev.args.from) },
        { label: 'Tx', value: `<a href="${EXPLORER}/tx/${ev.transactionHash}" target="_blank" rel="noopener">${formatAddr(ev.transactionHash)} ↗</a>` }
      ]
    });
  }
  return items;
}

/* ── Render ── */
function renderHistory() {
  const list = document.getElementById('history-list');
  const filtered = currentFilter === 'all'
    ? allHistory
    : allHistory.filter((h) => h.kind === currentFilter);

  if (filtered.length === 0) {
    list.innerHTML = '<div class="history-empty">No transactions yet.</div>';
    return;
  }

  list.innerHTML = filtered.map((item) => {
    const detailsHtml = item.details.map((d) =>
      `<div class="history-detail"><span class="lbl">${d.label}</span><span class="val">${d.value}</span></div>`
    ).join('');

    const iconSvg = item.kind === 'mint'
      ? '<svg viewBox="0 0 24 24" stroke="var(--teal)"><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/></svg>'
      : item.kind === 'burn'
      ? '<svg viewBox="0 0 24 24" stroke="var(--xmr)"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072 0-2.2.6-3 1.5"/><path d="M12 2 2 7l10 5 10-5z"/><path d="M2 17l10 5 10-5"/></svg>'
      : '<svg viewBox="0 0 24 24" stroke="var(--amber)"><path d="M7 17l9.2-9.2M17 8V2H7v13"/><circle cx="14" cy="14" r="2"/><path d="M2 17h10"/><path d="M2 12h5"/></svg>';

    return `
      <div class="history-row">
        <div class="history-row-header">
          <span class="history-type">${iconSvg} ${item.type}</span>
          <span class="history-status ${item.statusClass}">${item.status}</span>
        </div>
        <div class="history-details">
          <div class="history-detail">
            <span class="lbl">Amount</span>
            <span class="val">${item.amountLabel}</span>
          </div>
          <div class="history-detail">
            <span class="lbl">Time</span>
            <span class="val">${item.timestampLabel}</span>
          </div>
          ${detailsHtml}
        </div>
      </div>
    `;
  }).join('');
}

init().catch(console.error);
