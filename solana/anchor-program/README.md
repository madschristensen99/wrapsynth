# WrapSynth Vault Manager — Solana Program

A Solana/Anchor implementation of the WrapSynth vault manager protocol: minting and burning **wsXMR** (wrapped Monero) backed by **native SOL** collateral in permissioned LP vaults.

**Oracle-free.** Consensus never reads an external price. Each LP declares a `threshold` — lamports of collateral per `1e8` wsXMR — which determines mint capacity, vault solvency, burn/par settlement, and liquidation outcomes. Market prices are display-only in the frontend. Unhealthy vaults are resolved by a permissionless **bonded kick → Dutch auction** instead of oracle-triggered liquidations.

---

## Architecture Overview

```
programs/
  wrapsynth-vault-manager/   # Core Anchor program (Rust)
    src/
      instructions/
        initialize.rs        # Protocol init — GlobalState + wsXMR mint (no oracle args)
        vault_management.rs  # LP vault CRUD, native SOL deposit/withdraw, set_threshold,
                             # set_max_mint_wsxmr, repay_debt, kick-cancel hooks
        mint_flow.rs         # initiate_mint → provide_lp_key → set_mint_ready → reveal_secret
                             # → finalize_mint; cancel_mint + abandon/reclaim/claim/sweep paths
        burn_flow.rs         # request_burn → propose_hash → confirm_monero_lock → finalize_burn
                             # + claim_slashed_collateral, abort_burn, force_settle_burn,
                             # resolve_declined_proposal, abandon_proposed_burn
        auction.rs           # kick → open_auction → bid → resolve_kick / reauction,
                             # resolve_burn_for_auction, backstop_vault
        co_lp.rs             # set_max_co_lp_range, user_open_co_lp, collect_co_lp_fees,
                             # unwind_co_lp, rebalance_co_lp (Orca Whirlpools concentrated LP)
        withdrawals.rs       # initialize_pending_returns, withdraw_collateral_returns
        reconciliation.rs    # reconcile_global_debt across all vaults
      state/                 # GlobalState, Vault, MintRequest, BurnRequest,
                             # PendingReturns, Auction
      utils/math.rs          # threshold/par helpers (par_lamports, required_collateral,
                             # debt normalization, actual debt)
      constants.rs           # PDA seeds, lock ratios, kick/auction timing constants
      errors.rs              # WrapSynthError enum
tests/
  vault_manager.ts           # Integration suite (TypeScript/Mocha/Anchor) — 47 tests
types/
  wrapsynth_vault_manager.ts # Generated IDL type file (anchor build emits the IDL now)
```

---

## Oracle-free accounting

| Concept | On-chain meaning |
|---|---|
| `threshold` | Lamports of SOL per `1e8` wsXMR, declared by the LP (`set_threshold`). Floor: `MIN_THRESHOLD_LAMPORTS`. |
| `par(wsxmr)` | `wsxmr × threshold / 1e8` — the collateral value the protocol uses for settlement. |
| Mint capacity | `bond + (debt + pending_mints + mint) × threshold ≤ free_collateral` |
| Mint key bond | `par × MINT_LOCK_RATIO` (110%) |
| Burn lock | proportional `par` share of free collateral × `BURN_LOCK_MULTIPLIER_BPS` (1.3×), par-capped at the request's `threshold_at_request` |
| Price feeds | **none** — no Pyth, no RedStone, no whirlpool TWAP in consensus |

`xmr_price_at_*` request snapshots are gone — `threshold_at_ready` / `threshold_at_request` snapshot the LP's declared par instead, so settlement uses exactly the terms agreed at request time.

## Auction liquidation

Permissionless bonded kick → Dutch auction, mirroring `LiquidationAuctionFacet.sol` on EVM:

```
kick(vault)                 # anyone; posts KICK_BOND (2% of vault collateral, min floor)
  → GRACE window            # LP can cancel by proving liveness: deposit_collateral or repay_debt
  → open_auction            # settles in-flight mint/burn requests (resolve_burn_for_auction),
                            # unwinds co-LP, bumps liquidation_nonce + mint_nonce
  → ACTIVE auction          # bids = burn the full vault debt, receive X(t)% of offered collateral
                            # X(t) decays linearly 100% → HAIRCUT_FLOOR over the window
  → ENDED, no bid           # resolve_kick → vault frozen; backstop_vault lets a healthy LP
                            # assume the debt + collateral and pay out residual
reauction                   # anyone, after a bid fails to settle
```

Kicker bonds are escrowed at an `auction_bond` PDA. A cancelled kick forfeits the bond to vault equity; a resolved kick pays bond + a collateral chip to the kicker, with the "sane kick" guard (`KICK_SANE_BPS`) against griefing.

