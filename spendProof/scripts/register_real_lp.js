/**
 * Register Real LP Address
 * 
 * Registers the user's real Monero address as LP
 */

const { ethers } = require("hardhat");
const fs = require('fs');
const path = require('path');

async function main() {
    console.log("\n👤 Registering Real LP Address...\n");
    
    // Load deployment info
    const deploymentPath = path.join(__dirname, '../oracle/deployment.json');
    const deploymentInfo = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
    
    // Real Monero address keys
    const realAddress = "77LbMMUieh3CTNvrUP68XDF1ESU1mSszx43eFzrWe3cY7ADTfx7q61uSzKPMydn9Ad7UM3ZBmSPo1JLRwna8pXq3635j7tB";
    const A = "0x04b951042e094305211a6594a988bc183492657cfafba11f22198140faede16e"; // View key
    const B = "0x65a0123071779c0c2870a27e093f8edcd4412a1d223678d437ff4bffa48e5b99"; // Spend key
    
    // Compute LP address
    const lpAddress = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ['bytes32', 'bytes32'],
            [A, B]
        )
    );
    
    console.log(`Monero Address: ${realAddress}`);
    console.log(`View Key (A): ${A}`);
    console.log(`Spend Key (B): ${B}`);
    console.log(`LP Address: ${lpAddress}\n`);
    
    // Save LP info
    const lpInfo = {
        moneroAddress: realAddress,
        viewKey: A,
        spendKey: B,
        lpAddress: lpAddress,
        network: "stagenet"
    };
    
    const lpInfoPath = path.join(__dirname, '../oracle/lp_info.json');
    fs.writeFileSync(lpInfoPath, JSON.stringify(lpInfo, null, 2));
    console.log(`💾 LP info saved to: ${lpInfoPath}\n`);
    
    console.log("✅ LP address ready!");
    console.log("\n📝 Next steps:");
    console.log(`   1. Send Monero to: ${realAddress}`);
    console.log(`   2. Wait for oracle to post the block`);
    console.log(`   3. Submit proof with transaction data\n`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
