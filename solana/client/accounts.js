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
  const raw = await conn.getProgramAccounts(program.programId, {
    filters: mintRequestsForVault(vault),
  });
  const out = [];
  for (const { pubkey, account } of raw) {
    const req = program.coder.accounts.decode('mintRequest', account.data);
    if (!statuses || statuses.has(statusName(req.status))) {
      out.push({ pubkey, request: req });
    }
  }
  return out;
}

/** Fetch + decode all BurnRequests for a vault, optionally filtered by status. */
export async function scanBurnRequests(conn, program, vault, statuses) {
  const raw = await conn.getProgramAccounts(program.programId, {
    filters: burnRequestsForVault(vault),
  });
  const out = [];
  for (const { pubkey, account } of raw) {
    const req = program.coder.accounts.decode('burnRequest', account.data);
    if (!statuses || statuses.has(statusName(req.status))) {
      out.push({ pubkey, request: req });
    }
  }
  return out;
}

/** Anchor enum → { pending: {} } → 'pending'. */
export function statusName(statusEnum) {
  if (!statusEnum) return null;
  const k = Object.keys(statusEnum);
  return k.length ? k[0] : null;
}
