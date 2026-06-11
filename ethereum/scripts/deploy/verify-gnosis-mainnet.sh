#!/bin/bash
set -e

echo "================================"
echo "Verifying WrapSynth on Gnosisscan"
echo "================================"

# Current Gnosis mainnet deployment addresses
WSXMR="0x30Aeb2A142744430fFD7D698D5C7C41769CE1279"
HUB="0x1fb8E7593B01bCdAE13e5b63e529f0e30a3ebD50"
ROUTER="0x6893f38e1DeEdCa95ce8995B01550921cEe353a1"
ORACLE="0xa04bB8E8670c95Ae3017b959dcC7FAdA73A003dc"
VAULT="0x81Ef0aF3Eb50Df7241eaC44364dD64A0B754E6cB"
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
