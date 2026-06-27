#!/usr/bin/env node
// Create a fresh Monero wallet for the LP server
// Generates random keys, starts monero-wallet-rpc, creates wallet file

import { randomBytes, createHash } from 'crypto';
import { spawn, execSync } from 'child_process';
import { setTimeout } from 'timers/promises';
import * as ethers from 'ethers';

// ─── Config ─────────────────────────────────────────────────────────────────
const WALLET_DIR = '/home/remsee/wsFrontendOverhaul/lp-server-js/monero-wallets';
const WALLET_NAME = 'lp-wallet';
const WALLET_PASSWORD = 'lp-wallet-password';
const RPC_PORT = 18082;
const DAEMON_URL = 'xmr-node.cakewallet.com:18081'; // no https:// prefix!

// ─── Generate Monero keys ───────────────────────────────────────────────────
// Monero private spend key = random 32 bytes
// Private view key = keccak256(spend_key)
// Address derived from public keys

function generateKeys() {
  const spendKey = randomBytes(32);
  const viewKey = Buffer.from(ethers.keccak256(spendKey).slice(2), 'hex');

  // Reduce both modulo Ed25519 group order
  const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

  function reduceModL(bytes) {
    let n = 0n;
    for (let i = 0; i < 32; i++) {
      n = (n << 8n) | BigInt(bytes[i]);
    }
    const reduced = n % ED25519_L;
    const out = Buffer.alloc(32);
    let tmp = reduced;
    for (let i = 31; i >= 0; i--) {
      out[i] = Number(tmp & 0xffn);
      tmp = tmp >> 8n;
    }
    return out;
  }

  const spendKeyReduced = reduceModL(spendKey);
  const viewKeyReduced = reduceModL(viewKey);

  return {
    spendKey: spendKeyReduced.toString('hex'),
    viewKey: viewKeyReduced.toString('hex'),
  };
}

// We need @noble/ed25519 to derive the address from keys
async function deriveAddress(spendKeyHex, viewKeyHex) {
  const ed = await import('@noble/ed25519');
  if (!ed.etc.sha512Sync) {
    ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
  }

  const spendPriv = Buffer.from(spendKeyHex, 'hex');
  const viewPriv = Buffer.from(viewKeyHex, 'hex');

  // Monero uses direct scalar multiplication (scalar * G), NOT ed.getPublicKey()
  // which uses SHA512-based Ed25519 key derivation.
  const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const G = ed.ExtendedPoint.BASE;

  function scalarToPubKey(scalarBytes) {
    const le = Buffer.from(scalarBytes).reverse();
    const s = BigInt('0x' + le.toString('hex')) % ED25519_L;
    return Buffer.from(G.multiply(s).toRawBytes());
  }

  const publicSpend = scalarToPubKey(spendPriv);
  const publicView = scalarToPubKey(viewPriv);

  // Simple base58 encode for Monero address (network byte 0x12 for mainnet)
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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
      const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
      const targetLen = ENCODED_BLOCK_SIZES[block.length];
      while (encoded.length < targetLen) encoded = '1' + encoded;
      return encoded;
    }
    const BLOCK_SIZE = 8;
    let result = '';
    for (let i = 0; i < data.length; i += BLOCK_SIZE) {
      result += encodeBlock(data.slice(i, i + BLOCK_SIZE));
    }
    return result;
  }

  function keccak256(data) {
    return Buffer.from(ethers.keccak256(data).slice(2), 'hex');
  }

  const networkByte = 0x12; // mainnet
  const data = Buffer.concat([Buffer.from([networkByte]), publicSpend, publicView]);
  const checksum = keccak256(data).slice(0, 4);
  const addressBytes = Buffer.concat([data, checksum]);

  return base58Encode(addressBytes);
}

// ─── Wallet RPC Helper ──────────────────────────────────────────────────────

