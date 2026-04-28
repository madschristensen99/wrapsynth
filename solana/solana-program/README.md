# WrapSynth Vault Manager — Solana Program

A Solana/Anchor implementation of the WrapSynth vault manager protocol, which enables minting and burning of **wsXMR** (wrapped Monero) tokens backed by collateral held in permissioned LP vaults.

---

## Architecture Overview

```
programs/
  wrapsynth-vault-manager/   # Core Anchor program (Rust)
    src/
      instructions/
        initialize.rs        # Protocol init, GlobalState + wsXMR mint creation
        vault_management.rs  # LP vault CRUD, collateral deposit/withdraw, yield sync
        mint_flow.rs         # initiate_mint → set_mint_ready → finalize_mint → cancel_mint
        burn_flow.rs         # request_burn → propose_hash → confirm_monero_lock → finalize_burn
                             # + cancel_burn, claim_slashed_collateral
        liquidation.rs       # resolve_burn_for_liquidation, execute_liquidation
        buy_and_burn.rs      # trigger_buy_and_burn (war-chest deflation)
        withdrawals.rs       # initialize_pending_returns, withdraw_collateral_returns, withdraw_sol_returns
        reconciliation.rs    # reconcile_global_debt across all vaults
      state/                 # Account structs: GlobalState, Vault, MintRequest, BurnRequest, PendingReturns
      constants.rs           # PDA seeds, numeric constants (COLLATERAL_RATIO, INITIAL_DEBT_INDEX, …)
      errors.rs              # WrapSynthError enum
      oracle.rs              # Manual Pyth price-feed deserialization (no pyth-sdk dependency)
tests/
  vault_manager.ts           # Full integration test suite (TypeScript/Mocha/Anchor)
types/
  wrapsynth_vault_manager.ts # Hand-authored IDL type + IDL const (replaces anchor build IDL gen)
```

---

## Key Design Decisions

### Oracle
Pyth oracle accounts are passed as `AccountInfo` and deserialized manually in `oracle.rs`. The `pyth-solana-receiver-sdk` crate was removed because it conflicts with anchor-spl 0.30 via dependency version mismatches.

### `request_id` — Client-side keccak
Both `initiate_mint` and `request_burn` accept a `request_id: [u8; 32]` as an instruction argument. The client pre-computes this via `keccak256(nonce || vault || timestamp)`. This avoids runtime-expression PDA seeds that break Anchor's `Bumps` derive macro.

### `PendingReturns` — Pre-creation pattern
`PendingReturns` accounts for each actor (LP, user, keeper) must be created in advance via `initialize_pending_returns`. The `init_if_needed` pattern was abandoned because cross-account-field PDA seeds break the `Bumps` derive.

### wsXMR Mint — Manual CPI init
The wsXMR Token-2022 mint PDA is created via `SystemProgram::create_account` CPI and then initialized via `initialize_mint2` CPI inside the `initialize` handler. Anchor 0.30's `InterfaceAccount<Mint>` with `init` + `mint::token_program` incorrectly calls `InitializeMint2` twice on Token-2022 mints, causing error `0x6`. The manual approach avoids this.

### Borrow conflicts — `drop()` pattern
`finalize_mint` and `trigger_buy_and_burn` extract `bump` and `to_account_info()` before taking `&mut` borrows, then `drop()` the mutable borrow before CPI calls, and re-borrow after. This satisfies the Rust borrow checker in the Anchor 0.30 context.

### `CancelBurn` / `ClaimSlashedCollateral` / `ResolveBurnForLiquidation`
These instructions use `vault_lp: AccountInfo` with an explicit `constraint` check instead of cross-account-field seeds for vault PDA derivation, because cross-account seeds in `#[derive(Accounts)]` structs break Anchor's Bumps auto-derivation.

### Reconciliation
`reconcile_global_debt` iterates `remaining_accounts` and deserializes each `Vault` via `Vault::try_deserialize(&mut &data[8..])` directly from raw account data, avoiding the `Account::try_from` lifetime issue.

---

## Instruction Flow

### Mint flow
```
1. initiate_mint(xmr_amount, claim_commitment, timeout_duration, request_id)
   → MintRequest { status: Pending }, griefing deposit escrowed
2. set_mint_ready()            [LP]
   → MintRequest { status: Ready }
3. finalize_mint(secret)       [anyone with secret]
   → wsXMR minted to recipient, fee to LP ATA, debt recorded
4. cancel_mint()               [anyone, after timeout]
   → griefing deposit returned to initiator, LP penalised if Ready
```

### Burn flow
```
1. request_burn(wsxmr_amount, request_id)  [user]
   → wsXMR burned from user ATA, BurnRequest { status: Requested }, collateral locked
2. propose_hash(secret_hash)               [LP]
   → BurnRequest { status: Proposed }
3. confirm_monero_lock()                   [user]
   → BurnRequest { status: Committed }
4. finalize_burn(secret)                   [LP]
   → collateral released to user PendingReturns, debt reconciled
   OR
4b. claim_slashed_collateral()             [user, after deadline]
   → LP's collateral slashed to user PendingReturns
```

---

## Build & Test

### Prerequisites
- Rust + `cargo build-sbf` (Solana BPF toolchain v1.52)
- Node.js + npm
- `solana-test-validator`

### Build
```bash
cd solana/wrapsynth
touch programs/wrapsynth-vault-manager/src/lib.rs
cargo build-sbf --manifest-path programs/wrapsynth-vault-manager/Cargo.toml --tools-version v1.52
```

### Deploy to local validator
```bash
# Start fresh validator
solana-test-validator --reset --quiet &
sleep 8
solana airdrop 100

# Deploy
solana program deploy target/deploy/wrapsynth_vault_manager.so \
  --program-id target/deploy/wrapsynth_vault_manager-keypair.json
```

### Run tests
```bash
ANCHOR_PROVIDER_URL=http://localhost:8899 \
ANCHOR_WALLET=~/.config/solana/id.json \
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/vault_manager.ts
```

---

## Current Status

### Program compilation
✅ Compiles clean — 0 errors, ~40 warnings (unused variable noise) — under `anchor-lang 0.30.1` / `anchor-spl 0.30.1`.

### TypeScript test suite
✅ Zero `tsc --noEmit` errors. The IDL is hand-authored in `types/wrapsynth_vault_manager.ts` because `anchor build --features idl-build` cannot process `InterfaceAccount` types in Anchor 0.30.

### Integration tests
- **11 / 35 tests passing** as of last run
- `PendingReturns` initialization, burn flow (propose/confirm/finalize/cancel/slash), mint cancel (timeout), liquidation guard, and LP2 multi-vault scaffolding all pass
- **Blocked by**: `initialize` (test 1) still failing at runtime due to a double `InitializeMint2` invocation. The fix (manual `create_account` + `initialize_mint2` CPI replacing the Anchor `init` constraint) has been applied to the source and compiled, but requires a validator reset + fresh deploy to take effect.

### Known open issues
| # | Description |
|---|---|
| 1 | `initialize` fails with Token-2022 error `0x6` (double mint init) — fix compiled, pending fresh deploy |
| 2 | All downstream tests (vault creation, mint flow, burn flow, buy-and-burn, etc.) cascade-fail from issue 1 |
| 3 | `withdraw_collateral_returns` / `withdraw_sol_returns` — zero-balance rejection assertion fails (program returns success instead of `ZeroAmount`) |

---

## Program ID
`EZ1hsgYwmqmCY5Gzw9mwnJnJE4PJcKX5hHw5MZXk2ssy` (localnet)

Keypair: `target/deploy/wrapsynth_vault_manager-keypair.json`
