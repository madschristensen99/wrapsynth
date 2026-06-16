// Diagnostic script to investigate the secret mismatch issue
// Run this in the browser console to see what's stored

export function diagnoseMintSecretMismatch() {
    console.log('=== WrapSynth Mint Secret Mismatch Diagnostics ===\n');
    
    // 1. Check active swaps
    const activeSwapsKey = 'wrapsynth_active_swaps_v2';
    const activeSwapsRaw = localStorage.getItem(activeSwapsKey);
    
    if (!activeSwapsRaw) {
        console.log('❌ No active swaps found in localStorage');
        return;
    }
    
    let activeSwaps;
    try {
        activeSwaps = JSON.parse(activeSwapsRaw);
        console.log(`✅ Found ${activeSwaps.length} active swap(s)\n`);
    } catch (e) {
        console.log('❌ Failed to parse active swaps:', e);
        return;
    }
    
    // Find the problematic mint
    const requestId = '0x97704b6cd0cd9196204717e50dd4ffea33ef12a95666f5d9b4c56f3f23afa399';
    const swap = activeSwaps.find(s => s.requestId === requestId);
    
    if (!swap) {
        console.log(`❌ Swap with requestId ${requestId} not found in active swaps`);
        console.log('Available swaps:', activeSwaps.map(s => s.requestId));
        return;
    }
    
    console.log('📋 Swap State:');
    console.log('  Type:', swap.type);
    console.log('  State:', swap.state);
    console.log('  Request ID:', swap.requestId);
    console.log('  Public Spend Key:', swap.publicSpendKey);
    console.log('  XMR Amount:', swap.xmrAmount);
    console.log('  Timestamp:', new Date(swap.timestamp).toISOString());
    console.log('  Last Updated:', new Date(swap.lastUpdated).toISOString());
    console.log('');
    
    // 2. Check if seed is stored
    const publicSpendKey = swap.publicSpendKey;
    if (!publicSpendKey) {
        console.log('❌ No publicSpendKey found in swap state - cannot check seed storage');
        return;
    }
    
    // Get user address from wallet (this would need to be run in browser with wallet connected)
    console.log('🔍 Checking seed storage...');
    console.log('  Public Spend Key:', publicSpendKey);
    
    // Check all localStorage keys for seed storage
    const seedKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('wrapsynth/') && key.includes(publicSpendKey)) {
            seedKeys.push(key);
        }
    }
    
    if (seedKeys.length === 0) {
        console.log('❌ No seed found in localStorage for this publicSpendKey');
        console.log('   This is the ROOT CAUSE: Seed was never stored or was deleted');
        console.log('');
        console.log('💡 Possible reasons:');
        console.log('   1. User rejected the signature request during seed storage');
        console.log('   2. Browser crashed before seed was stored');
        console.log('   3. localStorage was cleared');
        console.log('   4. Seed storage failed silently');
        return;
    }
    
    console.log(`✅ Found ${seedKeys.length} seed storage key(s):`);
    seedKeys.forEach(key => console.log('  -', key));
    console.log('');
    
    // Check the seed format
    const seedData = localStorage.getItem(seedKeys[0]);
    if (seedData.startsWith('v2:')) {
        console.log('✅ Seed is in v2 format (encrypted)');
        const parts = seedData.slice(3).split(':');
        console.log('  Encrypted IV length:', parts[0].length / 2, 'bytes');
        console.log('  Encrypted Seed length:', parts[1].length / 2, 'bytes');
    } else {
        console.log('⚠️  Seed is in unknown format:', seedData.substring(0, 20) + '...');
    }
    
    console.log('');
    console.log('=== On-Chain Data ===');
    console.log('Expected commitment (from contract):');
    console.log('  0xa1822b3de665179fdb74ac64ca15ebc5ec9ebfe0f06e4527a04bf2cbcce4023a');
    console.log('');
    console.log('Actual commitment (from secret):');
    console.log('  0xdd08ea90b037932955f544d2c371ebf277fbc1544b1e8dffcc4114e4368b0ed9');
    console.log('');
    console.log('❌ MISMATCH: The secret being used does not match the commitment stored on-chain');
    console.log('');
    console.log('=== Diagnosis ===');
    if (seedKeys.length > 0) {
        console.log('The seed IS stored, but either:');
        console.log('  1. The wrong seed was restored (different publicSpendKey)');
        console.log('  2. The seed was re-generated instead of restored');
        console.log('  3. The commitment was computed differently during initiateMint vs finalizeMint');
    }
}

// Make it available globally for browser console
if (typeof window !== 'undefined') {
    window.diagnoseMintSecretMismatch = diagnoseMintSecretMismatch;
}
