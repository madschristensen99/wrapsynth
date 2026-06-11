require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');
const { HUB_ADDRESS, WSXMR_ADDRESS } = require('./deploymentConfig');

const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const hubAbi = [
  'function updateOraclePrices(bytes[] calldata updateData) external payable',
  'function unwindCoLP(uint256 tokenId, uint256 deadline) external',
  'function getPendingReturns(address user, address token) external view returns (uint256)',
  'function withdrawReturns(address token) external'
];

const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);

const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');
const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
  dataServiceId: 'redstone-primary-prod',
  uniqueSignersCount: 3,
  dataPackagesIds: ['XMR', 'DAI'],
  authorizedSigners
});

async function main() {
  console.log('Refreshing prices...');
  const updateTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
  await updateTx.wait();
  console.log('Prices updated:', updateTx.hash);

  const deadline = Math.floor(Date.now() / 1000) + 3600;
  console.log('Unwinding Co-LP position 5534...');
  const unwindTx = await hub.unwindCoLP(5534, deadline, { gasLimit: 2000000 });
  const receipt = await unwindTx.wait();
  console.log('Unwind TX:', unwindTx.hash);
  console.log('Gas used:', receipt.gasUsed.toString());

  const pending = await hub.getPendingReturns(wallet.address, WSXMR_ADDRESS);
  console.log('Pending wsXMR:', ethers.utils.formatUnits(pending, 8));
  if (pending.gt(0)) {
    const withdrawTx = await hub.withdrawReturns(WSXMR_ADDRESS, { gasLimit: 200000 });
    await withdrawTx.wait();
    console.log('Withdrawn:', withdrawTx.hash);
  }
}

main().catch(console.error);
