const hre = require('hardhat');
const { ethers } = hre;
const axios = require('axios');
const fs = require('fs');

async function main() {
    const [deployer] = await ethers.getSigners();
    
    const WRAPPED_MONERO = '0xe1B76b604F12Fd20b8D490C4C1f0634521626B0B';
    const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', WRAPPED_MONERO);
    
    // XMR/USD price feed ID on Pyth
    const XMR_USD_PRICE_ID = '0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d';
    
    console.log('🎯 UPDATE PYTH PRICE AND MINT\n');
    console.log('Contract:', WRAPPED_MONERO);
    console.log('Deployer:', deployer.address);
    console.log();
    
    // Step 1: Fetch Pyth price update data
    console.log('📡 Step 1: Fetching Pyth price data for XMR/USD...');
    
    const PYTH_ENDPOINT = 'https://hermes.pyth.network/v2/updates/price/latest';
    
    try {
        const response = await axios.get(PYTH_ENDPOINT, {
            params: {
                ids: [XMR_USD_PRICE_ID],
                encoding: 'hex'
            }
        });
        
        if (!response.data || !response.data.binary || !response.data.binary.data) {
            throw new Error('Invalid response from Pyth');
        }
        
        const priceUpdateData = ['0x' + response.data.binary.data[0]];
        console.log('✅ Pyth price data fetched');
        console.log('   Update data length:', priceUpdateData[0].length, 'chars');
        console.log();
        
        // Step 2: Update price on contract
        console.log('📝 Step 2: Updating price on contract...');
        
        // Get Pyth contract address
        const pythAddress = await wrappedMonero.pyth();
        const pyth = await ethers.getContractAt('IPyth', pythAddress);
        
        const updateFee = await pyth.getUpdateFee(priceUpdateData);
        console.log('   Update fee:', ethers.formatEther(updateFee), 'xDAI');
        
        const updateTx = await wrappedMonero.updatePythPrice(priceUpdateData, {
            value: updateFee
        });
        await updateTx.wait();
        console.log('✅ Price updated!');
        console.log();
        
        // Step 3: Load proof data
        console.log('📦 Step 3: Loading proof data...');
        const proof = JSON.parse(fs.readFileSync('proof.json', 'utf8'));
        const publicSignals = JSON.parse(fs.readFileSync('public.json', 'utf8'));
        const fullWitness = JSON.parse(fs.readFileSync('full_witness.json', 'utf8'));
        
        console.log('   Amount:', publicSignals[0], 'piconero');
        console.log('   Amount (XMR):', Number(publicSignals[0]) / 1e12);
        console.log();
        
        // Format proof for Solidity
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
        
        // DLEQ proof
        const dleqProof = {
            c: '0x' + BigInt(fullWitness.dleqProof.c).toString(16).padStart(64, '0'),
            s: '0x' + BigInt(fullWitness.dleqProof.s).toString(16).padStart(64, '0'),
            K1: '0x' + BigInt(fullWitness.dleqProof.K1.x).toString(16).padStart(64, '0'),
            K2: '0x' + BigInt(fullWitness.dleqProof.K2.x).toString(16).padStart(64, '0')
        };
        
        // Ed25519 proof
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
        
        // Load Merkle proofs first to get correct output index
        const merkleProofs = JSON.parse(fs.readFileSync('merkle_proofs.json', 'utf8'));
        
        // Monero output
        const output = {
            txHash: '0x73155c18b4b6a820ace7a77973ae1004bb8b1b8c0c8a96c9c7a6957309f14d79',
            outputIndex: 0, // Index within the transaction
            ecdhAmount: '0x3b475922544ca95e'.padEnd(66, '0'),
            outputPubKey: '0x10cc8ed1b28bb8ab053b9d7070e38834515bb464223b1be4a7aa6d8f80957c9c',
            commitment: '0xcd845e8d0642e639b02225abd06377ff96574e0bdf50fd1db1d2aafb4f824c11',
            blockHeight: 3595150
        };
        
        // Merkle proofs already loaded above
        const txMerkleProof = merkleProofs.txMerkleProof;
        const txIndex = merkleProofs.txIndex;
        const outputMerkleProof = merkleProofs.outputMerkleProof;
        const outputIndexForProof = merkleProofs.outputIndex;
        
        console.log('🌳 Merkle Proofs Loaded:');
        console.log('   TX Index:', txIndex);
        console.log('   TX Proof siblings:', txMerkleProof.length);
        console.log('   Output Proof siblings:', outputMerkleProof.length);
        console.log();
        
        console.log('🚀 Step 4: Minting with real PLONK proof...');
        console.log('   TX Hash:', output.txHash);
        console.log('   Block:', output.blockHeight);
        console.log('   Amount:', Number(publicSignals[0]) / 1e12, 'XMR');
        console.log();
        
        // Get Pyth update fee for mint call
        const mintPythFee = await pyth.getUpdateFee(priceUpdateData);
        
        const mintTx = await wrappedMonero.mint(
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
            deployer.address,
            deployer.address,
            priceUpdateData,
            { value: mintPythFee }
        );
        
        console.log('   TX submitted:', mintTx.hash);
        console.log('   Waiting for confirmation...');
        
        const receipt = await mintTx.wait();
        
        console.log('\n🎉🎉🎉 MINT SUCCESSFUL! 🎉🎉🎉');
        console.log('   Gas used:', receipt.gasUsed.toString());
        console.log('   Block:', receipt.blockNumber);
        console.log();
        
        // Check balance
        const balance = await wrappedMonero.balanceOf(deployer.address);
        console.log('💰 Your zeroXMR Balance:', ethers.formatUnits(balance, 12), 'zeroXMR');
        
        // Check LP backed amount
        const lpInfo = await wrappedMonero.lpInfo(deployer.address);
        console.log('💎 LP Backed Amount:', ethers.formatUnits(lpInfo.backedAmount, 12), 'zeroXMR');
        
        console.log('\n✅ REAL MONERO → ZEROXMR BRIDGE COMPLETE!');
        console.log('   Real Monero TX → Real PLONK Proof → Real zeroXMR Tokens');
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        if (error.response) {
            console.error('   API Error:', error.response.status, error.response.statusText);
        }
        if (error.data) {
            console.error('   Revert data:', error.data);
        }
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
