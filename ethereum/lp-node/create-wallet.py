#!/usr/bin/env python3
"""Create Monero wallet from private key using wallet RPC"""

import subprocess
import time
import requests
import json
import os

# Load private key from .env
with open('.env', 'r') as f:
    for line in f:
        if line.startswith('MONERO_PRIVATE_KEY='):
            private_key = line.split('=')[1].strip()
            break

WALLET_FILE = "lp-wallet"
WALLET_PASSWORD = "lp-password-change-me"
RPC_PORT = 18082
DAEMON_URL = "https://xmr-node.cakewallet.com:18081"
RESTORE_HEIGHT = 3242000  # June 9, 2026 - fresh wallet, no history

print(f"Creating wallet from private key...")
print(f"Wallet file: {WALLET_FILE}")
print(f"Restore height: {RESTORE_HEIGHT}")
print()

# Start wallet RPC in background
print("Starting wallet RPC...")
proc = subprocess.Popen([
    'monero-wallet-rpc',
    '--daemon-address', DAEMON_URL,
    '--rpc-bind-port', str(RPC_PORT),
    '--disable-rpc-login',
    '--wallet-file', WALLET_FILE,
    '--password', WALLET_PASSWORD,
    '--log-level', '1'
], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

# Wait for RPC to start
time.sleep(3)

# Create wallet from keys using RPC
print("Creating wallet from spend key...")
try:
    response = requests.post(f'http://127.0.0.1:{RPC_PORT}/json_rpc', json={
        "jsonrpc": "2.0",
        "id": "0",
        "method": "generate_from_keys",
        "params": {
            "restore_height": RESTORE_HEIGHT,
            "filename": WALLET_FILE,
            "password": WALLET_PASSWORD,
            "spendkey": private_key,
            "address": ""  # Will be derived from spend key
        }
    })
    
    result = response.json()
    if 'result' in result:
        print(f"✓ Wallet created successfully!")
        print(f"Address: {result['result'].get('address', 'N/A')}")
    else:
        print(f"Error: {result.get('error', 'Unknown error')}")
        
except Exception as e:
    print(f"Error creating wallet: {e}")
finally:
    # Stop wallet RPC
    proc.terminate()
    proc.wait()
    print("\nWallet RPC stopped")

print("\nYou can now start wallet RPC with: ./start-wallet-rpc.sh")
