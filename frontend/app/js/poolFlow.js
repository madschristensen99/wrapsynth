// Co-LP Pairing Flow - Liquidity Router Integration

import { CONTRACTS, ABIS, DECIMALS } from './config.js';
import { readHub, writeHub, readWsxmr, writeWsxmr, getUserAddress, getPublicClient, getWalletClient } from './viemClient.js';
import { formatUnits, parseUnits, parseAbi } from 'https://esm.sh/viem@2.7.0';

export class PoolFlow {
    constructor() {
        this.userAddress = null;
        this.routerAvailable = false;
    }

    async init() {
        this.userAddress = getUserAddress();
        if (!this.userAddress) {
            throw new Error('Wallet not connected');
        }

        this.routerAvailable = CONTRACTS.liquidityRouter !== '0x0000000000000000000000000000000000000000';
        
        if (!this.routerAvailable) {
            console.warn('Liquidity router not yet deployed');
            return false;
        }

        return true;
    }

    async allocateLiquidity(sDAIAmount) {
        const amount = parseUnits(sDAIAmount.toString(), DECIMALS.ETH);
        
        const client = getWalletClient();
        const publicClient = getPublicClient();
        
        const { request } = await publicClient.simulateContract({
            address: CONTRACTS.liquidityRouter,
            abi: parseAbi(ABIS.liquidityRouter),
            functionName: 'allocateLiquidity',
            args: [amount],
            account: this.userAddress
        });
        
        const hash = await client.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        
        console.log('Liquidity allocated:', receipt.transactionHash);
        return receipt;
    }

    async depositWsxmr(wsxmrAmount) {
        const amount = parseUnits(wsxmrAmount.toString(), DECIMALS.wsXMR);
        
        await writeWsxmr('approve', [CONTRACTS.liquidityRouter, amount]);
        
        const client = getWalletClient();
        const publicClient = getPublicClient();
        
        const { request } = await publicClient.simulateContract({
            address: CONTRACTS.liquidityRouter,
            abi: parseAbi(ABIS.liquidityRouter),
            functionName: 'depositWsxmr',
            args: [amount],
            account: this.userAddress
        });
        
        const hash = await client.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        
        console.log('wsXMR deposited:', receipt.transactionHash);
        return receipt;
    }

    async createPosition(lpAddress, sDAIAmount, wsxmrAmount, deadline) {
        const sDAI = parseUnits(sDAIAmount.toString(), DECIMALS.ETH);
        const wsxmr = parseUnits(wsxmrAmount.toString(), DECIMALS.wsXMR);
        
        const client = getWalletClient();
        const publicClient = getPublicClient();
        
        const { request } = await publicClient.simulateContract({
            address: CONTRACTS.liquidityRouter,
            abi: parseAbi(ABIS.liquidityRouter),
            functionName: 'createPosition',
            args: [lpAddress, this.userAddress, sDAI, wsxmr, BigInt(deadline)],
            account: this.userAddress
        });
        
        const hash = await client.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        
        console.log('Position created:', receipt.transactionHash);
        return receipt;
    }

    async closePosition(positionIndex, deadline, minTotalValueUSD) {
        const minValue = parseUnits(minTotalValueUSD.toString(), DECIMALS.USD);
        
        const client = getWalletClient();
        const publicClient = getPublicClient();
        
        const { request } = await publicClient.simulateContract({
            address: CONTRACTS.liquidityRouter,
            abi: parseAbi(ABIS.liquidityRouter),
            functionName: 'closePosition',
            args: [BigInt(positionIndex), BigInt(deadline), minValue],
            account: this.userAddress
        });
        
        const hash = await client.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        
        console.log('Position closed:', receipt.transactionHash);
        return receipt;
    }

    async getUserPositions(cursor = 0, limit = 10) {
        const publicClient = getPublicClient();
        
        const result = await publicClient.readContract({
            address: CONTRACTS.liquidityRouter,
            abi: parseAbi(ABIS.liquidityRouter),
            functionName: 'getUserPositions',
            args: [this.userAddress, BigInt(cursor), BigInt(limit)]
        });
        
        return result;
    }

    async getLpAvailableLiquidity(lpAddress) {
        const publicClient = getPublicClient();
        
        return await publicClient.readContract({
            address: CONTRACTS.liquidityRouter,
            abi: parseAbi(ABIS.liquidityRouter),
            functionName: 'getLpAvailableLiquidity',
            args: [lpAddress]
        });
    }

    async getUserAvailableWsxmr() {
        const publicClient = getPublicClient();
        
        return await publicClient.readContract({
            address: CONTRACTS.liquidityRouter,
            abi: parseAbi(ABIS.liquidityRouter),
            functionName: 'getUserAvailableWsxmr',
            args: [this.userAddress]
        });
    }

    async getPendingFees() {
        const publicClient = getPublicClient();
        
        return await publicClient.readContract({
            address: CONTRACTS.liquidityRouter,
            abi: parseAbi(ABIS.liquidityRouter),
            functionName: 'getPendingFees',
            args: [this.userAddress]
        });
    }

    async withdrawFees() {
        const client = getWalletClient();
        const publicClient = getPublicClient();
        
        const { request } = await publicClient.simulateContract({
            address: CONTRACTS.liquidityRouter,
            abi: parseAbi(ABIS.liquidityRouter),
            functionName: 'withdrawFees',
            args: [],
            account: this.userAddress
        });
        
        const hash = await client.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        
        console.log('Fees withdrawn:', receipt.transactionHash);
        return receipt;
    }

    async increaseLpApproval(lpAddress, additionalWsxmr) {
        const amount = parseUnits(additionalWsxmr.toString(), DECIMALS.wsXMR);
        
        const client = getWalletClient();
        const publicClient = getPublicClient();
        
        const { request } = await publicClient.simulateContract({
            address: CONTRACTS.liquidityRouter,
            abi: parseAbi(ABIS.liquidityRouter),
            functionName: 'increaseLpApproval',
            args: [lpAddress, amount],
            account: this.userAddress
        });
        
        const hash = await client.writeContract(request);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        
        console.log('LP approval increased:', receipt.transactionHash);
        return receipt;
    }
}

let poolFlowInstance = null;

export function getPoolFlow() {
    if (!poolFlowInstance) {
        poolFlowInstance = new PoolFlow();
    }
    return poolFlowInstance;
}
