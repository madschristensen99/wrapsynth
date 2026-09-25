#!/usr/bin/env node
/* Deploy wsXMR stack to HyperEVM via ethers. Resumable + verifies code lands.
 * Big-block aware: HyperEVM's block gas limit is 3M with occasional 30M blocks
 * (~every 5 min). Contracts needing >3M gas wait for a 30M block to submit,
 * then wait for the next 30M block to mine them. */
require('dotenv').config({ path: '/home/remsee/wsFrontendOverhaul/.env' });
const { ethers } = require('ethers');
const fs = require('fs'); const path = require('path');
const RPC = 'https://rpc.hyperliquid.xyz/evm';
const OUT = path.join(__dirname, '..', 'out');
const MANIFEST = path.join(__dirname, '..', 'deployments', 'hyperevm-deployment.json');
const USDE='0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', HYPERLEND_POOL='0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b', HYPERLEND_ATOKEN='0x333819c04975554260AaC119948562a0E24C2bd6';
const FACTORY='0xB1c0fa0B789320044A6F623cFe5eBda9562602E3', NFPM='0x6eDA206207c09e5428F281761DdC0D300851fBC8', HSROUTER='0x6D99e7f6747AF2cDbB5164b6DD50e40D4fDe1e77';
const XMR_PERP=224, POOL_FEE=3000, VERIFIER=ethers.constants.AddressZero;
const GP=ethers.utils.parseUnits('0.11','gwei');
const MAX_BLOCK_GAS=3000000;
// Measured deploy gas needs (anvil + live RPC estimates); gasLimit is a cap so
// small contracts use 2.9M (fits any block), large ones use their real need.
const GAS={
  wsXMR:1900000, wsXmrHub:2900000, StataUSDe:2900000, HyperCoreOracleFacet:2900000,
  VaultFacet:5500000, MintFacet:4000000, BurnFacet:4200000, LiquidationFacet:3400000,
  YieldFacet:2900000, wsXMRLiquidityRouter:2900000, Ed25519Helper:1900000, SwapHelper:1900000
};
const art=n=>{const j=JSON.parse(fs.readFileSync(path.join(OUT,n+'.sol',n+'.json')));return{abi:j.abi,bytecode:j.bytecode.object};};
const sqrt=x=>{let z=(x+1n)/2n,y=x;while(z<y){y=z;z=(x/z+z)/2n;}return y;};
const p2s=(xp,u0)=>{const sC=sqrt(ethers.BigNumber.from(10).pow(18).toBigInt()),s10=100000n,Q=1n<<96n,sX=sqrt(xp.toBigInt());return u0?(sC*Q)/(sX*s10):(sX*s10*Q)/sC;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// Enable HyperEVM big-block routing for the deployer via HyperCore L1 action
// evmUserModify { usingBigBlocks: true }. Idempotent — safe to call repeatedly.
async function enableBigBlocks(w){
  const nonce=Date.now();
  const type=Buffer.from('type'),typeVal=Buffer.from('evmUserModify'),key2=Buffer.from('usingBigBlocks');
  const msgpacked=Buffer.concat([Buffer.from([0x82]),Buffer.from([0xa4]),type,Buffer.from([0xad]),typeVal,Buffer.from([0xae]),key2,Buffer.from([0xc3])]);
  const nonceBuf=Buffer.alloc(8);nonceBuf.writeBigUInt64BE(BigInt(nonce));
  const hash=ethers.utils.keccak256(ethers.utils.concat([msgpacked,nonceBuf,Buffer.from([0x00])]));
  const sig=await w._signTypedData(
    {name:'Exchange',version:'1',chainId:1337,verifyingContract:'0x0000000000000000000000000000000000000000'},
    {Agent:[{name:'source',type:'string'},{name:'connectionId',type:'bytes32'}]},
    {source:'a',connectionId:hash}
  );
  const {r,s,v}=ethers.utils.splitSignature(sig);
  const resp=await fetch('https://api.hyperliquid.xyz/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:{type:'evmUserModify',usingBigBlocks:true},nonce,signature:{r,s,v},vaultAddress:null})});
  const j=await resp.json();
  if(j.status==='ok')console.log('  big blocks enabled');
  else console.log('  big blocks enable WARN:',JSON.stringify(j).slice(0,120));
}

// Wait for a tx to mine with a timeout; returns receipt or null if still pending.
// Polls the receipt directly (avoids ethers TransactionResponse.wait() quirks).
async function waitMined(p,hash,timeoutMs=900000){
  const t0=Date.now();
  for(;;){
    const rc=await p.getTransactionReceipt(hash).catch(()=>null);
    if(rc) return rc;
    if(Date.now()-t0>timeoutMs) return null;
    await sleep(5000);
  }
}

async function deploy(w,p,name,args,man,key){
  if(man[key]&&man[key]!==ethers.constants.AddressZero){
    const c=await p.getCode(man[key]);
    if(c!=='0x'){console.log(`  ${name}: live ${man[key]}`);return new ethers.Contract(man[key],art(name).abi,w);}
    console.log(`  ${name}: dead addr, redeploy`);
  }
  const gas=GAS[name];
  const{abi,bytecode}=art(name);
  const f=new ethers.ContractFactory(abi,bytecode,w);
  for(let a=0;a<30;a++){
    try{
      // Sign fresh each attempt with the current nonce (big-block routing is account-wide).
      const nonce=await w.getTransactionCount('pending');
      const unsigned=await f.getDeployTransaction(...args,{gasLimit:gas,gasPrice:GP,nonce});
      const signed=await w.signTransaction(unsigned);
      const target=ethers.utils.parseTransaction(signed).to;
      const resp=await p.sendTransaction(signed);
      console.log(`  ${name} tx ${resp.hash} (nonce ${nonce})`);
      // Poll code at the target (ground truth) — big blocks mine ~60s.
      const t0=Date.now();
      let code='0x';
      while(code==='0x'&&Date.now()-t0<900000){
        await sleep(5000);
        try{code=await p.getCode(target);}catch(e){}
      }
      if(code!=='0x'){
        console.log(`  ${name}: ${target}`);
        man[key]=target;fs.writeFileSync(MANIFEST,JSON.stringify(man,null,2));
        return new ethers.Contract(target,abi,w);
      }
      console.log(`  ${name} a${a} no code after timeout`);
    }catch(e){
      const msg=(e.reason||e.message||'').split('\n')[0];
      console.log(`  ${name} a${a} err ${msg}`);
      if(msg.includes('replacement fee too low')){console.log(`  ${name}: pending tx conflict, waiting for it to mine...`);await sleep(70000);}
    }
    await sleep(3000);
  }
  throw new Error(name+' deploy failed');
}
async function send(c,fn,args,gas,label){for(let a=0;a<4;a++){try{const t=await c[fn](...args,{gasLimit:gas,gasPrice:GP});console.log(`  ${label} tx ${t.hash}`);const t0=Date.now();let rc=null;while(!rc&&Date.now()-t0<300000){await sleep(5000);try{rc=await c.provider.getTransactionReceipt(t.hash);}catch(e){}}if(rc&&rc.status===1){console.log(`  ${label} OK`);return true;}console.log(`  ${label} status ${rc?rc.status:'timeout'}`);}catch(e){console.log(`  ${label} a${a} ${(e.reason||e.message||'').split('\n')[0]}`);}await sleep(4000);}return false;}
async function xmr(){try{const j=await(await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd')).json();const p=Math.floor(j.monero.usd);if(p>0)return ethers.BigNumber.from(p).mul(ethers.BigNumber.from(10).pow(18));}catch(e){}return ethers.BigNumber.from(390).mul(ethers.BigNumber.from(10).pow(18));}
async function main(){
  const p=new ethers.providers.JsonRpcProvider(RPC);const w=new ethers.Wallet(process.env.PRIVATE_KEY,p);
  let man={};try{man=JSON.parse(fs.readFileSync(MANIFEST));}catch(e){}
  let bal='?';try{bal=ethers.utils.formatEther(await w.getBalance());}catch(e){}
  console.log('=== deploy (big-block aware) ===',w.address,'HYPE',bal);
  await enableBigBlocks(w);
  const xp=await xmr();
  const wsxmr=await deploy(w,p,'wsXMR',[],man,'wsXMR');
  const hub=await deploy(w,p,'wsXmrHub',[wsxmr.address,VERIFIER],man,'wsXmrHub');
  const stata=await deploy(w,p,'StataUSDe',[HYPERLEND_POOL,HYPERLEND_ATOKEN,USDE],man,'stataUSDe');
  const oracle=await deploy(w,p,'HyperCoreOracleFacet',[wsxmr.address,VERIFIER],man,'oracleFacet');
  const vault=await deploy(w,p,'VaultFacet',[wsxmr.address,VERIFIER],man,'vaultFacet');
  const mint=await deploy(w,p,'MintFacet',[wsxmr.address,VERIFIER],man,'mintFacet');
  const burn=await deploy(w,p,'BurnFacet',[wsxmr.address,VERIFIER],man,'burnFacet');
  const liq=await deploy(w,p,'LiquidationFacet',[wsxmr.address,VERIFIER],man,'liquidationFacet');
  const yld=await deploy(w,p,'YieldFacet',[wsxmr.address,VERIFIER],man,'yieldFacet');
  if((await hub.vaultFacet())===ethers.constants.AddressZero)await send(hub,'registerFacets',[vault.address,mint.address,burn.address,liq.address,yld.address,oracle.address],2900000,'registerFacets');else console.log('  facets registered');
  if((await wsxmr.hub())===ethers.constants.AddressZero)await send(wsxmr,'setHub',[hub.address],300000,'setHub');else console.log('  hub set');
  if((await hub.collateralToken())===ethers.constants.AddressZero)await send(hub,'setExternalAddresses',[stata.address,USDE,HSROUTER,XMR_PERP],500000,'setExternalAddresses');
  const fac=new ethers.Contract(FACTORY,['function getPool(address,address,uint24) view returns (address)','function createPool(address,address,uint24) returns (address)'],w);
  const t0=USDE.toLowerCase()<wsxmr.address.toLowerCase()?USDE:wsxmr.address,t1=USDE.toLowerCase()<wsxmr.address.toLowerCase()?wsxmr.address:USDE;
  let pool=await fac.getPool(t0,t1,POOL_FEE);
  if(pool===ethers.constants.AddressZero){await send(fac,'createPool',[t0,t1,POOL_FEE],6000000,'createPool');pool=await fac.getPool(t0,t1,POOL_FEE);}
  console.log('  pool:',pool);man.pool=pool;
  const pc=new ethers.Contract(pool,['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)','function initialize(uint160)'],w);
  const s0=await pc.slot0();
  if(s0[0].eq(0)){const tgt=p2s(xp,USDE.toLowerCase()<wsxmr.address.toLowerCase());await send(pc,'initialize',[tgt],500000,'pool.init');}else console.log('  pool init done');
  const router=await deploy(w,p,'wsXMRLiquidityRouter',[hub.address,NFPM,USDE,wsxmr.address,pool],man,'liquidityRouter');
  if((await hub.liquidityRouter())===ethers.constants.AddressZero)await send(hub,'setLiquidityRouter',[router.address],300000,'setLiquidityRouter');
  await deploy(w,p,'Ed25519Helper',[],man,'ed25519Helper');
  await deploy(w,p,'SwapHelper',[],man,'swapHelper');
  // Final security step: permanently lock deployer powers (one-way, irreversible).
  if(!(await wsxmr.hubLocked()))await send(wsxmr,'lockHub',[],300000,'lockHub');else console.log('  hub locked');
  if(!(await hub.deployerOperationsLocked()))await send(hub,'lockDeployer',[],300000,'lockDeployer');else console.log('  deployer locked');
  Object.assign(man,{network:'hyperevm',chainId:999,deployer:w.address,usde:USDE,hyperlendPool:HYPERLEND_POOL,hyperlendAToken:HYPERLEND_ATOKEN,hyperswapFactory:FACTORY,hyperswapRouter:HSROUTER,hyperswapNFPM:NFPM,xmrPerpIndex:XMR_PERP});
  fs.writeFileSync(MANIFEST,JSON.stringify(man,null,2));
  console.log('\n=== DONE ===\n'+JSON.stringify(man,null,2));
  console.log('HYPE left:',ethers.utils.formatEther(await w.getBalance()));
}
main().catch(e=>{console.error('FATAL:',e.reason||e.message||e);process.exit(1);});
