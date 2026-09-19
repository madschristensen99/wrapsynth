#!/usr/bin/env node
/* Deploy wsXMR stack to HyperEVM via ethers. Resumable + verifies code lands. */
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
const art=n=>{const j=JSON.parse(fs.readFileSync(path.join(OUT,n+'.sol',n+'.json')));return{abi:j.abi,bytecode:j.bytecode.object};};
const sqrt=x=>{let z=(x+1n)/2n,y=x;while(z<y){y=z;z=(x/z+z)/2n;}return y;};
const p2s=(xp,u0)=>{const sC=sqrt(ethers.BigNumber.from(10).pow(18).toBigInt()),s10=100000n,Q=1n<<96n,sX=sqrt(xp.toBigInt());return u0?(sC*Q)/(sX*s10):(sX*s10*Q)/sC;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function deploy(w,p,name,args,gas,man,key){
  if(man[key]&&man[key]!==ethers.constants.AddressZero){const c=await p.getCode(man[key]);if(c!=='0x'){console.log(`  ${name}: live ${man[key]}`);return new ethers.Contract(man[key],art(name).abi,w);}console.log(`  ${name}: dead addr, redeploy`);}
  for(let a=0;a<5;a++){try{
    const{abi,bytecode}=art(name);const c=await new ethers.ContractFactory(abi,bytecode,w).deploy(...args,{gasLimit:gas,gasPrice:GP});
    console.log(`  ${name} tx ${c.deployTransaction.hash}`);const rc=await c.deployTransaction.wait();
    if(rc.status===1&&(await p.getCode(c.address))!=='0x'){console.log(`  ${name}: ${c.address}`);man[key]=c.address;fs.writeFileSync(MANIFEST,JSON.stringify(man,null,2));return new ethers.Contract(c.address,abi,w);}
    console.log(`  ${name} a${a} status ${rc.status}`);
  }catch(e){console.log(`  ${name} a${a} err ${(e.reason||e.message||'').split('\n')[0]}`);}await sleep(5000);}
  throw new Error(name+' deploy failed');
}
async function send(c,fn,args,gas,label){for(let a=0;a<4;a++){try{const t=await c[fn](...args,{gasLimit:gas,gasPrice:GP});const r=await t.wait();if(r.status===1){console.log(`  ${label} OK`);return true;}console.log(`  ${label} status0`);}catch(e){console.log(`  ${label} a${a} ${(e.reason||e.message||'').split('\n')[0]}`);}await sleep(4000);}return false;}
async function xmr(){try{const j=await(await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd')).json();const p=Math.floor(j.monero.usd);if(p>0)return ethers.BigNumber.from(p).mul(ethers.BigNumber.from(10).pow(18));}catch(e){}return ethers.BigNumber.from(390).mul(ethers.BigNumber.from(10).pow(18));}
async function main(){
  const p=new ethers.providers.JsonRpcProvider(RPC);const w=new ethers.Wallet(process.env.PRIVATE_KEY,p);
  let man={};try{man=JSON.parse(fs.readFileSync(MANIFEST));}catch(e){}
  console.log('=== deploy ===',w.address,'HYPE',ethers.utils.formatEther(await w.getBalance()));
  const xp=await xmr();
  const wsxmr=await deploy(w,p,'wsXMR',[],1900000,man,'wsXMR');
  const hub=await deploy(w,p,'wsXmrHub',[wsxmr.address,VERIFIER],8000000,man,'wsXmrHub');
  const stata=await deploy(w,p,'StataUSDe',[HYPERLEND_POOL,HYPERLEND_ATOKEN,USDE],4000000,man,'stataUSDe');
  const oracle=await deploy(w,p,'HyperCoreOracleFacet',[wsxmr.address,VERIFIER],9000000,man,'oracleFacet');
  const vault=await deploy(w,p,'VaultFacet',[wsxmr.address,VERIFIER],14000000,man,'vaultFacet');
  const mint=await deploy(w,p,'MintFacet',[wsxmr.address,VERIFIER],12000000,man,'mintFacet');
  const burn=await deploy(w,p,'BurnFacet',[wsxmr.address,VERIFIER],12000000,man,'burnFacet');
  const liq=await deploy(w,p,'LiquidationFacet',[wsxmr.address,VERIFIER],12000000,man,'liquidationFacet');
  const yld=await deploy(w,p,'YieldFacet',[wsxmr.address,VERIFIER],12000000,man,'yieldFacet');
  if((await hub.vaultFacet())===ethers.constants.AddressZero)await send(hub,'registerFacets',[vault.address,mint.address,burn.address,liq.address,yld.address,oracle.address],3000000,'registerFacets');else console.log('  facets registered');
  await send(wsxmr,'setHub',[hub.address],300000,'setHub');
  if((await hub.collateralToken())===ethers.constants.AddressZero)await send(hub,'setExternalAddresses',[stata.address,USDE,HSROUTER,XMR_PERP],500000,'setExternalAddresses');
  const fac=new ethers.Contract(FACTORY,['function getPool(address,address,uint24) view returns (address)','function createPool(address,address,uint24) returns (address)'],w);
  const t0=USDE.toLowerCase()<wsxmr.address.toLowerCase()?USDE:wsxmr.address,t1=USDE.toLowerCase()<wsxmr.address.toLowerCase()?wsxmr.address:USDE;
  let pool=await fac.getPool(t0,t1,POOL_FEE);
  if(pool===ethers.constants.AddressZero){await send(fac,'createPool',[t0,t1,POOL_FEE],6000000,'createPool');pool=await fac.getPool(t0,t1,POOL_FEE);}
  console.log('  pool:',pool);man.pool=pool;
  const pc=new ethers.Contract(pool,['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)','function initialize(uint160)'],w);
  const s0=await pc.slot0();
  if(s0[0].eq(0)){const tgt=p2s(xp,USDE.toLowerCase()<wsxmr.address.toLowerCase());await send(pc,'initialize',[tgt],500000,'pool.init');}else console.log('  pool init done');
  const router=await deploy(w,p,'wsXMRLiquidityRouter',[hub.address,NFPM,USDE,wsxmr.address,pool],6000000,man,'liquidityRouter');
  if((await hub.liquidityRouter())===ethers.constants.AddressZero)await send(hub,'setLiquidityRouter',[router.address],300000,'setLiquidityRouter');
  await deploy(w,p,'Ed25519Helper',[],1900000,man,'ed25519Helper');
  await deploy(w,p,'SwapHelper',[],1900000,man,'swapHelper');
  Object.assign(man,{network:'hyperevm',chainId:999,deployer:w.address,usde:USDE,hyperlendPool:HYPERLEND_POOL,hyperlendAToken:HYPERLEND_ATOKEN,hyperswapFactory:FACTORY,hyperswapRouter:HSROUTER,hyperswapNFPM:NFPM,xmrPerpIndex:XMR_PERP});
  fs.writeFileSync(MANIFEST,JSON.stringify(man,null,2));
  console.log('\n=== DONE ===\n'+JSON.stringify(man,null,2));
  console.log('HYPE left:',ethers.utils.formatEther(await w.getBalance()));
}
main().catch(e=>{console.error('FATAL:',e.reason||e.message||e);process.exit(1);});
