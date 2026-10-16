// recover-sweeps.js — one-shot recovery of unswept mint deposits.
// Iterates lp-secrets.json, reads the user's revealedSecret directly from the
// on-chain mint request (no event scan), reconstructs each deposit wallet from
// lpSecret + userSecret, and sweep_all's it to the LP main address.
//
// Run against a DEDICATED wallet-rpc instance so the live server's lp-wallet
// isn't evicted mid-send:
//   MONERO_WALLET_RPC_URL=http://127.0.0.1:18084 node recover-sweeps.js

import 'dotenv/config';
import * as ethers from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as moneroWallet from './moneroWallet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployment.json'), 'utf8'));
const HUB_ADDRESS = deployment.contracts.wsXmrHub;
const LP_MAIN_ADDRESS = '47c5D4w8C8Ya9cwKjXZVJDDZmCJh3DisqaUzHkrrKZDrY7psQni4udG5mBp5YyMzTYZK1ULJATnP1SdXCSTGV7xAHRfrhvn';
const SECRETS_FILE = path.join(__dirname, 'lp-secrets.json');

const HUB_ABI = [
  'function getMintRequest(bytes32) view returns (tuple(bytes32 requestId, address initiator, address recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout, uint256 griefingDeposit, uint256 normalizedDebtAmount, uint256 vaultMintNonce, bytes32 lpCommitment, bytes32 revealedSecret, uint8 status))',
  'function lpPublicKeys(bytes32) view returns (bytes32)',
  'function lpPublicViewKeys(bytes32) view returns (bytes32)',
];

const RPC_URLS = (process.env.RPC_URLS || process.env.RPC_URL || '').split(',').map(u => u.trim()).filter(Boolean);

async function makeProvider() {
  for (const url of RPC_URLS) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      await p.getBlockNumber();
      console.log(`[Recover] Using RPC ${url}`);
      return p;
    } catch { /* try next */ }
  }
  throw new Error('No working RPC_URL');
}

async function scalarHexToPubKeyHex(keyHex) {
  const ed = await import('@noble/ed25519');
  const { createHash } = await import('crypto');
  if (!ed.etc.sha512Sync) {
    ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
  }
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const le = Buffer.from(keyHex.replace(/^0x/, ''), 'hex').reverse();
  const s = BigInt('0x' + le.toString('hex')) % L;
  return Buffer.from(ed.ExtendedPoint.BASE.multiply(s).toRawBytes()).toString('hex');
}

const secrets = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
const provider = await makeProvider();
const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, provider);
const ZERO = '0x' + '0'.repeat(64);

console.log(`[Recover] Sweep destination: ${LP_MAIN_ADDRESS}`);

for (const [reqIdHex, entry] of Object.entries(secrets)) {
  if (entry.swept) { console.log(`[Recover] ${reqIdHex.slice(0, 14)} swept — skip`); continue; }
  if (entry.unrecoverable) { console.log(`[Recover] ${reqIdHex.slice(0, 14)} unrecoverable — skip`); continue; }

  try {
    const req = await hub.getMintRequest(reqIdHex);
    const status = Number(req.status);
    const userSecret = req.revealedSecret;

    if (userSecret === ZERO) {
      console.log(`[Recover] ${reqIdHex.slice(0, 14)} status=${status}, no revealedSecret — cannot sweep (user never revealed)`);
      continue;
    }
    console.log(`\n[Recover] ${reqIdHex} status=${status} — secret revealed, sweeping`);

    // Sanity: persisted lpSecret must derive the on-chain spend pub
    try {
      const onChainSpendPub = (await hub.lpPublicKeys(reqIdHex)).replace(/^0x/, '').toLowerCase();
      const derived = await scalarHexToPubKeyHex(entry.lpSecret);
      if (derived !== onChainSpendPub) {
        console.warn(`[Recover] ${reqIdHex.slice(0, 14)} lpSecret mismatch — marking unrecoverable`);
        entry.unrecoverable = true;
        continue;
      }
    } catch (e) {
      console.warn(`[Recover] key check failed (${e.message}) — proceeding anyway`);
    }

    let depositHeight = entry.depositHeight || 0;
    if (!depositHeight && entry.depositTxHash) {
      depositHeight = await moneroWallet.getTxHeight(entry.depositTxHash);
      if (depositHeight) entry.depositHeight = depositHeight;
    }
    if (!depositHeight) {
      console.warn(`[Recover] ${reqIdHex.slice(0, 14)} no deposit height — scan window may miss it`);
    }

    // View-key candidates, same scheme as server.js sweepMintWithViewKeyFallback
    const candidates = [];
    const lpSpendPub = (await hub.lpPublicKeys(reqIdHex)).replace(/^0x/, '').toLowerCase();
    const lpViewPub = (await hub.lpPublicViewKeys(reqIdHex)).replace(/^0x/, '').toLowerCase();
    if (lpSpendPub === lpViewPub) {
      candidates.push({ key: entry.lpSecret.replace(/^0x/, ''), label: 'lpSecret' });
    }
    // Always try all schemes — a persisted depositTxHash proves the deposit
    // exists somewhere even when the canonical derivation finds nothing.
    if (process.env.MONERO_VIEW_KEY) {
      candidates.push({ key: process.env.MONERO_VIEW_KEY.replace(/^0x/, ''), label: 'MONERO_VIEW_KEY' });
    }
    candidates.push({
      key: Buffer.from(userSecret.replace(/^0x/, ''), 'hex').reverse().toString('hex'),
      label: 'userSecret-LE',
    });
    if (!candidates.length) candidates.push({ key: entry.lpSecret.replace(/^0x/, ''), label: 'lpSecret' });

    for (const cand of candidates) {
      console.log(`[Recover]   trying view key: ${cand.label}`);
      try {
        const res = await moneroWallet.sweepMintDeposit({
          userSecretHex: userSecret,
          lpSecretHex: entry.lpSecret,
          lpMainAddress: LP_MAIN_ADDRESS,
          restoreHeight: entry.initiatedAtBlock || 0,
          depositHeight,
          viewKeyLeHex: cand.key,
        });
        if (res.swept) {
          entry.swept = true;
          entry.sweepTxHashes = res.txHashes;
          entry.sweepAmount = res.amount.toString();
          console.log(`[Recover]   SWEPT ${res.amount} atomic (${(Number(res.amount) / 1e12).toFixed(6)} XMR)`);
          break;
        }
        if (res.balance && res.balance > 0n) {
          console.log(`[Recover]   deposit found (${res.balance} atomic) but locked — will need confirmations`);
          break;
        }
        console.log(`[Recover]   no deposit at ${cand.label} address`);
      } catch (candErr) {
        console.warn(`[Recover]   candidate ${cand.label} errored: ${candErr.message}`);
      }
      // Reset wallet-rpc state: the sweep helper's main-wallet restore can leave
      // half-deleted files / "does not correspond" — wipe and reopen clean.
      try {
        await fetch(process.env.MONERO_WALLET_RPC_URL + '/json_rpc', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'close_wallet', params: {} }),
        });
      } catch {}
      const wdir = process.env.RECOVER_WALLET_DIR;
      if (wdir) {
        for (const f of fs.readdirSync(wdir)) {
          if (f.startsWith('sweep-tmp')) fs.unlinkSync(path.join(wdir, f));
        }
      }
    }
  } catch (err) {
    console.error(`[Recover] ${reqIdHex.slice(0, 14)} failed:`, err.message || err);
  }

  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 2));
}

console.log('\n[Recover] Done. Final secrets state written.');
