const { ethers } = require('hardhat');

/**
 * Simple oracle update using publicly available price data
 * No API keys required - uses on-chain Chainlink aggregators
 */

// Deployed contracts
const ORACLE_FACET = '0xfeB574473a45CBAe296160AC9274932147da7507';
const HUB = '0x577B42FC4FCBcCE799de1FB8c40592DE15Ac100a';

// Chainlink Price Feed Aggregators on Gnosis Chain
const DAI_USD_FEED = '0x678df3415BB319E5E94Dc79B7c9ca72338C201C7'; // DAI/USD on Gnosis

// Feed IDs that OracleFacet expects
const XMR_FEED_ID = '0x00038f3b8f8be4305564abf0ed3c9cc46cb8b4303c35ab54079ea873b7d74b3a';
const DAI_FEED_ID = '0x0003a9efc56074727bde001b0f0301eef38db844278734c32aa8b72dcb7902ba';

// ABI for Chainlink Aggregator
const AGGREGATOR_ABI = [
    'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'
];

async function buildMockReport(feedId, price) {
    // Build a mock ReportV3 struct that matches what the verifier would return
    const report = {
        feedId: feedId,
        validFromTimestamp: Math.floor(Date.now() / 1000),
        observationsTimestamp: Math.floor(Date.now() / 1000),
        nativeFee: 0,
        linkFee: 0,
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        price: price, // 8 decimals
        bid: price,
        ask: price
    };
    
    // Encode as the verifier would
    return ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(bytes32,uint32,uint32,uint192,uint192,uint32,int192,int192,int192)'],
        [[
            report.feedId,
            report.validFromTimestamp,
            report.observationsTimestamp,
            report.nativeFee,
            report.linkFee,
            report.expiresAt,
            report.price,
            report.bid,
            report.ask
        ]]
    );
}

async function buildReportPayload(feedId, price) {
    // The OracleFacet expects: bytes[] where each is a payload for the verifier
    // Payload format: abi.encode(bytes32[3] reportContext, bytes reportData)
    // reportData format: uint16(version) + feedId + ...
    
    const reportContext = [
        ethers.ZeroHash,
        ethers.ZeroHash,
        ethers.ZeroHash
    ];
    
    // Build reportData: version (2 bytes) + feedId (32 bytes) + timestamp (8 bytes)
    const version = 3;
    const reportData = ethers.concat([
        ethers.toBeHex(version, 2),
        feedId,
        ethers.toBeHex(Math.floor(Date.now() / 1000), 8)
    ]);
    
    return ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32[3]', 'bytes'],
        [reportContext, reportData]
    );
}

async function main() {
    console.log('============================================================');
    console.log('Simple Oracle Update (No API Keys Required)');
    console.log('============================================================\n');
    
    const [signer] = await ethers.getSigners();
    console.log('Signer:', signer.address);
    console.log('Balance:', ethers.formatEther(await ethers.provider.getBalance(signer.address)), 'xDAI\n');
    
    // Fetch DAI price from Chainlink aggregator
    console.log('Fetching DAI price from Chainlink aggregator...');
    const daiAggregator = new ethers.Contract(DAI_USD_FEED, AGGREGATOR_ABI, signer);
    const daiData = await daiAggregator.latestRoundData();
    const daiPrice = daiData.answer; // Already 8 decimals
    
    console.log('DAI Price:', ethers.formatUnits(daiPrice, 8), 'USD');
    console.log('Updated at:', new Date(Number(daiData.updatedAt) * 1000).toISOString());
    console.log('');
    
    // For XMR, we'll use a reasonable estimate since there's no Gnosis aggregator
    // In production, you'd fetch this from an external API or use a different chain
    const xmrPrice = ethers.parseUnits('160', 8); // $160 as example
    console.log('Using XMR price estimate:', ethers.formatUnits(xmrPrice, 8), 'USD');
    console.log('(Note: XMR has no Chainlink feed on Gnosis - using placeholder)\n');
    
    console.log('============================================================');
    console.log('Updating Oracle (Direct State Update)');
    console.log('============================================================\n');
    
    // Get the hub contract to update state directly
    const hub = await ethers.getContractAt('wsXmrHub', HUB, signer);
    
    console.log('OPTION 1: Update via mock verifier deployment');
    console.log('OPTION 2: Fork and modify OracleFacet to use standard feeds');
    console.log('OPTION 3: Use Chainlink Data Streams (requires API access)\n');
    
    console.log('Current limitation: Your OracleFacet requires Data Streams verifier.');
    console.log('');
    console.log('Solutions:');
    console.log('1. Deploy MockVerifierProxy and use it for testing');
    console.log('2. Modify OracleFacet to read from standard Chainlink aggregators');
    console.log('3. Get Chainlink Data Streams API access (free for testnet)');
    console.log('');
    console.log('For now, let me show you the prices we CAN fetch:');
    console.log('  DAI/USD:', ethers.formatUnits(daiPrice, 8), '(from on-chain aggregator)');
    console.log('  XMR/USD: Not available on Gnosis Chainlink feeds');
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });
