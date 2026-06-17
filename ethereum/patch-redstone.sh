#!/bin/bash
# Patch RedStone EVM connector assembly blocks with memory-safe annotations
# This fixes the Yul stack-too-deep error when compiling RedStoneOracleFacet

REDBASE="lib/redstone-oracles-monorepo/packages/evm-connector"

for f in \
  "$REDBASE/contracts/core/CalldataExtractor.sol" \
  "$REDBASE/contracts/core/RedstoneConsumerBase.sol" \
  "$REDBASE/contracts/core/RedstoneConsumerNumericBase.sol" \
  "$REDBASE/contracts/core/RedstoneConsumerBytesBase.sol" \
  "$REDBASE/contracts/core/ProxyConnector.sol" \
  "$REDBASE/contracts/libs/NumericArrayLib.sol" \
  "$REDBASE/contracts/libs/SignatureLib.sol"; do
  if [ -f "$f" ]; then
    sed -i 's/assembly {/assembly ("memory-safe") {/g' "$f"
    echo "Patched: $f"
  fi
done

echo "Done. Run 'forge build' to compile."
