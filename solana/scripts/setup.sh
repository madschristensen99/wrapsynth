#!/bin/bash

# WrapSynth Solana Setup Script

set -e

echo "🚀 WrapSynth Solana Setup"
echo "=========================="
echo ""

# Check if Anchor is installed
if ! command -v anchor &> /dev/null; then
    echo "❌ Anchor CLI not found. Please install Anchor first:"
    echo "   cargo install --git https://github.com/coral-xyz/anchor avm --locked --force"
    echo "   avm install latest"
    echo "   avm use latest"
    exit 1
fi

# Check if Solana is installed
if ! command -v solana &> /dev/null; then
    echo "❌ Solana CLI not found. Please install Solana first:"
    echo "   sh -c \"\$(curl -sSfL https://release.solana.com/stable/install)\""
    exit 1
fi

echo "✅ Anchor version: $(anchor --version)"
echo "✅ Solana version: $(solana --version)"
echo ""

# Install Node dependencies
echo "📦 Installing Node dependencies..."
npm install
echo ""

# Build the program
echo "🔨 Building Anchor program..."
anchor build
echo ""

# Get the program ID
PROGRAM_ID=$(solana address -k target/deploy/wsxmr_solana-keypair.json)
echo "📝 Program ID: $PROGRAM_ID"
echo ""

# Update lib.rs with program ID
echo "📝 Updating program ID in lib.rs..."
sed -i "s/declare_id!(\".*\")/declare_id!(\"$PROGRAM_ID\")/" programs/wsxmr_solana/src/lib.rs

# Update Anchor.toml
echo "📝 Updating program ID in Anchor.toml..."
sed -i "s/wsxmr_solana = \".*\"/wsxmr_solana = \"$PROGRAM_ID\"/" Anchor.toml

# Rebuild with correct program ID
echo "🔨 Rebuilding with correct program ID..."
anchor build
echo ""

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Configure Solana cluster: solana config set --url devnet"
echo "  2. Get devnet SOL: solana airdrop 2"
echo "  3. Deploy program: anchor deploy --provider.cluster devnet"
echo "  4. Run tests: anchor test --provider.cluster devnet"
echo ""
