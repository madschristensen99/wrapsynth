// accounts.js — on-chain account scanning. Solana has no event logs to
// subscribe to; request discovery = getProgramAccounts + memcmp filters +
// Anchor decoding. This is what the LP server polls.

import { sha256 } from '@noble/hashes/sha2.js';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

/** Anchor account discriminator = sha256("account:<Name>")[0..8]. */
export function accountDisc(name) {
  return Buffer.from(sha256(new TextEncoder().encode(`account:${name}`))).subarray(0, 8);
}

export const DISCRIMINATORS = {
  mintRequest: accountDisc('MintRequest'),
  burnRequest: accountDisc('BurnRequest'),
  vault: accountDisc('Vault'),
  globalState: accountDisc('GlobalState'),
  pendingReturns: accountDisc('PendingReturns'),
  coLpPosition: accountDisc('CoLpPosition'),
};

// Byte offsets into the account data (after the 8-byte discriminator) for
// fields we filter on with memcmp. Keep in sync with state/*.rs field order.
export const OFFSETS = {
  // MintRequest: request_id[32], initiator[32], recipient[32], lp_vault[32]
  mintLpVault: 8 + 32 * 3,
  // BurnRequest: request_id[32], user[32], lp_vault[32]
  burnLpVault: 8 + 32 * 2,
};

/** Filter for all MintRequest accounts belonging to a vault. */
export function mintRequestsForVault(vault) {
  return [
    { memcmp: { offset: 0, bytes: bs58.encode(DISCRIMINATORS.mintRequest) } },
    {
      memcmp: {
        offset: OFFSETS.mintLpVault,
        bytes: vault.toBase58(),
      },
    },
  ];
}

/** Filter for all BurnRequest accounts belonging to a vault. */
export function burnRequestsForVault(vault) {
  return [
    { memcmp: { offset: 0, bytes: bs58.encode(DISCRIMINATORS.burnRequest) } },
    {
      memcmp: {
        offset: OFFSETS.burnLpVault,
        bytes: vault.toBase58(),
      },
    },
  ];
}

/** Fetch + decode all MintRequests for a vault, optionally filtered by status. */
export async function scanMintRequests(conn, program, vault, statuses) {
  const reqs = await scanRequests(conn, program, vault, 'mint');
  return reqs.filter(r => !statuses || statuses.has(statusName(r.request.status)));
}

/** Fetch + decode all BurnRequests for a vault, optionally filtered by status. */
export async function scanBurnRequests(conn, program, vault, statuses) {
  const reqs = await scanRequests(conn, program, vault, 'burn');
  return reqs.filter(r => !statuses || statuses.has(statusName(r.request.status)));
}

// Primary: signature scan (works on every RPC tier). Secondary: GPA merged in
// when it responds within 15s — picks up requests outside the signature window.
async function scanRequests(conn, program, vault, kind) {
  const [sigRes, gpaRes] = await Promise.allSettled([
    scanRequestsViaSignatures(conn, program, vault).then(r => kind === 'mint' ? r.mints : r.burns),
    timeoutAfter(
      conn.getProgramAccounts(program.programId, {
        filters: kind === 'mint' ? mintRequestsForVault(vault) : burnRequestsForVault(vault),
      }).then(raw => raw.map(({ pubkey, account }) => ({
        pubkey,
        request: program.coder.accounts.decode(kind === 'mint' ? 'mintRequest' : 'burnRequest', account.data),
      }))),
      15000, []),
  ]);
  if (sigRes.status === 'rejected' && gpaRes.status === 'rejected') throw sigRes.reason;
  const seen = new Map();
  for (const r of [...(gpaRes.value ?? []), ...(sigRes.value ?? [])]) {
    seen.set(r.pubkey.toBase58(), r);
  }
  return [...seen.values()];
}

function timeoutAfter(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(res => setTimeout(() => res(fallback), ms)),
  ]).catch(() => fallback);
}

// ── Signature-based discovery (GPA-free fallback) ────────────────────────────
// getSignaturesForAddress + getMultipleAccountsInfo are available on free-tier
// RPCs that reject getProgramAccounts. We collect account keys from every tx
// that touched the vault, then filter to MintRequest/BurnRequest accounts by
// discriminator + lp_vault field.

const sigScanCache = new Map(); // vaultB58 → { sigs: Set, candidates: Set<pubkeyB58> }

function sigScanState(vault) {
  const key = vault.toBase58();
  if (!sigScanCache.has(key)) sigScanCache.set(key, { sigs: new Set(), candidates: new Set() });
  return sigScanCache.get(key);
}

export async function scanRequestsViaSignatures(conn, program, vault, sigLimit = 100) {
  const st = sigScanState(vault);
  const sigs = await conn.getSignaturesForAddress(vault, { limit: sigLimit });
  const fresh = sigs.filter(s => !st.sigs.has(s.signature));
  for (const s of fresh) st.sigs.add(s.signature);

  for (const s of fresh) {
    try {
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const msg = tx.transaction.message;
      const keys = msg.staticAccountKeys ?? msg.accountKeys ?? [];
      for (const k of keys) st.candidates.add((k.pubkey ?? k).toBase58());
      const la = tx.meta?.loadedAddresses;
      if (la) for (const k of [...la.writable, ...la.readonly]) st.candidates.add(k.toBase58());
    } catch (_) { /* tx fetch failed — skip, candidate may arrive via another tx */ }
  }

  // Re-fetch every candidate each scan so status transitions are observed.
  const pks = [...st.candidates].map(b => new PublicKey(b));
  const mints = [], burns = [];
  for (let i = 0; i < pks.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(pks.slice(i, i + 100));
    infos.forEach((info, j) => {
      if (!info || !info.owner.equals(program.programId)) return;
      const data = info.data;
      const disc = Buffer.from(data.subarray(0, 8));
      if (disc.equals(DISCRIMINATORS.mintRequest)) {
        const req = program.coder.accounts.decode('mintRequest', data);
        if (req.lpVault.equals(vault)) mints.push({ pubkey: pks[i + j], request: req });
      } else if (disc.equals(DISCRIMINATORS.burnRequest)) {
        const req = program.coder.accounts.decode('burnRequest', data);
        if (req.lpVault.equals(vault)) burns.push({ pubkey: pks[i + j], request: req });
      }
    });
  }
  return { mints, burns };
}

/** Anchor enum → { pending: {} } → 'pending'. */
export function statusName(statusEnum) {
  if (!statusEnum) return null;
  const k = Object.keys(statusEnum);
  return k.length ? k[0] : null;
}
