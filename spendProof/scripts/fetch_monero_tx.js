const axios = require('axios');

// Real Monero stagenet transaction
const TX_HASH = "5caae835b751a5ab243b455ad05c489cb9a06d8444ab2e8d3a9d8ef905c1439a";
const BLOCK_HEIGHT = 1934116;
const API_BASE = "https://stagenet.xmr.ditatompel.com";

async function fetchTransaction() {
    console.log("🔍 Fetching Monero Transaction Data...\n");
    console.log(`TX Hash: ${TX_HASH}`);
    console.log(`Block: ${BLOCK_HEIGHT}`);
    console.log(`API: ${API_BASE}\n`);
    
    try {
        // Try different API endpoints
        
        // Method 1: Try REST API for transaction
        console.log("📡 Trying REST API endpoint...");
        try {
            const restResponse = await axios.get(`${API_BASE}/api/transaction/${TX_HASH}`);
            console.log("✅ REST API Response:");
            console.log(JSON.stringify(restResponse.data, null, 2));
            return restResponse.data;
        } catch (e) {
            console.log("❌ REST API failed:", e.message);
        }
        
        // Method 2: Try daemon RPC
        console.log("\n📡 Trying daemon RPC gettransactions...");
        try {
            const daemonResponse = await axios.post(`${API_BASE}/gettransactions`, {
                txs_hashes: [TX_HASH],
                decode_as_json: true
            });
            console.log("✅ Daemon RPC Response:");
            console.log(JSON.stringify(daemonResponse.data, null, 2));
            
            if (daemonResponse.data && daemonResponse.data.txs) {
                return parseTxData(daemonResponse.data.txs[0]);
            }
        } catch (e) {
            console.log("❌ Daemon RPC failed:", e.message);
        }
        
        // Method 3: Try block endpoint
        console.log("\n📡 Trying block endpoint...");
        try {
            const blockResponse = await axios.get(`${API_BASE}/api/block/${BLOCK_HEIGHT}`);
            console.log("✅ Block API Response:");
            console.log(JSON.stringify(blockResponse.data, null, 2).substring(0, 500) + "...");
            return blockResponse.data;
        } catch (e) {
            console.log("❌ Block API failed:", e.message);
        }
        
        // Method 4: Try search endpoint
        console.log("\n📡 Trying search endpoint...");
        try {
            const searchResponse = await axios.get(`${API_BASE}/api/search/${TX_HASH}`);
            console.log("✅ Search API Response:");
            console.log(JSON.stringify(searchResponse.data, null, 2));
            return searchResponse.data;
        } catch (e) {
            console.log("❌ Search API failed:", e.message);
        }
        
    } catch (error) {
        console.error("\n❌ Error:", error.message);
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Data:", error.response.data);
        }
    }
}

function parseTxData(txData) {
    console.log("\n📋 Parsing Transaction Data...\n");
    
    if (!txData) {
        console.log("❌ No transaction data to parse");
        return null;
    }
    
    // Parse the JSON if it's a string
    let txJson = txData;
    if (typeof txData.as_json === 'string') {
        txJson = JSON.parse(txData.as_json);
    }
    
    console.log("Transaction Version:", txJson.version);
    console.log("Unlock Time:", txJson.unlock_time);
    
    // Extract transaction public key (R) from extra field
    if (txJson.extra) {
        console.log("\n🔑 Extra Field:");
        console.log("Length:", txJson.extra.length, "bytes");
        
        // Extra field format: [tag, data...]
        // Tag 0x01 = transaction public key (32 bytes)
        if (txJson.extra[0] === 1 && txJson.extra.length >= 33) {
            const txPubKey = Buffer.from(txJson.extra.slice(1, 33)).toString('hex');
            console.log("Transaction Public Key (R):", txPubKey);
        }
    }
    
    // Extract outputs
    if (txJson.vout) {
        console.log("\n📤 Outputs:", txJson.vout.length);
        txJson.vout.forEach((out, idx) => {
            console.log(`\nOutput ${idx}:`);
            console.log("  Amount:", out.amount);
            if (out.target && out.target.key) {
                console.log("  One-time address:", out.target.key);
            }
        });
    }
    
    // Extract RCT signatures
    if (txJson.rct_signatures) {
        console.log("\n🔐 RingCT Signatures:");
        console.log("Type:", txJson.rct_signatures.type);
        console.log("Fee:", txJson.rct_signatures.txnFee);
        
        // ECDH info (encrypted amounts)
        if (txJson.rct_signatures.ecdhInfo) {
            console.log("\n💰 ECDH Info (Encrypted Amounts):");
            console.log("Count:", txJson.rct_signatures.ecdhInfo.length);
            txJson.rct_signatures.ecdhInfo.forEach((ecdh, idx) => {
                console.log(`\nECDH ${idx}:`);
                console.log("  Mask:", ecdh.mask || "N/A");
                console.log("  Amount:", ecdh.amount || "N/A");
            });
        }
        
        // Output commitments (Pedersen commitments)
        if (txJson.rct_signatures.outPk) {
            console.log("\n🎯 Output Commitments (Pedersen):");
            console.log("Count:", txJson.rct_signatures.outPk.length);
            txJson.rct_signatures.outPk.forEach((commitment, idx) => {
                console.log(`Commitment ${idx}:`, commitment);
            });
        }
    }
    
    return txJson;
}

// Run the script
fetchTransaction().then(() => {
    console.log("\n✅ Script completed");
}).catch(err => {
    console.error("\n❌ Script failed:", err.message);
});
