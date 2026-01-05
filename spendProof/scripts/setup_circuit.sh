#!/bin/bash

echo "🔧 Setting up PLONK circuit for Monero Bridge"
echo "═══════════════════════════════════════════════════════════════════════"

# Check if circuit is compiled
if [ ! -f "monero_bridge.r1cs" ]; then
    echo "❌ Circuit not compiled. Run: npm run compile"
    exit 1
fi

echo "✅ Circuit compiled (monero_bridge.r1cs found)"

# Download Powers of Tau if not present
if [ ! -f "powersOfTau28_hez_final_12.ptau" ]; then
    echo ""
    echo "📥 Downloading Powers of Tau ceremony file (12.5 MB)..."
    wget -q --show-progress https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau
    echo "✅ Powers of Tau downloaded"
else
    echo "✅ Powers of Tau file already exists"
fi

# Setup PLONK proving key
echo ""
echo "🔑 Setting up PLONK proving key..."
if [ ! -f "circuit_final.zkey" ]; then
    snarkjs plonk setup monero_bridge.r1cs powersOfTau28_hez_final_12.ptau circuit_final.zkey
    echo "✅ PLONK proving key generated"
else
    echo "✅ PLONK proving key already exists"
fi

# Export verification key
echo ""
echo "📤 Exporting verification key..."
if [ ! -f "verification_key.json" ]; then
    snarkjs zkey export verificationkey circuit_final.zkey verification_key.json
    echo "✅ Verification key exported"
else
    echo "✅ Verification key already exists"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "🎉 Circuit setup complete!"
echo ""
echo "📊 Files created:"
ls -lh powersOfTau28_hez_final_12.ptau circuit_final.zkey verification_key.json 2>/dev/null
echo ""
echo "📝 Next steps:"
echo "   1. Generate witness: node scripts/fetch_monero_witness.js"
echo "   2. Generate proof: node scripts/test_circuit.js"
echo "   3. Test on-chain: npx hardhat run scripts/test_on_chain.js --network baseSepolia"
