const hre = require("hardhat");
const fs = require("fs");
const crypto = require("crypto");

async function main() {
    console.log("🎯 Testing MoneroBridge Mint with Real PLONK Proof\n");
    console.log("═".repeat(70));

    // Load deployment
    const deployment = JSON.parse(fs.readFileSync('oracle/deployment.json', 'utf8'));
    console.log("\n📋 Contract: ", deployment.bridge);

    // Get signer
    const [signer] = await hre.ethers.getSigners();
    console.log("👤 Signer:", signer.address);

    // Connect to contract
    const bridge = await hre.ethers.getContractAt("MoneroBridge", deployment.bridge);

    // Load proof data
    const proof = JSON.parse(fs.readFileSync('proof.json', 'utf8'));
    const publicSignals = JSON.parse(fs.readFileSync('public.json', 'utf8'));
    const dleqData = JSON.parse(fs.readFileSync('dleq_proof.json', 'utf8'));
    const txData = JSON.parse(fs.readFileSync('tx_data.json', 'utf8')).transactions.TX6;

    console.log("\n📊 Transaction Data:");
    console.log("   TX Hash:", txData.hash);
    console.log("   Block:", txData.block);
    console.log("   Amount:", txData.amount, "piconero");

    // Format PLONK proof
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

    // Format DLEQ proof
    const dleqProof = {
        K1_x: dleqData.dleqProof.K1.x,
        K1_y: dleqData.dleqProof.K1.y,
        K2_x: dleqData.dleqProof.K2.x,
        K2_y: dleqData.dleqProof.K2.y,
        c: dleqData.dleqProof.c,
        s: dleqData.dleqProof.s
    };

    // Format Ed25519 proof
    const ed25519Proof = {
        A_x: dleqData.ed25519Proof.A.x,
        A_y: dleqData.ed25519Proof.A.y,
        B_x: dleqData.ed25519Proof.B.x,
        B_y: dleqData.ed25519Proof.B.y,
        G_x: dleqData.ed25519Proof.G.x,
        G_y: dleqData.ed25519Proof.G.y,
        H_s: dleqData.ed25519Proof.H_s,
        P_x: dleqData.ed25519Proof.P.x,
        P_y: dleqData.ed25519Proof.P.y,
        R_x: dleqData.R.x,
        R_y: dleqData.R.y,
        S_x: dleqData.S.x,
        S_y: dleqData.S.y,
        rA_x: dleqData.rA.x,
        rA_y: dleqData.rA.y
    };

    // Fetch output data from blockchain
    console.log("\n🔍 Fetching output data from Monero...");
    const axios = require('axios');
    const response = await axios.post(`${txData.node}/get_transactions`, {
        txs_hashes: [txData.hash],
        decode_as_json: true
    });
    
    const txJson = JSON.parse(response.data.txs[0].as_json);
    const outputKey = txJson.vout[txData.output_index].target.tagged_key?.key || txJson.vout[txData.output_index].target.key;
    const ecdhAmount = txJson.rct_signatures.ecdhInfo[txData.output_index].amount;
    const commitment = txJson.rct_signatures.outPk[txData.output_index];

    console.log("   Output Key:", outputKey);
    console.log("   ECDH Amount:", ecdhAmount);
    console.log("   Commitment:", commitment);

    // Create MoneroTxOutput struct
    const output = {
        txHash: "0x" + txData.hash,
        outputIndex: BigInt(txData.output_index),
        ecdhAmount: ("0x" + ecdhAmount).padEnd(66, '0'),  // Pad to 32 bytes (0x + 64 hex chars)
        outputPubKey: "0x" + outputKey,
        commitment: "0x" + commitment,
        blockHeight: BigInt(txData.block),
        exists: false  // Will be set by contract
    };

    // Compute TX Merkle proof (single TX in block = empty proof)
    const txMerkleProof = [];
    const txIndex = 0;

    // Compute output Merkle proof
    // For 2 outputs, we need the sibling hash
    console.log("\n🌳 Computing Merkle proofs...");
    
    // Get both outputs
    const output0Key = txJson.vout[0].target.tagged_key?.key || txJson.vout[0].target.key;
    const output1Key = txJson.vout[1].target.tagged_key?.key || txJson.vout[1].target.key;
    const ecdh0 = txJson.rct_signatures.ecdhInfo[0].amount;
    const ecdh1 = txJson.rct_signatures.ecdhInfo[1].amount;
    const commit0 = txJson.rct_signatures.outPk[0];
    const commit1 = txJson.rct_signatures.outPk[1];
    
    // Compute leaf hashes using Keccak256 + ABI encoding (same as oracle)
    const leaf0 = hre.ethers.keccak256(
        hre.ethers.AbiCoder.defaultAbiCoder().encode(
            ['bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32'],
            [
                "0x" + txData.hash,
                0,
                ("0x" + ecdh0).padEnd(66, '0'),  // Right pad like oracle
                "0x" + output0Key,
                "0x" + commit0
            ]
        )
    );
    
    const leaf1 = hre.ethers.keccak256(
        hre.ethers.AbiCoder.defaultAbiCoder().encode(
            ['bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32'],
            [
                "0x" + txData.hash,
                1,
                ("0x" + ecdh1).padEnd(66, '0'),  // Right pad like oracle
                "0x" + output1Key,
                "0x" + commit1
            ]
        )
    );

    // For output 0, sibling is leaf1
    // Then hash them together with SHA256 for Merkle tree
    const parent = crypto.createHash('sha256')
        .update(Buffer.concat([
            Buffer.from(leaf0.slice(2), 'hex'),
            Buffer.from(leaf1.slice(2), 'hex')
        ]))
        .digest();
    
    const outputMerkleProof = [leaf1];  // Sibling leaf
    const outputIndex = 0;

    // Verify our leaf matches what we're sending
    const ourLeaf = hre.ethers.keccak256(
        hre.ethers.AbiCoder.defaultAbiCoder().encode(
            ['bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32'],
            [
                output.txHash,
                output.outputIndex,
                output.ecdhAmount,
                output.outputPubKey,
                output.commitment
            ]
        )
    );
    
    console.log("   TX Merkle Proof: empty (single TX)");
    console.log("   Output Merkle Proof: 1 sibling");
    console.log("   Our leaf (from output struct):", ourLeaf);
    console.log("   Leaf 0 (computed):", leaf0);
    console.log("   Match:", ourLeaf === leaf0);
    console.log("   Leaf 1 (sibling):", leaf1);
    console.log("   Computed root:", "0x" + parent.toString('hex'));
    console.log("   Expected root: 0x74fb425e264051b21b2e3d49393faa5f451bd1be0f0f35b793bf6dea51d1f503");

    // Submit proof
    console.log("\n🚀 Submitting proof to contract...");
    console.log("   Proof calldata length:", proofCalldata.length);
    console.log("   Public signals length:", publicSignals.length);
    console.log("   Block height:", txData.block);
    
    try {
        const tx = await bridge.verifyProof(
            proofCalldata,
            publicSignals,
            dleqProof,
            ed25519Proof,
            output,
            BigInt(txData.block),
            txMerkleProof,
            BigInt(txIndex),
            outputMerkleProof,
            BigInt(outputIndex)
        );
        
        console.log("  📝 TX Hash:", tx.hash);
        console.log("  ⏳ Waiting for confirmation...");
        
        const receipt = await tx.wait();
        console.log("  ✅ Confirmed in block", receipt.blockNumber);
        console.log("  ⛽ Gas used:", receipt.gasUsed.toString());
        
        console.log("\n🎉 SUCCESS! Proof verified on-chain!");
        
    } catch (error) {
        console.log("\n❌ Transaction failed:");
        console.log("   Error:", error.message);
        if (error.data) {
            console.log("   Data:", error.data);
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
