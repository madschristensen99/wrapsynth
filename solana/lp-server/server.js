// server.js — WrapSynth Solana LP node.
//
// Polls MintRequest/BurnRequest accounts for our vault and drives the atomic-
// swap handshakes. Express API mirrors lp-server-js so the frontend port stays
// a small diff. On-chain tx conventions come from solana/client (HTTP-poll
// confirm — websocket confirm dies under public devnet RPC throttling).
//
// Env:  LP_KEYPAIR (required, keypair JSON path) · DEVNET_URL · PORT · POLL_MS
//       LP_MONERO_ADDRESS · MONERO_WALLET_RPC_URL (+ usual moneroWallet env)
//       SKIP_DEPOSIT_VERIFICATION=1 (devnet only — marks mints ready w/o XMR)

import express from 'express';
import { WrapSynthClient } from '../client/client.js';
import { cfg } from './src/config.js';
import { JsonStore } from './src/store.js';
import { MintPipeline } from './src/mintPipeline.js';
import { BurnPipeline } from './src/burnPipeline.js';
import { Cranks } from './src/cranks.js';
import * as moneroWallet from './moneroWallet.js';

const client = WrapSynthClient.fromDevnet(cfg.lpKeypairPath, cfg.devnetConfigPath);
const lpPubkey = client.payer.publicKey;
const vault = client.vaultPda(lpPubkey);
const mintSecrets = new JsonStore(cfg.secretsFile);
const burnSecrets = new JsonStore(cfg.burnSecretsFile);
const mints = new MintPipeline({ client, vault, store: mintSecrets });
const burns = new BurnPipeline({ client, vault, store: burnSecrets });
const cranks = new Cranks({ client, vault, mintStore: mintSecrets });

const state = {
  startedAt: Date.now(),
  lastScanAt: null,
  lastScanError: null,
};

async function scanLoop() {
  try {
    await mints.tick();
    await burns.tick();
    await cranks.tick();
    state.lastScanAt = Date.now();
    state.lastScanError = null;
  } catch (e) {
    state.lastScanError = e.message ?? String(e);
    console.error('[scan]', state.lastScanError);
  }
}

// ─── API ────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
// The frontend runs on a different port — allow cross-origin reads.
app.use((_req, res, next) => {
  res.set('access-control-allow-origin', '*');
  res.set('access-control-allow-headers', 'content-type');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    lp: lpPubkey.toBase58(),
    vault: vault.toBase58(),
    program: client.programId.toBase58(),
    uptime: Math.floor((Date.now() - state.startedAt) / 1000),
    lastScanAt: state.lastScanAt,
    lastScanError: state.lastScanError,
    monero: moneroWallet.isWalletConfigured(),
    inFlight: [...mints.inFlight.keys(), ...burns.inFlight.keys()],
  });
});

// Mint deposit addresses + status for the frontend mint flow.
// GET /mint/:requestId (hex, 0x-prefix optional)
app.get('/mint/:id', (req, res) => {
  const id = req.params.id.replace(/^0x/, '');
  const meta = mints.tracked.get(id);
  const entry = mintSecrets.get(id);
  if (!meta && !entry) return res.status(404).json({ error: 'unknown request' });
  res.json({
    requestId: id,
    status: meta?.status,
    depositAddress: meta?.depositAddress || entry?.depositAddress || null,
    xmrAmount: meta?.xmrAmount,
    wsxmrAmount: meta?.wsxmrAmount,
    timeout: meta?.timeout,
    depositTx: meta?.depositTx || null,
    error: meta?.autoProcessError || null,
  });
});

// All tracked burns for this vault.
app.get('/burns', (_req, res) => {
  res.json([...burns.tracked.entries()].map(([id, b]) => ({
    requestId: id,
    status: b.status,
    sharedAddress: b.sharedAddress || null,
    xmrAmount: b.xmrAmount,
    wsxmrAmount: b.wsxmrAmount,
    moneroTxHash: b.moneroTxHash || null,
    error: b.autoProcessError || null,
  })));
});

// All tracked mints for this vault (LP dashboard).
app.get('/mints', (_req, res) => {
  res.json([...mints.tracked.entries()].map(([id, m]) => ({
    requestId: id,
    status: m.status,
    depositAddress: m.depositAddress || null,
    xmrAmount: m.xmrAmount,
    wsxmrAmount: m.wsxmrAmount,
    error: m.autoProcessError || null,
  })));
});

// ─── Start ──────────────────────────────────────────────────────────────────
console.log(`[lp-server] LP:     ${lpPubkey.toBase58()}`);
console.log(`[lp-server] vault:  ${vault.toBase58()}`);
console.log(`[lp-server] program: ${client.programId.toBase58()}`);
console.log(`[lp-server] rpc:    ${client.conn.rpcEndpoint}`);
console.log(`[lp-server] monero: ${moneroWallet.isWalletConfigured() ? 'configured' : 'NOT configured'}`);

app.listen(cfg.port, () => {
  console.log(`[lp-server] listening on :${cfg.port}`);
});
setInterval(scanLoop, cfg.pollMs);
scanLoop();
