#!/usr/bin/env node
/**
 * Co-LP open + unwind on HyperEVM mainnet.
 * Auto-buys USDe collateral + mints wsXMR if needed. Oracle = refreshPrices.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const { getWallet, getContracts, refreshPrices, ensureVault, mintWsXMR, send, sendRetry, cfg } = require('./hyperevmLib');

async function main() {
    const { provider, wallet } = getWallet();
    const c = getContracts(wallet, provider);
    console.log('Co-LP (HyperEVM) —', wallet.address);
    console.log('liquidityRouter:', await c.hub.liquidityRouter(), '\n');

    await ensureVault(wallet, c, ethers.utils.parseEther('0.2'));

    let wsxmrBal = await c.wsxmr.balanceOf(wallet.address);
    if (wsxmrBal.lt(20000)) {
        console.log('Minting wsXMR for Co-LP...');
        await mintWsXMR(wallet, c, ethers.BigNumber.from('200000000'));
        wsxmrBal = await c.wsxmr.balanceOf(wallet.address);
        console.log('  minted', ethers.utils.formatUnits(wsxmrBal, 8), 'wsXMR');
    }

    const toDeposit = wsxmrBal.div(2);
    if (toDeposit.eq(0)) { console.log('ERROR: no wsXMR for Co-LP'); process.exit(1); }
    console.log('Opening Co-LP with', ethers.utils.formatUnits(toDeposit, 8), 'wsXMR');
    await send(c.wsxmr.approve(cfg.HUB_ADDRESS, toDeposit), 'wsxmr.approve');
    await refreshPrices(c.hub);

    const deadline = Math.floor(Date.now()/1000)+3600;
    const rc = await sendRetry(() => c.hub.userOpenCoLP(wallet.address, toDeposit, deadline, { gasLimit: 2000000 }), 'userOpenCoLP');
    const tx = { hash: rc.transactionHash };
    let tokenId = null;
    for (const log of rc.logs) { try { const p = c.hub.interface.parseLog(log); if (p.name==='CoLPDeployed'){tokenId=p.args.tokenId;break;} } catch(e){} }
    console.log('  opened tokenId:', tokenId ? tokenId.toString() : '?', `| ${cfg.EXPLORER}/tx/${tx.hash}`);

    console.log('Unwinding...');
    await sendRetry(() => c.hub.unwindCoLP(tokenId, deadline, { gasLimit: 2000000 }), 'unwindCoLP');
    const pw = await c.hub.getPendingReturns(wallet.address, cfg.WSXMR_ADDRESS);
    if (pw.gt(0)) await sendRetry(() => c.hub.withdrawReturns(cfg.WSXMR_ADDRESS, { gasLimit: 300000 }), 'withdrawReturns');
    console.log('  unwound. final wsXMR:', ethers.utils.formatUnits(await c.wsxmr.balanceOf(wallet.address), 8));
    console.log('Co-LP test complete');
}
main().catch(e => { console.error(e); process.exit(1); });
