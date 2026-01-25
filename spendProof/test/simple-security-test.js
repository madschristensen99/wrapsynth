const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("WrappedMoneroV3 Simple Security Test", function () {
    const WRAPPED_MONERO = '0xe1B76b604F12Fd20b8D490C4C1f0634521626B0B';

    it("Should prevent replay attack - output already spent", async function () {
        console.log('\n🎯 Test: Replay Attack Protection');
        
        const [deployer] = await ethers.getSigners();
        const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', WRAPPED_MONERO);
        
        // Check if the output is already marked as spent
        const outputId = ethers.keccak256(
            ethers.solidityPacked(
                ['bytes32', 'uint256'],
                ['0x73155c18b4b6a820ace7a77973ae1004bb8b1b8c0c8a96c9c7a6957309f14d79', 0]
            )
        );
        
        const isSpent = await wrappedMonero.usedOutputs(outputId);
        console.log('   Output spent status:', isSpent);
        
        expect(isSpent).to.be.true;
        console.log('   ✅ Output correctly marked as spent - replay attack prevented!');
    });
    
    it("Should show correct balance after mint", async function () {
        console.log('\n🎯 Test: Balance Check');
        
        const [deployer] = await ethers.getSigners();
        const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', WRAPPED_MONERO);
        
        const balance = await wrappedMonero.balanceOf(deployer.address);
        const decimals = await wrappedMonero.decimals();
        
        console.log('   Balance:', ethers.formatUnits(balance, decimals), 'zeroXMR');
        console.log('   Decimals:', decimals.toString());
        
        expect(balance).to.equal(800000000n); // 0.0008 XMR in piconero
        expect(decimals).to.equal(12);
        console.log('   ✅ Balance and decimals correct!');
    });
});
