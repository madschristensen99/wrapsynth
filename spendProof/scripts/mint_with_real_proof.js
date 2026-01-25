const hre = require('hardhat');
const { ethers } = hre;
const fs = require('fs');
const path = require('path');

async function main() {
    const [deployer] = await ethers.getSigners();
    
    const WRAPPED_MONERO = '0xd53AB9c5789d202Ed45A596719D98a415da950f0';
    const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', WRAPPED_MONERO);
    
    console.log('🎯 MINTING WITH REAL PLONK PROOF\n');
    console.log('Contract:', WRAPPED_MONERO);
    console.log('Minter:', deployer.address);
    console.log();
    
    // Load proof and public signals
    const proof = JSON.parse(fs.readFileSync('proof.json', 'utf8'));
    const publicSignals = JSON.parse(fs.readFileSync('public.json', 'utf8'));
    const fullWitness = JSON.parse(fs.readFileSync('full_witness.json', 'utf8'));
    
    console.log('📦 Loaded Proof Data:');
    console.log('   Amount:', publicSignals[0], 'piconero');
    console.log('   Amount (XMR):', Number(publicSignals[0]) / 1e12);
    console.log();
    
    // Format proof for Solidity (24 elements for PLONK)
    const proofForSolidity = [
        proof.A[0], proof.A[1],
        proof.B[0], proof.B[1],
        proof.C[0], proof.C[1],
        proof.Z[0], proof.Z[1],
        proof.T1[0], proof.T1[1],
        proof.T2[0], proof.T2[1],
        proof.T3[0], proof.T3[1],
        proof.Wxi[0], proof.Wxi[1],
        proof.Wxiw[0], proof.Wxiw[1],
        proof.eval_a, proof.eval_b, proof.eval_c,
        proof.eval_s1, proof.eval_s2, proof.eval_zw
    ];
    
    // DLEQ proof (real data from full_witness.json)
    // Contract expects K1 and K2 as bytes32 (compressed points)
    // For now, use K1.x and K2.x as the compressed representation
    const dleqProof = {
        c: '0x' + BigInt(fullWitness.dleqProof.c).toString(16).padStart(64, '0'),
        s: '0x' + BigInt(fullWitness.dleqProof.s).toString(16).padStart(64, '0'),
        K1: '0x' + BigInt(fullWitness.dleqProof.K1.x).toString(16).padStart(64, '0'),
        K2: '0x' + BigInt(fullWitness.dleqProof.K2.x).toString(16).padStart(64, '0')
    };
    
    // Ed25519 proof (real data from full_witness.json)
    const ed25519Proof = {
        R_x: '0x' + BigInt(fullWitness.ed25519Proof.R_x).toString(16).padStart(64, '0'),
        R_y: '0x' + BigInt(fullWitness.ed25519Proof.R_y).toString(16).padStart(64, '0'),
        S_x: '0x' + BigInt(fullWitness.ed25519Proof.S_x).toString(16).padStart(64, '0'),
        S_y: '0x' + BigInt(fullWitness.ed25519Proof.S_y).toString(16).padStart(64, '0'),
        P_x: '0x' + BigInt(fullWitness.ed25519Proof.P.x).toString(16).padStart(64, '0'),
        P_y: '0x' + BigInt(fullWitness.ed25519Proof.P.y).toString(16).padStart(64, '0'),
        B_x: '0x' + BigInt(fullWitness.ed25519Proof.B.x).toString(16).padStart(64, '0'),
        B_y: '0x' + BigInt(fullWitness.ed25519Proof.B.y).toString(16).padStart(64, '0'),
        G_x: '0x' + BigInt(fullWitness.ed25519Proof.G.x).toString(16).padStart(64, '0'),
        G_y: '0x' + BigInt(fullWitness.ed25519Proof.G.y).toString(16).padStart(64, '0'),
        A_x: '0x' + BigInt(fullWitness.ed25519Proof.A.x).toString(16).padStart(64, '0'),
        A_y: '0x' + BigInt(fullWitness.ed25519Proof.A.y).toString(16).padStart(64, '0')
    };
    
    console.log('🔐 Real Cryptographic Proofs Loaded:');
    console.log('   DLEQ c:', dleqProof.c.substring(0, 18) + '...');
    console.log('   Ed25519 R_x:', ed25519Proof.R_x.substring(0, 18) + '...');
    console.log();
    
    // Monero output data
    const output = {
        txHash: '0x8759425cbf9865243bf5ba75934be23e9acba13711a23d7c23d4770d1689cdd9',
        outputIndex: 0,
        ecdhAmount: '0x0b8732a37789b900'.padEnd(66, '0'), // Pad to 32 bytes (66 chars with 0x)
        outputPubKey: '0xe807d0c53a80e26f9ef2383de767df1d105c69ba34ef00a385720b4f3e66af37',
        commitment: '0x8884ff9c3c236025eef274fc6af2d159d9e8eae28a1db1f3695e836cc9ca72f5',
        blockHeight: 3594966
    };
    
    // Mock Merkle proofs (would need to generate real ones)
    const txMerkleProof = []; // Empty array for now
    const txIndex = 0;
    const outputMerkleProof = []; // Empty array for now
    const outputIndexForProof = 0;
    
    console.log('📝 Transaction Details:');
    console.log('   TX Hash:', output.txHash);
    console.log('   Block:', output.blockHeight);
    console.log('   Output Index:', output.outputIndex);
    console.log('   Commitment:', output.commitment);
    console.log();
    
    // Check block is posted
    const blockData = await wrappedMonero.moneroBlocks(output.blockHeight);
    if (!blockData.exists) {
        console.error('❌ Block not posted by oracle');
        process.exit(1);
    }
    console.log('✅ Block posted by oracle');
    console.log('   TX Merkle Root:', blockData.txMerkleRoot);
    console.log('   Output Merkle Root:', blockData.outputMerkleRoot);
    console.log();
    
    // Check LP info
    const lpInfo = await wrappedMonero.lpInfo(deployer.address);
    console.log('💎 LP Info:');
    console.log('   Collateral Shares:', lpInfo.collateralShares.toString());
    console.log('   Backed Amount:', ethers.formatUnits(lpInfo.backedAmount, 12), 'zeroXMR');
    console.log('   Active:', lpInfo.active);
    console.log();
    
    console.log('🚀 Calling mint()...');
    console.log('   This will verify the PLONK proof on-chain!');
    console.log();
    
    try {
        // Try to estimate gas first to get better error message
        try {
            await wrappedMonero.mint.estimateGas(
            proofForSolidity,
            publicSignals,
            dleqProof,
            ed25519Proof,
            output,
            output.blockHeight,
            txMerkleProof,
            txIndex,
            outputMerkleProof,
            outputIndexForProof,
            deployer.address, // recipient
            deployer.address, // LP
            [] // priceUpdateData (empty for now)
            );
            console.log('   ✅ Gas estimation successful');
        } catch (gasError) {
            console.log('   ❌ Gas estimation failed:', gasError.message);
            if (gasError.data) {
                console.log('   Revert data:', gasError.data);
            }
            throw gasError;
        }
        
        const tx = await wrappedMonero.mint(
            proofForSolidity,
            publicSignals,
            dleqProof,
            ed25519Proof,
            output,
            output.blockHeight,
            txMerkleProof,
            txIndex,
            outputMerkleProof,
            outputIndexForProof,
            deployer.address, // recipient
            deployer.address, // LP
            [] // priceUpdateData (empty for now)
        );
        
        console.log('   TX submitted:', tx.hash);
        console.log('   Waiting for confirmation...');
        
        const receipt = await tx.wait();
        
        console.log('\n🎉 MINT SUCCESSFUL!');
        console.log('   Gas used:', receipt.gasUsed.toString());
        console.log('   Block:', receipt.blockNumber);
        console.log();
        
        // Check balance
        const balance = await wrappedMonero.balanceOf(deployer.address);
        console.log('💰 Your zeroXMR Balance:', ethers.formatUnits(balance, 12), 'zeroXMR');
        
        // Check LP backed amount
        const updatedLpInfo = await wrappedMonero.lpInfo(deployer.address);
        console.log('💎 Updated LP Backed Amount:', ethers.formatUnits(updatedLpInfo.backedAmount, 12), 'zeroXMR');
        
        console.log('\n✅ REAL MONERO → ZEROXMR MINT COMPLETE!');
        
    } catch (error) {
        console.log('\n❌ Mint failed:', error.message);
        
        if (error.message.includes('PLONK')) {
            console.log('\n   Issue with PLONK verification');
        } else if (error.message.includes('Merkle')) {
            console.log('\n   Issue with Merkle proof (expected - we used empty proofs)');
        } else if (error.message.includes('Output already used')) {
            console.log('\n   Output already minted!');
        }
        
        console.log('\n   Full error:', error);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
