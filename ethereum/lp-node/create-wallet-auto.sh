#!/bin/bash

# Automatically create Monero wallet from .env private key

WALLET_FILE="lp-wallet"
WALLET_PASSWORD="lp-password-change-me"
RESTORE_HEIGHT=3690400

# Load private key from .env
source .env

echo "Creating Monero wallet from private key in .env..."
echo "Wallet file: $WALLET_FILE"
echo "Restore height: $RESTORE_HEIGHT"
echo ""

# Use expect to automate the interactive prompts
expect << EOF
spawn monero-wallet-cli --generate-from-spend-key "$WALLET_FILE" --password "$WALLET_PASSWORD" --daemon-address https://xmr.hexide.com --restore-height $RESTORE_HEIGHT
expect "Secret spend key:"
send "$MONERO_PRIVATE_KEY\r"
expect "Secret view key:"
send "\r"
expect "wallet address:"
send "exit\r"
expect eof
EOF

echo ""
echo "Wallet created! You can now start wallet RPC with: ./start-wallet-rpc.sh"
