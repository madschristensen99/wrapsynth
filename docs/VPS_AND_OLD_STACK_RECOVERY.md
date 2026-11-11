# VPS & Old-Stack Recovery Notes

Snapshot taken 2026-11-11, after the oracle-free Base migration. This doc exists so the
**old oracle-based deployments** (Base / BNB / Robinhood) can be revived if needed —
they still hold real funds.

## VPS access

- Host: `root@76.13.98.87` (`srv1290621.hstgr.cloud`, Hostinger, AlmaLinux 10)
- Auth: SSH key (`~/.ssh/id_ed25519`) — already in `/root/.ssh/authorized_keys`
- NOTE: `86.38.205.119` in `~/handshake-main-old/deploy-to-vps.sh` is a STALE old box — do not use.
- Resources: 1 vCPU, 3.8 GB RAM, 49 GB disk. Load is high (~5) — be gentle.

## What's running now (new oracle-free stack)

pm2 (saved in `/root/.pm2/dump.pm2`):

| process | dir | port | purpose |
|---|---|---|---|
| `wrapsynth-lp` | `/root/wrapsynth-lp-of/` | 3001 | LP server, **base + bnb** |
| `peg-base` | `/root/wrapsynth-lp-of/` | — | wsXMR/cbBTC peg bot (SwapRouter02) |
| `peg-bnb` | `/root/wrapsynth-lp-of/` | — | wsXMR/QQQB peg bot (PCS SmartRouter) |
| `xmr-wallet-rpc` | `/root/wrapsynth-lp/monero-wallets` | 18082 | main Monero wallet RPC |

- New code: `/root/wrapsynth-lp-of/` (synced from `lp-server-js/` in this repo)
- Manifests the server reads: `/root/frontend/deployment.base.json` +
  `/root/frontend/deployment.bnb.json` (both NEW oracle-free deployments)
- `chains.json` in the new dir lists **base + bnb** — robinhood is ditched from
  active ops; its manifest still exists in `/root/frontend/` for recovery only.
- Deposit-scan wallet-rpc auto-spawns on :18083 from `DEPOSIT_WALLET_DIR`.

## Old stack — preserved, NOT deleted

Everything old lives untouched at **`/root/wrapsynth-lp/`** (55 files): old
oracle-based `server.js`, `oracleUpdate.js`, `pushBaseOracle.js`, `pegBot*.js`,
`.env` (has `REDSTONE_GATEWAY_URL`; `REDSTONE_API_KEY` is EMPTY), all
`lp-secrets-*.json` / `lp-burn-secrets-*.json`, and the Monero wallets:

- `/root/wrapsynth-lp/monero-wallets/` — main `lp-wallet` (+ keys)
- `/root/wrapsynth-lp/monero-wallets-deposit/` — per-mint view-only wallets
- `/root/wrapsynth-lp/monero-wallets-recover/` — recovery wallets

Old manifests: `/root/frontend/deployment.base.OLD.json`,
`/root/frontend/deployment.bnb.OLD.json` (renamed when the new BNB deployment
took over the canonical filename), and `/root/frontend/deployment.robinhood.json`.

### Old deployment addresses (all share deployer `0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB`)

**Base (oracle-based, wsXMR `0x9E50…`, hub `0xF22f…`)** — full manifest in
`/root/frontend/deployment.base.OLD.json`. Vault collateral is `stataCbBTC`
`0x64f05A6c0E19Fe7Ae76Ca88740D63EA069A5CA28`; pool `0xEac2…A3FEc`.

**BNB (chain 56, OLD oracle deployment)** — manifest `/root/frontend/deployment.bnb.OLD.json`:
hub `0x15bb9ba8236De055090a262F45a7e213F6040320`, wsXMR `0x9B8d1851bCc06ac265c1c1ACaBD0F71E69DD312c`,
collateral `stataQQQB` `0xd821A7D919e007b6b39925f672f1219dB4865Fba`,
pool `0x9711698489150C9Fbc377C7d5aBC735D6198A845`, QQQB `0x205812CdBed920aFf76C6580abD681a46D11efc7`.

**Robinhood (chain 4663)** — manifest `/root/frontend/deployment.robinhood.json`:
same hub/wsXMR/facet addresses as BNB (deterministic deploy),
collateral `stataSPY` `0xd821A7D919e007b6b39925f672f1219dB4865Fba`,
SPY `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C`, pool `0xf631c5DC155d7e635c259318117952B3fD9C9d85`.

### Old-vault state snapshot (2026-11-11, deployer vault `0x492c…72FB`)

