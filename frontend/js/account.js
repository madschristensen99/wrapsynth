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
} from './viemClient.js?v=3.22';
import { CONTRACTS, DECIMALS, NETWORKS } from './config.js?v=3.22';
import { parseAbi, formatUnits } from 'https://esm.sh/viem@2.7.0';

const EXPLORER = NETWORKS.hyperevm.blockExplorer;
const TRANSFER_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
const MINT_EVENT_ABI = ['event MintInitiated(bytes32 indexed requestId, address indexed initiator, address indexed recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout)'];
const BURN_EVENT_ABI = ['event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral, bytes32 claimCommitment, bytes32 userPublicKey, bytes32 userViewKey)'];

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

function formatHype(value) {
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
  0: { label: 'Invalid', class: 'status-unknown' },
  1: { label: 'Pending', class: 'status-initiated' },
  2: { label: 'Key Provided', class: 'status-proposed' },
  3: { label: 'Ready', class: 'status-committed' },
  4: { label: 'Secret Revealed', class: 'status-committed' },
  5: { label: 'Completed', class: 'status-completed' },
  6: { label: 'Cancelled', class: 'status-cancelled' },
  7: { label: 'Expired', class: 'status-cancelled' }
};

const BURN_STATUS = {
  0: { label: 'Requested', class: 'status-initiated' },
  1: { label: 'Requested', class: 'status-initiated' },
  2: { label: 'Hash Proposed', class: 'status-proposed' },
  3: { label: 'Committed', class: 'status-committed' },
  4: { label: 'Completed', class: 'status-completed' },
  5: { label: 'Slashed', class: 'status-slashed' },
  6: { label: 'Cancelled', class: 'status-cancelled' }
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
    document.getElementById('acct-xdai').textContent = formatHype(xdai) + ' HYPE';
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

  // Mints + burns are quick contract reads — render them first so the page
  // never hangs on the slow transfer scan.
  const [mints, burns] = await Promise.all([
    fetchMintHistory(address).catch((e) => { console.warn('Mints failed:', e); return []; }),
    fetchBurnHistory(address).catch((e) => { console.warn('Burns failed:', e); return []; })
  ]);
  allHistory = [...mints, ...burns];
  renderHistory();

  // Best-effort: fill in real creation timestamps from events, then re-sort
  // newest-first. Never blocks the render — falls back to contract order.
  await Promise.all([
    enrichWithTimestamps(mints, MINT_EVENT_ABI, 'MintInitiated', 'initiator', address),
    enrichWithTimestamps(burns, BURN_EVENT_ABI, 'BurnRequested', 'user', address)
  ]);
  allHistory.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  renderHistory();

  // Transfers scan a wide block range — load them separately with a timeout
  // so they can't block the page forever on a flaky RPC.
  try {
    const transfers = await Promise.race([
      fetchTransferHistory(address),
      new Promise((_, reject) => setTimeout(() => reject(new Error('transfer scan timed out')), 15000))
    ]);
    allHistory = [...allHistory, ...transfers];
    allHistory.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    renderHistory();
  } catch (e) {
    console.warn('Transfers failed (history still shows mints/burns):', e);
  }
}

/**
 * Fill in creation timestamps for mint/burn items from their Initiated/Requested
 * events. Scans a tight window around the earliest deadline (creation precedes
 * the deadline) so it stays fast; times out gracefully on flaky RPCs.
 */
