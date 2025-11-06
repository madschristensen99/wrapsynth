#!/bin/bash

echo "🚀 Starting Monero Oracle to Solana Devnet Integration"
echo "============================================="

# Clean up any previous runs
killall legacy_server 2>/dev/null || true

# Step 1: Check dependencies
echo "📦 Checking dependencies..."
cargo check --bin legacy_server &
cargo check --bin solana_push &
wait

if [ $? -ne 0 ]; then
    echo "❌ Dependency check failed"
    exit 1
fi

echo "✅ Dependencies ready"

# Step 2: Test Monero connection
echo "🔍 Testing Monero node connection..."
python3 test_oracle.py

if [ $? -ne 0 ]; then
    echo "❌ Monero connection failed"
    exit 1
fi

echo "✅ Monero connection successful"

# Step 3: Start the legacy server (background)
echo "⚙️  Starting legacy TCP server on port 38089..."
cargo run --bin legacy_server &
SERVER_PID=$!
echo "Legacy server started (PID: $SERVER_PID)"

sleep 3

# Step 4: Test the TCP server
if nc -z 127.0.0.1 38089; then
    echo "✅ TCP server running on port 38089"
else
    echo "❌ TCP server not responding"
    kill $SERVER_PID
    exit 1
fi

# Step 5: Test endpoint integration
echo "🌐 Testing GET_BLOCK_DATA endpoint..."
echo "GET_BLOCK_DATA" | nc 127.0.0.1 38089

echo ""
echo "🧮 Testing GET_ZK_BYTES endpoint..."
echo "GET_ZK_BYTES" | nc 127.0.0.1 38089

# Step 6: Direct Solana integration
echo "🔗 Starting direct Solana push..."
cargo run --bin solana_push

# Clean up
echo "🧹 Cleaning up..."
kill $SERVER_PID 2>/dev/null || true

echo "🎯 Oracle integration complete!"