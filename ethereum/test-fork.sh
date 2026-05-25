#!/bin/bash
# Run E2E tests on Gnosis Chain fork

set -e

echo "🔧 Running WrapSynth E2E Tests on Gnosis Fork..."
echo ""

# Use public RPC if no env var set
RPC_URL="${GNOSIS_RPC_URL:-https://rpc.gnosischain.com}"

echo "📡 Fork URL: $RPC_URL"
echo ""

# Run comprehensive tests by default
if [ "$1" == "--quick" ]; then
    echo "Running quick test (happy path only)..."
    forge test --match-test test_FullCycle -vv --fork-url "$RPC_URL"
else
    echo "Running comprehensive test suite..."
    forge test --match-path test/E2EComprehensive.t.sol -vv --fork-url "$RPC_URL"
fi

echo ""
echo "✅ All tests passed!"
