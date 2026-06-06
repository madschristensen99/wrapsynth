#!/bin/bash

# Start monero-wallet-rpc for LP node
# This creates a view-only wallet from the LP's private spend key

WALLET_FILE="./lp-wallet"
WALLET_PASSWORD="lp-password-change-me"
RPC_PORT=18082
DAEMON_URL="https://xmr.hexide.com"

# Load private key from .env
source .env

echo "Starting Monero Wallet RPC..."
echo "Wallet file: $WALLET_FILE"
echo "RPC port: $RPC_PORT"
echo "Daemon: $DAEMON_URL"

# Start wallet RPC
# --wallet-file: Path to wallet file (will be created if doesn't exist)
# --password: Wallet password
# --daemon-address: Monero daemon to connect to
# --rpc-bind-port: Port for RPC server
# --disable-rpc-login: No authentication (localhost only)
# --trusted-daemon: Trust the remote daemon
# --log-level: Set to 1 for less verbose output

monero-wallet-rpc \
  --wallet-file "$WALLET_FILE" \
  --password "$WALLET_PASSWORD" \
  --daemon-address "$DAEMON_URL" \
  --rpc-bind-port $RPC_PORT \
  --disable-rpc-login \
  --trusted-daemon \
  --log-level 1 \
  --confirm-external-bind
