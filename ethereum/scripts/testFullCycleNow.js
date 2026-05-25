#!/usr/bin/env node
/**
 * Test FULL mint and burn cycle - update prices and immediately execute
 */

const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const HUB_ADDRESS = '0x71587d4d85B9c319Fdf3A82e4686E68f62c09EF2';
const WSXMR_ADDRESS = '0xa0aaD445eA07997d877Add2A5F5A0865DB3A6286';
const WXDAI_ADDRESS = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log('🧪 Testing FULL Mint and Burn Cycle');
    console.log('====================================');
    console.log('Wallet:', wallet.address);
    console.log('');
    
    const hubAbi = [
        'function initiateMint(address lpVault, address initiator, uint256 wsxmrAmount, bytes32 claimCommitment, uint256 timeoutDuration) external payable returns (bytes32)',
        'function setMintReady(bytes32 requestId) external payable',
        'function finalizeMint(bytes32 requestId, bytes32 secret) external',
        'function requestBurn(uint256 wsxmrAmount, address lpVault, address burnRecipient) external returns (bytes32)',
        'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable'
    ];
    
    const wsxmrAbi = [
        'function balanceOf(address) external view returns (uint256)',
        'function totalSupply() external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)'
    ];
    
    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, wsxmrAbi, wallet);
    
    // Wrap with RedStone
    const authorizedSigners = getSignersForDataServiceId("redstone-primary-prod");
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: "redstone-primary-prod",
        uniqueSignersCount: 3,
        dataPackagesIds: ["XMR", "DAI"],
        authorizedSigners
    });
    
    console.log('📊 Step 1: Update Prices');
    console.log('========================');
    const updateTx = await wrappedHub.updateOraclePrices([]);
    console.log('TX:', updateTx.hash);
    await updateTx.wait();
    console.log('✅ Prices updated');
    console.log('');
    
    console.log('📊 Step 2: MINT - Initiate (IMMEDIATELY after price update)');
    console.log('============================================================');
    const xmrAmount = ethers.utils.parseUnits('0.01', 12);
    const secret = ethers.utils.randomBytes(32);
    const claimCommitment = ethers.utils.keccak256(secret);
    const griefingDeposit = ethers.utils.parseEther('0.001');
    
    console.log('Secret:', ethers.utils.hexlify(secret));
    
    const mintTx = await hub.initiateMint(
        wallet.address,
        wallet.address,
        xmrAmount,
        claimCommitment,
        3600,
        { value: griefingDeposit, gasLimit: 500000 }
    );
    const mintReceipt = await mintTx.wait();
    
    // Parse requestId from logs (events might not be decoded)
    let requestId;
    if (mintReceipt.events && mintReceipt.events.length > 0) {
        const mintEvent = mintReceipt.events.find(e => e.event === 'MintInitiated');
        requestId = mintEvent ? mintEvent.args.requestId : mintReceipt.logs[0].topics[1];
    } else {
        // Fallback: requestId is first topic after event signature
        requestId = mintReceipt.logs[0].topics[1];
    }
    
    console.log('✅ Mint initiated!');
    console.log('Request ID:', requestId);
    console.log('Gas:', mintReceipt.gasUsed.toString());
    console.log('');
    
    console.log('📊 Step 3: Update Prices Again (before setMintReady)');
    console.log('=====================================================');
    const updateTx2 = await wrappedHub.updateOraclePrices([]);
    await updateTx2.wait();
    console.log('✅ Prices refreshed');
    console.log('');
    
    console.log('📊 Step 4: MINT - LP Sets Ready');
    console.log('================================');
    const lpBond = ethers.utils.parseEther('0.001');
    const readyTx = await hub.setMintReady(requestId, { value: lpBond });
    await readyTx.wait();
    console.log('✅ LP marked ready');
    console.log('');
    
    console.log('📊 Step 5: MINT - Finalize');
    console.log('===========================');
    const finalizeTx = await hub.finalizeMint(requestId, secret, { gasLimit: 1000000 });
    const finalizeReceipt = await finalizeTx.wait();
    console.log('✅ Mint finalized!');
    console.log('Gas:', finalizeReceipt.gasUsed.toString());
    
    const wsxmrBalance = await wsxmr.balanceOf(wallet.address);
    console.log('wsXMR Balance:', ethers.utils.formatUnits(wsxmrBalance, 12));
    console.log('');
    
    console.log('📊 Step 6: BURN - Request');
    console.log('=========================');
    const burnAmount = wsxmrBalance;
    
    const approveTx = await wsxmr.approve(HUB_ADDRESS, burnAmount);
    await approveTx.wait();
    
    const burnTx = await hub.requestBurn(burnAmount, wallet.address, wallet.address);
    const burnReceipt = await burnTx.wait();
    
    // Parse burnRequestId from logs
    let burnRequestId;
    if (burnReceipt.events && burnReceipt.events.length > 0) {
        const burnEvent = burnReceipt.events.find(e => e.event === 'BurnRequested');
        burnRequestId = burnEvent ? burnEvent.args.requestId : burnReceipt.logs[0].topics[1];
    } else {
        burnRequestId = burnReceipt.logs[0].topics[1];
    }
    
    console.log('✅ Burn requested!');
    console.log('Request ID:', burnRequestId);
    console.log('Amount:', ethers.utils.formatUnits(burnAmount, 12), 'wsXMR');
    console.log('');
    
    console.log('📊 Step 7: BURN - Finalize');
    console.log('===========================');
    const burnSecret = ethers.utils.randomBytes(32);
    
    const finalizeBurnTx = await hub.finalizeBurn(burnRequestId, burnSecret, { gasLimit: 1000000 });
    const finalizeBurnReceipt = await finalizeBurnTx.wait();
    console.log('✅ Burn finalized!');
    console.log('Gas:', finalizeBurnReceipt.gasUsed.toString());
    
    const finalBalance = await wsxmr.balanceOf(wallet.address);
    const totalSupply = await wsxmr.totalSupply();
    console.log('Final wsXMR Balance:', ethers.utils.formatUnits(finalBalance, 12));
    console.log('Total Supply:', ethers.utils.formatUnits(totalSupply, 12));
    console.log('');
    
    console.log('🎉 FULL CYCLE COMPLETE!');
    console.log('=======================');
    console.log('✅ Minted wsXMR tokens');
    console.log('✅ Burned wsXMR tokens');
    console.log('✅ Protocol fully functional on Gnosis mainnet!');
}

main().catch(console.error);
