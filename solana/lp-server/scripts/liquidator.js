// liquidator.js — permissionless kick/auction watcher.
//
// Oracle-free: there is no price to read. A vault is kickable when its free
// collateral cannot cover debt+pendingDebt at its OWN declared threshold —
// the same coverage check the program enforces at mint time. The kick posts
// a bond and opens the grace window; the auction itself is the solvency test.
//
//   node scripts/liquidator.js            # single pass
//   node scripts/liquidator.js --loop 60  # every 60s
//
// Phases (unix seconds):
//   GRACE      kick_time .. +KICK_GRACE          — LP can still rescue
//   OPEN_DELAY .. +AUCTION_OPEN_DELAY            — settle in-flight burns, open
//   ACTIVE     .. auction_end                    — bid() clears FULL debt for
//                                                X(t)% of offered collateral
//   ENDED      ..                                — resolve_kick → freeze
//
// Env:
//   WATCH_ONLY=1   report only — never kick/bid/resolve (default: act)
//
import { SystemProgram } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from '@solana/spl-token';
import { WrapSynthClient } from '../../client/client.js';
import {
  auctionPda,
  auctionBondEscrowPda,
  vaultCollateralEscrowPda,
} from '../../client/pdas.js';

const KICK_GRACE_S = 3_600;
const AUCTION_OPEN_DELAY_S = 300;
const WATCH_ONLY = process.env.WATCH_ONLY === '1';
const LOOP_S = process.argv.includes('--loop')
  ? Number(process.argv[process.argv.indexOf('--loop') + 1] || 60)
  : null;

const c = WrapSynthClient.fromDevnet(
  process.env.LP_KEYPAIR || process.env.HOME + '/.config/solana/id.json'
);
const me = c.payer;

/** lamports required to cover `wsxmr` at the vault's declared threshold. */
const required = (wsxmr, threshold) =>
  (BigInt(wsxmr) * BigInt(threshold)) / 10n ** 8n;

function phaseOf(auction, now) {
  if (!auction.active) return 'NONE';
  const kick = Number(auction.kickTime.toString());
  const end = Number(auction.auctionEnd.toString());
  if (now < kick + KICK_GRACE_S) return 'GRACE';
  if (now < kick + KICK_GRACE_S + AUCTION_OPEN_DELAY_S) return 'OPEN_DELAY';
  if (now < end) return 'ACTIVE';
  return 'ENDED';
}

async function pass() {
  const gs = await c.fetchRetry(() =>
    c.program.account.globalState.fetch(c.globalState)
  );
  const debtIndex = BigInt(gs.globalDebtIndex.toString());
  const now = Math.floor(Date.now() / 1000);

  const vaults = await c.fetchRetry(() => c.program.account.vault.all());
  console.log(`scanning ${vaults.length} vault(s) | debtIndex ${debtIndex}`);

  for (const { publicKey: vaultKey, account: v } of vaults) {
    const debt =
      (BigInt(v.normalizedDebt.toString()) * debtIndex) / 10n ** 18n;
    const pending = BigInt(v.pendingDebt.toString());
    const threshold = BigInt(v.thresholdLamportsPerWsxmr.toString());
    const free =
      BigInt(v.collateralAmount.toString()) -
      BigInt(v.lockedCollateral.toString());
    const needed = required(debt + pending, threshold);
    const tag = vaultKey.toBase58().slice(0, 8);
    console.log(
      `  vault ${tag} (lp ${v.lpAddress.toBase58().slice(0, 8)}): ` +
        `debt ${debt} free ${free} needed ${needed} ` +
        `kick=${v.kickActive} frozen=${v.frozen}`
    );
    if (WATCH_ONLY) continue;

    // ── Active auction on this vault? ────────────────────────────────────
    const aucKey = auctionPda(vaultKey, c.programId);
    if (v.kickActive) {
      const auction = await c.fetchRetry(() =>
        c.program.account.auction.fetch(aucKey)
      );
      const phase = phaseOf(auction, now);
      console.log(`    auction phase: ${phase}`);
      const bondEscrow = auctionBondEscrowPda(vaultKey, c.programId);
      const vaultEscrow = vaultCollateralEscrowPda(vaultKey, c.programId);

      if (phase === 'ENDED') {
        try {
          const sig = await c.rpcIx(
            c.program.methods.resolveKick().accounts({
              caller: me.publicKey,
              vault: vaultKey,
              auction: aucKey,
              kicker: auction.kicker,
              bondEscrow,
              vaultCollateralEscrow: vaultEscrow,
              globalState: c.globalState,
              systemProgram: SystemProgram.programId,
            }),
            []
          );
          console.log(`    resolved kick → frozen — ${sig}`);
        } catch (e) {
          console.log(`    resolve_kick failed: ${e.message?.slice(0, 120)}`);
        }
        continue;
      }

      if (phase !== 'ACTIVE' || !auction.auctionOpened) continue;

      // ACTIVE + opened: bid if our wsXMR covers the full debt.
      if (debt === 0n) continue;
      const ata = getAssociatedTokenAddressSync(
        c.wsxmrMint, me.publicKey, true, TOKEN_2022_PROGRAM_ID
      );
      const bal = await getAccount(c.conn, ata, undefined, TOKEN_2022_PROGRAM_ID)
        .then((a) => BigInt(a.amount.toString()))
        .catch(() => 0n);
      if (bal < debt) {
        console.log(`    active auction, need ${debt} wsXMR — have ${bal}`);
        continue;
      }
      try {
        const sig = await c.rpcIx(
          c.program.methods.bid().accounts({
            bidder: me.publicKey,
            vault: vaultKey,
            auction: aucKey,
            kicker: auction.kicker,
            bondEscrow,
            globalState: c.globalState,
            wsxmrMint: c.wsxmrMint,
            bidderWsxmrAta: ata,
            vaultCollateralEscrow: vaultEscrow,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          }),
          []
        );
        console.log(`    BID — cleared ${debt} debt — ${sig}`);
      } catch (e) {
        console.log(`    bid failed: ${e.message?.slice(0, 120)}`);
      }
      continue;
    }

    // ── Kickable? free < required(debt+pending) at declared threshold ────
    if (!v.active || v.frozen || debt === 0n || free >= needed) continue;
    try {
      const sig = await c.rpcIx(
        c.program.methods.kick().accounts({
          kicker: me.publicKey,
          vault: vaultKey,
          auction: aucKey,
          bondEscrow: auctionBondEscrowPda(vaultKey, c.programId),
          globalState: c.globalState,
          systemProgram: SystemProgram.programId,
        }),
        []
      );
      console.log(`    KICKED (undercovered at own threshold) — ${sig}`);
    } catch (e) {
      console.log(`    kick failed: ${e.message?.slice(0, 120)}`);
    }
  }
}

if (LOOP_S) {
  console.log(`watcher loop every ${LOOP_S}s`);
  setInterval(
    () => pass().catch((e) => console.error('[watcher]', e.message)),
    LOOP_S * 1000
  );
}
pass().catch((e) => {
  console.error('[watcher]', e.message ?? e);
  if (!LOOP_S) process.exit(1);
});
