#!/usr/bin/env node

/**
 * Generate Full PLONK Proof from Witness Data
 */

const fs = require('fs');
const path = require('path');
const { generateWitness } = require('./generate_witness.js');
const snarkjs = require('snarkjs');

async function main() {
    console.log('🎯 Generating Full PLONK Proof\n');
    
    // Load witness data
    const witnessDataPath = path.join(__dirname, '../witness_data.json');
    if (!fs.existsSync(witnessDataPath)) {
        console.error('❌ witness_data.json not found. Run fetch_monero_witness.js first.');
        process.exit(1);
    }
    
    const witnessData = JSON.parse(fs.readFileSync(witnessDataPath, 'utf8'));
    console.log('✅ Loaded witness data');
    console.log('   Amount:', witnessData.v, 'piconero');
    console.log();
    
    // The witness data from fetch_monero_witness.js needs to be converted
    // to the format expected by our DLEQ-optimized circuit
    
    // We need to compute:
    // 1. A_compressed and B_compressed (LP keys)
    // 2. S_x (8·r·A compressed)
    // 3. amountKey
    // 4. Poseidon commitment
    
    console.log('🔧 Preparing circuit input...');
    
    // Extract needed values
    const inputData = {
        r: witnessData.r_hex || witnessData.r,
        v: witnessData.v,
        H_s_scalar: witnessData.H_s_scalar_hex || witnessData.H_s_scalar,
        ecdhAmount: witnessData.ecdhAmount,
        A_compressed: witnessData.A_compressed,
        B_compressed: witnessData.B_compressed
    };
    
    console.log('   r:', typeof inputData.r === 'string' ? inputData.r.substring(0, 16) + '...' : inputData.r.length + ' bits');
    console.log('   v:', inputData.v);
    console.log('   H_s_scalar:', typeof inputData.H_s_scalar === 'string' ? inputData.H_s_scalar.substring(0, 16) + '...' : inputData.H_s_scalar.length + ' bits');
    console.log();
    
    // Generate full witness with all required fields
    console.log('🔮 Generating witness with Poseidon commitment...');
    const witness = await generateWitness(inputData);
    
    console.log('✅ Witness generated');
    console.log('   Commitment:', witness.commitment.substring(0, 20) + '...');
    console.log();
    
    // Save circuit input
    const circuitInput = {
        r: witness.r,
        v: witness.v,
        H_s_scalar: witness.H_s_scalar,
        R_x: witness.R_x,
        S_x: witness.S_x,
        P_x: witness.P_x,
        ecdhAmount: witness.ecdhAmount,
        amountKey: witness.amountKey,
        commitment: witness.commitment
    };
    
    fs.writeFileSync('circuit_input.json', JSON.stringify(circuitInput, null, 2));
    console.log('💾 Circuit input saved to circuit_input.json');
    
    // Save full witness with DLEQ and Ed25519 proofs
    fs.writeFileSync('full_witness.json', JSON.stringify(witness, null, 2));
    console.log('💾 Full witness (with DLEQ/Ed25519 proofs) saved to full_witness.json');
    console.log();
    
    // Generate witness file
    console.log('🔧 Generating witness file...');
    const wasmPath = path.join(__dirname, '../build/monero_bridge_js/monero_bridge.wasm');
    
    if (!fs.existsSync(wasmPath)) {
        console.error('❌ Circuit WASM not found:', wasmPath);
        console.log('   Run: circom monero_bridge.circom --wasm');
        process.exit(1);
    }
    
    const { wtns } = await snarkjs.wtns.calculate(circuitInput, wasmPath);
    fs.writeFileSync('witness.wtns', wtns);
    console.log('✅ Witness file generated: witness.wtns');
    console.log();
    
    // Generate proof
    console.log('🔐 Generating PLONK proof...');
    const zkeyPath = path.join(__dirname, '../circuit_final.zkey');
    
    if (!fs.existsSync(zkeyPath)) {
        console.error('❌ Proving key not found:', zkeyPath);
        process.exit(1);
    }
    
    const { proof, publicSignals } = await snarkjs.plonk.prove(zkeyPath, wtns);
    
    fs.writeFileSync('proof.json', JSON.stringify(proof, null, 2));
    fs.writeFileSync('public.json', JSON.stringify(publicSignals, null, 2));
    
    console.log('✅ PLONK proof generated!');
    console.log('   Proof saved to: proof.json');
    console.log('   Public signals saved to: public.json');
    console.log();
    
    // Verify proof
    console.log('✔️  Verifying proof...');
    const vkeyPath = path.join(__dirname, '../verification_key.json');
    
    if (fs.existsSync(vkeyPath)) {
        const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf8'));
        const verified = await snarkjs.plonk.verify(vkey, publicSignals, proof);
        
        if (verified) {
            console.log('✅ Proof verified successfully!');
        } else {
            console.log('❌ Proof verification failed');
        }
    } else {
        console.log('⚠️  Verification key not found, skipping verification');
    }
    
    console.log('\n🎉 Proof generation complete!');
    console.log('\nNext step: Use proof.json and public.json to call mint() on the contract');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    });
