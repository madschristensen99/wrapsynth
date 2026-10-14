// app.js — WrapSynth Solana devnet frontend.
// Mint/burn flows against the deployed devnet program via the shared client.
// Requires the lp-server running for deposit addresses + request status.

import { PublicKey, SystemProgram, ComputeBudgetProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
  cfg, conn, program, attachWallet, walletTx, confirm, fetchRetry,
  vaultPda, pendingReturns, oracleAccounts, collateralAccounts, nextNonce,
  listVaults, pdas, accounts, secrets,
} from './browserClient.js';

const $ = (id) => document.getElementById(id);
const CU = (u) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusName = accounts.statusName;

let wallet = null;         // injected provider (window.solana)
let myVault = null;        // { pda, account }
let lpServer = localStorage.getItem('lpServer') || 'http://localhost:3002';
let lpServerVault = null; // vault PDA the connected lp-server drives
$('lpServer').value = lpServer;
$('lpServer').onchange = (e) => { lpServer = e.target.value; localStorage.setItem('lpServer', lpServer); lpServerVault = null; };
async function probeLpServer() {
  try {
    const h = await (await fetch(`${lpServer}/health`)).json();
    lpServerVault = h.vault || null;
    if (lpServerVault) log(`lp-server vault: ${lpServerVault.slice(0, 12)}…`);
  } catch { lpServerVault = null; }
}
probeLpServer();

