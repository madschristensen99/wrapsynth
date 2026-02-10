#!/bin/bash
# Setup script for Monero Oracle
# This script helps configure the oracle to work with the deployed contracts

set -e

echo "════════════════════════════════════════════════════════════════"
echo "  Monero Oracle Setup"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Change to project root
cd "$(dirname "$0")/../.."

# Load deployment info (prefer mock deployment if it exists)
if [ -f "deployments/unichain_testnet_mock_latest.json" ]; then
    DEPLOYMENT_FILE="deployments/unichain_testnet_mock_latest.json"
    echo "Using mock deployment"
else
    DEPLOYMENT_FILE="deployments/unichain_testnet_latest.json"
fi

if [ ! -f "$DEPLOYMENT_FILE" ]; then
    echo "❌ No deployment file found at $DEPLOYMENT_FILE"
    echo "   Please deploy contracts first: npm run deploy:unichain"
    exit 1
fi

# Extract contract address
BRIDGE_ADDRESS=$(jq -r '.contracts.WrappedMonero' "$DEPLOYMENT_FILE")

echo "Deployed Contract:"
echo "  WrappedMonero: $BRIDGE_ADDRESS"
echo ""

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo "✓ Created .env"
    echo ""
fi

# Update BRIDGE_ADDRESS in .env
if grep -q "^BRIDGE_ADDRESS=" .env; then
    # Update existing
    sed -i "s|^BRIDGE_ADDRESS=.*|BRIDGE_ADDRESS=$BRIDGE_ADDRESS|" .env
    echo "✓ Updated BRIDGE_ADDRESS in .env"
else
    # Add new
    echo "BRIDGE_ADDRESS=$BRIDGE_ADDRESS" >> .env
    echo "✓ Added BRIDGE_ADDRESS to .env"
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "✓ Oracle Configuration Updated"
echo "════════════════════════════════════════════════════════════════"
echo ""

echo "Next steps:"
echo "  1. Make sure PRIVATE_KEY is set in .env"
echo "     (this is used for both deployment and oracle)"
echo ""
echo "  2. Build the oracle:"
echo "     cd monero-oracle && cargo build --release"
echo ""
echo "  3. Run the oracle:"
echo "     cd monero-oracle && cargo run --release"
echo ""
echo "  Or use the helper script:"
echo "     ./scripts/oracle/run.sh"
echo ""
