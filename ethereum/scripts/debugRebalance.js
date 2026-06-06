#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

const HUB_ADDRESS = '0xd32e2ece901094550b81ab5051a72256761514d6';
const ROUTER_ADDRESS = '0x3235ffe7B51b3726BC0F398da21eD0583103F106';
const TOKEN_ID = 5477;

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const hubAbi = [
        'function rebalanceCoLP(uint256 tokenId, uint16 newRangeBps, uint256 deadline) external',
        'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps))'
    ];

    const routerAbi = [
        'function isPositionOutOfRange(uint256 tokenId, uint256 xmrPrice) external view returns (bool)',
        'function pool() external view returns (address)'
    ];

    const poolAbi = [
        'function slot0() external view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)'
    ];

    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, provider);
    const router = new ethers.Contract(ROUTER_ADDRESS, routerAbi, provider);

    console.log('Checking if position is out of range...');

    // Get current XMR price from oracle facet
    const oracleAbi = ['function getXmrPrice() external view returns (uint256)'];
    // Need oracle facet address - let's try calling through hub

    // Try calling isPositionOutOfRange with a reasonable price ($300 = 300e18)
    const testPrice = ethers.utils.parseUnits('300', '18');
    try {
        const outOfRange = await router.isPositionOutOfRange(TOKEN_ID, testPrice);
        console.log('isPositionOutOfRange($300):', outOfRange);
    } catch (e) {
        console.log('Error calling isPositionOutOfRange:', e.message);
    }

    // Get pool slot0
    const poolAddr = await router.pool();
    const pool = new ethers.Contract(poolAddr, poolAbi, provider);
    const slot0 = await pool.slot0();
    console.log('Pool tick:', slot0.tick);

    // Now try to simulate rebalanceCoLP
    const vault = await hub.getVault(wallet.address);
    console.log('Vault maxCoLPRangeBps:', vault.maxCoLPRangeBps);

    console.log('\nSimulating rebalanceCoLP...');
    try {
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        await hub.connect(wallet).callStatic.rebalanceCoLP(TOKEN_ID, 500, deadline);
        console.log('Simulation succeeded!');
    } catch (e) {
        console.log('Simulation failed:', e.reason || e.message);
        if (e.error && e.error.body) {
            try {
                const decoded = ethers.utils.defaultAbiCoder.decode(['string'], '0x' + e.error.body.slice(138));
                console.log('Revert reason:', decoded[0]);
            } catch (decErr) {}
        }
    }
}

main().catch(console.error);
