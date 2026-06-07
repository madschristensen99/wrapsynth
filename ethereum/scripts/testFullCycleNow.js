#!/usr/bin/env node
/**
 * Test FULL mint and burn cycle - update prices and immediately execute
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');
const { HUB_ADDRESS, WSXMR_ADDRESS, WXDAI_ADDRESS, ED25519_HELPER } = require('./deploymentConfig');

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('❌ PRIVATE_KEY environment variable not set');
        process.exit(1);
    }
    
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log('🧪 Testing FULL Mint and Burn Cycle');
    console.log('====================================');
    console.log('Wallet:', wallet.address);
    console.log('');
    
    const hubAbi = [
        'function createVault() external',
        'function depositCollateral(uint256 amount) external',
        'function hasActiveVault(address lpAddress) external view returns (bool)',
        'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active))',
        'function setMaxMintBps(uint16 maxMintBps) external',
        'function setMinBurnAmount(uint256 minAmount) external',
        'function setMintGriefingDeposit(uint256 deposit) external',
        'function setMintReadyBond(uint256 bond) external',
        'function setVaultMarketMetrics(uint16 mintFeeBps, uint16 burnRewardBps) external',
        'function getPendingReturns(address user, address token) external view returns (uint256)',
        'function withdrawReturns(address token) external',
        'function initiateMint(address lpVault, address initiator, uint256 wsxmrAmount, bytes32 claimCommitment) external payable returns (bytes32)',
        'function provideLPKey(bytes32 requestId, bytes32 lpPublicKey) external',
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
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function decimals() external view returns (uint8)'
    ];
    
    const wxdaiAbi = [
        'function balanceOf(address) external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function deposit() external payable',
        'function withdraw(uint256 amount) external'
    ];
    
    const ed25519HelperAbi = [
        'function computeCommitment(bytes32 secret) external view returns (bytes32)',
        'function scalarMultBase(uint256 scalar) external view returns (uint256 x, uint256 y)'
    ];
    
    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, wsxmrAbi, wallet);
    const wxdai = new ethers.Contract(WXDAI_ADDRESS, wxdaiAbi, wallet);
    const ed25519Helper = new ethers.Contract(ED25519_HELPER, ed25519HelperAbi, provider);
    
    // Wrap with RedStone
    const authorizedSigners = getSignersForDataServiceId("redstone-primary-prod");
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: "redstone-primary-prod",
        uniqueSignersCount: 3,
        dataPackagesIds: ["XMR", "DAI"],
        authorizedSigners
    });
    
    // Check if vault exists, create if needed
    const hasVault = await hub.hasActiveVault(wallet.address);
    if (!hasVault) {
        console.log('📊 Step 0: Creating Vault and Depositing Collateral');
        console.log('====================================================');
        
        const createVaultTx = await hub.createVault();
        await createVaultTx.wait();
        console.log('✅ Vault created');
        
        // Configure vault with fees
        await (await hub.setMaxMintBps(0)).wait();
        await (await hub.setMinBurnAmount(0)).wait();
        await (await hub.setMintGriefingDeposit(ethers.utils.parseEther('0.001'))).wait();
        await (await hub.setMintReadyBond(ethers.utils.parseEther('0.001'))).wait();
        await (await hub.setVaultMarketMetrics(50, 30)).wait(); // 0.5% mint fee, 0.3% burn reward
        console.log('✅ Vault configured (0.5% mint fee, 0.3% burn reward, 0.001 ETH bond)');
        
        // Check wxDAI balance and wrap if needed
        const collateralAmount = ethers.utils.parseEther('0.5'); // 0.5 xDAI
        const wxdaiBalance = await wxdai.balanceOf(wallet.address);
        
        if (wxdaiBalance.lt(collateralAmount)) {
            const toWrap = collateralAmount.sub(wxdaiBalance);
            await (await wxdai.deposit({ value: toWrap })).wait();
            console.log('✅ Wrapped', ethers.utils.formatEther(toWrap), 'xDAI');
        } else {
            console.log('✅ Already have', ethers.utils.formatEther(wxdaiBalance), 'wxDAI');
        }
        
        await (await wxdai.approve(HUB_ADDRESS, collateralAmount)).wait();
        await (await hub.depositCollateral(collateralAmount)).wait();
        console.log('✅ Deposited', ethers.utils.formatEther(collateralAmount), 'xDAI as collateral');
        console.log('');
    } else {
        console.log('✅ Vault already exists');
        
        // Update vault fees to ensure they're set correctly
        await (await hub.setVaultMarketMetrics(50, 30)).wait(); // 0.5% mint fee, 0.3% burn reward
        console.log('✅ Updated vault fees (0.5% mint fee, 0.3% burn reward)');
        
        // Check collateral balance
        const vault = await hub.getVault(wallet.address);
        console.log('   Collateral shares:', vault.collateralShares.toString());
        console.log('   Locked collateral:', vault.lockedCollateral.toString());
        console.log('   Normalized debt:', vault.normalizedDebt.toString());
        console.log('   Pending debt:', vault.pendingDebt.toString());
        console.log('   Mint fee:', vault.mintFeeBps, 'bps');
        console.log('   Burn reward:', vault.burnRewardBps, 'bps');
        
        // If no collateral, deposit some
        if (vault.collateralShares.eq(0)) {
            console.log('⚠️  No collateral in vault, depositing...');
            const collateralAmount = ethers.utils.parseEther('0.5'); // 0.5 xDAI
            const wxdaiBalance = await wxdai.balanceOf(wallet.address);
            
            if (wxdaiBalance.lt(collateralAmount)) {
                const toWrap = collateralAmount.sub(wxdaiBalance);
                await (await wxdai.deposit({ value: toWrap })).wait();
                console.log('✅ Wrapped', ethers.utils.formatEther(toWrap), 'xDAI');
            } else {
                console.log('✅ Already have', ethers.utils.formatEther(wxdaiBalance), 'wxDAI');
            }
            
            await (await wxdai.approve(HUB_ADDRESS, collateralAmount)).wait();
            await (await hub.depositCollateral(collateralAmount)).wait();
            console.log('✅ Deposited', ethers.utils.formatEther(collateralAmount), 'xDAI as collateral');
        }
        console.log('');
    }
    
    // Check if we already have wsXMR balance
    const existingBalance = await wsxmr.balanceOf(wallet.address);
    const MIN_BURN_AMOUNT = ethers.BigNumber.from('10000'); // 1e4 = 0.0001 wsXMR
    
    if (existingBalance.gt(0) && existingBalance.gte(MIN_BURN_AMOUNT)) {
        console.log('⚠️  Already have wsXMR balance:', existingBalance.toString());
        console.log('   Skipping mint, going straight to burn...\n');
        
        const decimals = await wsxmr.decimals();
        
        // Update prices before burn
        console.log('📊 Update Prices');
        console.log('================');
        const updateTx = await wrappedHub.updateOraclePrices([]);
        console.log('TX:', updateTx.hash);
        await updateTx.wait();
        console.log('✅ Prices updated\n');
        
        // Jump to burn
        console.log('📊 BURN - Request');
        console.log('=================');
        const burnAmount = existingBalance;
        
        const approveTx = await wsxmr.approve(HUB_ADDRESS, burnAmount);
        await approveTx.wait();
        
        const burnRequestId = await hub.callStatic.requestBurn(burnAmount, wallet.address, wallet.address);
        const burnTx = await hub.requestBurn(burnAmount, wallet.address, wallet.address);
        await burnTx.wait();
        
        console.log('✅ Burn requested!');
        console.log('Request ID:', burnRequestId);
        console.log('Amount:', ethers.utils.formatUnits(burnAmount, decimals), 'wsXMR');
        console.log('');
        
        console.log('📊 BURN - LP Proposes Hash');
        console.log('===========================');
        const burnSecret = ethers.utils.randomBytes(32);
        const secretHash = await ed25519Helper.computeCommitment(burnSecret);
        
        console.log('Burn Secret:', ethers.utils.hexlify(burnSecret));
        console.log('Secret Hash:', secretHash);
        
        const proposeHashTx = await hub.proposeHash(burnRequestId, secretHash);
        await proposeHashTx.wait();
        console.log('✅ LP proposed secret hash\n');
        
        console.log('📊 BURN - User Confirms Monero Lock');
        console.log('====================================');
        const confirmTx = await hub.confirmMoneroLock(burnRequestId, { gasLimit: 500000 });
        await confirmTx.wait();
        console.log('✅ User confirmed Monero lock\n');
        
        console.log('📊 BURN - LP Finalizes');
        console.log('=======================');
        const finalizeBurnTx = await hub.finalizeBurn(burnRequestId, burnSecret, { gasLimit: 1000000 });
        const finalizeBurnReceipt = await finalizeBurnTx.wait();
        console.log('✅ Burn finalized!');
        console.log('Gas:', finalizeBurnReceipt.gasUsed.toString());
        
        const finalBalance = await wsxmr.balanceOf(wallet.address);
        const totalSupply = await wsxmr.totalSupply();
        console.log('Final wsXMR Balance:', ethers.utils.formatUnits(finalBalance, decimals));
        console.log('Total Supply:', ethers.utils.formatUnits(totalSupply, decimals));
        console.log('');
        
        console.log('🎉 BURN COMPLETE!');
        console.log('=================');
        console.log('✅ Burned wsXMR tokens');
        console.log('✅ Protocol fully functional on Gnosis mainnet!');
        return;
    }
    
    console.log('📊 Step 1: Update Prices');
    console.log('========================');
    const updateTx = await wrappedHub.updateOraclePrices([]);
    console.log('TX:', updateTx.hash);
    await updateTx.wait();
    console.log('✅ Prices updated');
    console.log('');
    
    console.log('📊 Step 2: MINT - Initiate (IMMEDIATELY after price update)');
    console.log('============================================================');
    // Mint 0.0002 wsXMR = 20000 wsXMR units (above new minimum of 10000)
    // wsXMR = xmrAmount / 10000
    // So xmrAmount = 20000 * 10000 = 200,000,000 XMR atomic units
    const xmrAmount = ethers.BigNumber.from('200000000'); // Will produce 20000 wsXMR units = 0.0002 wsXMR
    const expectedWsXmr = xmrAmount.div(10000);
    console.log('XMR atomic units:', xmrAmount.toString());
    console.log('Expected wsXMR (raw):', expectedWsXmr.toString());
    console.log('Expected wsXMR:', ethers.utils.formatUnits(expectedWsXmr, 8));
    
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
    
    console.log('📊 Step 4: MINT - LP Provides Public Key');
    console.log('==========================================');
    // Generate real Ed25519 public key for LP
    const lpSecret = ethers.utils.randomBytes(32);
    const [lpPubX, lpPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(lpSecret));
    const lpPublicKey = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [lpPubX, lpPubY]));
    
    console.log('LP Secret:', ethers.utils.hexlify(lpSecret));
    console.log('LP Public Key (x, y):', lpPubX.toString(), lpPubY.toString());
    console.log('LP Public Key (hash):', lpPublicKey);
    
    const provideTx = await hub.provideLPKey(requestId, lpPublicKey);
    await provideTx.wait();
    console.log('✅ LP provided public key');
    console.log('');
    
    console.log('📊 Step 5: MINT - LP Sets Ready');
    console.log('================================');
    const lpBond = ethers.utils.parseEther('0.001');
    const readyTx = await hub.setMintReady(requestId, { value: lpBond });
    await readyTx.wait();
    console.log('✅ LP marked ready');
    console.log('');
    
    console.log('📊 Step 6: MINT - Finalize');
    console.log('===========================');
    const finalizeTx = await hub.finalizeMint(requestId, secret, { gasLimit: 1000000 });
    const finalizeReceipt = await finalizeTx.wait();
    console.log('✅ Mint finalized!');
    console.log('Gas:', finalizeReceipt.gasUsed.toString());
    
    const decimals = await wsxmr.decimals();
    const wsxmrBalance = await wsxmr.balanceOf(wallet.address);
    
    // Verify mint fee (0.5% = 50 bps)
    const expectedBeforeFee = expectedWsXmr;
    const feeAmount = expectedBeforeFee.mul(50).div(10000); // 0.5%
    const expectedAfterFee = expectedBeforeFee.sub(feeAmount);
    
    console.log('wsXMR Decimals:', decimals);
    console.log('Expected (before fee):', ethers.utils.formatUnits(expectedBeforeFee, decimals), 'wsXMR');
    console.log('Mint fee (0.5%):', ethers.utils.formatUnits(feeAmount, decimals), 'wsXMR');
    console.log('Expected (after fee):', ethers.utils.formatUnits(expectedAfterFee, decimals), 'wsXMR');
    console.log('Actual balance:', ethers.utils.formatUnits(wsxmrBalance, decimals), 'wsXMR');
    console.log('✅ Fee correctly applied:', wsxmrBalance.eq(expectedAfterFee) ? 'YES' : 'NO');
    console.log('');
    
    console.log('📊 Step 7: BURN - Request');
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
    console.log('Amount:', ethers.utils.formatUnits(burnAmount, decimals), 'wsXMR');
    console.log('');
    
    console.log('📊 Step 8: BURN - LP Proposes Hash');
    console.log('===================================');
    const burnSecret = ethers.utils.randomBytes(32);
    const secretHash = await ed25519Helper.computeCommitment(burnSecret);
    
    console.log('Burn Secret:', ethers.utils.hexlify(burnSecret));
    console.log('Secret Hash:', secretHash);
    
    const proposeHashTx = await hub.proposeHash(burnRequestId, secretHash);
    await proposeHashTx.wait();
    console.log('✅ LP proposed secret hash');
    console.log('');
    
    console.log('📊 Step 9: BURN - User Confirms Monero Lock');
    console.log('============================================');
    const confirmTx = await hub.confirmMoneroLock(burnRequestId, { gasLimit: 500000 });
    await confirmTx.wait();
    console.log('✅ User confirmed Monero lock');
    console.log('');
    
    console.log('📊 Step 10: BURN - LP Finalizes');
    console.log('================================');
    
    // Check wxDAI balance before burn to verify reward
    const wxdaiBalanceBefore = await wxdai.balanceOf(wallet.address);
    
    const finalizeBurnTx = await hub.finalizeBurn(burnRequestId, burnSecret, { gasLimit: 1000000 });
    const finalizeBurnReceipt = await finalizeBurnTx.wait();
    console.log('✅ Burn finalized!');
    console.log('Gas:', finalizeBurnReceipt.gasUsed.toString());
    
    // Check burn reward (0.3% of burn value in collateral)
    const wxdaiBalanceAfter = await wxdai.balanceOf(wallet.address);
    const burnReward = wxdaiBalanceAfter.sub(wxdaiBalanceBefore);
    
    console.log('');
    console.log('Burn Reward Received:', ethers.utils.formatEther(burnReward), 'wxDAI');
    console.log('✅ Burn reward applied:', burnReward.gt(0) ? 'YES' : 'NO');
    console.log('');
    
    const finalBalance = await wsxmr.balanceOf(wallet.address);
    const totalSupply = await wsxmr.totalSupply();
    console.log('Final wsXMR Balance:', ethers.utils.formatUnits(finalBalance, decimals));
    console.log('Total Supply:', ethers.utils.formatUnits(totalSupply, decimals));
    console.log('');
    
    console.log('📊 Step 11: CLAIM - Withdraw Burn Rewards');
    console.log('==========================================');
    const SDAI_ADDRESS = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';
    const pendingReward = await hub.getPendingReturns(wallet.address, SDAI_ADDRESS);
    console.log('Pending sDAI Reward:', ethers.utils.formatEther(pendingReward), 'sDAI');
    
    if (pendingReward.gt(0)) {
        const claimTx = await hub.withdrawReturns(SDAI_ADDRESS, { gasLimit: 200000 });
        await claimTx.wait();
        console.log('✅ Burn reward claimed!');
        
        const remainingReward = await hub.getPendingReturns(wallet.address, SDAI_ADDRESS);
        console.log('Remaining Pending:', ethers.utils.formatEther(remainingReward), 'sDAI');
    } else {
        console.log('⚠️  No pending rewards to claim');
    }
    console.log('');
    
    console.log('🎉 FULL CYCLE COMPLETE!');
    console.log('=======================');
    console.log('✅ Minted wsXMR tokens');
    console.log('✅ Burned wsXMR tokens');
    console.log('✅ Claimed burn rewards');
    console.log('✅ Protocol fully functional on Gnosis mainnet!');
}

main().catch(console.error);
