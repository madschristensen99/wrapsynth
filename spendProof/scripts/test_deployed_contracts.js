#!/usr/bin/env node

/**
 * Test deployed contracts on Base Sepolia
 */

const hre = require("hardhat");
const fs = require("fs");

async function main() {
    console.log("🧪 Testing Deployed Contracts on Base Sepolia\n");
    console.log("═".repeat(70));

    // Load deployment info
    const deployment = JSON.parse(fs.readFileSync('deployment_base_sepolia.json', 'utf8'));
    
    console.log("\n📋 Deployment Information:");
    console.log("   Network:", deployment.network);
    console.log("   Chain ID:", deployment.chainId);
    console.log("   Deployer:", deployment.deployer);
    console.log("   Timestamp:", deployment.timestamp);
    
    console.log("\n📝 Contract Addresses:");
    console.log("   PlonkVerifier:", deployment.contracts.PlonkVerifier);
    console.log("   MoneroBridgeDLEQ:", deployment.contracts.MoneroBridgeDLEQ);

    // Get signer
    const [signer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(signer.address);
    
    console.log("\n👤 Signer Information:");
    console.log("   Address:", signer.address);
    console.log("   Balance:", hre.ethers.formatEther(balance), "ETH");

    // Connect to contracts
    console.log("\n🔗 Connecting to contracts...");
    const PlonkVerifier = await hre.ethers.getContractFactory("PlonkVerifier");
    const verifier = PlonkVerifier.attach(deployment.contracts.PlonkVerifier);
    
    const MoneroBridgeDLEQ = await hre.ethers.getContractFactory("MoneroBridgeDLEQ");
    const bridge = MoneroBridgeDLEQ.attach(deployment.contracts.MoneroBridgeDLEQ);
    
    console.log("   ✅ Connected to PlonkVerifier");
    console.log("   ✅ Connected to MoneroBridgeDLEQ");

    // Test 1: Verify bridge points to correct verifier
    console.log("\n" + "═".repeat(70));
    console.log("TEST 1: Verify Bridge Configuration");
    console.log("═".repeat(70));
    
    const verifierAddress = await bridge.verifier();
    console.log("   Bridge's verifier address:", verifierAddress);
    console.log("   Expected verifier address:", deployment.contracts.PlonkVerifier);
    
    if (verifierAddress.toLowerCase() === deployment.contracts.PlonkVerifier.toLowerCase()) {
        console.log("   ✅ PASS: Bridge correctly configured with verifier");
    } else {
        console.log("   ❌ FAIL: Bridge verifier mismatch");
        process.exit(1);
    }

    // Test 2: Check contract code exists
    console.log("\n" + "═".repeat(70));
    console.log("TEST 2: Verify Contract Code");
    console.log("═".repeat(70));
    
    const verifierCode = await hre.ethers.provider.getCode(deployment.contracts.PlonkVerifier);
    const bridgeCode = await hre.ethers.provider.getCode(deployment.contracts.MoneroBridgeDLEQ);
    
    console.log("   PlonkVerifier code size:", verifierCode.length, "bytes");
    console.log("   MoneroBridgeDLEQ code size:", bridgeCode.length, "bytes");
    
    if (verifierCode.length > 2 && bridgeCode.length > 2) {
        console.log("   ✅ PASS: Both contracts have code deployed");
    } else {
        console.log("   ❌ FAIL: Contract code missing");
        process.exit(1);
    }

    // Test 3: Test view functions
    console.log("\n" + "═".repeat(70));
    console.log("TEST 3: Test View Functions");
    console.log("═".repeat(70));
    
    const testOutputId = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("test_output"));
    const isUsed = await bridge.isOutputUsed(testOutputId);
    console.log("   Test output ID:", testOutputId);
    console.log("   Is output used:", isUsed);
    console.log("   ✅ PASS: View function works correctly");

    // Summary
    console.log("\n" + "═".repeat(70));
    console.log("🎉 DEPLOYMENT VERIFICATION COMPLETE");
    console.log("═".repeat(70));
    
    console.log("\n✅ All tests passed!");
    console.log("\n📊 Summary:");
    console.log("   • Contracts deployed successfully");
    console.log("   • Configuration verified");
    console.log("   • View functions working");
    console.log("   • Ready for proof submission");
    
    console.log("\n🌐 View on BaseScan:");
    console.log(`   PlonkVerifier: https://sepolia.basescan.org/address/${deployment.contracts.PlonkVerifier}`);
    console.log(`   MoneroBridgeDLEQ: https://sepolia.basescan.org/address/${deployment.contracts.MoneroBridgeDLEQ}`);
    
    console.log("\n📝 Next Steps:");
    console.log("   1. Generate PLONK proofs using: node scripts/test_circuit.js");
    console.log("   2. Submit proofs using: node scripts/test_on_chain.js");
    console.log("   3. Verify contracts on BaseScan (optional)");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Error:", error.message);
        process.exit(1);
    });
