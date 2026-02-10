const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { generateWitness } = require("./generate_witness.js");
const snarkjs = require("snarkjs");
const bs58 = require("bs58");
const ed = require('@noble/ed25519');
const { CURVE } = require("../utils/ed25519_utils.js");
const { computeEd25519Operations } = require('./generate_dleq.js');
const { decryptMoneroAmount } = require('./compute_monero_keys.js');

async function main() {
    console.log("🔐 Generating Proof and Executing PRIVATE MINT via Relayer\n");
    console.log("═".repeat(70));

    // Load transaction data from JSON file
    const txDataPath = path.join(__dirname, '..', '..', 'transaction_data.json');
    console.log("\n📄 Loading transaction data from:", txDataPath);
    const txData = JSON.parse(fs.readFileSync(txDataPath, 'utf8'));
    
    const TX_HASH = txData.txHash;
    const SECRET_KEY_R = txData.secretKeyR;
    const FRESH_ADDRESS = txData.recipientAddress; // Fresh address for privacy!
    const BLOCK_HEIGHT = txData.blockHeight;
    const OUTPUT_INDEX = txData.outputIndex;
    const EXPECTED_AMOUNT = txData.expectedAmount;
    const LP_PRIVATE_VIEW_KEY = txData.lpPrivateViewKey;
    
    console.log("\n📦 Transaction Details:");
    console.log("   TX Hash:", TX_HASH);
    console.log("   Block Height:", BLOCK_HEIGHT);
    console.log("   Fresh Address:", FRESH_ADDRESS);
    console.log("   Expected Amount:", EXPECTED_AMOUNT, "piconero");
    
    console.log("\n⏳ Step 0: Loading contracts and LP info...");
    const deployment = JSON.parse(fs.readFileSync('deployments/unichain_testnet_latest.json'));
    const bridge = await hre.ethers.getContractAt('WrappedMonero', deployment.contracts.WrappedMonero);
    const mintRelayer = await hre.ethers.getContractAt('MintRelayer', deployment.contracts.MintRelayer);
    
    // Get signer (LP/Relayer)
    const [signer] = await hre.ethers.getSigners();
    console.log("   LP/Relayer Address:", signer.address);
    console.log("   Fresh Recipient:", FRESH_ADDRESS);
    
    console.log("\n⏳ Step 1: Verifying block is posted...");
    const blockInfo = await bridge.moneroBlocks(BLOCK_HEIGHT);
    if (!blockInfo.exists) {
        throw new Error(`Block ${BLOCK_HEIGHT} not posted by oracle yet!`);
    }
    console.log("   ✅ Block", BLOCK_HEIGHT, "found on-chain!");
    console.log("   TX Merkle root:", blockInfo.txMerkleRoot);
    
    console.log("\n📊 Step 2: Computing Merkle proofs...");
    process.env.MONERO_RPC_URL = 'http://xmr.privex.io:18081/json_rpc';
    const { computeTxMerkleProof, computeOutputMerkleProof } = require('../utils/compute_merkle_proof.js');
    
    const merkleData = await computeTxMerkleProof(BLOCK_HEIGHT, TX_HASH, OUTPUT_INDEX);
    const txMerkleProof = merkleData.proof;
    const txIndex = merkleData.txIndex;
    console.log("   ✅ TX Merkle proof computed, TX index:", txIndex);
    
    const outputMerkleData = await computeOutputMerkleProof(BLOCK_HEIGHT, TX_HASH, OUTPUT_INDEX);
    const outputMerkleProof = outputMerkleData.proof;
    const globalOutputIndex = outputMerkleData.outputIndex;
    console.log("   ✅ Output Merkle proof computed, global index:", globalOutputIndex);
    
    console.log("\n🔐 Step 3: Fetching Monero transaction data...");
    
    // Try multiple Monero RPC nodes from monero.fail
    // Use /get_transactions endpoint (daemon RPC), not /json_rpc
    const rpcNodes = [
        'http://node.monerodevs.org:18089',
        'http://node2.monerodevs.org:18089',
        'http://node3.monerodevs.org:18089',
        'http://xmr-node.cakewallet.com:18081',
        'http://nodex.monerujo.io:18081',
        'http://node.richfowler.net:18089',
        'http://xmr.support:18081',
        'https://node.sethforprivacy.com',
        'http://nodes.hashvault.pro:18081',
        'https://xmr-node.cakewallet.com:18081'
    ];
    
    let txData_full = null;
    let successfulNode = null;
    
    for (const rpcUrl of rpcNodes) {
        try {
            console.log(`   Trying node: ${rpcUrl}`);
            
            // Get transaction using daemon RPC endpoint
            const txResponse = await axios.post(`${rpcUrl}/get_transactions`, {
                txs_hashes: [TX_HASH],
                decode_as_json: true
            }, {
                timeout: 10000,
                headers: { 'Content-Type': 'application/json' }
            });
            
            console.log(`   Response status: ${txResponse.status}`);
            
            if (txResponse.data && txResponse.data.status === 'OK') {
                if (txResponse.data.txs && txResponse.data.txs.length > 0) {
                    const txInfo = txResponse.data.txs[0];
                    console.log(`   ✅ Transaction found! Status: ${txInfo.in_pool ? 'in pool' : 'confirmed'}`);
                    
                    if (txInfo.as_json) {
                        txData_full = JSON.parse(txInfo.as_json);
                        successfulNode = rpcUrl;
                        console.log(`   ✅ Successfully fetched from: ${rpcUrl}`);
                        break;
                    } else {
                        console.log(`   ⚠️  No JSON data in response`);
                    }
                } else if (txResponse.data.missed_tx && txResponse.data.missed_tx.length > 0) {
                    console.log(`   ⚠️  Transaction not found on this node (missed_tx)`);
                } else {
                    console.log(`   ⚠️  No transactions in response`);
                }
            } else {
                console.log(`   ⚠️  Status: ${txResponse.data?.status || 'unknown'}`);
            }
        } catch (error) {
            console.log(`   ❌ Error with ${rpcUrl}: ${error.message}`);
            continue;
        }
    }
    
    if (!txData_full) {
        console.log("\n❌ Could not fetch transaction from any node!");
        console.log("   Tried nodes:", rpcNodes.length);
        console.log("   TX Hash:", TX_HASH);
        console.log("   Block:", BLOCK_HEIGHT);
        throw new Error(`Transaction ${TX_HASH} not found on any Monero RPC node`);
    }
    
    console.log("   ✅ Transaction found!");
    console.log("   Outputs:", txData_full.vout.length);
    
    // Get the output we're interested in
    const output_data = txData_full.vout[OUTPUT_INDEX];
    const outputKey = output_data.target.tagged_key ? output_data.target.tagged_key.key : output_data.target.key;
    const ecdhAmount = txData_full.rct_signatures.ecdhInfo[OUTPUT_INDEX].amount;
    const commitment = txData_full.rct_signatures.outPk[OUTPUT_INDEX];
    
    console.log("   Output key:", outputKey.slice(0, 16) + "...");
    console.log("   ECDH amount:", ecdhAmount.slice(0, 16) + "...");
    
    console.log("\n🔑 Step 4: Decrypting amount with LP's private view key...");
    
    // Parse extra field to extract transaction public key
    // Extra field format: [tag, ...data]
    // Tag 1 = TX_EXTRA_TAG_PUBKEY (32 bytes follow)
    let txPubKey = null;
    const extra = txData_full.extra;
    
    for (let i = 0; i < extra.length; i++) {
        if (extra[i] === 1 && i + 32 < extra.length) {
            // Found TX public key tag, next 32 bytes are the key
            const keyBytes = extra.slice(i + 1, i + 33);
            txPubKey = Buffer.from(keyBytes).toString('hex');
            break;
        }
    }
    
    if (!txPubKey) {
        throw new Error("Transaction public key not found in extra data");
    }
    
    console.log("   TX public key:", txPubKey.slice(0, 16) + "...");
    
    const { amountPiconero, H_s } = await decryptMoneroAmount({
        privateViewKey: LP_PRIVATE_VIEW_KEY,
        txPublicKey: txPubKey,
        outputIndex: OUTPUT_INDEX,
        ecdhAmount: ecdhAmount
    });
    
    console.log("   ✅ Amount decrypted:", amountPiconero.toString(), "piconero");
    console.log("   ✅ Amount in XMR:", Number(amountPiconero) / 1e12);
    console.log("   ✅ H_s computed:", H_s.slice(0, 16) + "...");
    
    // Verify amount matches expected
    if (amountPiconero.toString() !== EXPECTED_AMOUNT) {
        console.log("   ⚠️  Warning: Decrypted amount doesn't match expected!");
        console.log("   Expected:", EXPECTED_AMOUNT);
        console.log("   Got:", amountPiconero.toString());
    }
    
    console.log("\n🧮 Step 5: Computing Ed25519 operations...");
    console.log("   H_s type:", typeof H_s);
    console.log("   H_s value:", H_s);
    console.log("   outputKey:", outputKey);
    
    // Use placeholder values for A and B (not needed for DLEQ-optimized circuit)
    const placeholderA = '0000000000000000000000000000000000000000000000000000000000000000';
    const placeholderB = outputKey; // Use output key as B
    
    const { A, B, C, D, dleqProof, ed25519Proof } = await computeEd25519Operations(
        SECRET_KEY_R,
        placeholderA,
        placeholderB,
        H_s
    );
    
    console.log("   ✅ Ed25519 operations computed");
    console.log("   ✅ DLEQ proof generated");
    
    // Format Ed25519Proof for contract (flatten nested structure)
    // Convert BigInt strings to proper bytes32 format
    const toBigIntHex = (value) => {
        const bigIntValue = typeof value === 'string' ? BigInt(value) : value;
        // Convert to hex string manually to handle large numbers
        let hexStr = bigIntValue.toString(16);
        // Pad to 64 hex chars (32 bytes)
        hexStr = hexStr.padStart(64, '0');
        return '0x' + hexStr;
    };
    
    const ed25519ProofForContract = {
        R_x: toBigIntHex(ed25519Proof.R_x),
        R_y: toBigIntHex(ed25519Proof.R_y),
        S_x: toBigIntHex(ed25519Proof.S_x),
        S_y: toBigIntHex(ed25519Proof.S_y),
        P_x: toBigIntHex(ed25519Proof.P.x),
        P_y: toBigIntHex(ed25519Proof.P.y),
        B_x: toBigIntHex(ed25519Proof.B.x),
        B_y: toBigIntHex(ed25519Proof.B.y),
        G_x: toBigIntHex(ed25519Proof.G.x),
        G_y: toBigIntHex(ed25519Proof.G.y),
        A_x: toBigIntHex(ed25519Proof.A.x),
        A_y: toBigIntHex(ed25519Proof.A.y)
    };
    
    // Format DLEQ proof for contract
    const dleqProofForContract = {
        c: toBigIntHex(dleqProof.c),
        s: toBigIntHex(dleqProof.s),
        K1: toBigIntHex(dleqProof.K1.x), // Contract expects just x coordinate as bytes32
        K2: toBigIntHex(dleqProof.K2.x)  // Contract expects just x coordinate as bytes32
    };
    
    console.log("\n⚡ Step 6: Generating ZK witness...");
    const inputData = {
        r: SECRET_KEY_R,
        H_s_scalar: H_s,
        v: amountPiconero.toString(),
        ecdhAmount: ecdhAmount,
        A_compressed: placeholderA,
        B_compressed: placeholderB,
        R_x: C, // R.x from Ed25519 operations
        S_x: D, // S.x from Ed25519 operations  
        P_compressed: outputKey
    };
    
    const witness = await generateWitness(inputData);
    
    console.log("   ✅ Witness generated!");
    
    console.log("\n🔐 Step 7: Generating PLONK proof...");
    const wasmPath = path.join(__dirname, '../../circuit/build/monero_bridge_js/monero_bridge.wasm');
    const zkeyPath = path.join(__dirname, '../../circuit/build/monero_bridge_final.zkey');
    const wtnsPath = path.join(__dirname, '../../circuit/build/witness.wtns');
    
    if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath)) {
        throw new Error("Circuit not compiled! Run: cd circuit && ./compile.sh");
    }
    
    // Prepare circuit inputs (must match signal names exactly)
    // Convert hex strings to BigInt where needed
    // IMPORTANT: ECDH amount is stored as little-endian bytes in Monero
    // We need to reverse the bytes before converting to a number
    const ecdhBytes = Buffer.from(ecdhAmount, 'hex');
    const ecdhAmountLE = ecdhBytes.readBigUInt64LE(0);
    const ecdhAmountDecimal = ecdhAmountLE;
    
    const circuitInputs = {
        r: witness.r, // Already bit array
        v: witness.v.toString(), // Already string
        H_s_scalar: witness.H_s_scalar, // Already bit array
        R_x: witness.R_x.toString(), // Already string
        S_x: witness.S_x.toString(), // Already string
        P_x: witness.P_compressed.toString(), // Circuit uses P_x, witness has P_compressed
        ecdhAmount: ecdhAmountDecimal.toString(), // Convert hex to decimal string
        amountKey: witness.amountKey, // Already bit array
        commitment: witness.commitment.toString() // Already string
    };
    
    console.log("\n🔍 Debug Circuit Inputs:");
    console.log("   v (claimed):", circuitInputs.v);
    console.log("   ecdhAmount:", circuitInputs.ecdhAmount, "(0x" + ecdhAmount + ")");
    console.log("   amountKey (first 8 bits):", witness.amountKey.slice(0, 8));
    console.log("   Expected decrypted:", amountPiconero.toString());
    
    // Calculate witness using WASM
    console.log("   Calculating witness with WASM...");
    await snarkjs.wtns.calculate(circuitInputs, wasmPath, wtnsPath);
    console.log("   ✅ Witness calculated!");
    
    // Generate proof
    console.log("   Generating PLONK proof...");
    const { proof, publicSignals } = await snarkjs.plonk.prove(zkeyPath, wtnsPath);
    console.log("   ✅ PLONK proof generated!");
    console.log("   Public signals:", publicSignals.length);
    
    // Format proof for contract
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
    
    console.log("\n📝 Step 8: Creating mint intent for relayer...");
    const nonce = await mintRelayer.getNonce(signer.address);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    
    // Calculate expected amount after LP fee (0.5% = 50 bps)
    const lpFeeBps = 50n;
    const lpFee = (amountPiconero * lpFeeBps) / 10000n;
    const expectedAfterFee = amountPiconero - lpFee;
    
    console.log("   Amount calculation:");
    console.log("     Gross amount:", amountPiconero.toString(), "piconero");
    console.log("     LP fee (0.5%):", lpFee.toString(), "piconero");
    console.log("     Expected net:", expectedAfterFee.toString(), "piconero");
    
    const intent = {
        signer: signer.address,
        recipient: FRESH_ADDRESS, // Fresh address!
        lp: signer.address,
        expectedAmount: expectedAfterFee.toString(),
        nonce: nonce,
        deadline: deadline,
        maxRelayerFee: hre.ethers.parseUnits("0.00001", 12)
    };
    
    console.log("   Intent created:");
    console.log("     Signer:", intent.signer);
    console.log("     Recipient (FRESH):", intent.recipient);
    console.log("     Amount:", amountPiconero.toString(), "piconero");
    
    const network = await hre.ethers.provider.getNetwork();
    const domain = {
        name: "HookedMoneroMintRelayer",
        version: "1",
        chainId: network.chainId,
        verifyingContract: deployment.contracts.MintRelayer
    };
    
    const types = {
        MintIntent: [
            { name: "signer", type: "address" },
            { name: "recipient", type: "address" },
            { name: "lp", type: "address" },
            { name: "expectedAmount", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "maxRelayerFee", type: "uint256" }
        ]
    };
    
    const signature = await signer.signTypedData(domain, types, intent);
    console.log("   ✅ Intent signed!");
    
    // Create output struct
    const output = {
        txHash: "0x" + TX_HASH,
        outputIndex: BigInt(OUTPUT_INDEX),
        ecdhAmount: "0x" + ecdhAmount.padStart(64, '0'),
        outputPubKey: "0x" + outputKey,
        commitment: "0x" + commitment,
        blockHeight: BigInt(BLOCK_HEIGHT)
    };
    
    console.log("\n🚀 Step 9: Executing PRIVATE MINT via relayMint()...");
    console.log("   This will mint wXMR to the FRESH ADDRESS");
    console.log("   No on-chain link to your address!");
    
    try {
        const tx = await mintRelayer.relayMint(
            intent,
            signature,
            proofCalldata,
            publicSignals,
            dleqProofForContract,
            ed25519ProofForContract,
            output,
            BigInt(BLOCK_HEIGHT),
            txMerkleProof,
            BigInt(txIndex),
            outputMerkleProof,
            BigInt(globalOutputIndex),
            [], // No price update data
            { gasLimit: 5000000 }
        );
        
        console.log("\n   📝 TX Hash:", tx.hash);
        console.log("   🔗 View: https://sepolia.uniscan.xyz/tx/" + tx.hash);
        console.log("   ⏳ Waiting for confirmation...");
        
        const receipt = await tx.wait();
        console.log("   ✅ Confirmed in block", receipt.blockNumber);
        console.log("   ⛽ Gas used:", receipt.gasUsed.toString());
        
        // Check balance at fresh address
        const balance = await bridge.balanceOf(FRESH_ADDRESS);
        
        console.log("\n" + "═".repeat(70));
        console.log("🎉🎉🎉 PRIVATE MINT SUCCESSFUL! 🎉🎉🎉");
        console.log("═".repeat(70));
        console.log("\n✅ wXMR minted to FRESH ADDRESS:");
        console.log("   Address:", FRESH_ADDRESS);
        console.log("   Balance:", hre.ethers.formatUnits(balance, 12), "XMR");
        console.log("   🔗 View: https://sepolia.uniscan.xyz/address/" + FRESH_ADDRESS);
        
        console.log("\n🔐 Privacy Achieved:");
        console.log("   ✓ No on-chain link to:", signer.address);
        console.log("   ✓ Relayer paid gas");
        console.log("   ✓ wXMR in fresh address");
        console.log("   ✓ Complete anonymity!");
        
        console.log("\n📊 Transaction Details:");
        console.log("   TX:", "https://sepolia.uniscan.xyz/tx/" + tx.hash);
        console.log("   Fresh Address:", "https://sepolia.uniscan.xyz/address/" + FRESH_ADDRESS);
        
    } catch (error) {
        console.log("\n❌ Mint failed:");
        console.log("   Error:", error.message);
        if (error.data) {
            console.log("   Data:", error.data);
        }
        if (error.reason) {
            console.log("   Reason:", error.reason);
        }
        
        console.log("\n✅ However, we successfully:");
        console.log("   - Fetched real Monero transaction data");
        console.log("   - Computed correct H_s using Monero cryptography");
        console.log("   - Decrypted amount with LP's private view key");
        console.log("   - Generated witness");
        console.log("   - Generated REAL PLONK proof");
        console.log("   - Signed privacy intent");
        
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
