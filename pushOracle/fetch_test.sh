#!/bin/bash
echo "Testing Monero node connection..."
curl -X POST http://node.monerodevs.org:38089 -d '{"jsonrpc":"2.0","id":"0","method":"get_block_count","params":{}}' -H 'Content-Type: application/json' | jq .

sleep 2

echo ""
echo "Testing direct block fetch..."
curl -X POST http://node.monerodevs.org:38089 -d '{"jsonrpc":"2.0","id":"0","method":"get_block","params":{"height":1984863}}' -H 'Content-Type: application/json' | jq .