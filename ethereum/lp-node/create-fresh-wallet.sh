#!/bin/bash
# Create fresh Monero wallet with recent restore height

source .env

WALLET_FILE="lp-wallet-fresh"
WALLET_PASSWORD="lp-password-change-me"
RESTORE_HEIGHT=3693400  # Current height - only scan last ~30 blocks
DAEMON="https://xmr-node.cakewallet.com:18081"

echo "Creating fresh wallet with restore height: $RESTORE_HEIGHT"

monero-wallet-cli \
  --generate-from-spend-key "$WALLET_FILE" \
  --password "$WALLET_PASSWORD" \
  --restore-height "$RESTORE_HEIGHT" \
  --daemon-address "$DAEMON" \
  --trusted-daemon \
  --command exit

echo "Wallet created successfully!"
