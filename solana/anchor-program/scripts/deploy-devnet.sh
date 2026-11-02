#!/usr/bin/env bash
# deploy-devnet.sh — full devnet bring-up.
#
#   bash scripts/deploy-devnet.sh
#
# Steps: build -> deploy the program -> devnet-setup (escrow floors, init).
# No oracle programs or price feeds — thresholds are LP-declared on-chain.
set -euo pipefail
cd "$(dirname "$0")/.."

WALLET="${ADMIN_KEY:-$HOME/.config/solana/id.json}"
ADDR=$(solana address -k "$WALLET")
BAL=$(solana balance -u devnet -k "$WALLET" | awk '{print $1}')
echo "deployer: $ADDR  balance: $BAL SOL"

if (( $(echo "$BAL < 7.5" | bc -l) )); then
  echo "WARN: balance under 7.5 SOL — deploy may fail partway (program rent)."
fi

echo "== anchor build =="
anchor build

echo "== deploy wrapsynth_vault_manager =="
anchor deploy --provider.cluster devnet --provider.wallet "$WALLET" \
  --program-name wrapsynth_vault_manager

echo "== devnet setup =="
node scripts/devnet-setup.js

echo ""
echo "Done. Next: share devnet/devnet-config.json with the LP server + frontend."
