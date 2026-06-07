#!/bin/bash
set -e

echo "================================"
echo "Verifying WrapSynth on Gnosisscan"
echo "================================"

WSXMR="0x2d8d62dd1aff2daafdef9ac4d02b732529342016"
HUB="0x14e5f2da5cef85446952f1f1c3218d392740b23a"
ORACLE="0xe5f338111c416d53be910d93fd5748b345ed7321"
VAULT="0x8a3e1c1cdd88b22dce7a55f0d9412c480f886192"
MINT="0x2d01e62a2a07760953a9cbf8507f33d92f11e3b8"
BURN="0xbbf7dc2c91bd55ea47878d064e5d28e772959e94"
LIQ="0x802b9d5bdf814d16d28f68658c07fd60cf420719"
YIELD="0xe98c27f979af940bcec76ca9dc461e7918bc136a"
ROUTER="0xc2ad4d38ca14eaf6fb7801f795c67c694d0df597"

VERIFIER="0x0000000000000000000000000000000000000000"
SDAI="0xaf204776c7245bF4147c2612BF6e5972Ee483701"
POS_MANAGER="0xAE8fbE656a77519a7490054274910129c9244FA3"
POOL="0xb07bfc2591fAd1612FD2B77180e52733C4B7410E"

# ABI-encoded constructor args for (address,address)
FACET_ARGS="0x0000000000000000000000002d8d62dd1aff2daafdef9ac4d02b7325293420160000000000000000000000000000000000000000000000000000000000000000"
# ABI-encoded constructor args for (address,address,address,address,address)
ROUTER_ARGS="0x00000000000000000000000014e5f2da5cef85446952f1f1c3218d392740b23a000000000000000000000000ae8fbe656a77519a7490054274910129c9244fa3000000000000000000000000af204776c7245bf4147c2612bf6e5972ee4837010000000000000000000000002d8d62dd1aff2daafdef9ac4d02b732529342016000000000000000000000000b07bfc2591fad1612fd2b77180e52733c4b7410e"

echo ""
echo "1. Verifying wsXMR..."
forge verify-contract $WSXMR contracts/wsXMR.sol:wsXMR --chain gnosis --verifier etherscan --skip-is-verified-check || echo "wsXMR done"

echo ""
echo "2. Verifying wsXmrHub..."
forge verify-contract $HUB contracts/core/wsXmrHub.sol:wsXmrHub --constructor-args $FACET_ARGS --chain gnosis --verifier etherscan --skip-is-verified-check || echo "wsXmrHub done"

echo ""
echo "3. Verifying RedStoneOracleFacet..."
forge verify-contract $ORACLE contracts/facets/RedStoneOracleFacet.sol:RedStoneOracleFacet --constructor-args $FACET_ARGS --chain gnosis --verifier etherscan --skip-is-verified-check || echo "OracleFacet done"

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
echo "================================"
echo "Verification complete!"
echo "================================"
