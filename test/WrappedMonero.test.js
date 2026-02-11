const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("WrappedMonero - Comprehensive Test Suite", function () {
    let wrappedMonero;
    let mockVerifier;
    let mockWstETH;
    let mockPyth;
    let owner;
    let lp1;
    let lp2;
    let user1;
    let user2;
    
    const INITIAL_MONERO_BLOCK = 3000000;
    const SAFE_RATIO = 150;
    const LIQUIDATION_THRESHOLD = 120;
    const PICONERO_PER_XMR = ethers.parseUnits("1", 12);
    
    // Mock Pyth price feed IDs
    const XMR_USD_PRICE_ID = "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d";
    const ETH_USD_PRICE_ID = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    
    beforeEach(async function () {
        [owner, lp1, lp2, user1, user2] = await ethers.getSigners();
        
        // Deploy Mock Verifier
        const MockVerifier = await ethers.getContractFactory("MockPlonkVerifier");
        mockVerifier = await MockVerifier.deploy();
        await mockVerifier.waitForDeployment();
        
        // Deploy Mock wstETH
        const MockWstETH = await ethers.getContractFactory("MockWstETH");
        mockWstETH = await MockWstETH.deploy();
        await mockWstETH.waitForDeployment();
        
        // Deploy Mock Pyth
        const MockPyth = await ethers.getContractFactory("MockPyth");
        mockPyth = await MockPyth.deploy();
        await mockPyth.waitForDeployment();
        
        // Set initial prices in Pyth
        // XMR = $150, ETH = $3000
        await mockPyth.setPrice(XMR_USD_PRICE_ID, 150 * 1e8, -8); // $150 with 8 decimals
        await mockPyth.setPrice(ETH_USD_PRICE_ID, 3000 * 1e8, -8); // $3000 with 8 decimals
        
        // Deploy WrappedMonero
        const WrappedMonero = await ethers.getContractFactory("WrappedMonero");
        wrappedMonero = await WrappedMonero.deploy(
            await mockVerifier.getAddress(),
            await mockWstETH.getAddress(),
            await mockPyth.getAddress(),
            INITIAL_MONERO_BLOCK
        );
        await wrappedMonero.waitForDeployment();
        
        // Mint mock wstETH to LPs for testing
        await mockWstETH.mint(lp1.address, ethers.parseEther("100"));
        await mockWstETH.mint(lp2.address, ethers.parseEther("100"));
    });
    
    describe("LP Registration and Deposits", function () {
        it("Should allow LP to register with valid parameters", async function () {
            const mintFeeBps = 100; // 1%
            const burnFeeBps = 100; // 1%
            const intentDepositBps = 50; // 0.5%
            const moneroAddress = "48edfHu7V9Z84YzzMa6fUueoELZ9ZRXq9VetWzYGzKt52XU5xvqgzYnDK9URnRoJMk1j8nLwEVsaSWJ4fhdUyZijBGUicoD";
            const privateViewKey = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            
            await expect(
                wrappedMonero.connect(lp1).registerLP(
                    mintFeeBps,
                    burnFeeBps,
                    intentDepositBps,
                    moneroAddress,
                    privateViewKey,
                    true
                )
            ).to.emit(wrappedMonero, "LPRegistered");
            
            const lpInfo = await wrappedMonero.lpInfo(lp1.address);
            expect(lpInfo.mintFeeBps).to.equal(mintFeeBps);
            expect(lpInfo.burnFeeBps).to.equal(burnFeeBps);
            expect(lpInfo.active).to.equal(true);
        });
        
        it("Should allow LP to deposit collateral", async function () {
            // Register LP first
            await wrappedMonero.connect(lp1).registerLP(
                100, 100, 50,
                "48edfHu7V9Z84YzzMa6fUueoELZ9ZRXq9VetWzYGzKt52XU5xvqgzYnDK9URnRoJMk1j8nLwEVsaSWJ4fhdUyZijBGUicoD",
                "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                true
            );
            
            const depositAmount = ethers.parseEther("10");
            
            // Approve wstETH
            await mockWstETH.connect(lp1).approve(await wrappedMonero.getAddress(), depositAmount);
            
            await expect(
                wrappedMonero.connect(lp1).lpDeposit(depositAmount)
            ).to.emit(wrappedMonero, "LPDeposit")
              .withArgs(lp1.address, depositAmount);
            
            const lpInfo = await wrappedMonero.lpInfo(lp1.address);
            expect(lpInfo.collateralAmount).to.equal(depositAmount);
        });
    });
    
    describe("Oracle Block Posting", function () {
        it("Should allow oracle to post Monero block", async function () {
            const blockHeight = INITIAL_MONERO_BLOCK + 1;
            const blockHash = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
            const txMerkleRoot = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
            const outputMerkleRoot = "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321";
            const timestamp = Math.floor(Date.now() / 1000);
            
            await expect(
                wrappedMonero.connect(owner).postMoneroBlock(
                    blockHeight,
                    blockHash,
                    txMerkleRoot,
                    outputMerkleRoot,
                    timestamp
                )
            ).to.emit(wrappedMonero, "MoneroBlockPosted")
              .withArgs(blockHeight, blockHash, txMerkleRoot, outputMerkleRoot);
            
            const block = await wrappedMonero.moneroBlocks(blockHeight);
            expect(block.blockHash).to.equal(blockHash);
            expect(block.txMerkleRoot).to.equal(txMerkleRoot);
            expect(block.outputMerkleRoot).to.equal(outputMerkleRoot);
        });
    });
    
    console.log("✅ Test suite created successfully!");
});
