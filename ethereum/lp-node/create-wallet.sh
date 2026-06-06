#!/bin/bash

# Create a Monero wallet from the LP's private spend key

WALLET_FILE="./lp-wallet"
WALLET_PASSWORD="lp-password-change-me"
DAEMON_URL="https://xmr.hexide.com"

# Load private key from .env
source .env

echo "Creating Monero wallet from private key..."
echo "Wallet file: $WALLET_FILE"
echo "Daemon: $DAEMON_URL"
echo ""
echo "This will create a wallet that can receive and track XMR deposits."
echo ""

# Create wallet using monero-wallet-cli in non-interactive mode
# We'll use --generate-from-spend-key to create from the private spend key

monero-wallet-cli \
  --daemon-address "$DAEMON_URL" \
  --generate-from-spend-key "$WALLET_FILE" \
  --password "$WALLET_PASSWORD" \
  --restore-height 0 \
  --command exit

echo ""
echo "Wallet created successfully!"
echo "You can now start the wallet RPC with: ./start-wallet-rpc.sh"
