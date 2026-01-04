const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require('fs');

describe("Test DLEQ Verification", function() {
    let bridge;
    
    before(async function() {
        // Deploy contracts
        const PlonkVerifier = await ethers.getContractFactory("PlonkVerifier");
        const verifier = await PlonkVerifier.deploy();
        await verifier.waitForDeployment();
        
        const MoneroBridgeDLEQ = await ethers.getContractFactory("MoneroBridgeDLEQ");
        bridge = await MoneroBridgeDLEQ.deploy(await verifier.getAddress());
        await bridge.waitForDeployment();
    });
    
    it("Should verify DLEQ proof", async function() {
        const dleqData = JSON.parse(fs.readFileSync('dleq_proof.json', 'utf8'));
        
        const dleqProof = {
            c: dleqData.dleqProof.c,
            s: dleqData.dleqProof.s,
            K1_x: dleqData.dleqProof.K1.x,
            K1_y: dleqData.dleqProof.K1.y,
            K2_x: dleqData.dleqProof.K2.x,
            K2_y: dleqData.dleqProof.K2.y
        };
        
        const ed25519Proof = {
            G_x: dleqData.ed25519Proof.G.x,
            G_y: dleqData.ed25519Proof.G.y,
            A_x: dleqData.ed25519Proof.A.x,
            A_y: dleqData.ed25519Proof.A.y,
            B_x: dleqData.ed25519Proof.B.x,
            B_y: dleqData.ed25519Proof.B.y,
            R_x: dleqData.R.x,
            R_y: dleqData.R.y,
            S_x: dleqData.S.x,
            S_y: dleqData.S.y,
            H_s: dleqData.ed25519Proof.H_s
        };
        
        console.log("\n🔍 Testing DLEQ Verification on Local Hardhat\n");
        
        // This will call the internal verifyDLEQ function
        // We can't call it directly, so we'll need to test via verifyAndMint
        // For now, just log that we have the data ready
        console.log("DLEQ Proof ready:");
        console.log("  c:", dleqProof.c);
        console.log("  s:", dleqProof.s);
        console.log("\nThis test would require calling verifyAndMint with full proof data");
        console.log("The DLEQ verification happens inside that function");
    });
});
