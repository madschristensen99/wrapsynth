#!/usr/bin/env python3
"""
ZK-TLS Oracle Test Client

Tests the new ZK-TLS enabled Monero oracle endpoints.
"""

import socket
import json
import sys
import argparse
from datetime import datetime

class ZkOracleClient:
    def __init__(self, host='127.0.0.1', port=38089):
        self.host = host
        self.port = port
    
    def query(self, command):
        """Send a command to the ZK-TLS oracle server"""
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.connect((self.host, self.port))
                s.sendall(f"{command}\n".encode())
                data = b''
                while True:
                    chunk = s.recv(1024)
                    if not chunk:
                        break
                    data += chunk
                
                if data:
                    return data.decode().strip()
                return None
        except Exception as e:
            return f'{{"error": "Connection failed: {str(e)}"}}'
    
    def format_proof(self, proof_data):
        """Format ZK-TLS proof data for display"""
        if not proof_data:
            return "No proof data available"
        
        try:
            data = json.loads(proof_data)
            if "error" in data:
                return f"❌ Error: {data['error']}"
            
            formatted = []
            
            if "zk_tls_proof" in data:
                zk = data["zk_tls_proof"]
                formatted.append("🔐 ZK-TLS PROOF")
                if "data_commitment" in zk:
                    formatted.append(f"  Data commitment: {zk['data_commitment'][:8]}...")
                if "timestamp" in zk:
                    dt = datetime.fromtimestamp(zk['timestamp'])
                    formatted.append(f"  Generated: {dt.strftime('%Y-%m-%d %H:%M:%S UTC')}")
            
            if "solana_proof" in data:
                sol = data["solana_proof"]
                formatted.append("🔗 SOLANA PROOF")
                if "verification_hash" in sol:
                    formatted.append(f"  Verification: {sol['verification_hash'][:8]}...")
                if "oracle_pubkey" in sol:
                    formatted.append(f"  Oracle: {sol['oracle_pubkey']}")
            
            if "raw_data" in data:
                raw = data["raw_data"]
                formatted.append("📊 BLOCK DATA")
                if "block_header" in raw:
                    header = raw["block_header"]
                    formatted.append(f"  Height: {header.get('height', 'N/A')}")
                    formatted.append(f"  Timestamp: {header.get('timestamp', 'N/A')}")
                    formatted.append(f"  Hash: {header.get('hash', 'N/A')[:8]}...")
            
            return "\n".join(formatted)
            
        except json.JSONDecodeError:
            return f"Raw response: {proof_data}"
    
    def test_all_endpoints(self):
        """Test all available endpoints"""
        print("🧪 Testing ZK-TLS Oracle Endpoints")
        print("=" * 50)
        
        endpoints = [
            ("GET_ORACLE_STATUS", "Oracle Status"),
            ("GET_ZK_PROOF", "ZK Proof Bundle"),
            ("GET_SOLANA_PROOF", "Solana Proof"),
            ("GET_LATEST_BLOCK", "Latest Block"),
        ]
        
        for command, description in endpoints:
            print(f"\n📋 {description}")
            print(f"Command: {command}")
            
            response = self.query(command)
            if response:
                if command == "GET_ORACLE_STATUS":
                    try:
                        status = json.loads(response)
                        print(f"✅ Status: {json.dumps(status, indent=2)}")
                    except:
                        print(f"❌ Raw: {response}")
                else:
                    print(self.format_proof(response))
            else:
                print("❌ No response")
        
        print("\n" + "=" * 50)

def main():
    parser = argparse.ArgumentParser(description='Test ZK-TLS Monero Oracle')
    parser.add_argument('--host', default='127.0.0.1', help='Oracle host')
    parser.add_argument('--port', type=int, default=38089, help='Oracle port')
    parser.add_argument('--command', help='Send specific command')
    parser.add_argument('--continuous', action='store_true', help='Monitor continuously')
    
    args = parser.parse_args()
    
    client = ZkOracleClient(args.host, args.port)
    
    if args.command:
        print(f"Sending: {args.command}")
        response = client.query(args.command.upper())
        print(client.format_proof(response))
    elif args.continuous:
        print("Monitoring ZK-TLS Oracle (Ctrl+C to stop)")
        print("-" * 50)
        
        import time
        try:
            while True:
                response = client.query("GET_ORACLE_STATUS")
                try:
                    status = json.loads(response)
                    timestamp = datetime.now().strftime("%H:%M:%S")
                    if status.get('has_active_proof', False):
                        age = status.get('proof_age_seconds', 0)
                        print(f"[{timestamp}] ✅ Active proof (age: {age}s)")
                    else:
                        print(f"[{timestamp}] ❌ No active proof")
                except:
                    print(f"[{timestamp}] ⚠️ Status: {response}")
                
                time.sleep(5)
        except KeyboardInterrupt:
            print("\n🛑 Stopping monitor")
    else:
        client.test_all_endpoints()

if __name__ == "__main__":
    main()