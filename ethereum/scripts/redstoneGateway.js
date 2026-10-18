// RedStone gateway config for scripts.
//
// RedStone's public gateways are being switched off (rejection windows grow
// daily until 2026-10-29). Signed data packages must be fetched from an
// authenticated gateway with an API key:
//   REDSTONE_GATEWAY_URL — authenticated gateway base URL (from RedStone)
//   REDSTONE_API_KEY     — sent as x-api-key on every gateway request
// Without a key the scripts fall back to the public gateways, which only
// work between rejection windows.

const axios = require('axios'); // same instance the SDK's request layer uses

if (process.env.REDSTONE_API_KEY) {
    axios.defaults.headers.common['x-api-key'] = process.env.REDSTONE_API_KEY;
}

function redstoneGatewayUrls() {
    const urls = [];
    if (process.env.REDSTONE_GATEWAY_URL) urls.push(process.env.REDSTONE_GATEWAY_URL);
    urls.push('https://oracle-gateway-1.a.redstone.finance');
    return urls;
}

module.exports = { redstoneGatewayUrls };
