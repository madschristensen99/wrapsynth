// config.js — LP server runtime configuration (env-driven).
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LP_DIR = path.join(__dirname, '..');

export const cfg = {
  // REQUIRED: path to the LP's Solana keypair JSON. The LP's vault PDA is
  // derived from this pubkey: [b"vault", lp_pubkey].
  lpKeypairPath: process.env.LP_KEYPAIR || null,

  port: Number(process.env.PORT || 3001),

  // devnet-config.json — defaults to the anchor-program deployment config
  devnetConfigPath: process.env.DEVNET_CONFIG || undefined,
  rpcUrl: process.env.DEVNET_URL || undefined,

  // How often to scan request accounts for our vault
  pollMs: Number(process.env.POLL_MS || 15000),

  // Mint pipeline tuning
  depositPollIntervalMs: Number(process.env.DEPOSIT_POLL_INTERVAL_MS || 15000),
  depositMaxWaitMs: Number(process.env.DEPOSIT_MAX_WAIT_MS || 2 * 60 * 60 * 1000),
  depositToleranceBps: Number(process.env.DEPOSIT_TOLERANCE_BPS || 300),

  // LP's main Monero wallet address — destination for swept mint deposits.
  lpMoneroAddress: process.env.LP_MONERO_ADDRESS || null,

  // Secret persistence (survives restarts — REQUIRED for sweep safety)
  secretsFile:
    process.env.LP_SECRETS_FILE || path.join(LP_DIR, 'lp-secrets.json'),
  burnSecretsFile:
    process.env.LP_BURN_SECRETS_FILE || path.join(LP_DIR, 'lp-burn-secrets.json'),

  // in-memory state file for processed requests (optional, restart hints)
  stateFile:
    process.env.LP_STATE_FILE || path.join(LP_DIR, 'lp-state.json'),
};

if (!cfg.lpKeypairPath) {
  console.error('Error: LP_KEYPAIR env var is required (path to keypair JSON)');
  process.exit(1);
}
