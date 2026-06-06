#!/bin/bash

# Interactive script to create Monero wallet from private key

WALLET_FILE="./lp-wallet"
WALLET_PASSWORD="lp-password-change-me"

# Load private key from .env
source .env

echo "Creating Monero wallet..."
echo ""
echo "You will be prompted to enter:"
echo "1. Secret spend key: $MONERO_PRIVATE_KEY"
echo "2. Secret view key: (press Enter to auto-generate)"
echo "3. Restore from specific height: 0"
echo ""
echo "Starting monero-wallet-cli..."
echo ""

# Run wallet CLI to create wallet from spend key
monero-wallet-cli \
  --generate-from-spend-key "$WALLET_FILE" \
  --password "$WALLET_PASSWORD" \
  --daemon-address https://xmr.hexide.com \
  --restore-height 0
