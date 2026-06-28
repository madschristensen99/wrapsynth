// moneroCrypto.js — Ed25519 + Monero address derivation for the LP server
// Mirrors frontend/js/moneroCrypto.js but uses Node ESM imports

import { createHash } from 'crypto';
import * as ed from '@noble/ed25519';
import * as ethers from 'ethers';

// Set up SHA-512 sync for @noble/ed25519
if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BLOCK_SIZE = 8;
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

function base58Encode(data) {
  function encodeBlock(block) {
    let num = 0n;
    for (let i = 0; i < block.length; i++) {
      num = num * 256n + BigInt(block[i]);
    }
    let encoded = '';
    while (num > 0n) {
      const remainder = num % 58n;
      num = num / 58n;
      encoded = ALPHABET[Number(remainder)] + encoded;
    }
    const targetLen = ENCODED_BLOCK_SIZES[block.length];
    while (encoded.length < targetLen) {
      encoded = '1' + encoded;
    }
    return encoded;
  }

  let result = '';
  for (let i = 0; i < data.length; i += BLOCK_SIZE) {
    const block = data.slice(i, i + BLOCK_SIZE);
    result += encodeBlock(block);
  }
  return result;
}

function keccak256(data) {
  return Buffer.from(ethers.keccak256(data).slice(2), 'hex');
}

function hexToBytes(hex) {
  hex = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export async function addEd25519Points(pointA, pointB) {
  const pA = ed.ExtendedPoint.fromHex(pointA);
  const pB = ed.ExtendedPoint.fromHex(pointB);
  const combined = pA.add(pB);
  return combined.toRawBytes();
}

export function deriveMoneroAddress(publicSpendKey, publicViewKey, mainnet = true) {
  const networkByte = mainnet ? 0x12 : 0x35;
  const data = new Uint8Array(1 + 32 + 32);
  data[0] = networkByte;
  data.set(publicSpendKey, 1);
  data.set(publicViewKey, 33);

  const checksum = keccak256(data).slice(0, 4);
  const addressBytes = new Uint8Array(data.length + checksum.length);
  addressBytes.set(data);
  addressBytes.set(checksum, data.length);

  return base58Encode(addressBytes);
}

/**
 * Compute the Monero deposit address for a mint.
 * @param {string} userCommitment — userPublicKey from MintInitiated event (hex)
 * @param {string} lpPublicSpendKey — LP public spend key (hex)
 * @param {string} lpPublicViewKey — LP public view key (hex)
 * @returns {Promise<string>} Monero address
 */
export async function computeDepositAddress(userCommitment, lpPublicSpendKey, lpPublicViewKey) {
  const userBytes = hexToBytes(userCommitment);
  const lpSpendBytes = hexToBytes(lpPublicSpendKey);
  const lpViewBytes = hexToBytes(lpPublicViewKey);

  const combinedSpendKey = await addEd25519Points(userBytes, lpSpendBytes);
  const combinedViewKey = lpViewBytes;

  return deriveMoneroAddress(combinedSpendKey, combinedViewKey, true);
}

/**
 * Compute the Monero shared address for a burn.
 * Combined spend key = user_pub_spend + LP_pub_spend (Ed25519 point addition)
 * View key = user's public view key (so the user can scan with their private view key)
 * @param {string} userPublicKey — user's Ed25519 public spend key (hex, 32 bytes compressed)
 * @param {string} userViewKey — user's Ed25519 public view key (hex, 32 bytes compressed)
 * @param {string} lpPublicSpendKey — LP's Ed25519 public spend key (hex, 32 bytes compressed)
 * @returns {Promise<string>} Monero address
 */
export async function computeBurnAddress(userPublicKey, userViewKey, lpPublicSpendKey) {
  const userSpendBytes = hexToBytes(userPublicKey);
  const userViewBytes = hexToBytes(userViewKey);
  const lpSpendBytes = hexToBytes(lpPublicSpendKey);

  const combinedSpendKey = await addEd25519Points(userSpendBytes, lpSpendBytes);
  const combinedViewKey = userViewBytes;

  return deriveMoneroAddress(combinedSpendKey, combinedViewKey, true);
}
