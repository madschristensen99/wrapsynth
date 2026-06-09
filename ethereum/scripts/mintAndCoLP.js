#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');
const { HUB_ADDRESS, WSXMR_ADDRESS, ED25519_HELPER } = require('./deploymentConfig');

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log('Wallet:', wallet.address);

    const hubAbi = [
        'function initiateMint(address lpVault, address initiator, uint256 wsxmrAmount, bytes32 claimCommitment, bytes32 userPublicKey) external payable returns (bytes32)',
        'function provideLPKey(bytes32 requestId, bytes32 lpPublicKey) external',
        'function setMintReady(bytes32 requestId) external payable',
        'function finalizeMint(bytes32 requestId, bytes32 secret) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable',
        'function userOpenCoLP(address lpVault, uint256 wsxmrAmount, uint256 deadline) external returns (uint256 tokenId)',
        'function hasActiveVault(address lpAddress) external view returns (bool)',
        'function getPendingReturns(address user, address token) external view returns (uint256)',
        'function withdrawReturns(address token) external',
        'event CoLPDeployed(address indexed lpVault, address indexed user, uint256 indexed tokenId, uint256 sDAIShares, uint256 wsxmrAmount, uint16 rangeBps)'
    ];

    const wsxmrAbi = [
        'function balanceOf(address) external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function decimals() external view returns (uint8)'
    ];

    const ed25519HelperAbi = [
        'function computeCommitment(bytes32 secret) external view returns (bytes32)',
        'function scalarMultBase(uint256 scalar) external view returns (uint256 x, uint256 y)'
    ];

    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, wsxmrAbi, wallet);
    const ed25519Helper = new ethers.Contract(ED25519_HELPER, ed25519HelperAbi, provider);

    const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: 'redstone-primary-prod',
        uniqueSignersCount: 3,
        dataPackagesIds: ['XMR', 'DAI'],
        authorizedSigners
    });

    // Step 1: Push fresh prices
    console.log('Pushing fresh oracle prices...');
    const priceTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
    await priceTx.wait();
    console.log('  Prices updated:', priceTx.hash);

    // Step 2: Mint wsXMR
    console.log('Minting wsXMR...');
    const secret = ethers.utils.randomBytes(32);
    const secretHex = ethers.utils.hexlify(secret);
    console.log('  Secret (save this!):', secretHex);
    const commitment = await ed25519Helper.computeCommitment(secret);
    const xmrAmount = ethers.BigNumber.from('100000000'); // produces 10000 wsXMR (0.0001) - smaller amount
    const griefingDeposit = ethers.utils.parseEther('0.001');

    const [userPubX, userPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(secret));
    const userPublicKey = ethers.utils.hexZeroPad(userPubX.toHexString(), 32);

    const mintTx = await hub.initiateMint(
        wallet.address,
        wallet.address,
        xmrAmount,
        commitment,
        userPublicKey,
        { value: griefingDeposit, gasLimit: 500000, maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('20', 'gwei') }
    );
    const mintReceipt = await mintTx.wait();
    const requestId = mintReceipt.logs[0].topics[1];
    console.log('  Mint initiated:', mintTx.hash);
    console.log('  Request ID:', requestId);

    // Refresh prices
    const refreshTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
    await refreshTx.wait();
    console.log('  Prices refreshed');

    // LP key
    const lpSecret = ethers.utils.randomBytes(32);
    const [lpPubX, lpPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(lpSecret));
    const lpPublicKey = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [lpPubX, lpPubY]));
    const provideTx = await hub.provideLPKey(requestId, lpPublicKey, { gasLimit: 200000, maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('20', 'gwei') });
    await provideTx.wait();
    console.log('  LP key provided');

    const readyTx = await hub.setMintReady(requestId, { value: griefingDeposit, gasLimit: 200000, maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('20', 'gwei') });
    await readyTx.wait();
    console.log('  Mint ready');

    const finalizeTx = await hub.finalizeMint(requestId, secret, { gasLimit: 1000000, maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('20', 'gwei') });
    await finalizeTx.wait();
    console.log('  Mint finalized:', finalizeTx.hash);

    const wsxmrBalance = await wsxmr.balanceOf(wallet.address);
    console.log('  wsXMR balance after mint:', ethers.utils.formatUnits(wsxmrBalance, 8));

    // Step 3: Co-LP half
    const wsxmrToDeposit = wsxmrBalance.div(2);
    console.log('Co-LPing', ethers.utils.formatUnits(wsxmrToDeposit, 8), 'wsXMR...');

    if (wsxmrToDeposit.eq(0)) {
        console.error('ERROR: wsxmrToDeposit is 0');
        process.exit(1);
    }

    const approveTx = await wsxmr.approve(HUB_ADDRESS, wsxmrToDeposit, { maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('20', 'gwei') });
    await approveTx.wait();

    const preCoLPTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
    await preCoLPTx.wait();
    console.log('  Prices pushed');

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const coLPTx = await hub.userOpenCoLP(wallet.address, wsxmrToDeposit, deadline, { gasLimit: 2000000, maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('20', 'gwei') });
    const coLPReceipt = await coLPTx.wait();
    console.log('  Co-LP TX:', coLPTx.hash);

    let tokenId = null;
    if (coLPReceipt.events) {
        const evt = coLPReceipt.events.find(e => e.event === 'CoLPDeployed');
        if (evt) tokenId = evt.args.tokenId;
    }
    if (!tokenId) {
        for (const log of coLPReceipt.logs) {
            try {
                const parsed = hub.interface.parseLog(log);
                if (parsed.name === 'CoLPDeployed') {
                    tokenId = parsed.args.tokenId;
                    break;
                }
            } catch (e) {}
        }
    }

    console.log('  Token ID:', tokenId ? ethers.BigNumber.from(tokenId).toString() : 'unknown');
    console.log('  View on Gnosisscan: https://gnosisscan.io/tx/' + coLPTx.hash);

    const finalBalance = await wsxmr.balanceOf(wallet.address);
    console.log('  Final wsXMR balance:', ethers.utils.formatUnits(finalBalance, 8));
    console.log('Done!');
}

main().catch(console.error);
