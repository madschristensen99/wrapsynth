// config.js — devnet-config.json loading + keypair/env plumbing (Node only —
// the frontend gets its config injected instead of reading files).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Keypair, PublicKey } from '@solana/web3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SOLANA_ROOT = path.join(__dirname, '..');
export const DEFAULT_CONFIG_PATH = path.join(
  SOLANA_ROOT,
  'anchor-program',
  'devnet',
  'devnet-config.json'
);
export const IDL_PATH = path.join(
  SOLANA_ROOT,
  'anchor-program',
  'target',
  'idl',
  'wrapsynth_vault_manager.json'
);
export const ORACLE_MOCK_IDL_PATH = path.join(
  SOLANA_ROOT,
  'anchor-program',
  'target',
  'idl',
  'oracle_mock.json'
);

export function loadConfig(configPath = process.env.DEVNET_CONFIG || DEFAULT_CONFIG_PATH) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return {
    raw: cfg,
    cluster: cfg.cluster,
    rpc: process.env.DEVNET_URL || cfg.rpc,
    programId: new PublicKey(cfg.programId),
    globalState: new PublicKey(cfg.globalState),
    wsxmrMint: new PublicKey(cfg.wsxmrMint),
    collateralMint: new PublicKey(cfg.collateralMint),
    programCollateralAta: new PublicKey(cfg.programCollateralAta),
    solEscrow: new PublicKey(cfg.solEscrow),
    oracleXmr: new PublicKey(cfg.oracle.xmr),
    oracleQqqx: new PublicKey(cfg.oracle.qqqx),
    oracleMockProgramId: new PublicKey(cfg.oracleMockProgramId),
    authority: new PublicKey(cfg.authority),
    adminCollateralAta: new PublicKey(cfg.adminCollateralAta),
  };
}

export function loadIdl() {
  return JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
}
export function loadOracleMockIdl() {
  return JSON.parse(fs.readFileSync(ORACLE_MOCK_IDL_PATH, 'utf8'));
}

export function loadKeypair(file) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8')))
  );
}
