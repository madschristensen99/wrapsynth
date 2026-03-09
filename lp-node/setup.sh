#!/bin/bash
# WrapSynth LP Node Setup Script

set -e

echo "🌉 WrapSynth LP Node Setup"
echo "=========================="
echo ""

# Check if .env exists
if [ -f .env ]; then
    echo "⚠️  .env file already exists"
    read -p "Do you want to overwrite it? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Setup cancelled"
        exit 0
    fi
fi

# Copy .env.example to .env
cp .env.example .env
echo "✅ Created .env file from template"
echo ""

# Prompt for required values
echo "Please provide the following information:"
echo ""

read -p "Enter your LP private key (with 0x prefix): " PRIVATE_KEY
read -p "Enter your LP vault address (with 0x prefix): " LP_VAULT_ADDRESS

# Update .env file
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s/PRIVATE_KEY=.*/PRIVATE_KEY=$PRIVATE_KEY/" .env
    sed -i '' "s/LP_VAULT_ADDRESS=.*/LP_VAULT_ADDRESS=$LP_VAULT_ADDRESS/" .env
else
    # Linux
    sed -i "s/PRIVATE_KEY=.*/PRIVATE_KEY=$PRIVATE_KEY/" .env
    sed -i "s/LP_VAULT_ADDRESS=.*/LP_VAULT_ADDRESS=$LP_VAULT_ADDRESS/" .env
fi

echo ""
echo "✅ Configuration saved to .env"
echo ""
echo "📋 Current Configuration:"
echo "  Network: Gnosis Chain (mainnet)"
echo "  VaultManager: 0xc5AF5A978ba0E33c29984Aa46f939a7Ff164A851"
echo "  wsXMR Token: 0x46520da3212dA53A8e981641f82C261b36C78dDd"
echo "  LP Vault: $LP_VAULT_ADDRESS"
echo ""
echo "⚠️  IMPORTANT: Make sure you have:"
echo "  1. Created a vault on-chain using the VaultManager contract"
echo "  2. Deposited sufficient collateral (sDAI) to your vault"
echo "  3. monero-wallet-rpc running on localhost:18082"
echo ""
echo "🚀 To start the LP node:"
echo "  cargo run --release"
echo ""
