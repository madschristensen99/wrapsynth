// Landing Page Live Stats - Fetch from Gnosis Mainnet
// Contract addresses are loaded from the canonical deployment.json (window.DEPLOYMENT).
import { createPublicClient, http, formatUnits, parseAbi } from 'https://esm.sh/viem@2.7.0';
import { gnosis } from 'https://esm.sh/viem@2.7.0/chains';

const D = window.DEPLOYMENT || {};
const CONFIG = {
    HUB_ADDRESS: D.contracts?.wsXmrHub || '0x96E2694a8277aaFE947D1A94eC0a4dD0C7A2Ffb7',
    WSXMR_ADDRESS: D.contracts?.wsXMR || '0xA39aF84413936f677159B1238B18016696e900Bb',
    RPC_URL: D.rpcUrl || 'https://rpc.gnosischain.com'
};

const HUB_ABI = parseAbi([
    'function getVaultCount() external view returns (uint256)',
    'function getVaultAtIndex(uint256 index) external view returns (address)',
    'function getVaultHealth(address lpAddress) external view returns (uint256)',
    'function getVaultDebt(address lpAddress) external view returns (uint256)',
    'function getXmrPrice() external view returns (uint256)',
    'function getCollateralPrice() external view returns (uint256)',
    'event MintInitiated(bytes32 indexed requestId, address indexed initiator, address indexed recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, uint256 timeout)',
    'event MintFinalized(bytes32 indexed requestId, bytes32 secret)',
    'event MintCancelled(bytes32 indexed requestId)',
    'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral)',
    'event BurnFinalized(bytes32 indexed requestId, bytes32 secret, uint256 reward)',
    'event BurnSlashed(bytes32 indexed requestId, address indexed user, uint256 totalSeized)'
]);

const GET_VAULT_ABI = [{
    inputs: [{ name: 'lpAddress', type: 'address' }],
    name: 'getVault',
    outputs: [{
        components: [
            { name: 'lpAddress', type: 'address' },
            { name: 'collateralShares', type: 'uint256' },
            { name: 'lockedCollateral', type: 'uint256' },
            { name: 'normalizedDebt', type: 'uint256' },
            { name: 'pendingDebt', type: 'uint256' },
            { name: 'maxMintBps', type: 'uint16' },
            { name: 'mintGriefingDeposit', type: 'uint256' },
            { name: 'mintReadyBond', type: 'uint256' },
            { name: 'mintFeeBps', type: 'uint16' },
            { name: 'burnRewardBps', type: 'uint16' },
            { name: 'liquidationNonce', type: 'uint256' },
            { name: 'mintNonce', type: 'uint256' },
            { name: 'minBurnAmount', type: 'uint256' },
            { name: 'active', type: 'bool' }
        ],
        name: '',
        type: 'tuple'
    }],
    stateMutability: 'view',
    type: 'function'
}];

const WSXMR_ABI = parseAbi([
    'function totalSupply() external view returns (uint256)',
    'function decimals() external view returns (uint8)',
    'event Transfer(address indexed from, address indexed to, uint256 value)'
]);

const publicClient = createPublicClient({
    chain: gnosis,
    transport: http(CONFIG.RPC_URL)
});

async function fetchXMRPrice() {
    try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd');
        const data = await response.json();
        return data.monero?.usd || 0;
    } catch (error) {
        console.error('Error fetching XMR price:', error);
        return 0;
    }
}