const log = (msg) => { const el = $('log'); el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`; el.scrollTop = el.scrollHeight; };

// ── Wallet ──────────────────────────────────────────────────────────────────
$('connect').onclick = async () => {
  const prov = window.solana;
  if (!prov?.isPhantom) return alert('Phantom not found — install it and point it at devnet');
  await prov.connect();
  wallet = prov;
  attachWallet(wallet);
  $('connect').textContent = wallet.publicKey.toBase58().slice(0, 4) + '…' + wallet.publicKey.toBase58().slice(-4);
  $('connect').disabled = true;
  log(`connected ${wallet.publicKey.toBase58()}`);
  await refreshAll();
  watchRequests();
};

$('airdrop').onclick = async () => {
  if (!wallet) return;
  try {
    const sig = await conn.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL);
    await confirm(sig);
    log('airdrop: +1 SOL');
    await refreshAll();
  } catch (e) { log('airdrop failed: ' + e.message); }
};

const ataOf = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
const tokenBal = async (ata) => getAccount(conn, ata, undefined, TOKEN_2022_PROGRAM_ID).then((a) => BigInt(a.amount.toString())).catch(() => 0n);
async function ensureAta(mint, owner) {
  const ata = ataOf(mint, owner);
  if (!(await conn.getAccountInfo(ata))) {
    const tx = new Transaction().add(createAssociatedTokenAccountInstruction(
      wallet.publicKey, ata, owner, mint, TOKEN_2022_PROGRAM_ID));
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    const sig = await conn.sendRawTransaction((await wallet.signTransaction(tx)).serialize());
    await confirm(sig);
  }
  return ata;
}

// ── Vault + balances ────────────────────────────────────────────────────────
async function refreshVaults() {
  if (!lpServerVault) await probeLpServer();
  const vaults = await listVaults();
  const sel = $('vaultSel');
  sel.innerHTML = '';
  // Capture the user's current pick BEFORE re-render — after innerHTML='' the
  // browser auto-selects option[0], which is NOT a real user choice.
  const prev = sel.value;
  for (const { publicKey: pda, account: v } of vaults) {
    const opt = document.createElement('option');
    opt.value = pda.toBase58();
    opt.textContent = `${pda.toBase58().slice(0, 8)}… lp:${v.lpAddress.toBase58().slice(0, 8)}… debt:${Number(v.normalizedDebt) / 1e8}` +
      (pda.toBase58() === lpServerVault ? '  [lp-server]' : '');
    sel.appendChild(opt);
  }
  if (!vaults.length) { await refreshVault(); return; }
  const has = (x) => x && vaults.some((v) => v.publicKey.toBase58() === x);
  sel.value = has(prev) ? prev : has(lpServerVault) ? lpServerVault : vaults[0].publicKey.toBase58();
  await refreshVault();
}

$('vaultSel').onchange = refreshVault;
$('refreshVaults').onclick = refreshVaults;

async function refreshVault() {
  const pdaStr = $('vaultSel').value;
  if (!pdaStr) return;
  const pda = new PublicKey(pdaStr);
  const v = await fetchRetry(() => program.account.vault.fetch(pda)).catch(() => null);
  if (!v) return;
  myVault = { pda, account: v };
  $('vaultStats').textContent =
    `collateral ${Number(v.collateralAmount) / 1e8} QQQx · debt ${Number(v.normalizedDebt) / 1e8} wsXMR · ` +
    `locked ${Number(v.lockedCollateral) / 1e8} · mint fee ${v.mintFeeBps / 100}% · burn reward ${v.burnRewardBps / 100}%`;
}

async function refreshAll() {
  if (!wallet) return;
  await refreshVaults();
  const sol = await conn.getBalance(wallet.publicKey);
  $('solBal').textContent = (sol / LAMPORTS_PER_SOL).toFixed(3) + ' SOL';
  $('wsxmrBal').textContent = (Number(await tokenBal(ataOf(cfg.wsxmrMint, wallet.publicKey))) / 1e8).toFixed(4) + ' wsXMR';
  const pr = pendingReturns(wallet.publicKey);
  const prAcc = await fetchRetry(() => program.account.pendingReturns.fetch(pr)).catch(() => null);
  $('pendingBal').textContent = prAcc
    ? `${Number(prAcc.collateralAmount) / 1e8} QQQx · ${Number(prAcc.solAmount) / LAMPORTS_PER_SOL} SOL`
    : 'no pending returns';
}

$('refresh').onclick = refreshAll;

// ── Mint flow ───────────────────────────────────────────────────────────────
const mintState = {}; // pda → {secret, pda, id}

$('mintBtn').onclick = async () => {
  if (!wallet || !myVault) return;
  const xmrAmt = BigInt(Math.round(parseFloat($('mintAmt').value) * 1e12)); // XMR 12-dec atomic
  if (xmrAmt <= 0n) return alert('bad amount');
  const vpda = myVault.pda;

  const secret = secrets.makeSecret();
  const id = pdas.mintRequestId(wallet.publicKey, vpda, xmrAmt, secret.commitment, await nextNonce());
  const pda = pdas.mintRequestPda(id, program.programId);
  const idHex = Buffer.from(id).toString('hex');

  // pendingReturns must exist before settle paths credit it
  const pr = pendingReturns(wallet.publicKey);
  if (!(await conn.getAccountInfo(pr))) {
    log('creating pending-returns account…');
    await walletTx(program.methods.initializePendingReturns().accounts({
      owner: wallet.publicKey, pendingReturns: pr, systemProgram: SystemProgram.programId }), wallet);
  }

  log(`initiating mint: ${parseFloat($('mintAmt').value)} XMR → req ${idHex.slice(0, 8)}…`);
  $('mintStatus').textContent = 'initiating…';
  try {
    await walletTx(program.methods.initiateMint(
      new BN(xmrAmt.toString()), Array.from(secret.commitment),
      Array.from(secret.pubKey), Array.from(id)
    ).accounts({
      initiator: wallet.publicKey, recipient: wallet.publicKey,
      vault: vpda, globalState: cfg.globalState, mintRequest: pda,
      griefingEscrow: cfg.raw.authority || wallet.publicKey,
      initiatorPendingReturns: pr,
      ...oracleAccounts(), systemProgram: SystemProgram.programId,
    }), wallet);
  } catch (e) { $('mintStatus').textContent = 'failed'; log('initiate failed: ' + e.message); return; }

  mintState[idHex] = { secret, pda, id };
  localStorage.setItem('mint-' + idHex, JSON.stringify({ secret: Buffer.from(secret.secret).toString('hex'), pda: pda.toBase58() }));
  log('mint initiated — LP server should pick it up shortly');
  trackMint(idHex);
};

async function trackMint(idHex) {
  const st = mintState[idHex];
  const lpPoll = async () => {
    try { return await (await fetch(`${lpServer}/mint/${idHex}`)).json(); } catch { return null; }
  };
  for (let i = 0; i < 600; i++) {
    await sleep(3000);
    let req = null;
    try { req = await program.account.mintRequest.fetch(st.pda); } catch {}
    const status = req && statusName(req.status);
    const srv = await lpPoll();
    const addr = srv?.depositAddress;
    $('mintStatus').textContent =
      `status: ${status || '?'}${addr ? ` · deposit XMR to ${addr.slice(0, 16)}…` : ''}`;

    if (status === 'ready' && !st.revealed) {
      st.revealed = true;
      log('mint ready — revealing secret on-chain');
      await walletTx(program.methods.revealSecret(Array.from(st.secret.secret))
        .preInstructions([CU(400_000)])
        .accounts({ caller: wallet.publicKey, mintRequest: st.pda }), wallet)
        .then(() => log('secret revealed'))
        .catch((e) => { st.revealed = false; log('reveal failed: ' + e.message); });
    }
    if (status === 'completed') {
      $('mintStatus').textContent = 'completed — wsXMR delivered';
      log(`mint ${idHex.slice(0, 8)} completed`);
      await refreshAll();
      return;
    }
    if (['cancelled', 'keyCancelled', 'expiredReady'].includes(status)) {
      $('mintStatus').textContent = 'resolved: ' + status;
      log(`mint ${idHex.slice(0, 8)} resolved as ${status}`);
      return;
    }
  }
}

// ── Burn flow ───────────────────────────────────────────────────────────────
const burnState = {};

$('burnBtn').onclick = async () => {
  if (!wallet || !myVault) return;
  const wsxmrAmt = BigInt(Math.round(parseFloat($('burnAmt').value) * 1e8));
  if (wsxmrAmt <= 0n) return alert('bad amount');
  if (wsxmrAmt < 1_000_000n) return alert('below protocol minimum: 0.01 wsXMR');
  const bal = await tokenBal(ataOf(cfg.wsxmrMint, wallet.publicKey));
  if (wsxmrAmt > bal) return alert(`insufficient wsXMR — balance ${Number(bal) / 1e8}`);
  const vpda = myVault.pda;
  const userAta = await ensureAta(cfg.wsxmrMint, wallet.publicKey);

  const secret = secrets.makeSecret();
  const id = pdas.burnRequestId(wallet.publicKey, vpda, wsxmrAmt, await nextNonce());
  const pda = pdas.burnRequestPda(id, program.programId);
  const idHex = Buffer.from(id).toString('hex');

  log(`requesting burn: ${$('burnAmt').value} wsXMR → req ${idHex.slice(0, 8)}…`);
  $('burnStatus').textContent = 'requesting…';
  try {
    await walletTx(program.methods.requestBurn(
      new BN(wsxmrAmt.toString()), Array.from(secret.commitment),
      Array.from(secret.pubKey), Array.from(secret.pubKey), Array.from(id)
    ).accounts({
      user: wallet.publicKey, vault: vpda, globalState: cfg.globalState, burnRequest: pda,
      wsxmrMint: cfg.wsxmrMint, userWsxmrAta: userAta,
      ...oracleAccounts(), tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }), wallet);
  } catch (e) {
    if (!/InvalidBurnRequest|0x1778/.test(e.message)) {
      $('burnStatus').textContent = 'failed'; log('burn request failed: ' + e.message); return;
    }
    // nonce raced another tx — retry once with a fresh nonce
    log('nonce raced — retrying with fresh request id');
    const id2 = pdas.burnRequestId(wallet.publicKey, vpda, wsxmrAmt, await nextNonce());
    const pda2 = pdas.burnRequestPda(id2, program.programId);
    try {
      await walletTx(program.methods.requestBurn(
        new BN(wsxmrAmt.toString()), Array.from(secret.commitment),
        Array.from(secret.pubKey), Array.from(secret.pubKey), Array.from(id2)
      ).accounts({
        user: wallet.publicKey, vault: vpda, globalState: cfg.globalState, burnRequest: pda2,
        wsxmrMint: cfg.wsxmrMint, userWsxmrAta: userAta,
        ...oracleAccounts(), tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }), wallet);
      burnState[Buffer.from(id2).toString('hex')] = { secret, pda: pda2, id: id2 };
      const idHex = Buffer.from(id2).toString('hex');
      log('burn requested — waiting for LP proposal');
      trackBurn(idHex);
      return;
    } catch (e2) { $('burnStatus').textContent = 'failed'; log('burn retry failed: ' + e2.message); return; }
  }

  burnState[idHex] = { secret, pda, id };
  localStorage.setItem('burn-' + idHex, JSON.stringify({ secret: Buffer.from(secret.secret).toString('hex'), pda: pda.toBase58() }));
  log('burn requested — waiting for LP proposal');
  trackBurn(idHex);
};

async function trackBurn(idHex) {
  const st = burnState[idHex];
  for (let i = 0; i < 600; i++) {
    await sleep(3000);
    let req = null;
    try { req = await program.account.burnRequest.fetch(st.pda); } catch {}
    const status = req && statusName(req.status);
    $('burnStatus').textContent = 'status: ' + (status || '?');

    if (status === 'proposed' && !st.confirmed) {
      st.confirmed = true;
      log('LP proposed — confirming monero lock on-chain');
      await walletTx(program.methods.confirmMoneroLock().accounts({
        user: wallet.publicKey, burnRequest: st.pda }), wallet)
        .then(() => log('lock confirmed — LP finalizing'))
        .catch((e) => { st.confirmed = false; log('confirm failed: ' + e.message); });
    }
    if (status === 'completed') {
      $('burnStatus').textContent = 'completed — collateral reward pending';
      log(`burn ${idHex.slice(0, 8)} completed — claim from pending returns`);
      await refreshAll();
      return;
    }
    if (['slashed', 'cancelled'].includes(status)) {
      $('burnStatus').textContent = 'resolved: ' + status;
      return;
    }
  }
}

// ── Pending returns ─────────────────────────────────────────────────────────
$('withdrawBtn').onclick = async () => {
  if (!wallet) return;
  const pr = pendingReturns(wallet.publicKey);
  const acc = await conn.getAccountInfo(pr);
  if (!acc) return alert('no pending returns account');
  const prAcc = await program.account.pendingReturns.fetch(pr);
  const hasCol = BigInt(prAcc.collateralAmount.toString()) > 0n;
  const hasSol = BigInt(prAcc.solAmount.toString()) > 0n;
  if (!hasCol && !hasSol) return alert('nothing to withdraw');

  if (hasSol) {
    await walletTx(program.methods.withdrawSolReturns().accounts({
      owner: wallet.publicKey, pendingReturns: pr, globalState: cfg.globalState,
      solEscrow: cfg.solEscrow, systemProgram: SystemProgram.programId,
    }), wallet).then(() => log('withdrew SOL returns')).catch((e) => log('sol withdraw failed: ' + e.message));
  }
  if (hasCol) {
    const userColAta = await ensureAta(cfg.collateralMint, wallet.publicKey);
    await walletTx(program.methods.withdrawCollateralReturns().accounts({
      owner: wallet.publicKey, pendingReturns: pr, globalState: cfg.globalState,
      collateralMint: cfg.collateralMint, programCollateralAta: cfg.programCollateralAta,
      userCollateralAta: userColAta, tokenProgram: TOKEN_2022_PROGRAM_ID,
    }), wallet).then(() => log('withdrew collateral returns')).catch((e) => log('collateral withdraw failed: ' + e.message));
  }
  await refreshAll();
};

// ── Request history ─────────────────────────────────────────────────────────
async function watchRequests() {
  const render = async () => {
    if (!wallet) return;
    try {
      const [mints, burns] = await Promise.all([
        program.account.mintRequest.all().then((a) => a.filter((r) => r.account.initiator.equals(wallet.publicKey))),
        program.account.burnRequest.all().then((a) => a.filter((r) => r.account.user.equals(wallet.publicKey))),
      ]);
      const rows = [
        ...mints.map((r) => ({ type: 'mint', status: statusName(r.account.status), amt: Number(r.account.xmrAmount) / 1e12 + ' XMR', pda: r.publicKey })),
        ...burns.map((r) => ({ type: 'burn', status: statusName(r.account.status), amt: Number(r.account.wsxmrAmount) / 1e8 + ' wsXMR', pda: r.publicKey })),
      ];
      $('history').innerHTML = rows.length
        ? rows.map((r) => `<tr><td>${r.type}</td><td>${r.amt}</td><td>${r.status}</td><td>${r.pda.toBase58().slice(0, 12)}…</td></tr>`).join('')
        : '<tr><td colspan="4">no requests yet</td></tr>';
    } catch (e) { /* throttled — retry next pass */ }
  };
  render();
  setInterval(render, 30000);
}

// recover in-flight requests after reload
for (let i = 0; i < localStorage.length; i++) {
  const k = localStorage.key(i);
  try {
    if (k.startsWith('mint-')) {
      const { secret, pda } = JSON.parse(localStorage.getItem(k));
      const id = k.slice(5);
      mintState[id] = { secret: { secret: Buffer.from(secret, 'hex') }, pda: new PublicKey(pda) };
      trackMint(id);
    } else if (k.startsWith('burn-')) {
      const { secret, pda } = JSON.parse(localStorage.getItem(k));
      burnState[k.slice(5)] = { secret, pda: new PublicKey(pda) };
    }
  } catch {}
}
