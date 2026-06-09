#!/usr/bin/env node
/**
 * Test both sides of the sDAI/wsXMR Uniswap V3 pool by doing small swaps
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { HUB_ADDRESS, SDAI_ADDRESS, WSXMR_ADDRESS, POOL_ADDRESS, SWAP_ROUTER, UNI_V3_FACTORY } = require('./deploymentConfig');

const POOL_FEE = 3000;

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log('Wallet:', wallet.address);
    console.log('');

    // Check wsXMR balance
    const wsxmrCheckAbi = ['function balanceOf(address) external view returns (uint256)'];
    const wsxmrCheck = new ethers.Contract(WSXMR_ADDRESS, wsxmrCheckAbi, provider);
    const initialBalance = await wsxmrCheck.balanceOf(wallet.address);
    console.log('Initial wsXMR balance:', ethers.utils.formatUnits(initialBalance, 8));
    console.log('');

    const factoryAbi = ['function getPool(address,address,uint24) external view returns (address)'];
    const poolAbi = [
        'function slot0() external view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
        'function liquidity() external view returns (uint128)',
        'function token0() external view returns (address)',
        'function token1() external view returns (address)'
    ];
    const erc20Abi = [
        'function balanceOf(address) external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function transfer(address to, uint256 amount) external returns (bool)',
        'function decimals() external view returns (uint8)',
        'function symbol() external view returns (string)'
    ];
    const routerAbi = [
        'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
    ];

    const factory = new ethers.Contract(UNI_V3_FACTORY, factoryAbi, provider);
    const poolAddr = await factory.getPool(SDAI_ADDRESS, WSXMR_ADDRESS, POOL_FEE);
    console.log('Pool address:', poolAddr);

    if (poolAddr === ethers.constants.AddressZero) {
        console.error('Pool does not exist!');
        process.exit(1);
    }

    const pool = new ethers.Contract(poolAddr, poolAbi, provider);
    const slot0 = await pool.slot0();
    const liquidity = await pool.liquidity();
    const token0 = await pool.token0();
    const token1 = await pool.token1();

    console.log('Pool state:');
    console.log('  sqrtPriceX96:', slot0.sqrtPriceX96.toString());
    console.log('  tick:', slot0.tick);
    console.log('  liquidity:', liquidity.toString());
    console.log('  token0:', token0);
    console.log('  token1:', token1);
    console.log('');

    const sdai = new ethers.Contract(SDAI_ADDRESS, erc20Abi, wallet);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, erc20Abi, wallet);
    const swapRouter = new ethers.Contract(SWAP_ROUTER, routerAbi, wallet);
    const positionManager = new ethers.Contract(
        '0xAE8fbE656a77519a7490054274910129c9244FA3',
        [
            'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'
        ],
        wallet
    );

    // Skip adding liquidity - test with existing pool liquidity from Co-LP
    console.log('Testing swaps with existing pool liquidity from Co-LP positions...');
    console.log('');

    const sdaiBalanceAfterLP = await sdai.balanceOf(wallet.address);
    const wsxmrBalanceAfterLP = await wsxmr.balanceOf(wallet.address);
    const sdaiSymbol = await sdai.symbol();
    const wsxmrSymbol = await wsxmr.symbol();
    const sdaiDecimals = await sdai.decimals();
    const wsxmrDecimals = await wsxmr.decimals();

    console.log('Wallet balances:');
    console.log('  ', wsxmrSymbol + ':', ethers.utils.formatUnits(wsxmrBalanceAfterLP, wsxmrDecimals));
    console.log('  ', sdaiSymbol + ':', ethers.utils.formatUnits(sdaiBalanceAfterLP, sdaiDecimals));
    console.log('');

    if (wsxmrBalanceAfterLP.eq(0) && sdaiBalanceAfterLP.eq(0)) {
        console.error('No tokens to swap!');
        process.exit(1);
    }

    // --- Swap 1: wsXMR -> sDAI (via SwapHelper) ---
    if (wsxmrBalanceAfterLP.gt(10)) {
        const wsxmrSwapAmount = ethers.BigNumber.from('1000'); // 0.00001 wsXMR
        console.log('Swap 1: wsXMR -> sDAI');
        console.log('  Amount in:', ethers.utils.formatUnits(wsxmrSwapAmount, wsxmrDecimals), wsxmrSymbol);

        // Approve SwapHelper to spend tokens
        const swapHelperAddr = '0x638f37995F762388621c8a6AE48671d1BD591AAc';
        const approve1 = await wsxmr.approve(swapHelperAddr, wsxmrSwapAmount, {
            maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
            maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
        });
        await approve1.wait();
        console.log('  Approved SwapHelper');

        // Call SwapHelper
        const swapHelperAbi = ['function swap(address pool, address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) external returns (int256, int256)'];
        const swapHelper = new ethers.Contract(swapHelperAddr, swapHelperAbi, wallet);
        
        const swap1 = await swapHelper.swap(
            poolAddr,
            wallet.address,
            true, // zeroForOne (wsXMR -> sDAI)
            wsxmrSwapAmount,
            0, // no price limit
            {
                gasLimit: 800000,
                maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
                maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
            }
        );
        const receipt1 = await swap1.wait();
        console.log('  Swap TX:', swap1.hash);

        const sdaiAfter1 = await sdai.balanceOf(wallet.address);
        const sdaiReceived = sdaiAfter1.sub(sdaiBalanceAfterLP);
        console.log('  sDAI received:', ethers.utils.formatUnits(sdaiReceived, sdaiDecimals));
        console.log('');
    } else {
        console.log('Skip swap 1: not enough wsXMR');
    }

    // --- Swap 2: sDAI -> wsXMR ---
    const sdaiBalanceAfter1 = await sdai.balanceOf(wallet.address);
    if (sdaiBalanceAfter1.gt(ethers.utils.parseUnits('0.001', sdaiDecimals))) {
        const sdaiSwapAmount = ethers.utils.parseUnits('0.001', sdaiDecimals); // 0.001 sDAI
        console.log('Swap 2: sDAI -> wsXMR');
        console.log('  Amount in:', ethers.utils.formatUnits(sdaiSwapAmount, sdaiDecimals), sdaiSymbol);

        // Approve SwapHelper
        const swapHelperAddr = '0x638f37995F762388621c8a6AE48671d1BD591AAc';
        const approve2 = await sdai.approve(swapHelperAddr, sdaiSwapAmount, {
            maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
            maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
        });
        await approve2.wait();
        console.log('  Approved SwapHelper');

        // Call SwapHelper
        const swapHelperAbi = ['function swap(address pool, address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) external returns (int256, int256)'];
        const swapHelper = new ethers.Contract(swapHelperAddr, swapHelperAbi, wallet);
        
        const swap2 = await swapHelper.swap(
            poolAddr,
            wallet.address,
            false, // zeroForOne = false (sDAI -> wsXMR)
            sdaiSwapAmount,
            0, // no price limit
            {
                gasLimit: 800000,
                maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
                maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
            }
        );
        const receipt2 = await swap2.wait();
        console.log('  Swap TX:', swap2.hash);

        const wsxmrAfter2 = await wsxmr.balanceOf(wallet.address);
        console.log('  Final wsXMR:', ethers.utils.formatUnits(wsxmrAfter2, wsxmrDecimals));
        console.log('');
    } else {
        console.log('Skip swap 2: not enough sDAI');
    }

    console.log('✅ Basic swaps complete!');
    console.log('');

    // --- Test Co-LP Position + Fee Collection ---
    console.log('=== Co-LP Position & Fee Collection Test ===');
    console.log('');

    const hubAbi = [
        'function liquidityRouter() external view returns (address)',
        'function userOpenCoLP(address user, uint256 wsxmrAmount, uint256 deadline) external returns (uint256 tokenId)',
        'function collectCoLPFees(uint256 tokenId) external returns (uint256 amount0, uint256 amount1)',
        'function getPendingCoLPReturns(address user) external view returns (uint256)'
    ];
    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);

    // Check if we have an existing Co-LP position from previous tests
    const positionManagerFullAbi = [
        'function balanceOf(address owner) external view returns (uint256)',
        'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
        'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
    ];
    const positionMgr = new ethers.Contract('0xAE8fbE656a77519a7490054274910129c9244FA3', positionManagerFullAbi, provider);
    
    const numPositions = await positionMgr.balanceOf(wallet.address);
    console.log('Existing NFT positions:', numPositions.toString());

    let coLPTokenId = null;
    
    // Check if we have existing positions
    if (numPositions.gt(0)) {
        // Get the last position
        const lastTokenId = await positionMgr.tokenOfOwnerByIndex(wallet.address, numPositions.sub(1));
        const position = await positionMgr.positions(lastTokenId);
        
        // Check if it's our pool
        if ((position.token0.toLowerCase() === SDAI_ADDRESS.toLowerCase() && position.token1.toLowerCase() === WSXMR_ADDRESS.toLowerCase()) ||
            (position.token0.toLowerCase() === WSXMR_ADDRESS.toLowerCase() && position.token1.toLowerCase() === SDAI_ADDRESS.toLowerCase())) {
            coLPTokenId = lastTokenId;
            console.log('Found existing Co-LP position, tokenId:', coLPTokenId.toString());
            console.log('  Liquidity:', position.liquidity.toString());
            console.log('  Fees owed - token0:', position.tokensOwed0.toString(), 'token1:', position.tokensOwed1.toString());
        }
    }

    // If no existing position, create one
    if (!coLPTokenId) {
        console.log('Creating new Co-LP position...');
        
        const wsxmrBalanceForCoLP = await wsxmr.balanceOf(wallet.address);
        if (wsxmrBalanceForCoLP.lt(ethers.utils.parseUnits('0.0001', 8))) {
            console.log('⚠️  Not enough wsXMR for Co-LP, skipping Co-LP test');
        } else {
            const coLPAmount = ethers.utils.parseUnits('0.0001', 8); // 0.0001 wsXMR
            
            // Approve hub
            const approveCoLP = await wsxmr.approve(HUB_ADDRESS, coLPAmount, {
                maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
                maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
            });
            await approveCoLP.wait();
            console.log('  Approved hub for wsXMR');

            // Update prices before Co-LP
            const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
                dataServiceId: 'redstone-primary-prod',
                uniqueSignersCount: 1,
                dataFeeds: ['XMR', 'DAI']
            }, ['https://oracle-gateway-1.a.redstone.finance']);

            try {
                const updatePricesTx = await wrappedHub.updatePrices({
                    maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
                    maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
                });
                await updatePricesTx.wait();
                console.log('  Prices updated');
            } catch (e) {
                console.log('  Price update failed (may not have oracle facet), continuing...');
            }

            const deadline = Math.floor(Date.now() / 1000) + 600;
            const coLPTx = await hub.userOpenCoLP(wallet.address, coLPAmount, deadline, {
                gasLimit: 800000,
                maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
                maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
            });
            const coLPReceipt = await coLPTx.wait();
            console.log('  Co-LP TX:', coLPTx.hash);

            // Get the new token ID from the receipt
            const numPositionsAfter = await positionMgr.balanceOf(wallet.address);
            coLPTokenId = await positionMgr.tokenOfOwnerByIndex(wallet.address, numPositionsAfter.sub(1));
            console.log('  Created Co-LP position, tokenId:', coLPTokenId.toString());
        }
    }

    // Do some swaps to generate fees
    if (coLPTokenId) {
        console.log('');
        console.log('Doing swaps to generate fees...');
        
        // Swap 1: Tiny wsXMR -> sDAI to generate fees
        const wsxmrForSwap = await wsxmr.balanceOf(wallet.address);
        if (wsxmrForSwap.gt(5)) {
            const swapAmount = ethers.BigNumber.from('5'); // 0.00000005 wsXMR
            const approveSwap = await wsxmr.approve(SWAP_ROUTER, swapAmount, {
                maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
                maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
            });
            await approveSwap.wait();

            const deadline = Math.floor(Date.now() / 1000) + 600;
            const swapParams = {
                tokenIn: WSXMR_ADDRESS,
                tokenOut: SDAI_ADDRESS,
                fee: POOL_FEE,
                recipient: wallet.address,
                deadline: deadline,
                amountIn: swapAmount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            };

            try {
                const swapTx = await swapRouter.exactInputSingle(swapParams, {
                    gasLimit: 800000,
                    maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
                    maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
                });
                await swapTx.wait();
                console.log('  Swap 1 TX:', swapTx.hash);
            } catch (e) {
                console.log('  Swap 1 failed:', e.message.split('\n')[0]);
            }
        }

        // Swap 2: Tiny sDAI -> wsXMR to generate fees
        const sdaiForSwap = await sdai.balanceOf(wallet.address);
        if (sdaiForSwap.gt(ethers.utils.parseUnits('0.00001', 18))) {
            const swapAmount = ethers.utils.parseUnits('0.00001', 18); // 0.00001 sDAI
            const approveSwap = await sdai.approve(SWAP_ROUTER, swapAmount, {
                maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
                maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
            });
            await approveSwap.wait();

            const deadline = Math.floor(Date.now() / 1000) + 600;
            const swapParams = {
                tokenIn: SDAI_ADDRESS,
                tokenOut: WSXMR_ADDRESS,
                fee: POOL_FEE,
                recipient: wallet.address,
                deadline: deadline,
                amountIn: swapAmount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            };

            try {
                const swapTx = await swapRouter.exactInputSingle(swapParams, {
                    gasLimit: 800000,
                    maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
                    maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
                });
                await swapTx.wait();
                console.log('  Swap 2 TX:', swapTx.hash);
            } catch (e) {
                console.log('  Swap 2 failed:', e.message.split('\n')[0]);
            }
        }

        console.log('');
        console.log('Collecting Co-LP fees...');
        
        // Check position before collecting
        const positionBefore = await positionMgr.positions(coLPTokenId);
        console.log('  Fees before collection:');
        console.log('    token0:', positionBefore.tokensOwed0.toString());
        console.log('    token1:', positionBefore.tokensOwed1.toString());

        try {
            const collectTx = await hub.collectCoLPFees(coLPTokenId, {
                gasLimit: 500000,
                maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
                maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
            });
            const collectReceipt = await collectTx.wait();
            console.log('  Collect TX:', collectTx.hash);

            // Check position after collecting
            const positionAfter = await positionMgr.positions(coLPTokenId);
            console.log('  Fees after collection:');
            console.log('    token0:', positionAfter.tokensOwed0.toString());
            console.log('    token1:', positionAfter.tokensOwed1.toString());
            
            console.log('✅ Fee collection complete!');
        } catch (e) {
            console.log('  Fee collection failed:', e.message.split('\n')[0]);
        }
    }

    console.log('');
    console.log('🎉 Comprehensive pool test complete!');
}

main().catch(console.error);