`open_auction` requires every in-flight request to be settled first — burns in `Requested`/`Proposed` re-mint the user's wsXMR; `Committed` burns settle (LP revealed → user paid reward + lock released; LP absent → par-capped slash). Request nonces are bumped so stale requests can never execute against the post-liquidation vault.

## Co-LP (Orca Whirlpools)

`user_open_co_lp` deploys vault collateral + user wsXMR into a WSOL/wsXMR concentrated-liquidity position. Sizing is **user-supplied** (collateral amount + wsXMR bounds) — no price matching on-chain. `unwind_co_lp`, `rebalance_co_lp`, `collect_co_lp_fees` manage the position; post-operation health is checked against threshold coverage.

---

## Key Design Decisions

### `request_id` — client-side keccak
Both `initiate_mint` and `request_burn` take a `request_id: [u8; 32]` argument; the client pre-computes `keccak256(parties ‖ amounts ‖ nonce)` where `nonce = global.request_nonce + 1`. Avoids runtime-expression PDA seeds that break Anchor's `Bumps` derive.

### `PendingReturns` — pre-creation pattern
`PendingReturns` per actor is created up front via `initialize_pending_returns`; `init_if_needed` was abandoned because cross-account-field PDA seeds break the `Bumps` derive.

### wsXMR mint — manual CPI init
The Token-2022 mint PDA is created via `SystemProgram::create_account` + `initialize_mint2` CPIs inside `initialize`. Anchor 0.30+'s `InterfaceAccount<Mint>` `init` path calls `InitializeMint2` twice on Token-2022 mints (error `0x6`); the manual path avoids it.

### RefCell scoping around CPIs
Zero-copy loaders (`GlobalState`) must drop their `RefMut` before any CPI that passes the account (e.g. `mint_to` with `global_state` as mint authority) or the runtime raises `AccountBorrowFailed`. Scopes are kept tight in `auction.rs`/`burn_flow.rs`.

### `test-lifecycle` cargo feature
`cargo build-sbf -- --features test-lifecycle` compiles short auction/kick/timeout constants (grace 15s, auction 10s, cooldown 10s) so the full liquidation lifecycle runs against `solana-test-validator` in minutes. Production/devnet builds keep EVM-parity timings (1h grace, 24h auction, 6h cooldown, 30m open delay).

---

## Build & Test

### Prerequisites
- Rust + `cargo build-sbf` (Solana BPF toolchain)
- Node.js + npm, `solana-test-validator`

### Build
```bash
cd solana/anchor-program/programs/wrapsynth-vault-manager
cargo build-sbf                              # production timing
cargo build-sbf -- --features test-lifecycle # short lifecycle constants for tests
```

### Integration suite (47 tests, ~3 min)
```bash
# Terminal 1 — validator with the test-lifecycle build baked in
solana-test-validator --reset \
  --bpf-program C9kVasKgQiUX1BCngBjorvMA8QaFyERHvdkYdwPyy3H1 \
  target/deploy/wrapsynth_vault_manager.so

# Terminal 2
npx tsc -p tsconfig.test.json
ANCHOR_PROVIDER_URL=http://localhost:8899 \
ANCHOR_WALLET=~/.config/solana/id.json \
npx mocha -t 1000000 dist-test/tests/vault_manager.js
```

Covers: initialize, vault/threshold config, whitelist, SOL deposit/withdraw, full mint + burn handshakes (Ed25519 secret scheme), `repay_debt`, kick → grace-cancel → re-kick → open auction → bid, auction expiry → freeze → `backstop_vault`, pending-return withdrawals, reconciliation.

Rust unit tests (`cargo test`) cover threshold/par math, auction bid curves, nonce invalidation, Whirlpool tick math, and Ed25519 verification.

> **Follow-up:** a co-LP fork suite (cloned mainnet Whirlpool via `scripts/run-fork-tests.sh`) needs to be rewritten for the new `user_open_co_lp` surface — the old suite targeted the removed SPL-collateral model.

### Deploy to devnet
```bash
bash scripts/deploy-devnet.sh   # anchor build → deploy → devnet-setup.js
```

`devnet-setup.js` funds the global escrow rent floors, runs `initialize` (no oracle args), and writes `devnet/devnet-config.json` for the LP server + frontend.

---

## Program ID

`C9kVasKgQiUX1BCngBjorvMA8QaFyERHvdkYdwPyy3H1`

Keypair: `target/deploy/wrapsynth_vault_manager-keypair.json`

Existing devnet state is **ABI-incompatible** — redeploy and re-`initialize`; old `GlobalState`/`Vault` accounts cannot be deserialized by this program.
