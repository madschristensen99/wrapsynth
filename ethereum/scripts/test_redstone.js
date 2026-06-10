console.log('STARTING');
try {
    const { WrapperBuilder } = require('@redstone-finance/evm-connector');
    console.log('RedStone SDK loaded');
} catch (e) {
    console.error('Error loading SDK:', e.message);
}
console.log('DONE');