async function updateLandingStats() {
    try {
        // Fetch total supply
        const totalSupply = await publicClient.readContract({
            address: CONFIG.WSXMR_ADDRESS,
            abi: WSXMR_ABI,
            functionName: 'totalSupply'
        });

        const wsxmrAmount = parseFloat(formatUnits(totalSupply, 8));

        // Fetch XMR price
        const xmrPrice = await fetchXMRPrice();

        // Update TVL display
        const tvlNumber = document.querySelector('.tvl-number');
        const tvlUsd = document.querySelector('.tvl-usd');
        
        if (tvlNumber) {
            tvlNumber.textContent = wsxmrAmount.toFixed(4);
        }
        
        if (tvlUsd) {
            const usdValue = wsxmrAmount * xmrPrice;
            tvlUsd.textContent = `≈ $${usdValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
        }

        // Try to fetch vault count (may fail if Diamond doesn't expose this)
        let vaultCount = 0n;
        try {
            vaultCount = await publicClient.readContract({
                address: CONFIG.HUB_ADDRESS,
                abi: HUB_ABI,
                functionName: 'getVaultCount'
            });
        } catch (error) {
            console.warn('Could not fetch vault count from Diamond, using hardcoded vault');
            // Use hardcoded known vault if Diamond doesn't expose getVaultCount
            vaultCount = 1n;
        }

        // Fetch vault data - use hardcoded known vault address
        let totalCollateral = 0n;
        let totalDebt = 0n;
        let activeVaults = 0;
        
        const knownVaults = [
            '0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB' // Default LP vault
        ];

        for (const lpAddress of knownVaults) {
            try {
                const vault = await publicClient.readContract({
                    address: CONFIG.HUB_ADDRESS,
                    abi: GET_VAULT_ABI,
                    functionName: 'getVault',
                    args: [lpAddress]
                });

                if (vault.active) {
                    activeVaults++;
                    totalCollateral += vault.collateralShares;
                    totalDebt += vault.normalizedDebt;
                }
            } catch (error) {
                console.warn(`Error fetching vault ${lpAddress}:`, error);
            }
        }

        // Calculate collateralization ratio
        const collateralInEth = parseFloat(formatUnits(totalCollateral, 18));
        const debtInWsxmr = parseFloat(formatUnits(totalDebt, 8));
        
        // Fetch collateral price (sDAI ≈ $1)
        let collateralPrice = 1.0;
        try {
            const collateralPriceWei = await publicClient.readContract({
                address: CONFIG.HUB_ADDRESS,
                abi: HUB_ABI,
                functionName: 'getCollateralPrice'
            });
            collateralPrice = parseFloat(formatUnits(collateralPriceWei, 18));
        } catch (error) {
            console.warn('Could not fetch collateral price, using $1');
        }

        const collateralValueUsd = collateralInEth * collateralPrice;
        const debtValueUsd = debtInWsxmr * xmrPrice;
        const collateralizationRatio = debtValueUsd > 0 ? (collateralValueUsd / debtValueUsd) * 100 : 0;

        // Update stats
        const activeVaultsStat = document.getElementById('active-vaults-stat');
        if (activeVaultsStat) {
            activeVaultsStat.textContent = activeVaults;
        }

        const totalSupplyStat = document.getElementById('total-supply-stat');
        if (totalSupplyStat) {
            totalSupplyStat.textContent = `${wsxmrAmount.toFixed(2)} wsXMR`;
        }

        const collateralRatioStat = document.getElementById('collateral-ratio-stat');
        if (collateralRatioStat) {
            collateralRatioStat.textContent = `${collateralizationRatio.toFixed(0)}%`;
        }

        const tvlUsdStat = document.getElementById('tvl-usd-stat');
        if (tvlUsdStat) {
            tvlUsdStat.textContent = `$${collateralValueUsd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
        }

        // Fetch swap metrics from hub events
        let totalMints = 0;
        let totalBurns = 0;
        let completedMints = 0;
        let completedBurns = 0;
        let avgSwapTime = 0;
        
        try {
            const currentBlock = await publicClient.getBlockNumber();
            const fromBlock = currentBlock - 100000n; // Last ~100k blocks (about 2 weeks on Gnosis)
            
            // Fetch mint events
            const [mintInitiated, mintFinalized, mintCancelled] = await Promise.all([
                publicClient.getContractEvents({
                    address: CONFIG.HUB_ADDRESS,
                    abi: HUB_ABI,
                    eventName: 'MintInitiated',
                    fromBlock,
                    toBlock: 'latest'
                }),
                publicClient.getContractEvents({
                    address: CONFIG.HUB_ADDRESS,
                    abi: HUB_ABI,
                    eventName: 'MintFinalized',
                    fromBlock,
                    toBlock: 'latest'
                }),
                publicClient.getContractEvents({
                    address: CONFIG.HUB_ADDRESS,
                    abi: HUB_ABI,
                    eventName: 'MintCancelled',
                    fromBlock,
                    toBlock: 'latest'
                })
            ]);
            
            totalMints = mintInitiated.length;
            completedMints = mintFinalized.length;
            
            // Fetch burn events
            const [burnRequested, burnFinalized, burnSlashed] = await Promise.all([
                publicClient.getContractEvents({
                    address: CONFIG.HUB_ADDRESS,
                    abi: HUB_ABI,
                    eventName: 'BurnRequested',
                    fromBlock,
                    toBlock: 'latest'
                }),
                publicClient.getContractEvents({
                    address: CONFIG.HUB_ADDRESS,
                    abi: HUB_ABI,
                    eventName: 'BurnFinalized',
                    fromBlock,
                    toBlock: 'latest'
                }),
                publicClient.getContractEvents({
                    address: CONFIG.HUB_ADDRESS,
                    abi: HUB_ABI,
                    eventName: 'BurnSlashed',
                    fromBlock,
                    toBlock: 'latest'
                })
            ]);
            
            totalBurns = burnRequested.length;
            completedBurns = burnFinalized.length;
            
            // Calculate average swap time for completed mints
            if (mintFinalized.length > 0 && mintInitiated.length > 0) {
                let totalTime = 0;
                let count = 0;
                
                for (const finalizedEvent of mintFinalized) {
                    const requestId = finalizedEvent.args.requestId;
                    const initiatedEvent = mintInitiated.find(e => e.args.requestId === requestId);
                    
                    if (initiatedEvent) {
                        const [initiatedBlock, finalizedBlock] = await Promise.all([
                            publicClient.getBlock({ blockNumber: initiatedEvent.blockNumber }),
                            publicClient.getBlock({ blockNumber: finalizedEvent.blockNumber })
                        ]);
                        
                        const timeDiff = Number(finalizedBlock.timestamp - initiatedBlock.timestamp);
                        totalTime += timeDiff;
                        count++;
                    }
                }
                
                if (count > 0) {
                    avgSwapTime = Math.floor(totalTime / count / 60); // Convert to minutes
                }
            }
            
            console.log(`Swap metrics: ${totalMints} mints (${completedMints} completed), ${totalBurns} burns (${completedBurns} completed)`);
        } catch (error) {
            console.warn('Could not fetch swap events:', error);
        }

        // Update stats
        const totalTxsEl = document.getElementById('total-txs');
        if (totalTxsEl) {
            totalTxsEl.textContent = totalMints + totalBurns;
        }

        const verifiedTxsStat = document.getElementById('verified-txs-stat');
        if (verifiedTxsStat) {
            verifiedTxsStat.textContent = (completedMints + completedBurns).toLocaleString();
        }
        
        // Add average swap time if element exists
        const avgSwapTimeEl = document.getElementById('avg-swap-time');
        if (avgSwapTimeEl) {
            avgSwapTimeEl.textContent = avgSwapTime > 0 ? `~${avgSwapTime}m` : '--';
        }
        
        // Add success rate if element exists
        const successRateEl = document.getElementById('success-rate');
        if (successRateEl) {
            const totalSwaps = totalMints + totalBurns;
            const completedSwaps = completedMints + completedBurns;
            const successRate = totalSwaps > 0 ? Math.floor((completedSwaps / totalSwaps) * 100) : 100;
            successRateEl.textContent = `${successRate}%`;
        }

        console.log('Landing stats updated:', {
            wsxmrAmount,
            xmrPrice,
            activeVaults,
            collateralizationRatio: `${collateralizationRatio.toFixed(0)}%`,
            tvl: `$${collateralValueUsd.toFixed(2)}`
        });

    } catch (error) {
        console.error('Error updating landing stats:', error);
    }
}

// Update stats on load
document.addEventListener('DOMContentLoaded', () => {
    updateLandingStats();
    // Refresh every 30 seconds
    setInterval(updateLandingStats, 30000);
});

// Export for manual refresh
window.refreshLandingStats = updateLandingStats;
