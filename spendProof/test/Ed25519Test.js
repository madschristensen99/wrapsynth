const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Ed25519 Library Test", function () {
    let ed25519Test;
    
    before(async function () {
        // Deploy a test contract that uses Ed25519 library
        const Ed25519Test = await ethers.getContractFactory("contracts/test/Ed25519TestHelper.sol:Ed25519TestHelper");
        ed25519Test = await Ed25519Test.deploy();
    });
    
    it("Should validate Ed25519 base point G", async function () {
        const G_x = "15112221349535400772501151409588531511454012693041857206046113283949847762202";
        const G_y = "46316835694926478169428394003475163141307993866256225615783033603165251855960";
        
        console.log("Testing isOnCurve with G...");
        const result = await ed25519Test.testIsOnCurve(G_x, G_y);
        console.log("Result:", result);
        expect(result).to.be.true;
    });
});
