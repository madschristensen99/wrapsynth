// Script to find which stored seed matches the on-chain commitment
// Run this in the browser console with wallet connected

import { keccak256, hexToBytes, bytesToHex } from 'https://esm.sh/viem@2.7.0';
import * as ed25519 from 'https://esm.sh/@noble/ed25519@2.1.0';
import { createKeySet } from './seedManager.js';
import { loadSeed } from './seedStorage.js';

const Point = ed25519.ExtendedPoint || ed25519.Point;

async function findCorrectSeed() {
    console.log('=== Finding Correct Seed for Mint ===\n');
    
    const expectedCommitment = '0xa1822b3de665179fdb74ac64ca15ebc5ec9ebfe0f06e4527a04bf2cbcce4023a';
    const requestId = '0x97704b6cd0cd9196204717e50dd4ffea33ef12a95666f5d9b4c56f3f23afa399';
    
    console.log('Target Request ID:', requestId);
    console.log('Expected Commitment:', expectedCommitment);
    console.log('');
    
    // Get all seed keys from localStorage
    const seedKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('wrapsynth/') && key.includes('/0x')) {
            seedKeys.push(key);
        }
    }
    
    console.log(`Found ${seedKeys.length} stored seed(s)\n`);
    
    // Try each seed
    for (let i = 0; i < seedKeys.length; i++) {
        const key = seedKeys[i];
        const parts = key.split('/');
        const publicSpendKey = parts[1];
        
        console.log(`\nSeed ${i + 1}/${seedKeys.length}:`);
        console.log(`  Public Key: ${publicSpendKey}`);
        
        try {
            // Load and decrypt the seed
            console.log('  Decrypting seed...');
            const seed = await loadSeed(publicSpendKey);
            
            if (!seed) {
                console.log('  ❌ Failed to decrypt (user may have cancelled signature)');
                continue;
            }
            
            console.log('  ✅ Seed decrypted successfully');
            
            // Generate commitment from this seed
            const keySet = createKeySet(seed);
            const commitment = keySet.commitment;
            
            console.log('  Commitment:', commitment);
            
            if (commitment.toLowerCase() === expectedCommitment.toLowerCase()) {
                console.log('\n🎉 FOUND IT! This seed matches the on-chain commitment!');
                console.log('  Public Spend Key:', publicSpendKey);
                console.log('  Secret:', keySet.secret);
                console.log('\nYou can now use this secret to finalize the mint.');
                return {
                    found: true,
                    publicSpendKey,
                    secret: keySet.secret,
                    commitment,
                    seed
                };
            } else {
                console.log('  ❌ Does not match');
            }
        } catch (error) {
            console.log('  ❌ Error:', error.message);
        }
    }
    
    console.log('\n❌ None of the stored seeds match the expected commitment.');
    console.log('\nPossible reasons:');
    console.log('1. The correct seed was deleted from localStorage');
    console.log('2. The seed was stored under a different wallet address');
    console.log('3. The commitment was generated with a different seed that was never stored');
    console.log('\nYou will need to cancel this mint on-chain to recover your griefing deposit.');
    
    return { found: false };
}

// Make it available globally
if (typeof window !== 'undefined') {
    window.findCorrectSeed = findCorrectSeed;
}

export { findCorrectSeed };
