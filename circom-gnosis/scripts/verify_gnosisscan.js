const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

async function verifyContract(address, contractName, constructorArgs = '') {
    console.log(`\n🔍 Verifying ${contractName} at ${address}...`);
    
    const sourceCode = fs.readFileSync(`${contractName}_flat.sol`, 'utf8');
    
    const form = new FormData();
    form.append('module', 'contract');
    form.append('action', 'verifysourcecode');
    form.append('contractaddress', address);
    form.append('sourceCode', sourceCode);
    form.append('codeformat', 'solidity-single-file');
    form.append('contractname', contractName);
    form.append('compilerversion', 'v0.8.20+commit.a1b79de6');
    form.append('optimizationUsed', '1');
    form.append('runs', '200');
    form.append('evmversion', 'paris');
    form.append('constructorArguements', constructorArgs);
    form.append('apikey', process.env.BASESCAN_API_KEY || '');
    
    try {
        const response = await axios.post('https://api.gnosisscan.io/api', form, {
            headers: form.getHeaders()
        });
        
        console.log('Response:', response.data);
        
        if (response.data.status === '1') {
            console.log(`✅ ${contractName} verification submitted!`);
            console.log(`   GUID: ${response.data.result}`);
            return response.data.result;
        } else {
            console.log(`❌ Verification failed: ${response.data.result}`);
            return null;
        }
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
        return null;
    }
}

async function checkStatus(guid) {
    console.log(`\n⏳ Checking verification status for GUID: ${guid}...`);
    
    try {
        const response = await axios.get('https://api.gnosisscan.io/api', {
            params: {
                module: 'contract',
                action: 'checkverifystatus',
                guid: guid,
                apikey: process.env.BASESCAN_API_KEY || ''
            }
        });
        
        console.log('Status:', response.data);
        return response.data;
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        return null;
    }
}

async function main() {
    console.log("🚀 Verifying contracts on GnosisScan\n");
    console.log("═".repeat(70));
    
    // Verify PlonkVerifier
    const verifierGuid = await verifyContract(
        '0x21F824b645B7369dcfB3Ef61a6697102Cb329652',
        'PlonkVerifier'
    );
    
    if (verifierGuid) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        await checkStatus(verifierGuid);
    }
    
    // Encode constructor arguments for WrappedMonero
    const hre = require('hardhat');
    const constructorArgs = hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'address', 'address', 'address', 'uint256', 'uint256'],
        [
            '0x21F824b645B7369dcfB3Ef61a6697102Cb329652',  // verifier
            '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',  // WxDAI
            '0xaf204776c7245bF4147c2612BF6e5972Ee483701',  // sDAI
            '0x2880aB155794e7179c9eE2e38200202908C17B43',  // Pyth
            '16000000000',  // initial price
            '3300000'       // initial block
        ]
    ).slice(2);  // Remove 0x prefix
    
    console.log('\n📝 Constructor args (hex):', constructorArgs);
    
    // Verify WrappedMonero
    const bridgeGuid = await verifyContract(
        '0x9a437cB98CDD7621DaCd0ED44A1002bDbE6DFA70',
        'WrappedMonero',
        constructorArgs
    );
    
    if (bridgeGuid) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        await checkStatus(bridgeGuid);
    }
    
    console.log("\n" + "═".repeat(70));
    console.log("✅ Verification requests submitted!");
    console.log("\n📝 Check status on GnosisScan:");
    console.log("   PlonkVerifier: https://gnosisscan.io/address/0x21F824b645B7369dcfB3Ef61a6697102Cb329652#code");
    console.log("   WrappedMonero: https://gnosisscan.io/address/0x9a437cB98CDD7621DaCd0ED44A1002bDbE6DFA70#code");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
