// Vendor entry — everything the Solana port of viemClient.js needs,
// bundled once by esbuild so the rest of the UI keeps its URL-import style.

import "./buffer-shim.js";
export * as web3 from '@solana/web3.js';
export { Program, AnchorProvider } from '@coral-xyz/anchor';
export { default as BN } from 'bn.js';
export * as spl from '@solana/spl-token';

export * as pdas from '../../client/pdas.js';
export * as accounts from '../../client/accounts.js';
export * as secrets from '../../client/secrets.js';
export { loadProgram, confirm, sendAndConfirm, rpcIx, fetchRetry, makeConnection, DEFAULT_COMMITMENT } from '../../client/connection.js';

export { keccak_256 } from '@noble/hashes/sha3';
export { sha256 } from '@noble/hashes/sha2.js';
export * as ed25519 from '@noble/ed25519';
