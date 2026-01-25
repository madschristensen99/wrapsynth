const hre = require('hardhat');
const fs = require('fs');

async function main() {
    const deployment = JSON.parse(fs.readFileSync('deployment_v3_fixed.json', 'utf8'));
    
    const PYTH = '0x2880aB155794e7179c9eE2e38200202908C17B43';
    const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
    const SDAI = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';
    
    console.log('🔍 Verifying contracts on Gnosisscan...\n');
    
    // Verify PlonkVerifier
    console.log('1️⃣ Verifying PlonkVerifier...');
    try {
        await hre.run("verify:verify", {
            address: deployment.contracts.PlonkVerifier,
            constructorArguments: []
        });
        console.log('✅ PlonkVerifier verified!\n');
    } catch (error) {
        if (error.message.includes('Already Verified')) {
            console.log('✅ PlonkVerifier already verified!\n');
        } else {
            console.log('❌ Error:', error.message, '\n');
        }
    }
    
    // Verify WrappedMoneroV3
    console.log('2️⃣ Verifying WrappedMoneroV3...');
    try {
        await hre.run("verify:verify", {
            address: deployment.contracts.WrappedMoneroV3,
            constructorArguments: [
                deployment.contracts.PlonkVerifier,
                WXDAI,
                SDAI,
                PYTH,
                '180000000000000000000', // 180 USD
                3595150
            ]
        });
        console.log('✅ WrappedMoneroV3 verified!\n');
    } catch (error) {
        if (error.message.includes('Already Verified')) {
            console.log('✅ WrappedMoneroV3 already verified!\n');
        } else {
            console.log('❌ Error:', error.message, '\n');
        }
    }
    
    console.log('🎉 Verification complete!');
    console.log('\n📋 Contract addresses:');
    console.log('   PlonkVerifier:', deployment.contracts.PlonkVerifier);
    console.log('   WrappedMoneroV3:', deployment.contracts.WrappedMoneroV3);
    console.log('\n🔗 View on Gnosisscan:');
    console.log('   https://gnosisscan.io/address/' + deployment.contracts.WrappedMoneroV3);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
