#!/bin/bash
source .env

# Start wallet RPC without a wallet (will wait for RPC commands)
monero-wallet-rpc \
  --daemon-address https://xmr-node.cakewallet.com:18081 \
  --rpc-bind-port 18082 \
  --disable-rpc-login \
  --trusted-daemon \
  --log-level 1 \
  --confirm-external-bind &

WALLET_PID=$!
echo "Wallet RPC started (PID: $WALLET_PID)"
sleep 5

# Create wallet from spend key via RPC
echo "Creating wallet from spend key..."
curl -X POST http://127.0.0.1:18082/json_rpc -d "{
  \"jsonrpc\": \"2.0\",
  \"id\": \"0\",
  \"method\": \"generate_from_keys\",
  \"params\": {
    \"restore_height\": 3242000,
    \"filename\": \"lp-wallet\",
    \"password\": \"lp-password-change-me\",
    \"spendkey\": \"$MONERO_PRIVATE_KEY\",
    \"address\": \"\"
  }
}" -H 'Content-Type: application/json'

echo ""
echo "Wallet created! Stopping temporary RPC..."
kill $WALLET_PID
sleep 2
echo "Done! Start wallet RPC with: ./start-wallet-rpc.sh"
