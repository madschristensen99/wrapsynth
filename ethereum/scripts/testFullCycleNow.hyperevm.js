#!/usr/bin/env node
/**
 * FULL mint->coLP->burn->claim cycle on HyperEVM mainnet.
 * Auto-buys USDe (HYPE->WHYPE->USDe) if the wallet is short.
 * Oracle = HyperCore refreshPrices. No real Monero tx needed.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const { getWallet, getContracts, refreshPrices, ensureVault, mintWsXMR, cfg } = require('./hyperevmLib');

async function main() {
    const { provider, wallet } = getWallet();
    const c = getContracts(wallet, provider);
    console.log('FULL CYCLE (HyperEVM) —', wallet.address);
    console.log('HYPE:', ethers.utils.formatEther(await wallet.getBalance()), '\n');

    // Vault + 0.5 USDe collateral (auto-buys USDe if short)
    await ensureVault(wallet, c, ethers.utils.parseEther('0.5'));

    // If we already hold wsXMR, skip to burn
    let bal = await c.wsxmr.balanceOf(wallet.address);
    if (bal.lt(10000)) {
        console.log('MINT — initiating (0.0002 wsXMR)');
        await mintWsXMR(wallet, c, ethers.BigNumber.from('200000000'));
        bal = await c.wsxmr.balanceOf(wallet.address);
        console.log('Minted:', ethers.utils.formatUnits(bal, 8), 'wsXMR\n');
    } else {
        console.log('Already hold', ethers.utils.formatUnits(bal, 8), 'wsXMR — skip mint\n');
    }

    // Co-LP open + unwind
    const coLPAmount = bal.div(2);
    if (coLPAmount.gt(0)) {
        console.log('CO-LP — open + unwind', ethers.utils.formatUnits(coLPAmount, 8), 'wsXMR');
        await (await c.wsxmr.approve(cfg.HUB_ADDRESS, coLPAmount)).wait();
        try {
            const tx = await c.hub.userOpenCoLP(wallet.address, coLPAmount, Math.floor(Date.now()/1000)+3600, { gasLimit: 2000000 });
            const rc = await tx.wait();
            let tokenId = null;
            for (const log of rc.logs) { try { const p = c.hub.interface.parseLog(log); if (p.name==='CoLPDeployed'){tokenId=p.args.tokenId;break;} } catch(e){} }
            console.log('  opened tokenId:', tokenId ? tokenId.toString() : '?');
            if (tokenId) {
                await (await c.hub.unwindCoLP(tokenId, Math.floor(Date.now()/1000)+3600, { gasLimit: 2000000 })).wait();
                const pw = await c.hub.getPendingReturns(wallet.address, cfg.WSXMR_ADDRESS);
                if (pw.gt(0)) await (await c.hub.withdrawReturns(cfg.WSXMR_ADDRESS, { gasLimit: 300000 })).wait();
                console.log('  unwound + returns claimed');
            }
        } catch (e) { console.log('  co-LP failed (needs pool liquidity):', (e.reason||e.message).split('\n')[0]); }
        console.log('');
    }

    // Burn
    const burnAmount = await c.wsxmr.balanceOf(wallet.address);
    if (burnAmount.gt(0)) {
        console.log('BURN —', ethers.utils.formatUnits(burnAmount, 8), 'wsXMR');
        await refreshPrices(c.hub);
        await (await c.wsxmr.approve(cfg.HUB_ADDRESS, burnAmount)).wait();
        const dc = ethers.utils.id('test');
        const reqId = await c.hub.callStatic.requestBurn(burnAmount, wallet.address, wallet.address, dc, ethers.utils.id('pub'), ethers.utils.id('view'));
        await (await c.hub.requestBurn(burnAmount, wallet.address, wallet.address, dc, ethers.utils.id('pub'), ethers.utils.id('view'))).wait();
        const burnSecret = ethers.utils.randomBytes(32);
        const sh = await c.ed25519.computeCommitment(burnSecret);
        const [bx, by] = await c.ed25519.scalarMultBase(ethers.BigNumber.from(burnSecret));
        await (await c.hub.proposeHash(reqId, sh, ethers.utils.hexZeroPad(ethers.BigNumber.from(bx).toHexString(),32), ethers.utils.hexZeroPad(ethers.BigNumber.from(by).toHexString(),32))).wait();
        await (await c.hub.confirmMoneroLock(reqId, { gasLimit: 500000 })).wait();
        await refreshPrices(c.hub);
        await (await c.hub.finalizeBurn(reqId, burnSecret, { gasLimit: 1000000 })).wait();
        const reward = await c.hub.getPendingReturns(wallet.address, cfg.STATA_USDE_ADDRESS);
        if (reward.gt(0)) await (await c.hub.withdrawReturns(cfg.STATA_USDE_ADDRESS, { gasLimit: 300000 })).wait();
        console.log('  burned + reward claimed:', ethers.utils.formatEther(reward), 'stataUSDe\n');
    }

    console.log('FULL CYCLE COMPLETE —', `${cfg.EXPLORER}/address/${wallet.address}`);
}
main().catch(e => { console.error(e); process.exit(1); });
