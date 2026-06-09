#!/usr/bin/env node
/**
 * Simple deployment verification - check contracts are deployed and accessible
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { HUB_ADDRESS, WSXMR_ADDRESS, POOL_ADDRESS, SDAI_ADDRESS } = require('./deploymentConfig');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log('🔍 Deployment Verification');
    console.log('==========================');
    console.log('Network: Gnosis Chain');
    console.log('Wallet:', wallet.address);
    console.log('');
    
    // Check contract deployments
    console.log('📋 Contract Addresses:');
    console.log('======================');
    console.log('wsXMR:          ', WSXMR_ADDRESS);
    console.log('wsXmrHub:       ', HUB_ADDRESS);
    console.log('Uniswap V3 Pool:', POOL_ADDRESS);
    console.log('sDAI:           ', SDAI_ADDRESS);
    console.log('');
    
    // Check contract code exists
    console.log('✅ Checking Contracts...');
    const wsxmrCode = await provider.getCode(WSXMR_ADDRESS);
    const hubCode = await provider.getCode(HUB_ADDRESS);
    const poolCode = await provider.getCode(POOL_ADDRESS);
    
    if (wsxmrCode === '0x') throw new Error('wsXMR not deployed!');
    if (hubCode === '0x') throw new Error('Hub not deployed!');
    if (poolCode === '0x') throw new Error('Pool not deployed!');
    
    console.log('✅ All contracts deployed');
    console.log('');
    
    // Check wsXMR token
    const wsxmrAbi = [
        'function name() external view returns (string)',
        'function symbol() external view returns (string)',
        'function decimals() external view returns (uint8)',
        'function totalSupply() external view returns (uint256)',
        'function balanceOf(address) external view returns (uint256)'
    ];
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, wsxmrAbi, provider);
    
    const name = await wsxmr.name();
    const symbol = await wsxmr.symbol();
    const decimals = await wsxmr.decimals();
    const totalSupply = await wsxmr.totalSupply();
    const userBalance = await wsxmr.balanceOf(wallet.address);
    
    console.log('📊 wsXMR Token Info:');
    console.log('====================');
    console.log('Name:        ', name);
    console.log('Symbol:      ', symbol);
    console.log('Decimals:    ', decimals);
    console.log('Total Supply:', ethers.utils.formatUnits(totalSupply, decimals), symbol);
    console.log('Your Balance:', ethers.utils.formatUnits(userBalance, decimals), symbol);
    console.log('');
    
    // Check pool
    const poolAbi = [
        'function slot0() external view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
        'function liquidity() external view returns (uint128)',
        'function token0() external view returns (address)',
        'function token1() external view returns (address)',
        'function fee() external view returns (uint24)'
    ];
    const pool = new ethers.Contract(POOL_ADDRESS, poolAbi, provider);
    
    const slot0 = await pool.slot0();
    const liquidity = await pool.liquidity();
    const token0 = await pool.token0();
    const token1 = await pool.token1();
    const fee = await pool.fee();
    
    console.log('🏊 Uniswap V3 Pool Info:');
    console.log('========================');
    console.log('Token0:      ', token0);
    console.log('Token1:      ', token1);
    console.log('Fee Tier:    ', fee, 'bps');
    console.log('Tick:        ', slot0.tick);
    console.log('Liquidity:   ', liquidity.toString());
    console.log('Initialized: ', slot0.sqrtPriceX96.gt(0) ? 'Yes' : 'No');
    console.log('');
    
    // Check hub
    const hubAbi = [
        'function hasActiveVault(address) external view returns (bool)',
        'function liquidityRouter() external view returns (address)'
    ];
    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, provider);
    
    const hasVault = await hub.hasActiveVault(wallet.address);
    const router = await hub.liquidityRouter();
    
    console.log('🏛️  Hub Info:');
    console.log('=============');
    console.log('Liquidity Router:', router);
    console.log('Your Vault:      ', hasVault ? 'Active' : 'Not created');
    console.log('');
    
    console.log('✅ All Checks Passed!');
    console.log('====================');
    console.log('Deployment is healthy and ready to use.');
    console.log('');
    console.log('Next steps:');
    console.log('1. Create vault: hub.createVault()');
    console.log('2. Deposit collateral: hub.depositCollateral(amount)');
    console.log('3. Configure vault parameters');
    console.log('4. Start LP node for automated operations');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('❌ Error:', error.message);
        process.exit(1);
    });