async function walletRpc(url, method, params = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  }
  return data.result;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== WrapSynth LP Monero Wallet Creation ===\n');

  // 1. Generate keys
  console.log('1. Generating random Monero keys...');
  const keys = generateKeys();
  const address = await deriveAddress(keys.spendKey, keys.viewKey);

  console.log(`   Address:  ${address}`);
  console.log(`   SpendKey: ${keys.spendKey}`);
  console.log(`   ViewKey:  ${keys.viewKey}`);

  // 2. Start monero-wallet-rpc in background
  console.log('\n2. Starting monero-wallet-rpc...');
  console.log(`   Wallet dir: ${WALLET_DIR}`);
  console.log(`   RPC port:   ${RPC_PORT}`);

  const rpcProcess = spawn('monero-wallet-rpc', [
    '--wallet-dir', WALLET_DIR,
    '--rpc-bind-port', String(RPC_PORT),
    '--rpc-bind-ip', '127.0.0.1',
    '--daemon-address', DAEMON_URL,
    '--trusted-daemon',
    '--daemon-ssl', 'enabled',
    '--daemon-ssl-allow-any-cert',
    '--disable-rpc-login',
    '--non-interactive',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  rpcProcess.stderr.on('data', (data) => {
    // Monero logs to stderr
    const line = data.toString().trim();
    if (line.includes('ERROR') || line.includes('error')) {
      console.error('   [wallet-rpc]', line);
    }
  });

  // Wait for RPC to be ready
  const rpcUrl = `http://127.0.0.1:${RPC_PORT}/json_rpc`;
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await setTimeout(500);
    try {
      await walletRpc(rpcUrl, 'get_version', {});
      ready = true;
      console.log('   ✅ Wallet RPC ready');
      break;
    } catch (e) {
      // not ready yet
    }
  }

  if (!ready) {
    rpcProcess.kill();
    throw new Error('wallet-rpc did not become ready within 15s');
  }

  // 3. Create wallet from keys (this also opens it)
  console.log('\n3. Creating wallet from keys...');
  try {
    await walletRpc(rpcUrl, 'generate_from_keys', {
      filename: WALLET_NAME,
      address: address,
      spendkey: keys.spendKey,
      viewkey: keys.viewKey,
      password: WALLET_PASSWORD,
      language: 'English',
      restore_height: 3690000, // approximate mainnet height from a while ago
    });
    console.log('   ✅ Wallet created and opened');
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('   ℹ️ Wallet already exists, opening it...');
      await walletRpc(rpcUrl, 'open_wallet', {
        filename: WALLET_NAME,
        password: WALLET_PASSWORD,
      });
      console.log('   ✅ Wallet opened');
    } else {
      rpcProcess.kill();
      throw e;
    }
  }

  // 5. Get balance
  console.log('\n5. Checking balance...');
  try {
    const balance = await walletRpc(rpcUrl, 'get_balance', { account_index: 0 });
    console.log(`   Balance: ${balance.balance} (unlocked: ${balance.unlocked_balance})`);
  } catch (e) {
    console.log(`   ⚠️ Could not get balance: ${e.message}`);
  }

  // 6. Write .env file for lp-server-js
  console.log('\n6. Writing lp-server-js/.env...');
  const envContent = `# WrapSynth LP Server Configuration
# Auto-generated by create-monero-wallet.js

# Required: Private key of the LP vault wallet (0x...)
PRIVATE_KEY=

# RPC URL for the EVM chain (default: Gnosis Chain mainnet)
RPC_URL=https://rpc.gnosischain.com

# HTTP server port
PORT=3001

# Burn auto-processing
AUTO_PROCESS_BURNS=false
BURN_PROPOSE_DELAY_MS=5000
BURN_FINALIZE_DELAY_MS=30000

# LP Ed25519 public keys for burn operations (optional)
# BURN_LP_PUBLIC_SPEND_KEY=
# BURN_LP_PUBLIC_VIEW_KEY=

# Monero wallet RPC URL
MONERO_WALLET_RPC_URL=${rpcUrl}

# Optional: monero-wallet-rpc HTTP basic auth
# MONERO_WALLET_RPC_USER=
# MONERO_WALLET_RPC_PASSWORD=

# ─── MONERO WALLET KEYS (BACK THESE UP!) ────────────────────────────────────
# These keys control the LP's Monero funds. Keep them secure.
MONERO_SPEND_KEY=${keys.spendKey}
MONERO_VIEW_KEY=${keys.viewKey}
`;

  const fs = await import('fs');
  fs.writeFileSync('/home/remsee/wsFrontendOverhaul/lp-server-js/.env', envContent);
  console.log('   ✅ Written to lp-server-js/.env');

  // 7. Print summary
  console.log('\n=== Wallet Summary ===');
  console.log(`Address:     ${address}`);
  console.log(`Spend Key:   ${keys.spendKey}`);
  console.log(`View Key:    ${keys.viewKey}`);
  console.log(`Wallet File: ${WALLET_DIR}/${WALLET_NAME}`);
  console.log(`RPC URL:     ${rpcUrl}`);
  console.log('\n⚠️  IMPORTANT:');
  console.log('   - This is a FRESH wallet with 0 XMR balance.');
  console.log('   - To use for burns, you need to fund it with XMR.');
  console.log('   - BACK UP THE SPEND KEY — it is the only way to recover funds.');
  console.log(`\n   Wallet RPC is running on port ${RPC_PORT}.`);
  console.log('   Press Ctrl+C to stop it, or leave it running in the background.');
  console.log('   To restart later:');
  console.log(`   monero-wallet-rpc --wallet-file ${WALLET_DIR}/${WALLET_NAME} --password "${WALLET_PASSWORD}" --rpc-bind-port ${RPC_PORT} --disable-rpc-login --daemon-address ${DAEMON_URL}`);

  // Keep process alive
  console.log('\nWallet RPC running. Waiting...');
  await new Promise(() => {});
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
