#!/bin/bash
set -e

echo "=== WrapSynth Setup ==="
echo "Installing Foundry dependencies..."
forge install

echo "Patching RedStone assembly blocks for memory-safe compilation..."
./patch-redstone.sh

echo ""
echo "Setup complete. Run 'forge build' to compile."
echo "Run 'forge test' to run the test suite."
