#!/usr/bin/env bash
# start-validator.sh
# Generates fresh mock Pyth oracle account files and starts solana-test-validator
# with those accounts pre-loaded (so oracle staleness checks pass at t=0).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

# Fixed keypairs so PDA derivations in tests are stable
XMR_ORACLE_KEYPAIR="$ROOT/tests/fixtures/pyth_xmr_keypair.json"
COL_ORACLE_KEYPAIR="$ROOT/tests/fixtures/pyth_col_keypair.json"
PROGRAM_SO="$ROOT/target/deploy/wrapsynth_vault_manager.so"
PROGRAM_KEYPAIR="$ROOT/target/deploy/wrapsynth_vault_manager-keypair.json"

mkdir -p "$ROOT/tests/fixtures"

# Generate stable oracle keypairs if they don't exist
if [ ! -f "$XMR_ORACLE_KEYPAIR" ]; then
  solana-keygen new --no-bip39-passphrase --silent -o "$XMR_ORACLE_KEYPAIR"
fi
if [ ! -f "$COL_ORACLE_KEYPAIR" ]; then
  solana-keygen new --no-bip39-passphrase --silent -o "$COL_ORACLE_KEYPAIR"
fi

XMR_PUBKEY=$(solana-keygen pubkey "$XMR_ORACLE_KEYPAIR")
COL_PUBKEY=$(solana-keygen pubkey "$COL_ORACLE_KEYPAIR")

echo "XMR oracle: $XMR_PUBKEY"
echo "COL oracle: $COL_PUBKEY"

# Generate fresh mock Pyth account data with current timestamp
node "$SCRIPT_DIR/gen-mock-pyth.js" "$XMR_PUBKEY" "$COL_PUBKEY"

XMR_ACCOUNT_FILE="/tmp/pyth_xmr_account_${XMR_PUBKEY}.json"
COL_ACCOUNT_FILE="/tmp/pyth_col_account_${COL_PUBKEY}.json"

pkill -f solana-test-validator || true
sleep 2

solana-test-validator \
  --reset \
  --quiet \
  --bpf-program "$(solana-keygen pubkey "$PROGRAM_KEYPAIR")" "$PROGRAM_SO" \
  --account "$XMR_PUBKEY" "$XMR_ACCOUNT_FILE" \
  --account "$COL_PUBKEY" "$COL_ACCOUNT_FILE" \
  &

echo "Waiting for validator..."
for i in $(seq 1 20); do
  if solana cluster-version --url http://localhost:8899 2>/dev/null; then
    echo "Validator ready."
    break
  fi
  sleep 1
done

solana airdrop 100 --url http://localhost:8899 2>/dev/null || true
echo "Done. XMR_ORACLE=$XMR_PUBKEY COL_ORACLE=$COL_PUBKEY"