| chain | collateralShares (stata, 18dec) | normalizedDebt | wsXMR supply | pool liquidity |
|---|---|---|---|---|
| base | 0.00123621 stataCbBTC | ~0.00000000001 | 0.09789891 | 4,174,726 |
| bnb | 0.24719276 stataQQQB | ~0.00000000001 | 0.09856939 | 7,240,877,403,563 |
| robinhood | 0.06820064 stataSPY | ~0.000000000005 | 0.0476 | 2,151,529,820,904 |

Collateral tokens are **stataTokens** (yield-bearing) — redeem via the stata
wrapper before/alongside withdrawal. wsXMR supplies are small; most "value" is
the pool liquidity + vault collateral.

## Reviving the old stack

1. `cd /root/wrapsynth-lp`
2. Restore the manifest it should serve: copy `/root/frontend/deployment.base.OLD.json`
   over `/root/frontend/deployment.base.json` **only if** you also stop the new
   server (it reads the same file). For bnb/robinhood the manifests are still in place.
3. Port conflict: old and new servers both want `:3001`. Either stop the new one
   (`pm2 stop wrapsynth-lp peg-base`) or set a different `PORT` in the old `.env`.
4. `pm2 start server.js --name wrapsynth-lp-old` and the `pegBot*.js` files as needed.
5. Old `.env.bak` exists if the current `.env` was modified.

## Freeing funds from old deployments (RedStone path)

The old protocol is oracle-driven: vault health/liquidations read prices pushed
by the LP via `oracleUpdate.js` / `pushBaseOracle.js` through the RedStone gateway.

- `REDSTONE_GATEWAY_URL` is already set in `/root/wrapsynth-lp/.env`.
- `REDSTONE_API_KEY` is **EMPTY** — obtain a RedStone API key, add it to that `.env`,
  restart the old oracle updater, then:
  - users can `requestBurn` wsXMR → LP sends XMR → `finalizeBurn` releases collateral;
  - LP can `withdrawCollateral` once vault is solvent per the pushed prices;
  - co-LP positions unwind via `unwindCoLP`.
- Monero side for burns uses the preserved `lp-wallet` — its secrets
  (`lp-secrets-*.json`, `lp-burn-secrets-*.json`) are needed to recognize/settle
  in-flight requests; do not delete them.

## New (oracle-free) Base deployment — for reference

- wsXMR `0x42caa1aA5B21250E4260431E90D07b12B2e2e592`
- wsXmrHub `0x69cCB294c050dE270c61057051e53c70FfdBBBf7`
- LiquidityRouter `0xc509F558122b57a1F65BC1cD52b64044f34c3326`
- Pool `0x61dC3Bb99f76E069451Ec115da681aCc47611d6b` (cbBTC/wsXMR, fee 500)
- All verified on BaseScan. Deployer powers permanently locked.
- Vault `0x492c…72FB` holds ~0.002 cbBTC collateral ( topped up 2026-11-11 ),
  threshold `0.00585` normalized per 1e8 wsXMR, live co-LP position tokenId 6540730.

## New (oracle-free) BNB deployment — for reference

Deployed 2026-11-11 via `DeployBnb.s.sol` (deployer powers locked). Collateral is
**raw QQQB** (no stata wrapper). Pool is PancakeSwap V3 wsXMR/QQQB, fee 500.

- wsXMR `0x71FeC2287DaAB5bf6d6bF76Ed817067E201Fb894`
- wsXmrHub `0xb85220dd012dbF07CDedc0F451C5F24701bCb814`
- LiquidityRouter `0x7889Ff9C15e05c01Ce7c7D2e0D928D6bDBD1bF12`
- Pool `0xb194431E130faF842d8f530316a9D1653091e4d4`
- QQQB `0x205812CdBed920aFf76C6580abD681a46D11efc7` (same token as old stack)
- Vault `0x492c…72FB` holds ~0.1 QQQB collateral; live co-LP position tokenId 7787471.
- `pegBot.bnb.js` is gitignored like `pegBot.base.js` — VPS copy lives at
  `/root/wrapsynth-lp-of/pegBot.bnb.js`; repo copy exists locally but is ignored.

## Robinhood status

Ditch from ACTIVE operations (2026-11-11): removed from `CHAINS` in
`frontend/js/config.js` and from VPS `chains.json`. The old deployment still
holds funds (see snapshot above) — manifest preserved at
`/root/frontend/deployment.robinhood.json`. To revive for recovery only, see
"Reviving the old stack"; do NOT re-add to `CHAINS`/`chains.json` unless the
oracle-based stack is intentionally restored.
