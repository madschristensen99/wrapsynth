const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { generateRealProof, generateTestTxData } = require("./helpers/proofGenerator");

describe("WrappedMonero - Real ZK Proofs Test Suite", function () {
    // Increase timeout for proof generation
    this.timeout(60000); // 60 seconds
    
    async function deployFixture() {
        const [owner, lp1, user1] = await ethers.getSigners();
        
        const INITIAL_MONERO_BLOCK = 3000000;
        const XMR_USD_PRICE_ID = "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d";
        const ETH_USD_PRICE_ID = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
        
        // Deploy REAL PlonkVerifier (not mock!)
        console.log("    📦 Deploying real PlonkVerifier contract...");
        const PlonkVerifier = await ethers.getContractFactory("PlonkVerifier");
        const verifier = await PlonkVerifier.deploy();
        console.log("    ✅ Real PlonkVerifier deployed");
        
        // Deploy Mock wstETH and Pyth
        const MockWstETH = await ethers.getContractFactory("MockWstETH");
        const mockWstETH = await MockWstETH.deploy();
        
        const MockPyth = await ethers.getContractFactory("MockPyth");
        const mockPyth = await MockPyth.deploy();
        
        // Set prices
        await mockPyth.setPrice(XMR_USD_PRICE_ID, 150 * 1e8, -8);
        await mockPyth.setPrice(ETH_USD_PRICE_ID, 3000 * 1e8, -8);
        
        // Deploy WrappedMonero with REAL verifier
        const WrappedMonero = await ethers.getContractFactory("WrappedMonero");
        const wrappedMonero = await WrappedMonero.deploy(
            await verifier.getAddress(),
            await mockWstETH.getAddress(),
            await mockPyth.getAddress(),
            INITIAL_MONERO_BLOCK
        );
        
        // Fund LPs
        await mockWstETH.connect(lp1).deposit({ value: ethers.parseEther("100") });
        
        return {
            wrappedMonero,
            verifier,
            mockWstETH,
            mockPyth,
            owner,
            lp1,
            user1,
            INITIAL_MONERO_BLOCK
        };
    }
    
    describe("Real ZK Proof Generation and Verification", function () {
        it("Should generate and verify a real ZK proof for mint", async function () {
            const { wrappedMonero, mockWstETH, owner, lp1, user1, INITIAL_MONERO_BLOCK } = await loadFixture(deployFixture);
            
            console.log("\n  🧪 Test: Real ZK Proof Mint Flow");
            
            // Setup LP
            console.log("    1️⃣  Setting up LP...");
            await wrappedMonero.connect(lp1).registerLP(
                100, 100, 50,
                "48edfHu7V9Z84YzzMa6fUueoELZ9ZRXq9VetWzYGzKt52XU5xvqgzYnDK9URnRoJMk1j8nLwEVsaSWJ4fhdUyZijBGUicoD",
                "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                true
            );
            
            const depositAmount = ethers.parseEther("10");
            await mockWstETH.connect(lp1).approve(await wrappedMonero.getAddress(), depositAmount);
            await wrappedMonero.connect(lp1).lpDepositWstETH(depositAmount);
            console.log("    ✅ LP registered with 10 wstETH collateral");
            
            // Post Monero block
            console.log("    2️⃣  Posting Monero block...");
            const blockHeight = INITIAL_MONERO_BLOCK + 1;
            await wrappedMonero.connect(owner).postMoneroBlock(
                blockHeight,
                "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
                "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321"
            );
            console.log("    ✅ Block posted");
            
            // Create mint intent
            console.log("    3️⃣  Creating mint intent...");
            const expectedAmount = ethers.parseUnits("100", 12); // 100 XMR
            const depositRequired = ethers.parseEther("1");
            await wrappedMonero.connect(user1).createMintIntent(lp1.address, expectedAmount, { value: depositRequired });
            console.log("    ✅ Mint intent created");
            
            // Generate REAL ZK proof
            console.log("    4️⃣  Generating REAL ZK proof...");
            const txData = generateTestTxData();
            txData.blockHeight = blockHeight;
            
            const { proof, publicSignals, dleqProof, ed25519Proof } = await generateRealProof(txData);
            
            // Prepare proof data for contract
            const output = {
                txHash: txData.txHash,
                outputIndex: txData.outputIndex,
                ecdhAmount: txData.ecdhAmount,
                outputPubKey: txData.outputPubKey,
                commitment: txData.commitment,
                blockHeight: blockHeight
            };
            
            const txMerkleProof = ["0x3030303030303030303030303030303030303030303030303030303030303030"];
            const outputMerkleProof = ["0x4040404040404040404040404040404040404040404040404040404040404040"];
            const txPublicKey = "0x5050505050505050505050505050505050505050505050505050505050505050";
            
            // Mint with REAL proof
            console.log("    5️⃣  Minting with real ZK proof...");
            await wrappedMonero.connect(user1).mint(
                proof,
                publicSignals,
                dleqProof,
                ed25519Proof,
                output,
                blockHeight,
                txMerkleProof,
                0,
                outputMerkleProof,
                0,
                user1.address,
                lp1.address,
                txPublicKey,
                []
            );
            
            const balance = await wrappedMonero.balanceOf(user1.address);
            expect(balance).to.be.gt(0);
            
            console.log(`    ✅ Successfully minted ${ethers.formatUnits(balance, 12)} XMR with REAL ZK proof!`);
            console.log("    🎉 Real proof verification PASSED!\n");
        });
        
        it("Should reject invalid ZK proof", async function () {
            const { wrappedMonero, mockWstETH, owner, lp1, user1, INITIAL_MONERO_BLOCK } = await loadFixture(deployFixture);
            
            console.log("\n  🧪 Test: Invalid Proof Rejection");
            
            // Setup
            await wrappedMonero.connect(lp1).registerLP(
                100, 100, 50,
                "48edfHu7V9Z84YzzMa6fUueoELZ9ZRXq9VetWzYGzKt52XU5xvqgzYnDK9URnRoJMk1j8nLwEVsaSWJ4fhdUyZijBGUicoD",
                "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                true
            );
            await mockWstETH.connect(lp1).approve(await wrappedMonero.getAddress(), ethers.parseEther("10"));
            await wrappedMonero.connect(lp1).lpDepositWstETH(ethers.parseEther("10"));
            
            const blockHeight = INITIAL_MONERO_BLOCK + 1;
            await wrappedMonero.connect(owner).postMoneroBlock(
                blockHeight,
                "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
                "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321"
            );
            
            await wrappedMonero.connect(user1).createMintIntent(lp1.address, ethers.parseUnits("100", 12), { value: ethers.parseEther("1") });
            
            // Generate valid proof
            const txData = generateTestTxData();
            txData.blockHeight = blockHeight;
            const { proof, publicSignals, dleqProof, ed25519Proof } = await generateRealProof(txData);
            
            // Tamper with the proof
            const tamperedProof = proof.replace(/00/g, 'FF');
            
            const output = {
                txHash: txData.txHash,
                outputIndex: txData.outputIndex,
                ecdhAmount: txData.ecdhAmount,
                outputPubKey: txData.outputPubKey,
                commitment: txData.commitment,
                blockHeight: blockHeight
            };
            
            // Should reject tampered proof
            console.log("    🔐 Attempting mint with tampered proof...");
            await expect(
                wrappedMonero.connect(user1).mint(
                    tamperedProof,
                    publicSignals,
                    dleqProof,
                    ed25519Proof,
                    output,
                    blockHeight,
                    ["0x3030303030303030303030303030303030303030303030303030303030303030"],
                    0,
                    ["0x4040404040404040404040404040404040404040404040404040404040404040"],
                    0,
                    user1.address,
                    lp1.address,
                    "0x5050505050505050505050505050505050505050505050505050505050505050",
                    []
                )
            ).to.be.reverted;
            
            console.log("    ✅ Tampered proof correctly rejected!\n");
        });
    });
});
