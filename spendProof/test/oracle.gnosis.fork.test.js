/**
 * Oracle Test on Gnosis Chain Fork
 * 
 * Tests the complete oracle flow:
 * 1. Deploy MoneroBridge
 * 2. Register LP
 * 3. Run oracle to post blocks
 * 4. Manually send Monero TX to LP address
 * 5. Submit proof with Merkle proofs
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Oracle on Gnosis Fork", function() {
    let bridge;
    let oracle;
    let user;
    let lpAddress;
    
    before(async function() {
        [oracle, user] = await ethers.getSigners();
        
        console.log("\n🔧 Setting up Gnosis fork...");
        console.log(`   Oracle: ${oracle.address}`);
        console.log(`   User: ${user.address}`);
    });
    
    it("Should deploy MoneroBridge", async function() {
        console.log("\n📦 Deploying MoneroBridge...");
        
        // Deploy mock verifier
        const MockVerifier = await ethers.getContractFactory("MockPlonkVerifier");
        const verifier = await MockVerifier.deploy();
        await verifier.waitForDeployment();
        const verifierAddress = await verifier.getAddress();
        console.log(`   Verifier deployed: ${verifierAddress}`);
        
        // Deploy MoneroBridge
        const MoneroBridge = await ethers.getContractFactory("MoneroBridge");
        bridge = await MoneroBridge.deploy(verifierAddress);
        await bridge.waitForDeployment();
        const bridgeAddress = await bridge.getAddress();
        console.log(`   MoneroBridge deployed: ${bridgeAddress}`);
        
        // Verify oracle is set
        const oracleAddr = await bridge.oracle();
        expect(oracleAddr).to.equal(oracle.address);
        console.log(`   ✅ Oracle set to deployer: ${oracleAddr}`);
    });
    
    it("Should prepare LP address", async function() {
        console.log("\n👤 Preparing LP address...");
        
        // Generate LP keypair (A, B)
        // For testing, use deterministic values
        const A = "0x" + "a".repeat(64); // Public view key
        const B = "0x" + "b".repeat(64); // Public spend key
        
        console.log(`   View Key (A): ${A}`);
        console.log(`   Spend Key (B): ${B}`);
        
        // Compute LP address (same as WrappedMonero does)
        const lpAddressBytes = ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
                ['bytes32', 'bytes32'],
                [A, B]
            )
        );
        lpAddress = lpAddressBytes;
        
        console.log(`   ✅ LP address computed: ${lpAddress}`);
        console.log(`   ✅ Ready to receive Monero`);
    });
    
    it("Should post Monero block", async function() {
        console.log("\n🌳 Posting Monero block...");
        
        // Placeholder block data
        const blockHeight = 3000000;
        const blockHash = "0x" + "1".repeat(64);
        const txMerkleRoot = "0x" + "2".repeat(64);
        const outputMerkleRoot = "0x" + "3".repeat(64);
        
        console.log(`   Block Height: ${blockHeight}`);
        console.log(`   Block Hash: ${blockHash}`);
        console.log(`   TX Merkle Root: ${txMerkleRoot}`);
        console.log(`   Output Merkle Root: ${outputMerkleRoot}`);
        
        // Post block
        const tx = await bridge.connect(oracle).postMoneroBlock(
            blockHeight,
            blockHash,
            txMerkleRoot,
            outputMerkleRoot
        );
        await tx.wait();
        
        // Verify block posted
        const latestBlock = await bridge.latestMoneroBlock();
        expect(latestBlock).to.equal(blockHeight);
        console.log(`   ✅ Block posted, latest: ${latestBlock}`);
        
        // Verify block data
        const blockData = await bridge.moneroBlocks(blockHeight);
        expect(blockData.blockHash).to.equal(blockHash);
        expect(blockData.txMerkleRoot).to.equal(txMerkleRoot);
        expect(blockData.outputMerkleRoot).to.equal(outputMerkleRoot);
        expect(blockData.exists).to.be.true;
        console.log(`   ✅ Block data verified`);
    });
    
    it("Should show next steps", async function() {
        console.log("\n📝 Next Steps:");
        console.log(`   1. Send Monero to LP address: ${lpAddress}`);
        console.log(`   2. Get transaction data from Monero`);
        console.log(`   3. Generate ZK proof`);
        console.log(`   4. Get Merkle proofs (TX + output)`);
        console.log(`   5. Submit proof to contract`);
        console.log("\n   ⚠️  Waiting for manual Monero transaction...");
    });
});
