#!/bin/bash
# Create fresh Monero wallet with current restore height (fast sync)

source .env

WALLET_FILE="lp-wallet-fresh"
WALLET_PASSWORD="lp-password-change-me"
DAEMON="https://xmr-node.cakewallet.com:18081"

# Get current Monero height
CURRENT_HEIGHT=$(curl -s https://xmr-node.cakewallet.com:18081/get_info | jq -r '.height // 3693400')
# Start scanning from 10 blocks ago
RESTORE_HEIGHT=$((CURRENT_HEIGHT - 10))

echo "Current Monero height: $CURRENT_HEIGHT"
echo "Creating wallet with restore height: $RESTORE_HEIGHT (only scanning last 10 blocks)"

# Create wallet using monero-wallet-cli with auto-confirm
expect << EOF
spawn monero-wallet-cli --generate-from-spend-key "$WALLET_FILE" --password "$WALLET_PASSWORD" --restore-height "$RESTORE_HEIGHT" --daemon-address "$DAEMON" --trusted-daemon
expect "Enter your private spend key:"
send "$MONERO_PRIVATE_KEY\r"
expect "Enter language selection"
send "1\r"
expect "Generated new wallet"
expect "Background refresh thread started"
sleep 2
send "exit\r"
expect eof
EOF

echo ""
echo "✅ Wallet created: $WALLET_FILE"
echo "✅ Restore height: $RESTORE_HEIGHT"
echo "✅ Will only scan ~10 blocks (should take <30 seconds)"