async function enrichWithTimestamps(items, eventAbi, eventName, filterField, address) {
  if (!items.length) return;
  try {
    const client = getPublicClient();
    const deadlines = items.map(i => i._deadline).filter(Boolean);
    if (!deadlines.length) return;
    const minDeadline = BigInt(Math.min(...deadlines));
    const fromBlock = minDeadline > 5000n ? minDeadline - 5000n : 0n;

    const events = await Promise.race([
      getPastEvents(CONTRACTS.hub, eventAbi, eventName, fromBlock, 'latest', { [filterField]: address }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('event scan timed out')), 10000))
    ]);

    const blockByReq = new Map();
    for (const ev of events) blockByReq.set(ev.args.requestId, ev.blockNumber);
    const tss = await fetchBlockTimestamps([...new Set(blockByReq.values())]);
    for (const item of items) {
      const bn = blockByReq.get(item.requestId);
      const ts = bn ? tss.get(bn) : 0;
      if (ts) {
        item.timestamp = ts;
        item.timestampLabel = tsLabel(ts);
      }
    }
  } catch (e) {
    console.warn('Timestamp enrichment failed (times stay unknown):', e);
  }
}

/** Fetch block timestamps in parallel (concurrency-limited). */
async function fetchBlockTimestamps(blockNumbers) {
  const client = getPublicClient();
  const timestamps = new Map();
  const CONCURRENCY = 8;
  let next = 0;
  async function worker() {
    while (next < blockNumbers.length) {
      const bn = blockNumbers[next++];
      try {
        const block = await client.getBlock({ blockNumber: bn });
        timestamps.set(bn, Number(block.timestamp));
      } catch {
        timestamps.set(bn, 0);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, blockNumbers.length) }, worker));
  return timestamps;
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
        _deadline: Number(req.timeout) || 0,
        timestamp: 0,
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
        claimable: status === 4, // COMPLETED — LP revealed its secret, XMR claimable
        _deadline: Number(req.deadline) || 0,
        timestamp: 0,
        timestampLabel: '—',
        details: [
          { label: 'Request ID', value: formatAddr(id) },
          { label: 'LP Vault', value: formatAddr(req.lpVault) },
          { label: 'Locked Collateral', value: formatToken(req.lockedCollateral, 18) + ' USDe' }
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
  // ~20000 blocks (~5.5h at ~1s blocks) — wide enough for recent activity,
  // small enough that the chunked eth_getLogs scan finishes quickly.
  const fromBlock = currentBlock > 20000n ? currentBlock - 20000n : 0n;

  const [outEvents, inEvents] = await Promise.all([
    getPastEvents(CONTRACTS.wsxmrToken, TRANSFER_ABI, 'Transfer', fromBlock, 'latest', { from: address }).catch(() => []),
    getPastEvents(CONTRACTS.wsxmrToken, TRANSFER_ABI, 'Transfer', fromBlock, 'latest', { to: address }).catch(() => [])
  ]);

  // Fetch block timestamps in parallel (concurrency-limited)
  const blockNumbers = [...new Set([...outEvents, ...inEvents].map(ev => ev.blockNumber))];
  const blockTimestamps = await fetchBlockTimestamps(blockNumbers);

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
        ${item.claimable ? `<button class="claim-xmr-btn" data-request-id="${item.requestId}" style="margin-top:0.75rem;padding:0.5rem 1rem;border-radius:8px;border:1px solid var(--xmr,#f97316);background:transparent;color:var(--xmr,#f97316);font-weight:600;cursor:pointer;">Claim XMR</button>` : ''}
      </div>
    `;
  }).join('');

  // Delegated click handler for claim buttons
  list.onclick = async (e) => {
    const btn = e.target.closest('.claim-xmr-btn');
    if (!btn) return;
    const requestId = btn.dataset.requestId;
    btn.disabled = true;
    btn.textContent = 'Loading keys…';
    try {
      const { buildBurnClaimKeys } = await import('./burnSweep.js?v=3.12');
      const { showBurnKeysFallback } = await import('./ui.js?v=3.22');
      const { keys, sharedAddress, restoreHeight } = await buildBurnClaimKeys(requestId);
      showBurnKeysFallback(keys, restoreHeight, sharedAddress);
    } catch (err) {
      console.error('Claim failed:', err);
      const { showError } = await import('./ui.js?v=3.22');
      showError('Cannot Claim XMR', err.message || 'Could not rebuild your claim keys.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Claim XMR';
    }
  };
}

init().catch(console.error);
