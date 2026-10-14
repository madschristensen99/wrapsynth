#!/usr/bin/env bash
# deploy-devnet.sh — full devnet bring-up.
#
#   bash scripts/deploy-devnet.sh
#
# Steps: build -> deploy both programs -> devnet-setup (mint, oracles, init).
# After it finishes, run `node scripts/oracle-refresh.js` in a persistent
# shell/tmux to keep the mock feeds fresh (PRICE_MAX_AGE is 120s).
set -euo pipefail
cd "$(dirname "$0")/.."

WALLET="${ADMIN_KEY:-$HOME/.config/solana/id.json}"
ADDR=$(solana address -k "$WALLET")
BAL=$(solana balance -u devnet -k "$WALLET" | awk '{print $1}')
echo "deployer: $ADDR  balance: $BAL SOL"

# ~8.4 SOL needed: ~7.1 vault program + ~1.2 oracle-mock + init/ATA txs
if (( $(echo "$BAL < 8.5" | bc -l) )); then
  echo "WARN: balance under 8.5 SOL — deploy may fail partway (program rent)."
fi

echo "== anchor build =="
anchor build

echo "== deploy wrapsynth_vault_manager =="
anchor deploy --provider.cluster devnet --provider.wallet "$WALLET" \
  --program-name wrapsynth_vault_manager

echo "== deploy oracle_mock =="
anchor deploy --provider.cluster devnet --provider.wallet "$WALLET" \
  --program-name oracle_mock

echo "== devnet setup =="
node scripts/devnet-setup.js

echo ""
echo "Done. Next:"
echo "  1. node scripts/oracle-refresh.js   # keep alive — feeds go stale in 120s"
echo "  2. share devnet/devnet-config.json with the LP server + frontend"
