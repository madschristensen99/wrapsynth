#!/usr/bin/env python3
import requests
import json
import time
import socket

def test_monero_rpc():
    """Test direct Monero RPC connection"""
    url = "http://node.monerodevs.org:38089/json_rpc"
    
    payload = {
        "jsonrpc": "2.0",
        "id": "0",
        "method": "get_block_count",
        "params": {}
    }
    
    try:
        response = requests.post(url, json=payload, timeout=10)
        result = response.json()
        print("✅ Monero RPC test - Block count:", result.get("result", {}).get("count"))
        return result["result"]["count"]
    except Exception as e:
        print("❌ Monero RPC test failed:", str(e))
        return None

def test_block_data(height):
    """Test getting block data"""
    url = "http://node.monerodevs.org:38089/json_rpc"
    
    payload = {
        "jsonrpc": "2.0",
        "id": "0",
        "method": "get_block",
        "params": {"height": height}
    }
    
    try:
        response = requests.post(url, json=payload, timeout=10)
        result = response.json()
        
        if "result" in result and "block_header" in result["result"]:
            header = result["result"]["block_header"]
            print("✅ Block data retrieved:")
            print(f"  Height: {header.get('height')}")
            print(f"  Hash: {header.get('hash')}")
            print(f"  Timestamp: {header.get('timestamp')}")
            print(f"  Tx count: {len(header.get('tx_hashes', []))}")
            return result["result"]
        else:
            print("❌ Malformed block response:", result)
            return None
    except Exception as e:
        print("❌ Block data test failed:", str(e))
        return None

def push_to_solana_devnet(block_data):
    """Simulate pushing block data to Solana devnet"""
    print("📡 Preparing to push to Solana devnet...")
    
    # This is where we'll integrate with Solana client
    block_hash = block_data["block_header"]["hash"]
    height = block_data["block_header"]["height"]
    timestamp = block_data["block_header"]["timestamp"]
    tx_hashes = block_data["block_header"].get("tx_hashes", [])
    
    # Format for Solana
    oracle_data = {
        "block_hash": block_hash,
        "height": height,
        "timestamp": timestamp,
        "source": "monero_oracle",
        "timestamp_submitted": int(time.time()),
        "transactions_count": len(tx_hashes)
    }
    
    print("✅ Oracle data prepared for Solana:")
    print(json.dumps(oracle_data, indent=2))
    return oracle_data

if __name__ == "__main__":
    print("🧪 Testing Monero oracle connection...")
    
    height = test_monero_rpc()
    if height:
        # Subtract 1 to get the actual top block
        block_data = test_block_data(height - 1)
        if block_data:
            solana_data = push_to_solana_devnet(block_data)
            print("🎯 Ready to push to Solana devnet!")