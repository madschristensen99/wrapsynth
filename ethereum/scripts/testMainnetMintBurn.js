#!/usr/bin/env node
/**
 * Test full mint and burn cycle on mainnet
 */

const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const HUB_ADDRESS = '0x2eAe12Ba637e854dD5bDE99807929096cfb012f2';
const WSXMR_ADDRESS = '0x01487E9de328B464a0B59C9847940a1Bb4C49f8c';
const WXDAI_ADDRESS = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';

async function main() {
    const rpcUrl = process.env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com';
    const privateKey = process.env.PRIVATE_KEY;
    
    if (!privateKey) {
        console.error('❌ PRIVATE_KEY not set');
        process.exit(1);
    }
    
    console.log('🧪 Testing Mint and Burn on Mainnet');
    console.log('===================================\n');
    
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    
    const balance = await wallet.getBalance();
    console.log('Wallet:', wallet.address);
    console.log('Balance:', ethers.utils.formatEther(balance), 'xDAI');
    console.log('');
    
    try {
        // Contract ABIs
        const hubAbi = [
            'function updateOraclePrices(bytes[] calldata) external payable',
            'function initiateMint(address lpVault, address recipient, uint256 xmrAmount, bytes32 claimCommitment, uint256 timeoutDuration) external payable returns (bytes32)',
            'function getXmrPrice() external view returns (uint256)',
            'function getCollateralPrice() external view returns (uint256)'
        ];
        
        const wsxmrAbi = [
            'function balanceOf(address) external view returns (uint256)',
            'function totalSupply() external view returns (uint256)'
        ];
        
        const wxdaiAbi = [
            'function balanceOf(address) external view returns (uint256)',
            'function approve(address spender, uint256 amount) external returns (bool)'
        ];
        
        const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
        const wsxmr = new ethers.Contract(WSXMR_ADDRESS, wsxmrAbi, wallet);
        const wxdai = new ethers.Contract(WXDAI_ADDRESS, wxdaiAbi, wallet);
        
        // Step 1: Check balances
        console.log('📊 Step 2: Checking balances...');
        const wxdaiBalance = await wxdai.balanceOf(wallet.address);
        const wsxmrBalance = await wsxmr.balanceOf(wallet.address);
        const wsxmrSupply = await wsxmr.totalSupply();
        
        console.log('   wxDAI:', ethers.utils.formatEther(wxdaiBalance));
        console.log('   wsXMR:', ethers.utils.formatUnits(wsxmrBalance, 6));
        console.log('   wsXMR Total Supply:', ethers.utils.formatUnits(wsxmrSupply, 6));
        console.log('');
        
        // Step 3: Initiate mint
        console.log('🔨 Step 3: Initiating mint request...');
        console.log('   Amount: 0.01 XMR');
        console.log('   Griefing deposit: 0.01 xDAI');
        
        const xmrAmount = ethers.utils.parseUnits('0.01', 6); // 0.01 XMR (6 decimals)
        const griefingDeposit = ethers.utils.parseEther('0.01'); // 0.01 xDAI
        const lpVault = wallet.address; // Using our own address as LP for testing
        const claimCommitment = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('test-secret-123'));
        const timeoutDuration = 3600; // 1 hour
        
        console.log('   LP Vault:', lpVault);
        console.log('   Claim Commitment:', claimCommitment);
        console.log('');
        
        // Update prices right before mint (they expire in 2 minutes)
        console.log('   Updating prices before mint...');
        const authorizedSigners = getSignersForDataServiceId("redstone-primary-prod");
        const wrappedHub = WrapperBuilder
            .wrap(hub)
            .usingDataService({
                dataServiceId: "redstone-primary-prod",
                uniqueSignersCount: 3,
                dataPackagesIds: ["XMR", "DAI"],
                authorizedSigners
            });
        
        const priceUpdateTx = await wrappedHub.updateOraclePrices([]);
        console.log('   Price update TX:', priceUpdateTx.hash);
        await priceUpdateTx.wait();
        console.log('   ✅ Prices updated');
        
        // Send mint immediately after update confirms
        console.log('   Sending mint (immediately after update)...');
        
        // Set manual gas limit to skip estimation (which uses stale state)
        const mintTx = await hub.initiateMint(
            lpVault,
            wallet.address,
            xmrAmount,
            claimCommitment,
            timeoutDuration,
            { 
                value: griefingDeposit,
                gasLimit: 500000 // Manual gas limit to avoid stale estimation
            }
        );
        
        console.log('   Mint TX:', mintTx.hash);
        const mintReceipt = await mintTx.wait();
        console.log('   ✅ Mint initiated!');
        console.log('   Gas used:', mintReceipt.gasUsed.toString());
        console.log('');
        
        // Parse the MintInitiated event to get requestId
        const mintEvent = mintReceipt.logs.find(log => {
            try {
                const parsed = hub.interface.parseLog(log);
                return parsed.name === 'MintInitiated';
            } catch {
                return false;
            }
        });
        
        if (mintEvent) {
            const parsed = hub.interface.parseLog(mintEvent);
            console.log('   📋 Request ID:', parsed.args.requestId);
        }
        
        console.log('');
        console.log('🎉 Mint request successful!');
        console.log('');
        console.log('📝 Next steps (requires LP):');
        console.log('   1. LP receives XMR on Monero network');
        console.log('   2. LP calls setMintReady(requestId)');
        console.log('   3. User calls finalizeMint(requestId, secret)');
        console.log('   4. User receives wsXMR tokens');
        console.log('');
        console.log('For burn:');
        console.log('   1. User calls requestBurn(wsxmrAmount, lpVault, user)');
        console.log('   2. LP sends XMR to user on Monero');
        console.log('   3. LP calls finalizeBurn(requestId, secret)');
        console.log('   4. Burn completes');
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        if (error.error) {
            console.error('Contract error:', error.error);
        }
        if (error.reason) {
            console.error('Reason:', error.reason);
        }
        if (error.data) {
            console.error('Data:', error.data);
        }
        console.error('\nFull error:');
        console.error(error);
        process.exit(1);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
