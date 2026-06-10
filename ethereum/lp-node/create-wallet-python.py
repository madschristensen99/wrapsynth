#!/usr/bin/env python3
import subprocess
import os
import requests
import time

# Load environment
with open('.env') as f:
    for line in f:
        if line.startswith('MONERO_PRIVATE_KEY='):
            private_key = line.split('=')[1].strip()
            break

WALLET_FILE = "lp-wallet-fresh"
WALLET_PASSWORD = "lp-password-change-me"
DAEMON = "https://xmr-node.cakewallet.com:18081"

# Get current height
try:
    resp = requests.get(f"{DAEMON}/get_info", timeout=5)
    current_height = resp.json().get('height', 3693400)
except:
    current_height = 3693400

restore_height = current_height - 10

print(f"Current Monero height: {current_height}")
print(f"Creating wallet with restore height: {restore_height} (only scanning last 10 blocks)")

# Create wallet using subprocess with stdin
proc = subprocess.Popen([
    'monero-wallet-cli',
    '--generate-from-spend-key', WALLET_FILE,
    '--password', WALLET_PASSWORD,
    '--restore-height', str(restore_height),
    '--daemon-address', DAEMON,
    '--trusted-daemon',
    '--command', 'exit'
], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

# Send private key and language selection
proc.stdin.write(f"{private_key}\n")
proc.stdin.write("1\n")  # English
proc.stdin.flush()

# Wait for completion
stdout, stderr = proc.communicate(timeout=30)

if proc.returncode == 0 or os.path.exists(f"{WALLET_FILE}.keys"):
    print(f"\n✅ Wallet created: {WALLET_FILE}")
    print(f"✅ Restore height: {restore_height}")
    print(f"✅ Will only scan ~10 blocks (should take <30 seconds)")
else:
    print(f"\n❌ Error creating wallet:")
    print(stdout)
    print(stderr)
