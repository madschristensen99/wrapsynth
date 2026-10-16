// Script to find all stored seeds in localStorage
// Run this in the browser console

export function findAllSeeds() {
    console.log('=== Searching for stored seeds in localStorage ===\n');
    
    const seeds = [];
    const otherKeys = [];
    
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        
        if (key.startsWith('wrapsynth/')) {
            const value = localStorage.getItem(key);
            seeds.push({ key, value: value.substring(0, 50) + '...' });
        } else {
            otherKeys.push(key);
        }
    }
    
    console.log(`Found ${seeds.length} seed(s) in localStorage:\n`);
    seeds.forEach((s, i) => {
        console.log(`Seed ${i + 1}:`);
        console.log(`  Key: ${s.key}`);
        console.log(`  Value: ${s.value}`);
        console.log('');
        
        // Parse the key to extract info
        const parts = s.key.split('/');
        if (parts.length === 3) {
            console.log(`  Public Key: ${parts[1]}`);
            console.log(`  User Address: ${parts[2]}`);
            console.log('');
        }
    });
    
    console.log('Other localStorage keys:');
    otherKeys.forEach(k => console.log(`  - ${k}`));
    
    console.log('\n=== Active Swaps ===\n');
    const activeSwapsKey = 'wrapsynth_active_swaps_v2';
    const activeSwapsRaw = localStorage.getItem(activeSwapsKey);
    
    if (activeSwapsRaw) {
        try {
            const swaps = JSON.parse(activeSwapsRaw);
            console.log(`Found ${swaps.length} active swap(s):\n`);
            swaps.forEach((swap, i) => {
                console.log(`Swap ${i + 1}:`);
                console.log(`  Type: ${swap.type}`);
                console.log(`  Request ID: ${swap.requestId}`);
                console.log(`  State: ${swap.state}`);
                console.log(`  Public Spend Key: ${swap.publicSpendKey}`);
                console.log(`  XMR Amount: ${swap.xmrAmount}`);
                console.log(`  Timestamp: ${new Date(swap.timestamp).toISOString()}`);
                console.log('');
            });
        } catch (e) {
            console.error('Failed to parse active swaps:', e);
        }
    } else {
        console.log('No active swaps found');
    }
    
    return { seeds, activeSwapsRaw };
}

// Make it available globally
if (typeof window !== 'undefined') {
    window.findAllSeeds = findAllSeeds;
}

// Auto-run if loaded directly
if (typeof window !== 'undefined') {
    console.log('Run findAllSeeds() to search for stored seeds');
}
