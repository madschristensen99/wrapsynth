require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');
const { HUB_ADDRESS } = require('./deploymentConfig');

const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const hubAbi = [
  'function lastXmrPrice() view returns (int192)',
  'function lastXmrPriceTimestamp() view returns (uint256)',
  'function lastCollateralPrice() view returns (int192)',
  'function lastCollateralPriceTimestamp() view returns (uint256)',
  'function xmrEmaPrice() view returns (uint256)',
  'function updateOraclePrices(bytes[] calldata updateData) external payable',
  'function getXmrPrice() view returns (uint256)',
  'function getCollateralPrice() view returns (uint256)'
];

const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);

async function main() {
  console.log('=== BEFORE UPDATE ===');
  const lxp = await hub.lastXmrPrice();
  const lxt = await hub.lastXmrPriceTimestamp();
  const lcp = await hub.lastCollateralPrice();
  const lct = await hub.lastCollateralPriceTimestamp();
  const ema = await hub.xmrEmaPrice();

  console.log('lastXmrPrice (raw int192):', lxp.toString());
  console.log('lastXmrPrice (8-dec):     ', ethers.utils.formatUnits(lxp, 8));
  console.log('lastXmrPriceTimestamp:    ', lxt.toString(), 'diff:', Math.floor(Date.now()/1000) - lxt.toNumber(), 's ago');
  console.log('lastCollateralPrice:      ', ethers.utils.formatUnits(lcp, 8));
  console.log('xmrEmaPrice (18-dec):     ', ethers.utils.formatUnits(ema, 18));
  try {
    const gp = await hub.getXmrPrice();
    console.log('getXmrPrice() (18-dec):   ', ethers.utils.formatUnits(gp, 18));
  } catch(e) {
    console.log('getXmrPrice() reverted:', e.reason || e.message);
  }

  console.log('\n=== FETCHING FRESH REDSTONE DATA ===');
  const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');
  console.log('Authorized signers count:', authorizedSigners.length);
  console.log('Signers:', authorizedSigners.slice(0, 3));

  const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
    dataServiceId: 'redstone-primary-prod',
    uniqueSignersCount: 3,
    dataPackagesIds: ['XMR', 'DAI'],
    authorizedSigners
  });

  console.log('\n=== SENDING PRICE UPDATE ===');
  try {
    const tx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
    console.log('TX hash:', tx.hash);
    const receipt = await tx.wait();
    console.log('Mined in block:', receipt.blockNumber);
  } catch(e) {
    console.log('TX failed:', e.message);
  }

  console.log('\n=== AFTER UPDATE ===');
  const lxp2 = await hub.lastXmrPrice();
  const lxt2 = await hub.lastXmrPriceTimestamp();
  const lcp2 = await hub.lastCollateralPrice();
  const ema2 = await hub.xmrEmaPrice();

  console.log('lastXmrPrice (raw int192):', lxp2.toString());
  console.log('lastXmrPrice (8-dec):     ', ethers.utils.formatUnits(lxp2, 8));
  console.log('lastXmrPriceTimestamp:    ', lxt2.toString(), 'diff:', Math.floor(Date.now()/1000) - lxt2.toNumber(), 's ago');
  console.log('lastCollateralPrice:      ', ethers.utils.formatUnits(lcp2, 8));
  console.log('xmrEmaPrice (18-dec):     ', ethers.utils.formatUnits(ema2, 18));

  try {
    const gp2 = await hub.getXmrPrice();
    console.log('getXmrPrice() (18-dec):   ', ethers.utils.formatUnits(gp2, 18));
  } catch(e) {
    console.log('getXmrPrice() reverted:', e.reason || e.message);
  }
}

main().catch(console.error);
