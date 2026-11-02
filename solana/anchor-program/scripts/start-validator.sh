#!/usr/bin/env bash
# start-validator.sh — start solana-test-validator with the vault-manager
# program pre-deployed. Build first:
#   cargo build-sbf                          # production timing
#   cargo build-sbf -- --features test-lifecycle   # short auction windows
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PROGRAM_SO="$ROOT/target/deploy/wrapsynth_vault_manager.so"
PROGRAM_KEYPAIR="$ROOT/target/deploy/wrapsynth_vault_manager-keypair.json"

pkill -f solana-test-validator || true
sleep 2

solana-test-validator \
  --reset \
  --quiet \
  --bpf-program "$(solana-keygen pubkey "$PROGRAM_KEYPAIR")" "$PROGRAM_SO" \
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
echo "Done."
