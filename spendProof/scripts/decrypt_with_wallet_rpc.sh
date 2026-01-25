#!/bin/bash

# Use monero-wallet-rpc to decrypt transaction outputs
# This will properly identify which output is ours and decrypt the amount

WALLET_DIR="/tmp/lp_wallet"
WALLET_NAME="lp_view_wallet"
VIEW_KEY="14e6b2d5e3f3df596fcceacdec8f3d0cd12005ffe5848e40c2b176cf84612809"
ADDRESS="87G8STCTDVLXm3RYuTBUigPNY4N1yDroBBbDSEwME4w9ezDDcTJhXcSL6urUJiHJK2hADMyqweuMZgaK9fw2bF21CyAuQBQ"
TX_HASH="8759425cbf9865243bf5ba75934be23e9acba13711a23d7c23d4770d1689cdd9"

echo "🔓 Decrypting Monero Transaction with Wallet RPC"
echo ""
echo "TX Hash: $TX_HASH"
echo "Address: $ADDRESS"
echo ""

# Create wallet directory
mkdir -p "$WALLET_DIR"

# Generate view-only wallet
echo "📝 Creating view-only wallet..."
monero-wallet-cli --generate-from-view-key "$WALLET_DIR/$WALLET_NAME" \
    --daemon-address http://xmr.privex.io:18081 \
    --password "" \
    --restore-height 3594960 \
    --command exit << EOF
$ADDRESS
$VIEW_KEY
EOF

echo ""
echo "✅ Wallet created"
echo ""

# Start wallet RPC in background
echo "🚀 Starting monero-wallet-rpc..."
monero-wallet-rpc \
    --wallet-file "$WALLET_DIR/$WALLET_NAME" \
    --password "" \
    --daemon-address http://xmr.privex.io:18081 \
    --rpc-bind-port 18083 \
    --disable-rpc-login \
    --log-level 0 &

WALLET_RPC_PID=$!
echo "   PID: $WALLET_RPC_PID"
sleep 5

# Query the transaction
echo ""
echo "🔍 Querying transaction..."
curl -s http://localhost:18083/json_rpc -d '{
  "jsonrpc": "2.0",
  "id": "0",
  "method": "get_transfer_by_txid",
  "params": {
    "txid": "'"$TX_HASH"'"
  }
}' | jq '.'

echo ""
echo "🔍 Getting incoming transfers..."
curl -s http://localhost:18083/json_rpc -d '{
  "jsonrpc": "2.0",
  "id": "0",
  "method": "incoming_transfers",
  "params": {
    "transfer_type": "all"
  }
}' | jq '.'

# Cleanup
echo ""
echo "🧹 Cleaning up..."
kill $WALLET_RPC_PID 2>/dev/null
wait $WALLET_RPC_PID 2>/dev/null

echo ""
echo "✅ Done"
