// client.js — WrapSynthClient facade: connection + program + config + signer
// bundled with the pdas/secrets/accounts helpers. Both the LP server and the
// frontend (injected deps) use this surface.

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import * as conn_ from './connection.js';
import * as pdas from './pdas.js';
import * as accounts from './accounts.js';
import * as secrets from './secrets.js';
import { loadConfig, loadIdl, loadKeypair } from './config.js';

export { conn_, pdas, accounts, secrets };
export { TOKEN_2022_PROGRAM_ID, SystemProgram, PublicKey };

export class WrapSynthClient {
  /**
   * @param {import('@solana/web3.js').Connection} conn
   * @param {import('@coral-xyz/anchor').Program} program
   * @param {object} cfg — parsed devnet config (loadConfig output)
   * @param {import('@solana/web3.js').Keypair|null} payer — signer for this process
   */
  constructor(conn, program, cfg, payer) {
    this.conn = conn;
    this.program = program;
    this.cfg = cfg;
    this.payer = payer;
    this.programId = program.programId;
  }

  /** Node convenience: build everything from devnet-config + a keypair file. */
  static fromDevnet(keypairFile, configPath) {
    const cfg = loadConfig(configPath);
    const payer = loadKeypair(keypairFile);
    const conn = conn_.makeConnection(cfg.rpc);
    const program = conn_.loadProgram(conn, payer, loadIdl());
    return new WrapSynthClient(conn, program, cfg, payer);
  }

  // ── PDAs ────────────────────────────────────────────────────────────────
  vaultPda = (lp) => pdas.vaultPda(lp, this.programId);
  vaultCollateralEscrow = (vault) => pdas.vaultCollateralEscrowPda(vault, this.programId);
  // Legacy alias — same PDA, pre-SOL naming
  vaultCollateralAta = (vault) => this.vaultCollateralEscrow(vault);
  pendingReturns = (owner) => pdas.pendingReturnsPda(owner, this.programId);
  mintRequestPda = (id) => pdas.mintRequestPda(id, this.programId);
  burnRequestPda = (id) => pdas.burnRequestPda(id, this.programId);
  get globalState() { return this.cfg.globalState; }
  get wsxmrMint() { return this.cfg.wsxmrMint; }
  get collateralMint() { return this.cfg.collateralMint; }
  get programCollateralAta() { return this.cfg.programCollateralAta; }
  get pythXmr() { return this.cfg.oracleXmr; }
  get pythCol() { return this.cfg.oracleSol; }

  nextNonce = () => pdas.nextRequestNonce(this.program, this.globalState);

  // ── Tx plumbing (HTTP confirm — see connection.js for why) ──────────────
  rpcIx = (builder, signers, opts) =>
    conn_.rpcIx(this.conn, builder, [this.payer, ...signers], opts);
  fetchRetry = conn_.fetchRetry;
  confirm = (sig) => conn_.confirm(this.conn, sig);

  // ── Request scanning ────────────────────────────────────────────────────
  scanMintRequests = (vault, statuses) =>
    accounts.scanMintRequests(this.conn, this.program, vault, statuses);
  scanBurnRequests = (vault, statuses) =>
    accounts.scanBurnRequests(this.conn, this.program, vault, statuses);

  // ── Common account sets ──────────────────────────────────────────────────
  oracleAccounts() {
    return { pythXmr: this.pythXmr, pythCollateral: this.pythCol };
  }
  collateralAccounts(vault) {
    return {
      vaultCollateralEscrow: this.vaultCollateralAta(vault),
      collateralEscrow: this.programCollateralAta,
    };
  }
}
