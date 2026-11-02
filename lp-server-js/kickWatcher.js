import * as ethers from 'ethers';

/**
 * Bonded-kick liquidation auction watcher + optional seeded bidder.
 *
 * Oracle-free liquidation: anyone can post a bond to kick() a vault. The LP
 * gets a grace window to cancel (any depositCollateral or partial repayDebt),
 * then the auction opens with a Dutch haircut decaying 100% -> 5%. A no-bid
 * auction freezes the vault until reauction/backstop.
 *
 * Behavior:
 *  - Tracks KickStarted/ReauctionStarted for every vault on this deployment.
 *  - Own vault: logs the grace deadline; with KICK_AUTOCANCEL=true cancels the
 *    kick ourselves — a 1-unit repayDebt, or a small depositCollateral top-up
 *    when we hold no wsXMR. Either credits the kicker's bond to vault equity.
 *  - Seeded bidder (SEEDED_BIDDER=true): bids on ACTIVE auctions while the
 *    haircut X(t) >= SEEDED_BIDDER_MIN_X_BPS (default 7000 = 70% of offered
 *    collateral). Bidding burns the vault's full debt in wsXMR, so the bid is
 *    skipped when our wsXMR balance can't cover it. Infrastructure, not
 *    consensus — the protocol never trusts this bot's "price".
 *
 * Env:
 *   KICK_WATCH=0               disable watcher (default: enabled)
 *   KICK_WATCH_POLL_MS=30000   poll interval
 *   KICK_AUTOCANCEL=true       auto-cancel kicks on our own vault during grace
 *   KICK_DEPOSIT_RAW=10000     raw collateral units deposited when no wsXMR
 *   SEEDED_BIDDER=true         bid on auctions for liveness
 *   SEEDED_BIDDER_MIN_X_BPS=7000  never bid below this haircut floor
 *
 * ctx = { key, provider, wallet, hub, hubAddress, nonce (createNonceManager),
 *         deployment, logChunkSize }
 */
