#!/bin/bash

# Deploy WrapSynth to Solana Devnet

set -e

echo "🚀 Deploying WrapSynth to Solana Devnet"
echo "========================================"
echo ""

# Check balance
BALANCE=$(solana balance --url devnet | awk '{print $1}')
echo "💰 Current balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 2" | bc -l) )); then
    echo "⚠️  Low balance. Requesting airdrop..."
    solana airdrop 2 --url devnet
    echo ""
fi

# Build the program
echo "🔨 Building program..."
anchor build
echo ""

# Deploy to devnet
echo "🚀 Deploying to devnet..."
anchor deploy --provider.cluster devnet
echo ""

# Get program ID
PROGRAM_ID=$(solana address -k target/deploy/wsxmr_solana-keypair.json)
echo "✅ Program deployed!"
echo "📝 Program ID: $PROGRAM_ID"
echo ""

echo "Next steps:"
echo "  1. Initialize global state"
echo "  2. Create LP vaults"
echo "  3. Test mint/burn flows"
echo ""
echo "View on Solana Explorer:"
echo "  https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
echo ""
