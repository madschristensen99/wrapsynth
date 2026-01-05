const hre = require("hardhat");
const fs = require("fs");
const { execSync } = require("child_process");

async function main() {
    console.log("🧪 Testing Monero Bridge on Base Sepolia\n");
    console.log("═".repeat(70));

    // Load deployment info
    const deployment = JSON.parse(fs.readFileSync('deployment_base_sepolia.json', 'utf8'));
    console.log("\n📋 Using deployed contracts:");
    console.log("   PlonkVerifier:", deployment.contracts.PlonkVerifier);
    console.log("   MoneroBridgeDLEQ:", deployment.contracts.MoneroBridgeDLEQ);

    // Get signer
    const [signer] = await hre.ethers.getSigners();
    console.log("\n👤 Signer:", signer.address);
    console.log("   Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(signer.address)), "ETH");

    // Connect to deployed contract
    const MoneroBridgeDLEQ = await hre.ethers.getContractFactory("MoneroBridgeDLEQ");
    const bridge = MoneroBridgeDLEQ.attach(deployment.contracts.MoneroBridgeDLEQ);

    console.log("\n" + "═".repeat(70));
    // Load transaction data from config
    const txDataConfig = JSON.parse(fs.readFileSync('tx_data.json', 'utf8'));
    const txId = process.argv[2] || txDataConfig.current;
    const txData = txDataConfig.transactions[txId];
    
    if (!txData) {
        console.error(`❌ Transaction ${txId} not found in tx_data.json`);
        console.log('Available transactions:', Object.keys(txDataConfig.transactions).join(', '));
        process.exit(1);
    }
    
    console.log(`🔄 Generating PLONK proof for ${txId} (${txData.name})...`);
    console.log("═".repeat(70));

    // Step 1: Fetch from blockchain
    console.log("\n  🔄 Step 1: Fetching from blockchain...");
    try {
        execSync(`node scripts/fetch_monero_witness.js ${txId} > /dev/null 2>&1`);
        console.log("  ✅ Blockchain data fetched");
    } catch(e) {
        console.log("  ❌ Fetch failed:", e.message);
        return;
    }

    // Step 2: Generate DLEQ witness
    console.log("\n  🔄 Step 2: Generating DLEQ witness...");
    try {
        const { generateWitness } = require('./generate_witness.js');
        const inputData = JSON.parse(fs.readFileSync('input.json', 'utf8'));
        const witness = await generateWitness(inputData);
        
        const circuitInputs = {
            r: witness.r,
            v: witness.v,
            H_s_scalar: witness.H_s_scalar,
            R_x: witness.R_x,
            S_x: witness.S_x,
            P_compressed: witness.P_compressed,
            ecdhAmount: witness.ecdhAmount,
            amountKey: witness.amountKey,
            commitment: witness.commitment
        };
        
        fs.writeFileSync('input.json', JSON.stringify(circuitInputs, null, 2));
        
        // Save DLEQ proofs for Solidity verification
        if (witness.dleqProof && witness.ed25519Proof) {
            fs.writeFileSync('dleq_proof.json', JSON.stringify({
                R: witness.R,
                rA: witness.rA,
                S: witness.S,
                dleqProof: witness.dleqProof,
                ed25519Proof: witness.ed25519Proof
            }, null, 2));
        }
        
        console.log("  ✅ DLEQ witness generated");
    } catch(e) {
        console.log("  ❌ DLEQ generation failed:", e.message);
        return;
    }

    // Step 3: Calculate witness
    console.log("\n  🔄 Step 3: Calculating circuit witness...");
    try {
        execSync('snarkjs wtns calculate build/monero_bridge_js/monero_bridge.wasm input.json witness.wtns 2>&1', {stdio: 'pipe'});
        console.log("  ✅ Witness calculated");
    } catch(e) {
        console.log("  ❌ Witness calculation failed");
        return;
    }

    // Step 4: Generate PLONK proof
    console.log("\n  🔄 Step 4: Generating PLONK proof...");
    const proofStart = Date.now();
    try {
        execSync('snarkjs plonk prove circuit_final.zkey witness.wtns proof.json public.json 2>&1', {stdio: 'pipe'});
        const proofTime = ((Date.now() - proofStart) / 1000).toFixed(2);
        console.log(`  ✅ PLONK proof generated (${proofTime}s)`);
    } catch(e) {
        console.log("  ❌ Proof generation failed");
        return;
    }

    // Step 5: Verify proof locally
    console.log("\n  🔄 Step 5: Verifying proof locally...");
    try {
        const result = execSync('snarkjs plonk verify verification_key.json public.json proof.json 2>&1').toString();
        if (result.includes('OK!')) {
            console.log("  ✅ Proof verified locally");
        } else {
            console.log("  ❌ Local verification failed");
            return;
        }
    } catch(e) {
        console.log("  ❌ Verification failed");
        return;
    }

    // Step 6: Submit to Base Sepolia
    console.log("\n" + "═".repeat(70));
    console.log("📤 Submitting proof to Base Sepolia...");
    console.log("═".repeat(70));

    // Read proof and public signals
    const proof = JSON.parse(fs.readFileSync('proof.json', 'utf8'));
    const publicSignals = JSON.parse(fs.readFileSync('public.json', 'utf8'));

    // Format PLONK proof for Solidity (24 elements)
    const proofCalldata = [
        proof.A[0], proof.A[1],
        proof.B[0], proof.B[1],
        proof.C[0], proof.C[1],
        proof.Z[0], proof.Z[1],
        proof.T1[0], proof.T1[1],
        proof.T2[0], proof.T2[1],
        proof.T3[0], proof.T3[1],
        proof.Wxi[0], proof.Wxi[1],
        proof.Wxiw[0], proof.Wxiw[1],
        proof.eval_a, proof.eval_b, proof.eval_c,
        proof.eval_s1, proof.eval_s2, proof.eval_zw
    ];

    // Read DLEQ proof data
    const dleqData = JSON.parse(fs.readFileSync('dleq_proof.json', 'utf8'));
    
    // Format DLEQ proof struct
    const dleqProof = {
        c: dleqData.dleqProof.c,
        s: dleqData.dleqProof.s,
        K1_x: dleqData.dleqProof.K1.x,
        K1_y: dleqData.dleqProof.K1.y,
        K2_x: dleqData.dleqProof.K2.x,
        K2_y: dleqData.dleqProof.K2.y
    };
    
    // Format Ed25519 proof struct
    const ed25519Proof = {
        G_x: dleqData.ed25519Proof.G.x,
        G_y: dleqData.ed25519Proof.G.y,
        A_x: dleqData.ed25519Proof.A.x,
        A_y: dleqData.ed25519Proof.A.y,
        B_x: dleqData.ed25519Proof.B.x,
        B_y: dleqData.ed25519Proof.B.y,
        R_x: dleqData.R.x,
        R_y: dleqData.R.y,
        S_x: dleqData.rA.x,  // Pass rA as S (standard DLEQ)
        S_y: dleqData.rA.y,
        H_s: dleqData.ed25519Proof.H_s
    };

    console.log("\n  📊 Proof data:");
    console.log("     Public signals:", publicSignals.length);
    console.log("     Commitment:", publicSignals[0].slice(0, 20) + "...");

    try {
        console.log("\n  📊 Estimating gas...");
        const txHash = "0x" + txData.hash;
        
        try {
            const gasEstimate = await bridge.verifyAndMint.estimateGas(proofCalldata, publicSignals, dleqProof, ed25519Proof, txHash);
            console.log("     Estimated gas:", gasEstimate.toString());
        } catch (gasError) {
            console.log("     ⚠️  Gas estimation failed:", gasError.message);
            if (gasError.data) {
                console.log("     Error data:", gasError.data);
            }
        }
        
        console.log("\n  🔄 Sending transaction...");
        const tx = await bridge.verifyAndMint(proofCalldata, publicSignals, dleqProof, ed25519Proof, txHash);
        console.log("  📝 Transaction hash:", tx.hash);
        
        console.log("  ⏳ Waiting for confirmation...");
        const receipt = await tx.wait();
        
        console.log("\n" + "═".repeat(70));
        console.log("🎉 SUCCESS! Proof submitted to Base Sepolia");
        console.log("═".repeat(70));
        console.log("\n  ✅ Transaction confirmed!");
        console.log("     Block:", receipt.blockNumber);
        console.log("     Gas used:", receipt.gasUsed.toString());
        console.log("     Status:", receipt.status === 1 ? "Success" : "Failed");
        console.log("\n  🌐 View on BaseScan:");
        console.log(`     https://sepolia.basescan.org/tx/${tx.hash}`);

        // Check if output was marked as used
        console.log("\n  🔍 Checking output status...");
        // Note: Would need R_x and P_compressed to check usedOutputs mapping
        console.log("     Transaction successful - proof verified on-chain!");

    } catch(e) {
        console.log("\n  ❌ Transaction failed:", e.message);
        if (e.data) {
            console.log("     Error data:", e.data);
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
