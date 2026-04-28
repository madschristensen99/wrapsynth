#!/bin/bash

# Script to run tests with Gnosis fork enabled

echo "Running WrapSynth tests on Gnosis Chain fork..."
echo "================================================"

# Set environment variable to enable forking
export FORK_GNOSIS=true

# Run all tests
npx hardhat test

echo ""
echo "Test run complete!"
