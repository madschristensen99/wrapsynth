#!/bin/bash
# Price Update Script for Gnosis Mainnet
# Run this regularly (e.g., every 5 minutes via cron) to keep oracle prices fresh

set -e

# Load environment variables
if [ -f .env ]; then
    source .env
else
    echo "Error: .env file not found"
    exit 1
fi

# Check required variables
if [ -z "$GNOSIS_RPC_URL" ] || [ -z "$PRIVATE_KEY" ] || [ -z "$ORACLE_ADDRESS" ]; then
    echo "Error: Missing required environment variables"
    echo "Required: GNOSIS_RPC_URL, PRIVATE_KEY, ORACLE_ADDRESS"
    exit 1
fi

echo "=== WrapSynth Price Update ==="
echo "Time: $(date)"

# Fetch current prices from RedStone
echo "Fetching prices from RedStone..."
PRICES_OUTPUT=$(node scripts/fetchRedStonePrices.js XMR,DAI 2>&1)

if [ $? -ne 0 ]; then
    echo "Error fetching prices: $PRICES_OUTPUT"
    exit 1
fi

# Parse prices (assuming output format: "XMR: $390.50, DAI: $1.00")
XMR_PRICE=$(echo "$PRICES_OUTPUT" | grep -oP 'XMR.*?(\d+)' | grep -oP '\d+' | head -1)
DAI_PRICE=$(echo "$PRICES_OUTPUT" | grep -oP 'DAI.*?(\d+)' | grep -oP '\d+' | head -1)

echo "XMR Price: $XMR_PRICE (8 decimals)"
echo "DAI Price: $DAI_PRICE (8 decimals)"

# Update prices on-chain
echo "Updating on-chain prices..."
TX_HASH=$(cast send $ORACLE_ADDRESS \
    "updatePrices(uint256,uint256)" \
    $XMR_PRICE $DAI_PRICE \
    --rpc-url $GNOSIS_RPC_URL \
    --private-key $PRIVATE_KEY \
    --gas-limit 100000 \
    --json | jq -r '.transactionHash')

if [ -z "$TX_HASH" ] || [ "$TX_HASH" == "null" ]; then
    echo "Error: Failed to update prices"
    exit 1
fi

echo "Success! Transaction: $TX_HASH"
echo "View on Gnosisscan: https://gnosisscan.io/tx/$TX_HASH"
echo "==================================="
