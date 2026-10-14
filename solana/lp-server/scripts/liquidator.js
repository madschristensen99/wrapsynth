// liquidator.js — permissionless liquidation bot.
//
// Scans every Vault account, computes the collateral ratio off-chain from the
// (mock) oracle prices, and calls execute_liquidation on underwater vaults.
// The liquidator pays wsXMR (burned against vault debt) and receives vault
// collateral at the LIQUIDATION_BONUS discount.
//
//   node scripts/liquidator.js            # single pass
//   node scripts/liquidator.js --loop 60  # every 60s
//
// Ratio formula mirrors the program exactly (all USD at 1e18 scale):
//   actual_debt = normalized_debt * global_debt_index / 1e18
//   col_usd     = collateral_amount * col_price_18 / 1e8
//   debt_usd    = actual_debt      * xmr_price_18 / 1e8
//   ratio       = col_usd * 100 / debt_usd   →  liquidate when < 150

import { SystemProgram, Transaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from '@solana/spl-token';
import BN from 'bn.js';
import { WrapSynthClient } from '../../client/client.js';
import { vaultCollateralAtaPda } from '../../client/pdas.js';
import { sendAndConfirm } from '../../client/connection.js';

const LIQUIDATION_RATIO = 150n;
const LOOP_S = process.argv.includes('--loop')
  ? Number(process.argv[process.argv.indexOf('--loop') + 1] || 60)
  : null;

const c = WrapSynthClient.fromDevnet(
  process.env.LP_KEYPAIR || process.env.HOME + '/.config/solana/id.json'
);
const lp = c.payer;

/** Mock-Pyth blob: price i64 @74, exponent i32 @90 → 18-decimal USD. */
function readMockPrice(accountData) {
  const price = accountData.readBigInt64LE(74);
  const exp = accountData.readInt32LE(90);
  if (price <= 0n) return null;
  return price * 10n ** BigInt(18 + exp);
}

async function pass() {
  const [colAcc, xmrAcc] = await c.fetchRetry(() =>
    c.conn.getMultipleAccountsInfo([c.pythCol, c.pythXmr]));
  const colPrice = readMockPrice(colAcc.data);
  const xmrPrice = readMockPrice(xmrAcc.data);
  const gs = await c.fetchRetry(() => c.program.account.globalState.fetch(c.globalState));
  const debtIndex = BigInt(gs.globalDebtIndex.toString());
  console.log(`prices: QQQX $${Number(colPrice) / 1e18} | XMR $${Number(xmrPrice) / 1e18} | debtIndex ${debtIndex}`);

  const vaults = await c.fetchRetry(() => c.program.account.vault.all());
  console.log(`scanning ${vaults.length} vault(s)`);

  for (const { publicKey: vaultPda, account: v } of vaults) {
    const actualDebt = (BigInt(v.normalizedDebt.toString()) * debtIndex) / 10n ** 18n;
    if (actualDebt === 0n || BigInt(v.deployedCollateral.toString()) > 0n) continue;

    const colUsd = (BigInt(v.collateralAmount.toString()) * colPrice) / 10n ** 8n;
    const debtUsd = (actualDebt * xmrPrice) / 10n ** 8n;
    const ratio = debtUsd === 0n ? 10n ** 9n : (colUsd * 100n) / debtUsd;
    console.log(`  vault ${vaultPda.toBase58().slice(0, 8)} (lp ${v.lpAddress.toBase58().slice(0, 8)}): CR ${ratio}%`);
    if (ratio >= LIQUIDATION_RATIO) continue;

    // Liquidate as much debt as our wsXMR balance covers.
    const liqWsxmrAta = getAssociatedTokenAddressSync(c.wsxmrMint, lp.publicKey, true, TOKEN_2022_PROGRAM_ID);
    const liqColAta = getAssociatedTokenAddressSync(c.collateralMint, lp.publicKey, true, TOKEN_2022_PROGRAM_ID);
    if (!(await c.conn.getAccountInfo(liqColAta))) {
      await sendAndConfirm(c.conn, new Transaction().add(createAssociatedTokenAccountInstruction(
        lp.publicKey, liqColAta, lp.publicKey, c.collateralMint, TOKEN_2022_PROGRAM_ID)), [lp]);
    }
    const bal = await getAccount(c.conn, liqWsxmrAta, undefined, TOKEN_2022_PROGRAM_ID)
      .then((a) => BigInt(a.amount.toString())).catch(() => 0n);
    const debtToClear = bal < actualDebt ? bal : actualDebt;
    if (debtToClear === 0n) {
      console.log('    liquidatable but liquidator holds no wsXMR — skipping');
      continue;
    }
    try {
      const sig = await c.rpcIx(
        c.program.methods.executeLiquidation(new BN(debtToClear.toString())).accounts({
          liquidator: lp.publicKey,
          vault: vaultPda,
          globalState: c.globalState,
          wsxmrMint: c.wsxmrMint,
          collateralMint: c.collateralMint,
          liquidatorWsxmrAta: liqWsxmrAta,
          liquidatorCollateralAta: liqColAta,
          vaultCollateralAta: vaultCollateralAtaPda(vaultPda, c.programId),
          ...c.oracleAccounts(),
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }),
        []
      );
      console.log(`    LIQUIDATED ${debtToClear} raw debt — ${sig}`);
    } catch (e) {
      console.log(`    liquidation failed: ${e.message?.slice(0, 120)}`);
    }
  }
}

if (LOOP_S) {
  console.log(`liquidator loop every ${LOOP_S}s`);
  setInterval(() => pass().catch((e) => console.error('[liquidator]', e.message)), LOOP_S * 1000);
}
pass().catch((e) => { console.error('[liquidator]', e.message ?? e); if (!LOOP_S) process.exit(1); });
