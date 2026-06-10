#!/bin/bash
set -e

echo "================================"
echo "Verifying WrapSynth on Gnosisscan"
echo "================================"

# Current Gnosis mainnet deployment addresses
WSXMR="0xf1AfA7DFF4F5feFba2c3C3D0e0e4BADeE2681225"
HUB="0xc75a388ce5d04a3831733937e8CaEc6e23bC24c4"
ROUTER="0x0D1CF3C6F0F71b99AB02049a46fbeBF7c3BFFf97"
ORACLE="0xCbE66353a44ffe0ab97Fc211a49a9c6efC0b2707"
VAULT="0x80dF75a0999619E51aEA40E9484c7Aea7Cf19F5C"
MINT="0x52c5C8E817dF71788DD6bDe69C748F5868f2250a"
BURN="0x2CA8CFFC50320A2c13A9e02807Db291Cfb654604"
LIQ="0xc9c9C664A5757bF6bb7A4fb2EC885Ff83541e596"
YIELD="0x035B50d75458C309B750bb7b4a2778b761E142C3"

# ABI-encoded constructor args for (address,address) - wsXMR + zero verifier
FACET_ARGS="0x000000000000000000000000f1afa7dff4f5fefba2c3c3d0e0e4badee26812250000000000000000000000000000000000000000000000000000000000000000"
# ABI-encoded constructor args for (address,address,address,address,address) - router
ROUTER_ARGS="0x000000000000000000000000c75a388ce5d04a3831733937e8caec6e23bc24c4000000000000000000000000ae8fbe656a77519a7490054274910129c9244fa3000000000000000000000000af204776c7245bf4147c2612bf6e5972ee483701000000000000000000000000f1afa7dff4f5fefba2c3c3d0e0e4badee2681225000000000000000000000000df8e9163944013782181d4f2e60f34e79971de64"

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
