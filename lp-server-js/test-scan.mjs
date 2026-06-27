import { createHash } from 'crypto';
import * as ed from '@noble/ed25519';
import { addEd25519Points } from './moneroCrypto.js';

if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
}

// On-chain keys
const userPubSpend = '83e98034898410d95499a095da5151bb95a20e111b447ea9222105d0feb7eb1a';
const lpPubSpend = '54a2e4d04138b67d3cd0d56a0681728c4e699b3674c7376d8d358939705842e6';
const lpPrivView = '058811dcd20792a435e84dbd8f09d9f9109aae51788cf1db0e0c9ca844862c55';

const hex = (b) => Buffer.from(b).toString('hex');
function buf(b) { return Buffer.isBuffer(b) ? b : Buffer.from(b); }

// Combined spend key B = userPubSpend + lpPubSpend
const combinedSpend = await addEd25519Points(userPubSpend, lpPubSpend);
console.log('Combined spend key B:', hex(combinedSpend));

// Tx public key R
const R = 'a3688d57d84e32f5bae95d111f9c1580a6b54b903b034587e8fe901c9133befc';

// Output keys from the tx
const outKey1 = '2b01299f32c4d8151a726ada5b50be30e447e5bd09c3aedf4e9b57be0087d699';
const outKey2 = '48ccebd4ac5bb11cca223a5da09218336f3cf37e568e6e4fa627f68c64c702c0';

// Compute a * R (scalar multiplication)
const scalar = ed.helpers.mod(BigInt('0x' + lpPrivView));
const RPoint = ed.ExtendedPoint.fromHex(R);
const aR = RPoint.multiply(scalar);
const aRBytes = aR.toRawBytes();
console.log('a*R:', hex(aRBytes));

// Monero uses Hs(D || index) where D = a*R, index is 8-byte LE
for (let i = 0; i < 2; i++) {
  const indexBytes = Buffer.alloc(8);
  indexBytes.writeBigUInt64LE(BigInt(i));
  const hashInput = Buffer.concat([aRBytes, indexBytes]);
  // Monero uses keccak-256 for Hs
  const hashHex = createHash('sha3-256').update(hashInput).digest().toString('hex');
  // Actually Monero uses cn_fast_hash which is keccak-256
  // But we need to reduce mod l
  const hs = ed.helpers.mod(BigInt('0x' + hashHex));
  console.log(`Hs(a*R, ${i}):`, hs.toString(16));

  // Hs(a*R) * G + B
  const G = ed.ExtendedPoint.BASE;
  const hsG = G.multiply(hs);
  const B = ed.ExtendedPoint.fromHex(hex(combinedSpend));
  const expected = hsG.add(B);
  const expectedBytes = expected.toRawBytes();
  console.log(`Expected output key ${i}:`, hex(expectedBytes));
  console.log(`Actual output key ${i}:  `, i === 0 ? outKey1 : outKey2);
  console.log(`Match:`, hex(expectedBytes) === (i === 0 ? outKey1 : outKey2));
  console.log();
}
