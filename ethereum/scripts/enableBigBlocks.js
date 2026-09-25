#!/usr/bin/env node
/* Enable HyperEVM big-block routing for the deployer via HyperCore L1 action
 * evmUserModify { usingBigBlocks: true }.
 * Signing: msgpack(action) + nonce(8B BE) + 0x00 (no vault) -> keccak ->
 * EIP-712 "Agent" phantom (domain: Exchange/1/1337/0x0), POST /exchange. */
require('dotenv').config({ path: '/home/remsee/wsFrontendOverhaul/.env' });
const { ethers } = require('ethers');

// msgpack encode {"type":"evmUserModify","usingBigBlocks":true}
function msgpackEvmUserModify() {
  const type = Buffer.from('type');
  const typeVal = Buffer.from('evmUserModify');
  const key2 = Buffer.from('usingBigBlocks');
  return Buffer.concat([
    Buffer.from([0x82]),
    Buffer.from([0xa4]), type,
    Buffer.from([0xad]), typeVal,
    Buffer.from([0xae]), key2,
    Buffer.from([0xc3]), // true
  ]);
}

async function main() {
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
  const nonce = Date.now();
  const action = { type: 'evmUserModify', usingBigBlocks: true };

  // action hash: keccak(msgpack(action) + nonce(8B BE) + 0x00)
  const msgpacked = msgpackEvmUserModify();
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64BE(BigInt(nonce));
  const hash = ethers.utils.keccak256(ethers.utils.concat([msgpacked, nonceBuf, Buffer.from([0x00])]));

  // phantom agent: {"source":"a" (mainnet),"connectionId":hash}
  const domain = {
    name: 'Exchange',
    version: '1',
    chainId: 1337,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };
  const types = {
    Agent: [
      { name: 'source', type: 'string' },
      { name: 'connectionId', type: 'bytes32' },
    ],
  };
  const value = { source: 'a', connectionId: hash };

  const sig = await wallet._signTypedData(domain, types, value);
  const { r, s, v } = ethers.utils.splitSignature(sig);

  const payload = {
    action,
    nonce,
    signature: { r, s, v },
    vaultAddress: null,
  };

  console.log('POST /exchange evmUserModify usingBigBlocks=true');
  const resp = await fetch('https://api.hyperliquid.xyz/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  console.log('HTTP', resp.status, '->', text.slice(0, 300));
  try {
    const j = JSON.parse(text);
    if (j.status === 'ok') { console.log('BIG BLOCKS ENABLED'); process.exit(0); }
    console.log('FAILED:', JSON.stringify(j).slice(0, 300));
    process.exit(1);
  } catch (e) { process.exit(1); }
}
main().catch(e => { console.error('FATAL:', e.message.split('\n')[0]); process.exit(1); });
