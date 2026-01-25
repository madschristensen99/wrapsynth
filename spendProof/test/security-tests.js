const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require('fs');

describe("WrappedMoneroV3 Security Tests", function () {
    let wrappedMonero;
    let deployer, user;
    const WRAPPED_MONERO = '0xe1B76b604F12Fd20b8D490C4C1f0634521626B0B';

    before(async function () {
        [deployer, user] = await ethers.getSigners();
        wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', WRAPPED_MONERO);
        console.log('\n🔒 Security Test Suite');
        console.log('Contract:', WRAPPED_MONERO);
        console.log('Deployer:', deployer.address);
    });

    describe("1. Replay Attack Protection", function () {
        it("Should prevent double-spending the same output", async function () {
            console.log('\n🎯 Test: Replay Attack (Double Spend)');
            
            // Load the proof data from our successful mint
            const proof = JSON.parse(fs.readFileSync('proof.json', 'utf8'));
            const publicSignals = JSON.parse(fs.readFileSync('public.json', 'utf8'));
            const fullWitness = JSON.parse(fs.readFileSync('full_witness.json', 'utf8'));
            const merkleProofs = JSON.parse(fs.readFileSync('merkle_proofs.json', 'utf8'));

            // Prepare the same mint data
            const output = {
                txHash: '0x73155c18b4b6a820ace7a77973ae1004bb8b1b8c0c8a96c9c7a6957309f14d79',
                outputIndex: 0,
                ecdhAmount: '0x3b475922544ca95e'.padEnd(66, '0'),
                outputPubKey: '0x10cc8ed1b28bb8ab053b9d7070e38834515bb464223b1be4a7aa6d8f80957c9c',
                commitment: '0xcd845e8d0642e639b02225abd06377ff96574e0bdf50fd1db1d2aafb4f824c11',
                blockHeight: 3595150
            };

            const ed25519Proof = {
                R_x: fullWitness.ed25519Proof.R_x,
                R_y: fullWitness.ed25519Proof.R_y,
                S_x: fullWitness.ed25519Proof.S_x,
                S_y: fullWitness.ed25519Proof.S_y,
                P_x: fullWitness.ed25519Proof.P.x,
                P_y: fullWitness.ed25519Proof.P.y,
                message: "0x" + Buffer.from("test").toString('hex').padEnd(64, '0'),
                publicKey: fullWitness.ed25519Proof.A.x,
                signature_r: fullWitness.ed25519Proof.R_x,
                signature_s: fullWitness.ed25519Proof.S_x
            };

            const dleqProof = {
                c: fullWitness.dleqProof.c,
                r: fullWitness.dleqProof.s,
                R1_x: fullWitness.dleqProof.K1.x,
                R1_y: fullWitness.dleqProof.K1.y,
                R2_x: fullWitness.dleqProof.K2.x,
                R2_y: fullWitness.dleqProof.K2.y,
                H_x: fullWitness.ed25519Proof.H_s.x,
                H_y: fullWitness.ed25519Proof.H_s.y
            };

            // Try to mint the same output again
            console.log('   Attempting to mint same output twice...');
            
            await expect(
                wrappedMonero.mint(
                    deployer.address,
                    deployer.address,
                    output,
                    ed25519Proof,
                    dleqProof,
                    proof,
                    publicSignals,
                    merkleProofs.txMerkleProof,
                    merkleProofs.outputMerkleProof,
                    []
                )
            ).to.be.revertedWith("Output spent");

            console.log('   ✅ Replay attack prevented!');
        });
    });

    describe("2. Invalid Proof Tests", function () {
        it("Should reject proof with wrong amount", async function () {
            console.log('\n🎯 Test: Wrong Amount in Proof');
            
            const proof = JSON.parse(fs.readFileSync('proof.json', 'utf8'));
            const publicSignals = JSON.parse(fs.readFileSync('public.json', 'utf8'));
            const fullWitness = JSON.parse(fs.readFileSync('full_witness.json', 'utf8'));
            const merkleProofs = JSON.parse(fs.readFileSync('merkle_proofs.json', 'utf8'));

            // Modify the amount in public signals
            const modifiedSignals = [...publicSignals];
            modifiedSignals[0] = "999999999999"; // Wrong amount

            const output = {
                txHash: '0x73155c18b4b6a820ace7a77973ae1004bb8b1b8c0c8a96c9c7a6957309f14d79',
                outputIndex: 0,
                ecdhAmount: '0x3b475922544ca95e'.padEnd(66, '0'),
                outputPubKey: '0x10cc8ed1b28bb8ab053b9d7070e38834515bb464223b1be4a7aa6d8f80957c9c',
                commitment: '0xcd845e8d0642e639b02225abd06377ff96574e0bdf50fd1db1d2aafb4f824c11',
                blockHeight: 3595150
            };

            const ed25519Proof = {
                R_x: fullWitness.ed25519Proof.R_x,
                R_y: fullWitness.ed25519Proof.R_y,
                S_x: fullWitness.ed25519Proof.S_x,
                S_y: fullWitness.ed25519Proof.S_y,
                P_x: fullWitness.ed25519Proof.P.x,
                P_y: fullWitness.ed25519Proof.P.y,
                message: "0x" + Buffer.from("test").toString('hex').padEnd(64, '0'),
                publicKey: fullWitness.ed25519Proof.A.x,
                signature_r: fullWitness.ed25519Proof.R_x,
                signature_s: fullWitness.ed25519Proof.S_x
            };

            const dleqProof = {
                c: fullWitness.dleqProof.c,
                r: fullWitness.dleqProof.s,
                R1_x: fullWitness.dleqProof.K1.x,
                R1_y: fullWitness.dleqProof.K1.y,
                R2_x: fullWitness.dleqProof.K2.x,
                R2_y: fullWitness.dleqProof.K2.y,
                H_x: fullWitness.ed25519Proof.H_s.x,
                H_y: fullWitness.ed25519Proof.H_s.y
            };

            console.log('   Attempting mint with modified amount...');
            
            await expect(
                wrappedMonero.mint(
                    deployer.address,
                    deployer.address,
                    output,
                    ed25519Proof,
                    dleqProof,
                    proof,
                    modifiedSignals,
                    merkleProofs.txMerkleProof,
                    merkleProofs.outputMerkleProof,
                    []
                )
            ).to.be.revertedWith("Invalid ZK proof");

            console.log('   ✅ Invalid proof rejected!');
        });

        it("Should reject proof with wrong Ed25519 coordinates (proof binding)", async function () {
            console.log('\n🎯 Test: Proof Binding (Wrong Ed25519 Coordinates)');
            
            const proof = JSON.parse(fs.readFileSync('proof.json', 'utf8'));
            const publicSignals = JSON.parse(fs.readFileSync('public.json', 'utf8'));
            const fullWitness = JSON.parse(fs.readFileSync('full_witness.json', 'utf8'));
            const merkleProofs = JSON.parse(fs.readFileSync('merkle_proofs.json', 'utf8'));

            const output = {
                txHash: '0x73155c18b4b6a820ace7a77973ae1004bb8b1b8c0c8a96c9c7a6957309f14d79',
                outputIndex: 0,
                ecdhAmount: '0x3b475922544ca95e'.padEnd(66, '0'),
                outputPubKey: '0x10cc8ed1b28bb8ab053b9d7070e38834515bb464223b1be4a7aa6d8f80957c9c',
                commitment: '0xcd845e8d0642e639b02225abd06377ff96574e0bdf50fd1db1d2aafb4f824c11',
                blockHeight: 3595150
            };

            // Use wrong Ed25519 coordinates
            const ed25519Proof = {
                R_x: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
                R_y: fullWitness.ed25519Proof.R.y,
                S_x: fullWitness.ed25519Proof.S.x,
                S_y: fullWitness.ed25519Proof.S.y,
                P_x: fullWitness.ed25519Proof.P.x,
                P_y: fullWitness.ed25519Proof.P.y,
                message: fullWitness.ed25519Proof.message,
                publicKey: fullWitness.ed25519Proof.publicKey,
                signature_r: fullWitness.ed25519Proof.signature_r,
                signature_s: fullWitness.ed25519Proof.signature_s
            };

            const dleqProof = {
                c: fullWitness.dleqProof.c,
                r: fullWitness.dleqProof.s,
                R1_x: fullWitness.dleqProof.K1.x,
                R1_y: fullWitness.dleqProof.K1.y,
                R2_x: fullWitness.dleqProof.K2.x,
                R2_y: fullWitness.dleqProof.K2.y,
                H_x: fullWitness.ed25519Proof.H_s.x,
                H_y: fullWitness.ed25519Proof.H_s.y
            };

            console.log('   Attempting mint with wrong Ed25519 R_x...');
            
            await expect(
                wrappedMonero.mint(
                    deployer.address,
                    deployer.address,
                    output,
                    ed25519Proof,
                    dleqProof,
                    proof,
                    publicSignals,
                    merkleProofs.txMerkleProof,
                    merkleProofs.outputMerkleProof,
                    []
                )
            ).to.be.revertedWith("R_x mismatch");

            console.log('   ✅ Proof binding enforced!');
        });
    });

    describe("3. Merkle Proof Tests", function () {
        it("Should reject invalid TX Merkle proof", async function () {
            console.log('\n🎯 Test: Invalid TX Merkle Proof');
            
            const proof = JSON.parse(fs.readFileSync('proof.json', 'utf8'));
            const publicSignals = JSON.parse(fs.readFileSync('public.json', 'utf8'));
            const fullWitness = JSON.parse(fs.readFileSync('full_witness.json', 'utf8'));
            const merkleProofs = JSON.parse(fs.readFileSync('merkle_proofs.json', 'utf8'));

            const output = {
                txHash: '0x73155c18b4b6a820ace7a77973ae1004bb8b1b8c0c8a96c9c7a6957309f14d79',
                outputIndex: 0,
                ecdhAmount: '0x3b475922544ca95e'.padEnd(66, '0'),
                outputPubKey: '0x10cc8ed1b28bb8ab053b9d7070e38834515bb464223b1be4a7aa6d8f80957c9c',
                commitment: '0xcd845e8d0642e639b02225abd06377ff96574e0bdf50fd1db1d2aafb4f824c11',
                blockHeight: 3595150
            };

            const ed25519Proof = {
                R_x: fullWitness.ed25519Proof.R_x,
                R_y: fullWitness.ed25519Proof.R_y,
                S_x: fullWitness.ed25519Proof.S_x,
                S_y: fullWitness.ed25519Proof.S_y,
                P_x: fullWitness.ed25519Proof.P.x,
                P_y: fullWitness.ed25519Proof.P.y,
                message: "0x" + Buffer.from("test").toString('hex').padEnd(64, '0'),
                publicKey: fullWitness.ed25519Proof.A.x,
                signature_r: fullWitness.ed25519Proof.R_x,
                signature_s: fullWitness.ed25519Proof.S_x
            };

            const dleqProof = {
                c: fullWitness.dleqProof.c,
                r: fullWitness.dleqProof.s,
                R1_x: fullWitness.dleqProof.K1.x,
                R1_y: fullWitness.dleqProof.K1.y,
                R2_x: fullWitness.dleqProof.K2.x,
                R2_y: fullWitness.dleqProof.K2.y,
                H_x: fullWitness.ed25519Proof.H_s.x,
                H_y: fullWitness.ed25519Proof.H_s.y
            };

            // Corrupt the TX Merkle proof
            const badTxProof = [...merkleProofs.txMerkleProof];
            badTxProof[0] = ethers.keccak256(ethers.toUtf8Bytes("fake"));

            console.log('   Attempting mint with corrupted TX Merkle proof...');
            
            await expect(
                wrappedMonero.mint(
                    deployer.address,
                    deployer.address,
                    output,
                    ed25519Proof,
                    dleqProof,
                    proof,
                    publicSignals,
                    badTxProof,
                    merkleProofs.outputMerkleProof,
                    []
                )
            ).to.be.revertedWith("Invalid TX proof");

            console.log('   ✅ Invalid TX Merkle proof rejected!');
        });

        it("Should reject invalid Output Merkle proof", async function () {
            console.log('\n🎯 Test: Invalid Output Merkle Proof');
            
            const proof = JSON.parse(fs.readFileSync('proof.json', 'utf8'));
            const publicSignals = JSON.parse(fs.readFileSync('public.json', 'utf8'));
            const fullWitness = JSON.parse(fs.readFileSync('full_witness.json', 'utf8'));
            const merkleProofs = JSON.parse(fs.readFileSync('merkle_proofs.json', 'utf8'));

            const output = {
                txHash: '0x73155c18b4b6a820ace7a77973ae1004bb8b1b8c0c8a96c9c7a6957309f14d79',
                outputIndex: 0,
                ecdhAmount: '0x3b475922544ca95e'.padEnd(66, '0'),
                outputPubKey: '0x10cc8ed1b28bb8ab053b9d7070e38834515bb464223b1be4a7aa6d8f80957c9c',
                commitment: '0xcd845e8d0642e639b02225abd06377ff96574e0bdf50fd1db1d2aafb4f824c11',
                blockHeight: 3595150
            };

            const ed25519Proof = {
                R_x: fullWitness.ed25519Proof.R_x,
                R_y: fullWitness.ed25519Proof.R_y,
                S_x: fullWitness.ed25519Proof.S_x,
                S_y: fullWitness.ed25519Proof.S_y,
                P_x: fullWitness.ed25519Proof.P.x,
                P_y: fullWitness.ed25519Proof.P.y,
                message: "0x" + Buffer.from("test").toString('hex').padEnd(64, '0'),
                publicKey: fullWitness.ed25519Proof.A.x,
                signature_r: fullWitness.ed25519Proof.R_x,
                signature_s: fullWitness.ed25519Proof.S_x
            };

            const dleqProof = {
                c: fullWitness.dleqProof.c,
                r: fullWitness.dleqProof.s,
                R1_x: fullWitness.dleqProof.K1.x,
                R1_y: fullWitness.dleqProof.K1.y,
                R2_x: fullWitness.dleqProof.K2.x,
                R2_y: fullWitness.dleqProof.K2.y,
                H_x: fullWitness.ed25519Proof.H_s.x,
                H_y: fullWitness.ed25519Proof.H_s.y
            };

            // Corrupt the Output Merkle proof
            const badOutputProof = [...merkleProofs.outputMerkleProof];
            badOutputProof[0] = ethers.keccak256(ethers.toUtf8Bytes("fake"));

            console.log('   Attempting mint with corrupted Output Merkle proof...');
            
            await expect(
                wrappedMonero.mint(
                    deployer.address,
                    deployer.address,
                    output,
                    ed25519Proof,
                    dleqProof,
                    proof,
                    publicSignals,
                    merkleProofs.txMerkleProof,
                    badOutputProof,
                    []
                )
            ).to.be.revertedWith("Output not in Merkle tree");

            console.log('   ✅ Invalid Output Merkle proof rejected!');
        });
    });
});
