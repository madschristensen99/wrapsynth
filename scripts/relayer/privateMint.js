const { ethers } = require("hardhat");
const { createPrivateMintIntent } = require("./signMintIntent");
const fs = require("fs");

/**
 * Private Mint Flow
 * 
 * This script demonstrates how a user can mint wXMR privately:
 * 1. User sends XMR to LP's Monero address
 * 2. User generates ZK proof of ownership
 * 3. User creates fresh Ethereum address
 * 4. User signs intent with fresh address as recipient
 * 5. User submits intent to relayer
 * 6. Relayer executes mint to fresh address
 * 7. wXMR appears in fresh address (no on-chain link to user)
 */

async function main() {
    console.log("🔐 Private Mint Flow for Hooked Monero\n");

    // Get deployment addresses
    const deploymentPath = "./deployments/localhost/deployment.json";
    if (!fs.existsSync(deploymentPath)) {
        console.error("❌ Deployment file not found. Deploy contracts first.");
        process.exit(1);
    }

    const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    const relayerAddress = deployment.mintRelayer;
    const wrappedMoneroAddress = deployment.wrappedMonero;

    console.log("📋 Contract Addresses:");
    console.log(`   WrappedMonero: ${wrappedMoneroAddress}`);
    console.log(`   MintRelayer: ${relayerAddress}\n`);

    // Get signers
    const [deployer, lp, user] = await ethers.getSigners();
    console.log("👤 User address:", user.address);

    // Get contracts
    const relayerContract = await ethers.getContractAt("MintRelayer", relayerAddress);
    const wrappedMonero = await ethers.getContractAt("WrappedMonero", wrappedMoneroAddress);

    // Example: User wants to mint 1 XMR privately
    const amount = ethers.parseUnits("1", 12); // 1 XMR in piconero
    console.log(`\n💰 Minting ${ethers.formatUnits(amount, 12)} XMR privately\n`);

    // Step 1: Generate fresh recipient address
    console.log("🆕 Step 1: Generating fresh recipient address...");
    const { createPrivateMintIntent: createIntent } = require("./signMintIntent");
    
    const intentData = await createIntent(
        {
            signer: user.address,
            lp: lp.address,
            expectedAmount: amount.toString()
        },
        relayerAddress,
        user
    );

    console.log(`   Fresh address: ${intentData.freshAddress.address}`);
    console.log(`   ⚠️  SAVE THIS PRIVATE KEY: ${intentData.freshAddress.privateKey}`);
    console.log(`   (In production, use a secure key management system)\n`);

    // Step 2: Sign intent
    console.log("✍️  Step 2: Signing mint intent...");
    console.log(`   Signer: ${intentData.intent.signer}`);
    console.log(`   Recipient: ${intentData.intent.recipient}`);
    console.log(`   Nonce: ${intentData.intent.nonce}`);
    console.log(`   Deadline: ${new Date(intentData.intent.deadline * 1000).toISOString()}`);
    console.log(`   Max Relayer Fee: ${ethers.formatUnits(intentData.intent.maxRelayerFee, 12)} XMR\n`);

    // Step 3: Save intent for relayer
    console.log("💾 Step 3: Submitting intent to relayer...");
    
    // In production, this would be submitted to a relayer API
    // For now, we'll save it to the relayer queue file
    const queueFile = "./relayer-queue.json";
    let queue = [];
    if (fs.existsSync(queueFile)) {
        queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    }

    // Note: In a real scenario, proofData would come from generate_proof_and_mint.js
    // For this demo, we'll create a placeholder
    const intentWithProof = {
        intent: intentData.intent,
        signature: intentData.signature,
        proofData: {
            // These would be real proof data from ZK proof generation
            proof: Array(24).fill("0"),
            publicSignals: Array(70).fill("0"),
            dleqProof: {
                c: "0x0000000000000000000000000000000000000000000000000000000000000000",
                s: "0x0000000000000000000000000000000000000000000000000000000000000000"
            },
            ed25519Proof: {
                Ax: "0x0000000000000000000000000000000000000000000000000000000000000000",
                Ay: "0x0000000000000000000000000000000000000000000000000000000000000000"
            },
            output: {
                txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
                outputIndex: 0,
                ecdhAmount: "0x0000000000000000000000000000000000000000000000000000000000000000",
                outputPubKey: "0x0000000000000000000000000000000000000000000000000000000000000000",
                commitment: "0x0000000000000000000000000000000000000000000000000000000000000000"
            },
            blockHeight: 0,
            txMerkleProof: [],
            txIndex: 0,
            outputMerkleProof: [],
            outputIndex: 0,
            priceUpdateData: []
        },
        addedAt: Date.now(),
        status: "pending"
    };

    queue.push(intentWithProof);
    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2));
    
    console.log("✅ Intent submitted to relayer queue\n");

    // Step 4: Display privacy benefits
    console.log("🔐 Privacy Benefits:");
    console.log("   ✓ No on-chain link between user and fresh address");
    console.log("   ✓ Relayer pays gas (user address not revealed)");
    console.log("   ✓ wXMR appears in fresh address");
    console.log("   ✓ User can transfer from fresh address to any destination");
    console.log("   ✓ Monero privacy + Ethereum privacy\n");

    // Step 5: Instructions for next steps
    console.log("📝 Next Steps:");
    console.log("   1. Send XMR to LP's Monero address");
    console.log("   2. Generate ZK proof using generate_proof_and_mint.js");
    console.log("   3. Add proof data to intent in relayer queue");
    console.log("   4. Run relayer service to execute mint");
    console.log("   5. Check fresh address for wXMR tokens\n");

    // Verify signature
    console.log("🔍 Verifying signature...");
    const typedDataHash = await relayerContract.getTypedDataHash(intentData.intent);
    console.log(`   Typed data hash: ${typedDataHash}`);
    
    const recoveredAddress = ethers.verifyMessage(
        ethers.getBytes(typedDataHash),
        intentData.signature
    );
    console.log(`   Signature valid: ${recoveredAddress.toLowerCase() === user.address.toLowerCase()}\n`);

    console.log("✅ Private mint intent created successfully!");
    console.log("\n💡 Tip: Save the fresh address private key securely.");
    console.log("   You'll need it to access your wXMR tokens.\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
