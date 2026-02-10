#!/bin/bash
# Run the Monero Oracle service

set -e

echo "════════════════════════════════════════════════════════════════"
echo "  Starting Monero Oracle"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Change to project root
cd "$(dirname "$0")/../.."

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "❌ No .env file found"
    echo "   Run: ./scripts/oracle/setup.sh"
    exit 1
fi

# Check if oracle is built
if [ ! -f "monero-oracle/target/release/monero-oracle" ]; then
    echo "Building oracle..."
    cd monero-oracle
    cargo build --release
    cd ..
    echo "✓ Oracle built"
    echo ""
fi

# Run oracle
cd monero-oracle
exec cargo run --release
