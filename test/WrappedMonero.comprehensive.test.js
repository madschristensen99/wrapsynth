const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("WrappedMonero - Comprehensive Test Suite", function () {
    // Test fixture for deployment
    async function deployFixture() {
        const [owner, lp1, lp2, user1, user2] = await ethers.getSigners();
        
        const INITIAL_MONERO_BLOCK = 3000000;
        const XMR_USD_PRICE_ID = "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d";
        const ETH_USD_PRICE_ID = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
        
        // Deploy mocks
        const MockVerifier = await ethers.getContractFactory("MockPlonkVerifier");
        const mockVerifier = await MockVerifier.deploy();
        
        const MockWstETH = await ethers.getContractFactory("MockWstETH");
        const mockWstETH = await MockWstETH.deploy();
        
        const MockPyth = await ethers.getContractFactory("MockPyth");
        const mockPyth = await MockPyth.deploy();
        
        // Set initial prices: XMR = $150, ETH = $3000
        await mockPyth.setPrice(XMR_USD_PRICE_ID, 150 * 1e8, -8);
        await mockPyth.setPrice(ETH_USD_PRICE_ID, 3000 * 1e8, -8);
        
        // Deploy WrappedMonero
        const WrappedMonero = await ethers.getContractFactory("WrappedMonero");
        const wrappedMonero = await WrappedMonero.deploy(
            await mockVerifier.getAddress(),
            await mockWstETH.getAddress(),
            await mockPyth.getAddress(),
            INITIAL_MONERO_BLOCK
        );
        
        // Deposit ETH to get wstETH for LPs
        await mockWstETH.connect(lp1).deposit({ value: ethers.parseEther("100") });
        await mockWstETH.connect(lp2).deposit({ value: ethers.parseEther("100") });
        
        return {
            wrappedMonero,
            mockVerifier,
            mockWstETH,
            mockPyth,
            owner,
            lp1,
            lp2,
            user1,
            user2,
            INITIAL_MONERO_BLOCK,
            XMR_USD_PRICE_ID,
            ETH_USD_PRICE_ID
        };
    }
    
    describe("1. LP Registration and Deposit", function () {
        it("Should register LP and deposit collateral", async function () {
            const { wrappedMonero, mockWstETH, lp1 } = await loadFixture(deployFixture);
            
            // Register LP
            await wrappedMonero.connect(lp1).registerLP(
                100, // 1% mint fee
                100, // 1% burn fee
                50,  // 0.5% intent deposit
                "48edfHu7V9Z84YzzMa6fUueoELZ9ZRXq9VetWzYGzKt52XU5xvqgzYnDK9URnRoJMk1j8nLwEVsaSWJ4fhdUyZijBGUicoD",
                "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                true
            );
            
            // Deposit collateral
            const depositAmount = ethers.parseEther("10");
            await mockWstETH.connect(lp1).approve(await wrappedMonero.getAddress(), depositAmount);
            await wrappedMonero.connect(lp1).lpDepositWstETH(depositAmount);
            
            const lpInfo = await wrappedMonero.lpInfo(lp1.address);
            expect(lpInfo.collateralAmount).to.equal(depositAmount);
            expect(lpInfo.active).to.equal(true);
            
            console.log("    ✅ LP registered and deposited", ethers.formatEther(depositAmount), "wstETH");
        });
    });
    
    describe("2. Oracle Posts Monero Block", function () {
        it("Should post a Monero block with merkle roots", async function () {
            const { wrappedMonero, owner, INITIAL_MONERO_BLOCK } = await loadFixture(deployFixture);
            
            const blockHeight = INITIAL_MONERO_BLOCK + 1;
            const blockHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const txMerkleRoot = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
            const outputMerkleRoot = "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";
            
            await wrappedMonero.connect(owner).postMoneroBlock(
                blockHeight,
                blockHash,
                txMerkleRoot,
                outputMerkleRoot
            );
            
            const block = await wrappedMonero.moneroBlocks(blockHeight);
            expect(block.blockHash).to.equal(blockHash);
            expect(block.txMerkleRoot).to.equal(txMerkleRoot);
            expect(block.outputMerkleRoot).to.equal(outputMerkleRoot);
            
            console.log("    ✅ Block", blockHeight, "posted with merkle roots");
        });
    });
    
    describe("3. Mint Flow - Valid Transaction", function () {
        it("Should successfully mint with valid proof", async function () {
            const { wrappedMonero, mockWstETH, mockVerifier, owner, lp1, user1, INITIAL_MONERO_BLOCK } = await loadFixture(deployFixture);
            
            // Setup LP
            await wrappedMonero.connect(lp1).registerLP(
                100, 100, 50,
                "48edfHu7V9Z84YzzMa6fUueoELZ9ZRXq9VetWzYGzKt52XU5xvqgzYnDK9URnRoJMk1j8nLwEVsaSWJ4fhdUyZijBGUicoD",
                "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                true
            );
            const depositAmount = ethers.parseEther("10");
            await mockWstETH.connect(lp1).approve(await wrappedMonero.getAddress(), depositAmount);
            await wrappedMonero.connect(lp1).lpDepositWstETH(depositAmount);
            
            // Post block
            const blockHeight = INITIAL_MONERO_BLOCK + 1;
            await wrappedMonero.connect(owner).postMoneroBlock(
                blockHeight,
                "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
                "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
            );
            
            // Create mint intent
            const expectedAmount = ethers.parseUnits("100", 12); // 100 XMR to meet 1% minimum // 1 XMR
            // Calculate deposit: 0.5% of expected amount in ETH value
            // XMR price = $150, ETH price = $3000, so 1 XMR = 0.05 ETH
            // For 1 XMR: 0.05 ETH * 0.5% = 0.00025 ETH
            const depositRequired = ethers.parseEther("1"); // Using 0.1% for simplicity
            await wrappedMonero.connect(user1).createMintIntent(lp1.address, expectedAmount, { value: depositRequired });
            
            // Prepare mock proof data
            const proof = "0x" + "00".repeat(768);
            // Public signals must be BigInt values for the circuit
            const publicSignals = Array(70).fill(0n);
            const dleqProof = {
                c: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                s: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
                K1: "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
                K2: "0x1111111111111111111111111111111111111111111111111111111111111111"
            };
            const ed25519Proof = {
                R_x: "0x2222222222222222222222222222222222222222222222222222222222222222",
                R_y: "0x3333333333333333333333333333333333333333333333333333333333333333",
                S_x: "0x4444444444444444444444444444444444444444444444444444444444444444",
                S_y: "0x5555555555555555555555555555555555555555555555555555555555555555",
                P_x: "0x6666666666666666666666666666666666666666666666666666666666666666",
                P_y: "0x7777777777777777777777777777777777777777777777777777777777777777",
                B_x: "0x8888888888888888888888888888888888888888888888888888888888888888",
                B_y: "0x9999999999999999999999999999999999999999999999999999999999999999",
                G_x: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                G_y: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                A_x: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                A_y: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
            };
            const output = {
                txHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                outputIndex: 0,
                ecdhAmount: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                outputPubKey: "0x1010101010101010101010101010101010101010101010101010101010101010",
                commitment: "0x2020202020202020202020202020202020202020202020202020202020202020",
                blockHeight: blockHeight
            };
            
            // Mint
            await wrappedMonero.connect(user1).mint(
                proof, publicSignals, dleqProof, ed25519Proof, output,
                blockHeight,
                ["0x3030303030303030303030303030303030303030303030303030303030303030"],
                0,
                ["0x4040404040404040404040404040404040404040404040404040404040404040"],
                0,
                user1.address, lp1.address,
                "0x5050505050505050505050505050505050505050505050505050505050505050",
                []
            );
            
            const balance = await wrappedMonero.balanceOf(user1.address);
            expect(balance).to.be.gt(0);
            
            console.log("    ✅ Minted", ethers.formatUnits(balance, 12), "XMR to user");
        });
    });
    
    describe("4. Invalid Proof Variants - Should Reject", function () {
        it("Should reject mint with wrong block height", async function () {
            const { wrappedMonero, mockWstETH, owner, lp1, user1, INITIAL_MONERO_BLOCK } = await loadFixture(deployFixture);
            
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
                "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
            );
            
            const expectedAmount = ethers.parseUnits("100", 12); // 100 XMR to meet 1% minimum
            // Calculate deposit: 0.5% of expected amount in ETH value
            // XMR price = $150, ETH price = $3000, so 1 XMR = 0.05 ETH
            // For 1 XMR: 0.05 ETH * 0.5% = 0.00025 ETH
            const depositRequired = ethers.parseEther("1"); // Using 0.1% for simplicity
            await wrappedMonero.connect(user1).createMintIntent(lp1.address, expectedAmount, { value: depositRequired });
            
            const proof = "0x" + "00".repeat(768);
            const publicSignals = Array(70).fill(0n);
            const dleqProof = {
                c: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                s: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
                K1: "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
                K2: "0x1111111111111111111111111111111111111111111111111111111111111111"
            };
            const ed25519Proof = {
                R_x: "0x2222222222222222222222222222222222222222222222222222222222222222",
                R_y: "0x3333333333333333333333333333333333333333333333333333333333333333",
                S_x: "0x4444444444444444444444444444444444444444444444444444444444444444",
                S_y: "0x5555555555555555555555555555555555555555555555555555555555555555",
                P_x: "0x6666666666666666666666666666666666666666666666666666666666666666",
                P_y: "0x7777777777777777777777777777777777777777777777777777777777777777",
                B_x: "0x8888888888888888888888888888888888888888888888888888888888888888",
                B_y: "0x9999999999999999999999999999999999999999999999999999999999999999",
                G_x: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                G_y: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                A_x: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                A_y: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
            };
            const output = {
                txHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                outputIndex: 0,
                ecdhAmount: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                outputPubKey: "0x1010101010101010101010101010101010101010101010101010101010101010",
                commitment: "0x2020202020202020202020202020202020202020202020202020202020202020",
                blockHeight: INITIAL_MONERO_BLOCK + 999 // Wrong block!
            };
            
            await expect(
                wrappedMonero.connect(user1).mint(
                    proof, publicSignals, dleqProof, ed25519Proof, output,
                    INITIAL_MONERO_BLOCK + 999, // Wrong block!
                    ["0x3030303030303030303030303030303030303030303030303030303030303030"],
                    0,
                    ["0x4040404040404040404040404040404040404040404040404040404040404040"],
                    0,
                    user1.address, lp1.address,
                    "0x5050505050505050505050505050505050505050505050505050505050505050",
                    []
                )
            ).to.be.revertedWith("Block not posted");
            
            console.log("    ✅ Correctly rejected mint with wrong block height");
        });
        
        it("Should reject mint with already used output (double-spend)", async function () {
            const { wrappedMonero, mockWstETH, owner, lp1, user1, INITIAL_MONERO_BLOCK } = await loadFixture(deployFixture);
            
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
                "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
            );
            
            const expectedAmount = ethers.parseUnits("100", 12); // 100 XMR to meet 1% minimum
            // Calculate deposit: 0.5% of expected amount in ETH value
            // XMR price = $150, ETH price = $3000, so 1 XMR = 0.05 ETH
            // For 1 XMR: 0.05 ETH * 0.5% = 0.00025 ETH
            const depositRequired = ethers.parseEther("1"); // Using 0.1% for simplicity
            await wrappedMonero.connect(user1).createMintIntent(lp1.address, expectedAmount, { value: depositRequired });
            
            const proof = "0x" + "00".repeat(768);
            const publicSignals = Array(70).fill(0n);
            const dleqProof = {
                c: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                s: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
                K1: "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
                K2: "0x1111111111111111111111111111111111111111111111111111111111111111"
            };
            const ed25519Proof = {
                R_x: "0x2222222222222222222222222222222222222222222222222222222222222222",
                R_y: "0x3333333333333333333333333333333333333333333333333333333333333333",
                S_x: "0x4444444444444444444444444444444444444444444444444444444444444444",
                S_y: "0x5555555555555555555555555555555555555555555555555555555555555555",
                P_x: "0x6666666666666666666666666666666666666666666666666666666666666666",
                P_y: "0x7777777777777777777777777777777777777777777777777777777777777777",
                B_x: "0x8888888888888888888888888888888888888888888888888888888888888888",
                B_y: "0x9999999999999999999999999999999999999999999999999999999999999999",
                G_x: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                G_y: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                A_x: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                A_y: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
            };
            const output = {
                txHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                outputIndex: 0,
                ecdhAmount: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                outputPubKey: "0x1010101010101010101010101010101010101010101010101010101010101010",
                commitment: "0x2020202020202020202020202020202020202020202020202020202020202020",
                blockHeight: blockHeight
            };
            
            // First mint - should succeed
            await wrappedMonero.connect(user1).mint(
                proof, publicSignals, dleqProof, ed25519Proof, output,
                blockHeight,
                ["0x3030303030303030303030303030303030303030303030303030303030303030"],
                0,
                ["0x4040404040404040404040404040404040404040404040404040404040404040"],
                0,
                user1.address, lp1.address,
                "0x5050505050505050505050505050505050505050505050505050505050505050",
                []
            );
            
            // Second mint with same output - should fail
            await expect(
                wrappedMonero.connect(user1).mint(
                    proof, publicSignals, dleqProof, ed25519Proof, output,
                    blockHeight,
                    ["0x3030303030303030303030303030303030303030303030303030303030303030"],
                    0,
                    ["0x4040404040404040404040404040404040404040404040404040404040404040"],
                    0,
                    user1.address, lp1.address,
                    "0x5050505050505050505050505050505050505050505050505050505050505050",
                    []
                )
            ).to.be.revertedWith("Output already used");
            
            console.log("    ✅ Correctly rejected double-spend attempt");
        });
    });
    
    describe("5. Burn Flow", function () {
        it("Should allow user to request burn and LP to fulfill", async function () {
            const { wrappedMonero, mockWstETH, owner, lp1, user1, INITIAL_MONERO_BLOCK } = await loadFixture(deployFixture);
            
            // Setup and mint tokens first
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
                "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
            );
            
            // Mint tokens (100 XMR to meet 1% minimum of LP capacity)
            const mintAmount = ethers.parseUnits("100", 12);
            const depositRequired = ethers.parseEther("1"); // Intent deposit
            await wrappedMonero.connect(user1).createMintIntent(lp1.address, mintAmount, { value: depositRequired });
            
            const proof = "0x" + "00".repeat(768);
            const publicSignals = Array(70).fill(0n);
            const dleqProof = {
                c: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                s: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
                K1: "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
                K2: "0x1111111111111111111111111111111111111111111111111111111111111111"
            };
            const ed25519Proof = {
                R_x: "0x2222222222222222222222222222222222222222222222222222222222222222",
                R_y: "0x3333333333333333333333333333333333333333333333333333333333333333",
                S_x: "0x4444444444444444444444444444444444444444444444444444444444444444",
                S_y: "0x5555555555555555555555555555555555555555555555555555555555555555",
                P_x: "0x6666666666666666666666666666666666666666666666666666666666666666",
                P_y: "0x7777777777777777777777777777777777777777777777777777777777777777",
                B_x: "0x8888888888888888888888888888888888888888888888888888888888888888",
                B_y: "0x9999999999999999999999999999999999999999999999999999999999999999",
                G_x: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                G_y: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                A_x: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                A_y: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
            };
            const output = {
                txHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                outputIndex: 0,
                ecdhAmount: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                outputPubKey: "0x1010101010101010101010101010101010101010101010101010101010101010",
                commitment: "0x2020202020202020202020202020202020202020202020202020202020202020",
                blockHeight: blockHeight
            };
            
            await wrappedMonero.connect(user1).mint(
                proof, publicSignals, dleqProof, ed25519Proof, output,
                blockHeight,
                ["0x3030303030303030303030303030303030303030303030303030303030303030"],
                0,
                ["0x4040404040404040404040404040404040404040404040404040404040404040"],
                0,
                user1.address, lp1.address,
                "0x5050505050505050505050505050505050505050505050505050505050505050",
                []
            );
            
            // Request burn
            const burnAmount = ethers.parseUnits("0.5", 12);
            const xmrAddress = "48edfHu7V9Z84YzzMa6fUueoELZ9ZRXq9VetWzYGzKt52XU5xvqgzYnDK9URnRoJMk1j8nLwEVsaSWJ4fhdUyZijBGUicoD";
            const burnDeposit = ethers.parseEther("0.001"); // Anti-griefing deposit
            
            const tx = await wrappedMonero.connect(user1).requestBurn(
                lp1.address,
                burnAmount,
                xmrAddress,
                { value: burnDeposit }
            );
            const receipt = await tx.wait();
            
            // Get burn ID from event
            const event = receipt.logs.find(log => {
                try {
                    return wrappedMonero.interface.parseLog(log).name === "BurnRequested";
                } catch {
                    return false;
                }
            });
            const burnId = wrappedMonero.interface.parseLog(event).args.burnId;
            
            // LP fulfills burn
            const xmrTxHash = "0x9999999999999999999999999999999999999999999999999999999999999999";
            await wrappedMonero.connect(lp1).fulfillBurn(burnId, xmrTxHash);
            
            const burnRequest = await wrappedMonero.burnRequests(burnId);
            expect(burnRequest.fulfilled).to.equal(true);
            
            console.log("    ✅ Burn request fulfilled, XMR sent to user's Monero address");
        });
    });
});
