#!/usr/bin/env python3
"""Create Monero wallet from private key using pexpect"""

import pexpect
import sys

# Load private key from .env
with open('.env', 'r') as f:
    for line in f:
        if line.startswith('MONERO_PRIVATE_KEY='):
            private_key = line.split('=')[1].strip()
            break

WALLET_FILE = "lp-wallet"
WALLET_PASSWORD = "lp-password-change-me"
DAEMON_URL = "https://xmr.hexide.com"
RESTORE_HEIGHT = 3690400

print(f"Creating wallet from private key...")
print(f"Wallet file: {WALLET_FILE}")
print(f"Restore height: {RESTORE_HEIGHT}")
print()

# Spawn monero-wallet-cli
child = pexpect.spawn(
    f'monero-wallet-cli --generate-from-spend-key {WALLET_FILE} --password {WALLET_PASSWORD} --daemon-address {DAEMON_URL} --restore-height {RESTORE_HEIGHT}',
    timeout=60
)

child.logfile = sys.stdout.buffer

try:
    # Wait for spend key prompt
    child.expect('Secret spend key:')
    child.sendline(private_key)
    
    # Wait for language selection
    child.expect('Enter the number corresponding to the language of your choice:')
    child.sendline('1')  # English
    
    # Wait for view key prompt (press enter to auto-generate)
    child.expect('Secret view key:')
    child.sendline('')
    
    # Wait for restore height confirmation
    child.expect('Still apply restore height?', timeout=10)
    child.sendline('y')
    
    # Wait for wallet to be created
    child.expect('Generated new wallet:', timeout=30)
    
    # Send exit command
    child.sendline('exit')
    child.expect(pexpect.EOF)
    
    print("\n✓ Wallet created successfully!")
    print(f"Files: {WALLET_FILE}, {WALLET_FILE}.keys")
    print("\nYou can now start wallet RPC with: ./start-wallet-rpc.sh")
    
except pexpect.TIMEOUT:
    print("\nTimeout waiting for wallet creation")
    child.close()
    sys.exit(1)
except Exception as e:
    print(f"\nError: {e}")
    child.close()
    sys.exit(1)
