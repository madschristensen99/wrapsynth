#!/usr/bin/env node
/**
 * Test FULL mint and burn cycle - update prices and immediately execute
 */

const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const HUB_ADDRESS = '0x6889AC1EA36019ce6bb4552FB9d24ED50b5F13Ed';
const WSXMR_ADDRESS = '0xc9162719b6BD9AfCc123D1e9F4D657b857E3aCDd';
const WXDAI_ADDRESS = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
const ED25519_HELPER = '0x7EBdE733CE8Bac20984f919e4d2E66e9eE86f2a3';

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
        'function proposeHash(bytes32 requestId, bytes32 secretHash) external',
        'function confirmMoneroLock(bytes32 requestId) external',
        'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable'
    ];
    
    const wsxmrAbi = [
        'function balanceOf(address) external view returns (uint256)',
        'function totalSupply() external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)'
    ];
    
    const ed25519HelperAbi = [
        'function computeCommitment(bytes32 secret) external view returns (bytes32)'
    ];
    
    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, wsxmrAbi, wallet);
    const ed25519Helper = new ethers.Contract(ED25519_HELPER, ed25519HelperAbi, provider);
    
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
    
    // Generate secret and compute Ed25519 commitment
    const secret = ethers.utils.randomBytes(32);
    const claimCommitment = await ed25519Helper.computeCommitment(secret);
    const griefingDeposit = ethers.utils.parseEther('0.001');
    
    console.log('Secret:', ethers.utils.hexlify(secret));
    console.log('Commitment:', claimCommitment);
    
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
    
    // requestBurn returns the requestId directly
    const burnRequestId = await hub.callStatic.requestBurn(burnAmount, wallet.address, wallet.address);
    const burnTx = await hub.requestBurn(burnAmount, wallet.address, wallet.address);
    await burnTx.wait();
    
    console.log('✅ Burn requested!');
    console.log('Request ID:', burnRequestId);
    console.log('Amount:', ethers.utils.formatUnits(burnAmount, 12), 'wsXMR');
    console.log('');
    
    console.log('📊 Step 7: BURN - LP Proposes Hash');
    console.log('===================================');
    const burnSecret = ethers.utils.randomBytes(32);
    const secretHash = await ed25519Helper.computeCommitment(burnSecret);
    
    console.log('Burn Secret:', ethers.utils.hexlify(burnSecret));
    console.log('Secret Hash:', secretHash);
    
    const proposeHashTx = await hub.proposeHash(burnRequestId, secretHash);
    await proposeHashTx.wait();
    console.log('✅ LP proposed secret hash');
    console.log('');
    
    console.log('📊 Step 8: BURN - User Confirms Monero Lock');
    console.log('============================================');
    const confirmTx = await hub.confirmMoneroLock(burnRequestId, { gasLimit: 500000 });
    await confirmTx.wait();
    console.log('✅ User confirmed Monero lock');
    console.log('');
    
    console.log('📊 Step 9: BURN - LP Finalizes');
    console.log('===============================');
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
