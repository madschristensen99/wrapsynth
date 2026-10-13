#!/usr/bin/env bash
# Fork test runner — clones the real Orca Whirlpools program + config + fee tier
# from mainnet into a local validator, deploys the vault manager, and runs the
# co-LP integration suite against the real program binary.
#
# NOTE: uses `cargo build-sbf` directly instead of `anchor build` because the
# anchor CLI (0.31.1) regenerates the lockfile with edition2024 crates that the
# solana toolchain's cargo 1.79 cannot parse. The lockfile is pinned to
# compatible versions (see the cargo update --precise pins below).
set -euo pipefail
cd "$(dirname "$0")/.."

ORCA_PROGRAM="whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
ORCA_CONFIG="2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ"
ORCA_FEE_TIER_64="HT55NVGVTjWmWLjV7BrSMPVZ7ppU8T2xE5nCAZ6YaGad"
MAINNET_RPC="mainnet-beta"

echo "==> Generating mock Pyth fixtures"
node scripts/gen-mock-pyth.js

echo "==> Building program (cargo build-sbf)"
cargo build-sbf --manifest-path programs/wrapsynth-vault-manager/Cargo.toml

echo "==> Ensuring deploy keypair"
DEPLOY_KEYPAIR="tests/fixtures/vault_manager_deploy_keypair.json"
if [ ! -f "$DEPLOY_KEYPAIR" ]; then
  solana-keygen new --no-bip39-passphrase --silent -o "$DEPLOY_KEYPAIR"
fi

echo "==> Starting fork validator (cloning Orca from mainnet)"
solana-test-validator \
  --reset \
  --url "$MAINNET_RPC" \
  --clone-upgradeable-program "$ORCA_PROGRAM" \
  --clone "$ORCA_CONFIG" \
  --clone "$ORCA_FEE_TIER_64" \
  --account 6LwVtpkVzR9zSCo4xKkesQJaraDJaqzaQTRAQfZo6jxf tests/fixtures/pyth_xmr_account.json \
  --account 7D8MNQMdCEDrVebrMPmnMQ5Z54WqceWsu89FDEqrWL73 tests/fixtures/pyth_col_account.json \
  --account 7e5pxK83ceXb2iWXBizF1U8MdL7C5VcVBBXpDWaYo3x1 tests/fixtures/pyth_rr_account.json \
  --account 5WQs7ZbQjbDLfEbPeUFKLq3oLh1KkKbvaLKJ2RUUqDXa tests/fixtures/pyth_xmr_account_v2.json \
  --account 7yyaeuJ1GGtVBLT2z2xub5ZWYKaNhF28mj1RdV4VDFVk tests/fixtures/pyth_jitosol_account.json \
  --account H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG tests/fixtures/pyth_sol_account.json \
  --account Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb tests/fixtures/jitosol_stake_pool.json \
  > /tmp/fork-validator.log 2>&1 &
VALIDATOR_PID=$!
trap 'kill $VALIDATOR_PID 2>/dev/null || true' EXIT

echo "==> Waiting for validator RPC"
for i in $(seq 1 90); do
  if curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q '"ok"'; then
    break
  fi
  if ! kill -0 $VALIDATOR_PID 2>/dev/null; then
    echo "!! Validator exited early:"; tail -20 /tmp/fork-validator.log; exit 1
  fi
  sleep 1
done

echo "==> Deploying vault manager"
solana config set --url http://localhost:8899 > /dev/null
solana airdrop 10 > /dev/null 2>&1 || true
PROGRAM_ID=$(solana-keygen pubkey "$DEPLOY_KEYPAIR")
solana program deploy \
  --program-id "$DEPLOY_KEYPAIR" \
  target/deploy/wrapsynth_vault_manager.so

echo "==> Running co-LP fork test (program ID: $PROGRAM_ID)"
export ANCHOR_PROVIDER_URL=http://localhost:8899
export ANCHOR_WALLET="$HOME/.config/solana/id.json"
npx ts-mocha -p ./tsconfig.json -t 1000000 tests/co_lp_fork.test.ts
