// pdas.js — PDA seeds, derivations, and request-ID hashing.
// MUST mirror the on-chain formulas exactly or transactions revert:
//   mint: request_id = keccak(initiator, vault, xmr_amount[u64le],
//                             claim_commitment, nonce[u64le])
//   burn: request_id = keccak(user, vault, wsxmr_amount[u64le], nonce[u64le])
// where nonce = global_state.request_nonce + 1 AT CALL TIME — read it fresh
// immediately before building the request.

import { PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';

export const SEEDS = {
  globalState: Buffer.from('global_state'),
  wsxmrMint: Buffer.from('wsxmr_mint'),
  programCollateral: Buffer.from('program_collateral'),
  vault: Buffer.from('vault'),
  vaultCollateral: Buffer.from('vault_collateral'),
  pendingReturns: Buffer.from('pending_returns'),
  mintRequest: Buffer.from('mint_request'),
  burnRequest: Buffer.from('burn_request'),
  solEscrow: Buffer.from('sol_escrow'),
  coLpPosition: Buffer.from('co_lp_position'),
  coLpPositionMint: Buffer.from('co_lp_position_mint'),
};

export const findPda = (seeds, programId) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const globalStatePda = (pid) => findPda([SEEDS.globalState], pid);
export const wsxmrMintPda = (pid) => findPda([SEEDS.wsxmrMint], pid);
export const programCollateralAtaPda = (pid) =>
  findPda([SEEDS.programCollateral], pid);
export const solEscrowPda = (pid) => findPda([SEEDS.solEscrow], pid);
export const vaultPda = (lp, pid) =>
  findPda([SEEDS.vault, lp.toBuffer()], pid);
export const vaultCollateralAtaPda = (vault, pid) =>
  findPda([SEEDS.vaultCollateral, vault.toBuffer()], pid);
export const pendingReturnsPda = (owner, pid) =>
  findPda([SEEDS.pendingReturns, owner.toBuffer()], pid);
export const mintRequestPda = (requestId, pid) =>
  findPda([SEEDS.mintRequest, requestId], pid);
export const burnRequestPda = (requestId, pid) =>
  findPda([SEEDS.burnRequest, requestId], pid);

export function le64(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

/** Mint request ID — keccak(initiator, vault, xmr_amount, commitment, nonce). */
export function mintRequestId(initiator, vault, xmrAmount, commitment, nonce) {
  return Buffer.from(
    keccak_256(
      Buffer.concat([
        initiator.toBuffer(),
        vault.toBuffer(),
        le64(xmrAmount),
        Buffer.from(commitment),
        le64(nonce),
      ])
    )
  );
}

/** Burn request ID — keccak(user, vault, wsxmr_amount, nonce). */
export function burnRequestId(user, vault, wsxmrAmount, nonce) {
  return Buffer.from(
    keccak_256(
      Buffer.concat([
        user.toBuffer(),
        vault.toBuffer(),
        le64(wsxmrAmount),
        le64(nonce),
      ])
    )
  );
}

/** Read global.request_nonce fresh — the value to hash is nonce + 1. */
export async function nextRequestNonce(program, globalState) {
  const gs = await program.account.globalState.fetch(globalState);
  return BigInt(gs.requestNonce.toString()) + 1n;
}
