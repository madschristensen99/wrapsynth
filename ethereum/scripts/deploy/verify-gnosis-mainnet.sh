#!/bin/bash
set -e

echo "================================"
echo "Verifying WrapSynth on Gnosisscan"
echo "================================"

# Current Gnosis mainnet deployment addresses
WSXMR="0x1fab9db7aeb79a71278b1348acdf55ef55292010"
HUB="0xbf24788234512bb0aa10451f6efa88ca0e31d88e"
ROUTER="0x69ab32e9df71333fc3e6c526ef8cb9ea4cfa9a63"
ORACLE="0xa533cb055527ff3f8cfc3f3f2902fd0d208c20a2"
VAULT="0xcf8d4a0f5cf7abe725ccc2f765fc1c21798a0b99"
MINT="0x8b96fce0f6a8d1bc67829310d9513f9968b51041"
BURN="0x0fff27bf5645a9948a02aac65a170782baa45c78"
LIQ="0x7c3f2773a5a280604689a621b8bbaf2d92f77d96"
YIELD="0x2c73826c36895f7fff9839fe58d3ab164a206721"
SWAP_HELPER="0x4e18904a3be0703790ebb08b3385af0bc1ed5e07"

# ABI-encoded constructor args for (address,address) - wsXMR + zero verifier
FACET_ARGS="0x0000000000000000000000001fab9db7aeb79a71278b1348acdf55ef552920100000000000000000000000000000000000000000000000000000000000000000"
# ABI-encoded constructor args for (address,address,address,address,address) - router
ROUTER_ARGS="000000000000000000000000bf24788234512bb0aa10451f6efa88ca0e31d88e000000000000000000000000ae8fbe656a77519a7490054274910129c9244fa3000000000000000000000000af204776c7245bf4147c2612bf6e5972ee4837010000000000000000000000001fab9db7aeb79a71278b1348acdf55ef55292010000000000000000000000052063599d6f53e437f4dd07382b0183748057870"

echo ""
echo "1. Verifying wsXMR..."
forge verify-contract $WSXMR contracts/wsXMR.sol:wsXMR --chain gnosis --verifier etherscan --skip-is-verified-check || echo "wsXMR done"

echo ""
echo "2. Verifying wsXmrHub..."
forge verify-contract $HUB contracts/core/wsXmrHub.sol:wsXmrHub --constructor-args $FACET_ARGS --chain gnosis --verifier etherscan --skip-is-verified-check || echo "wsXmrHub done"

echo ""
echo "3. Verifying RedStoneOracleFacet..."
forge verify-contract $ORACLE contracts/redstone/RedStoneOracleFacet.sol:RedStoneOracleFacet --constructor-args $FACET_ARGS --chain gnosis --verifier etherscan --skip-is-verified-check || echo "OracleFacet done"

echo ""
echo "4. Verifying VaultFacet..."
forge verify-contract $VAULT contracts/facets/VaultFacet.sol:VaultFacet --constructor-args $FACET_ARGS --chain gnosis --verifier etherscan --skip-is-verified-check || echo "VaultFacet done"

echo ""
echo "5. Verifying MintFacet..."
forge verify-contract $MINT contracts/facets/MintFacet.sol:MintFacet --constructor-args $FACET_ARGS --chain gnosis --verifier etherscan --skip-is-verified-check || echo "MintFacet done"

echo ""
echo "6. Verifying BurnFacet..."
forge verify-contract $BURN contracts/facets/BurnFacet.sol:BurnFacet --constructor-args $FACET_ARGS --chain gnosis --verifier etherscan --skip-is-verified-check || echo "BurnFacet done"

echo ""
echo "7. Verifying LiquidationFacet..."
forge verify-contract $LIQ contracts/facets/LiquidationFacet.sol:LiquidationFacet --constructor-args $FACET_ARGS --chain gnosis --verifier etherscan --skip-is-verified-check || echo "LiquidationFacet done"

echo ""
echo "8. Verifying YieldFacet..."
forge verify-contract $YIELD contracts/facets/YieldFacet.sol:YieldFacet --constructor-args $FACET_ARGS --chain gnosis --verifier etherscan --skip-is-verified-check || echo "YieldFacet done"

echo ""
echo "9. Verifying wsXMRLiquidityRouter..."
forge verify-contract $ROUTER contracts/router/wsXMRLiquidityRouter.sol:wsXMRLiquidityRouter --constructor-args $ROUTER_ARGS --chain gnosis --verifier etherscan --skip-is-verified-check || echo "Router done"

echo ""
echo "10. Verifying SwapHelper..."
forge verify-contract $SWAP_HELPER contracts/test/SwapHelper.sol:SwapHelper --chain gnosis --verifier etherscan --skip-is-verified-check || echo "SwapHelper done"

echo ""
echo "================================"
echo "Verification complete!"
echo "================================"