export function createKickWatcher(ctx) {
  const CHAIN = ctx.key;
  const LTAG = `[${CHAIN}][Kick]`;
  const provider = ctx.provider;
  const wallet = ctx.wallet;
  const hub = ctx.hub;
  const LOG_QUERY_CHUNK = ctx.logChunkSize || 900;
  const getNextNonce = () => ctx.nonce.getNextNonce();
  const resetNonceCache = () => ctx.nonce.resetNonceCache();

  // ─── Config ─────────────────────────────────────────────────────────────
  const ENABLED = (process.env.KICK_WATCH || '1') !== '0';
  const POLL_MS = parseInt(process.env.KICK_WATCH_POLL_MS || '30000', 10);
  const AUTOCANCEL = (process.env.KICK_AUTOCANCEL || 'false').toLowerCase() === 'true';
  const DEPOSIT_RAW = BigInt(process.env.KICK_DEPOSIT_RAW || '10000');
  const SEEDED = (process.env.SEEDED_BIDDER || 'false').toLowerCase() === 'true';
  const MIN_X_BPS = BigInt(process.env.SEEDED_BIDDER_MIN_X_BPS || '7000');

  const PHASE_NAMES = ['GRACE', 'OPEN_DELAY', 'ACTIVE', 'ENDED'];

  // Token contracts resolved lazily on first need.
  let wsxmr = null;
  let collateral = null;
  const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
  ];
  async function wsxmrToken() {
    if (!wsxmr) {
      const addr = (ctx.deployment.contracts && (ctx.deployment.contracts.wsXMR || ctx.deployment.contracts.wsXmrToken))
        || ctx.deployment.wsXMR || await hub.wsxmrToken();
      wsxmr = new ethers.Contract(addr, ERC20_ABI, wallet);
    }
    return wsxmr;
  }
  async function collateralToken() {
    if (!collateral) {
      const addr = (ctx.deployment.contracts && ctx.deployment.contracts.collateral)
        || ctx.deployment.collateral || await hub.collateralToken();
      collateral = new ethers.Contract(addr, ERC20_ABI, wallet);
    }
    return collateral;
  }

  // vault(lowercase) -> { kicker, auctionEnd, cancelAttempted, bidAttempted }
  const watched = new Map();
  let lastCheckedBlock = 0;
  let busy = false;

  const LOG_DELAY_MS = 150;
  async function queryFilterChunked(filter, fromBlock, toBlock) {
    const events = [];
    for (let start = fromBlock; start <= toBlock; start += LOG_QUERY_CHUNK) {
      const end = Math.min(start + LOG_QUERY_CHUNK - 1, toBlock);
      let retries = 5;
      while (true) {
        try {
          events.push(...await hub.queryFilter(filter, start, end));
          break;
        } catch (err) {
          const rateLimited = err.message?.includes('rate limit')
            || err.code === 'UNKNOWN_ERROR' || err.code === 'BAD_DATA';
          if (!rateLimited || --retries === 0) throw err;
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      await new Promise(r => setTimeout(r, LOG_DELAY_MS));
    }
    return events;
  }

  // ─── Own-vault cancel ────────────────────────────────────────────────────
  // During GRACE, any repayDebt or depositCollateral cancels the kick and pays
  // the kicker's bond into our vault equity. Cheapest path first: burn 1 unit
  // of wsXMR debt; fall back to a tiny collateral deposit when we hold none.
  async function cancelOwnKick(vaultAddr, state) {
    const entry = watched.get(vaultAddr);
    if (entry && entry.cancelAttempted) return;
    watched.set(vaultAddr, { ...(entry || {}), cancelAttempted: true });

    try {
      const token = await wsxmrToken();
      const balance = await token.balanceOf(wallet.address);
      if (balance > 0n) {
        const nonce = await getNextNonce();
        console.log(`${LTAG} Cancelling kick on our vault via repayDebt(1) — burns 1 unit, takes kicker bond`);
        const tx = await hub.repayDebt(1n, { nonce });
        console.log(`${LTAG} repayDebt tx: ${tx.hash}`);
        await tx.wait();
        console.log(`${LTAG} Kick cancelled — kicker bond credited to vault equity`);
        return;
      }

      const coll = await collateralToken();
      const collBalance = await coll.balanceOf(wallet.address);
      if (collBalance < DEPOSIT_RAW) {
        console.warn(`${LTAG} AUTOCANCEL: no wsXMR and collateral balance ${collBalance} < ${DEPOSIT_RAW} — cannot cancel, add funds!`);
        return;
      }
      const allowance = await coll.allowance(wallet.address, ctx.hubAddress);
      if (allowance < DEPOSIT_RAW) {
        const an = await getNextNonce();
        const atx = await coll.approve(ctx.hubAddress, ethers.MaxUint256, { nonce: an });
        console.log(`${LTAG} Collateral approve tx: ${atx.hash}`);
        await atx.wait();
      }
      const nonce = await getNextNonce();
      console.log(`${LTAG} Cancelling kick on our vault via depositCollateral(${DEPOSIT_RAW} raw)`);
      const tx = await hub.depositCollateral(DEPOSIT_RAW, { nonce });
      console.log(`${LTAG} depositCollateral tx: ${tx.hash}`);
      await tx.wait();
      console.log(`${LTAG} Kick cancelled — kicker bond credited to vault equity`);
    } catch (err) {
      resetNonceCache();
      console.error(`${LTAG} Autocancel failed for ${vaultAddr}: ${err.shortMessage || err.message}`);
    }
  }

  // ─── Seeded bid ──────────────────────────────────────────────────────────
  // Guarantees auction liveness day one. Only bids while X(t) >= floor — we
  // never accept a deeper haircut than configured. Needs wsXMR >= full debt.
  async function maybeSeedBid(vaultAddr, state) {
    const entry = watched.get(vaultAddr);
    if (entry && entry.bidAttempted) return;
    if (vaultAddr.toLowerCase() === wallet.address.toLowerCase()) return; // own vault -> cancel path

    try {
      const vault = await hub.getVault(vaultAddr);
      const debt = vault.normalizedDebt; // index is fixed 1e18 -> normalized == actual
      if (debt === 0n) return;
      const token = await wsxmrToken();
      const balance = await token.balanceOf(wallet.address);
      if (balance < debt) {
        console.log(`${LTAG} Seeded bid skipped on ${vaultAddr}: wsXMR balance ${balance} < debt ${debt}`);
        return;
      }
      watched.set(vaultAddr, { ...(entry || {}), bidAttempted: true });
      const nonce = await getNextNonce();
      console.log(`${LTAG} Seeded bid on ${vaultAddr}: X=${state.xBps}bps, debt=${debt} wsXMR`);
      const tx = await hub.bid(vaultAddr, { nonce, gasLimit: 2500000n });
      console.log(`${LTAG} bid tx: ${tx.hash}`);
      await tx.wait();
      console.log(`${LTAG} Bid confirmed on ${vaultAddr}`);
    } catch (err) {
      resetNonceCache();
      console.warn(`${LTAG} Seeded bid failed on ${vaultAddr}: ${err.shortMessage || err.message}`);
    }
  }

  // ─── Poll loop ───────────────────────────────────────────────────────────
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const head = await provider.getBlockNumber();
      if (lastCheckedBlock === 0) {
        lastCheckedBlock = Math.max(ctx.deployment.deployedAtBlock || 0, head - 9999);
      }
      if (head > lastCheckedBlock) {
        for (const filterName of ['KickStarted', 'ReauctionStarted']) {
          const events = await queryFilterChunked(hub.filters[filterName](), lastCheckedBlock + 1, head);
          for (const e of events) {
            const vault = e.args.vault.toLowerCase();
            watched.set(vault, { kicker: e.args.kicker, auctionEnd: e.args.auctionEnd });
            const ours = vault === wallet.address.toLowerCase();
            console.log(`${LTAG} ${filterName}: vault=${e.args.vault} kicker=${e.args.kicker} bond=${e.args.bond} auctionEnd=${e.args.auctionEnd}${ours ? '  <<< OUR VAULT' : ''}`);
          }
        }
        for (const e of await queryFilterChunked(hub.filters.VaultFrozen(), lastCheckedBlock + 1, head)) {
          console.log(`${LTAG} VaultFrozen: ${e.args.vault}${e.args.vault.toLowerCase() === wallet.address.toLowerCase() ? '  <<< OUR VAULT — needs reauction/backstop/full repay' : ''}`);
        }
        for (const e of await queryFilterChunked(hub.filters.AuctionSettled(), lastCheckedBlock + 1, head)) {
          console.log(`${LTAG} AuctionSettled: vault=${e.args.vault} bidder=${e.args.bidder} debt=${e.args.debtCleared} X=${e.args.clearingXBps}bps${e.args.wrongfulKick ? ' (wrongful kick)' : ''}`);
          watched.delete(e.args.vault.toLowerCase());
        }
        lastCheckedBlock = head;
      }

      // Refresh tracked kicks.
      for (const vaultAddr of [...watched.keys()]) {
        let state;
        try {
          state = await hub.auctionState(vaultAddr);
        } catch (err) {
          console.warn(`${LTAG} auctionState(${vaultAddr}) failed: ${err.shortMessage || err.message}`);
          continue;
        }
        if (!state.active) { watched.delete(vaultAddr); continue; }
        const phase = Number(state.phase);
        const ours = vaultAddr === wallet.address.toLowerCase();
        if (ours) {
          if (phase === 0 && AUTOCANCEL) {
            await cancelOwnKick(vaultAddr, state);
          } else if (phase === 0) {
            console.warn(`${LTAG} OUR VAULT KICKED — grace phase, auctionEnd=${state.auctionEnd}. Cancel by depositing collateral or repaying debt.`);
          } else {
            console.warn(`${LTAG} OUR VAULT KICKED — phase ${PHASE_NAMES[phase]}. Grace over; only a FULL debt repay (${await hub.getVault(vaultAddr).then(v => v.normalizedDebt).catch(() => '?')} wsXMR) cancels now.`);
          }
        } else if (SEEDED && phase === 2 && state.xBps >= MIN_X_BPS) {
          await maybeSeedBid(vaultAddr, state);
        }
      }
    } catch (err) {
      console.warn(`${LTAG} poll error: ${err.shortMessage || err.message}`);
    } finally {
      busy = false;
    }
  }

  function start() {
    if (!ENABLED) {
      console.log(`${LTAG} watcher disabled (KICK_WATCH=0)`);
      return;
    }
    console.log(`${LTAG} watcher started — poll ${POLL_MS / 1000}s | autocancel=${AUTOCANCEL} | seededBidder=${SEEDED}${SEEDED ? ` (floor ${MIN_X_BPS}bps)` : ''}`);
    tick().catch(() => {});
    setInterval(() => tick().catch(() => {}), POLL_MS);
  }

  return { start, watched };
}
