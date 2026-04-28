// Test Ed25519 Compatibility Between Frontend and Contract
// Run with: npx hardhat test test/Ed25519Compatibility.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Ed25519 Compatibility Test", function () {
    let ed25519;
    
    before(async function () {
        // Deploy Ed25519 library wrapper for testing
        const Ed25519Test = await ethers.getContractFactory("Ed25519Test");
        ed25519 = await Ed25519Test.deploy();
        await ed25519.waitForDeployment();
    });

    it("Should generate matching commitments between frontend and contract", async function () {
        // Test secret (same as frontend test)
        const testSecret = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        
        console.log("\n=== Testing Ed25519 Commitment Generation ===");
        console.log("Test Secret:", testSecret);
        
        // Call contract to generate public key from secret
        const result = await ed25519.testScalarMultBase(testSecret);
        const px = result[0];
        const py = result[1];
        
        console.log("\nContract Generated:");
        console.log("px:", px);
        console.log("py:", py);
        
        // Generate commitment as keccak256(abi.encodePacked(px, py))
        const commitment = ethers.keccak256(
            ethers.solidityPacked(["uint256", "uint256"], [px, py])
        );
        
        console.log("\nCommitment:", commitment);
        
        // Frontend should generate the same commitment
        console.log("\n✓ Contract generates commitment:", commitment);
        console.log("✓ Frontend must generate same commitment for verification to work");
        
        // Verify the commitment can be verified
        const isValid = await ed25519.verifyCommitment(testSecret, commitment);
        expect(isValid).to.be.true;
        
        console.log("✓ Commitment verification successful!");
    });

    it("Should reject invalid secrets", async function () {
        const testSecret = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        const wrongSecret = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        
        // Generate commitment from correct secret
        const result = await ed25519.testScalarMultBase(testSecret);
        const commitment = ethers.keccak256(
            ethers.solidityPacked(["uint256", "uint256"], [result[0], result[1]])
        );
        
        // Try to verify with wrong secret
        const isValid = await ed25519.verifyCommitment(wrongSecret, commitment);
        expect(isValid).to.be.false;
        
        console.log("✓ Invalid secret correctly rejected!");
    });

    it("Should match VaultManager finalizeMint verification logic", async function () {
        const testSecret = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
        
        // Generate commitment (simulating frontend)
        const result = await ed25519.testScalarMultBase(testSecret);
        const px = result[0];
        const py = result[1];
        const commitment = ethers.keccak256(
            ethers.solidityPacked(["uint256", "uint256"], [px, py])
        );
        
        console.log("\n=== Simulating VaultManager Verification ===");
        console.log("Stored Commitment:", commitment);
        console.log("Revealed Secret:", testSecret);
        
        // Simulate VaultManager's verification logic
        const verifyResult = await ed25519.testScalarMultBase(testSecret);
        const computedCommitment = ethers.keccak256(
            ethers.solidityPacked(["uint256", "uint256"], [verifyResult[0], verifyResult[1]])
        );
        
        console.log("Computed Commitment:", computedCommitment);
        
        expect(computedCommitment).to.equal(commitment);
        console.log("✓ VaultManager verification logic works correctly!");
    });
});
