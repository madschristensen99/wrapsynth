#!/usr/bin/env node
/** One-off: burn the wsXMR already minted on Base (continuation of the full-cycle test). */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');
const { redstoneGatewayUrls } = require('./redstoneGateway');
const { HUB_ADDRESS, WSXMR_ADDRESS, ED25519_HELPER, RPC_URL } = require('./deploymentConfig.base');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const w = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const hub = new ethers.Contract(HUB_ADDRESS, [
        'function requestBurn(uint256,address,address,bytes32,bytes32,bytes32) external returns (bytes32)',
        'function proposeHash(bytes32,bytes32,bytes32,bytes32) external',
        'function confirmMoneroLock(bytes32) external',
        'function finalizeBurn(bytes32,bytes32) external',
        'function updateOraclePrices(bytes[]) external payable',
        'function getXmrPrice() view returns (uint256)'
    ], w);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256)', 'function totalSupply() view returns (uint256)'], w);
    const helper = new ethers.Contract(ED25519_HELPER, ['function computeCommitment(bytes32) view returns (bytes32)', 'function scalarMultBase(uint256) view returns (uint256,uint256)'], provider);
    const wrapped = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: 'redstone-primary-prod', uniqueSignersCount: 3, dataPackagesIds: ['XMR'],
        authorizedSigners: getSignersForDataServiceId('redstone-primary-prod'),
        urls: redstoneGatewayUrls()
    });

    try { await hub.getXmrPrice(); console.log('prices fresh'); }
    catch { const t = await wrapped.updateOraclePrices([]); await t.wait(); console.log('pushed:', t.hash); }

    const bal = await wsxmr.balanceOf(w.address);
    console.log('burning', ethers.utils.formatUnits(bal, 8), 'wsXMR');
    await (await wsxmr.approve(HUB_ADDRESS, bal)).wait();
    const reqId = await hub.callStatic.requestBurn(bal, w.address, w.address, ethers.utils.id('t'), ethers.utils.id('p'), ethers.utils.id('v'));
    const btx = await hub.requestBurn(bal, w.address, w.address, ethers.utils.id('t'), ethers.utils.id('p'), ethers.utils.id('v'), { gasLimit: 800000 });
    await btx.wait(); console.log('requestBurn:', btx.hash);

    const secret = ethers.utils.randomBytes(32);
    const sh = await helper.computeCommitment(secret);
    const [px, py] = await helper.scalarMultBase(ethers.BigNumber.from(secret));
    const ptx = await hub.proposeHash(reqId, sh, ethers.utils.hexZeroPad(px.toHexString(), 32), ethers.utils.hexZeroPad(py.toHexString(), 32), { gasLimit: 400000 });
    await ptx.wait(); console.log('proposeHash:', ptx.hash);

    const ctx = await hub.confirmMoneroLock(reqId, { gasLimit: 400000 });
    await ctx.wait(); console.log('confirmMoneroLock:', ctx.hash);

    const ftx = await hub.finalizeBurn(reqId, secret, { gasLimit: 800000 });
    const fr = await ftx.wait(); console.log('finalizeBurn:', ftx.hash, 'gas:', fr.gasUsed.toString());
    console.log('wsXMR bal:', ethers.utils.formatUnits(await wsxmr.balanceOf(w.address), 8), '| supply:', ethers.utils.formatUnits(await wsxmr.totalSupply(), 8));
    console.log('ETH left:', ethers.utils.formatEther(await provider.getBalance(w.address)));
}
main().catch(e => { console.error(e); process.exit(1); });
