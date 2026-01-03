const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require('fs');

describe("Debug DLEQ On-Chain", function() {
    let debug;
    
    before(async function() {
        const Ed25519Debug = await ethers.getContractFactory("Ed25519Debug");
        debug = await Ed25519Debug.deploy();
        await debug.waitForDeployment();
    });
    
    it("Should debug DLEQ verification step by step", async function() {
        const dleqData = JSON.parse(fs.readFileSync('dleq_proof.json', 'utf8'));
        
        console.log("\n🔍 Testing DLEQ Verification Step by Step\n");
        
        const tx = await debug.testDLEQ(
            dleqData.ed25519Proof.G.x,
            dleqData.ed25519Proof.G.y,
            dleqData.ed25519Proof.A.x,
            dleqData.ed25519Proof.A.y,
            dleqData.R.x,
            dleqData.R.y,
            dleqData.rA.x,
            dleqData.rA.y,
            dleqData.dleqProof.c,
            dleqData.dleqProof.s,
            dleqData.dleqProof.K1.x,
            dleqData.dleqProof.K1.y,
            dleqData.dleqProof.K2.x,
            dleqData.dleqProof.K2.y
        );
        
        const receipt = await tx.wait();
        
        console.log("\nEvents emitted:");
        for (const event of receipt.logs) {
            try {
                const parsed = debug.interface.parseLog(event);
                if (parsed) {
                    if (parsed.name === 'DebugPoint') {
                        console.log(`  ${parsed.args[0]}: (${parsed.args[1].toString()}, ${parsed.args[2].toString()})`);
                    } else if (parsed.name === 'DebugScalar') {
                        console.log(`  ${parsed.args[0]}: ${parsed.args[1].toString()}`);
                    } else if (parsed.name === 'DebugBool') {
                        console.log(`  ${parsed.args[0]}: ${parsed.args[1]}`);
                    }
                }
            } catch (e) {
                // Skip unparseable events
            }
        }
    });
});
