#!/bin/bash

# ════════════════════════════════════════════════════════════════════════════
# Circom Circuit Compilation Script - PLONK
# ════════════════════════════════════════════════════════════════════════════
# This script compiles the monero_bridge.circom circuit using PLONK and 
# generates all necessary artifacts for proof generation and verification.
# ════════════════════════════════════════════════════════════════════════════

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
CIRCUIT_NAME="monero_bridge"
CIRCUIT_FILE="${CIRCUIT_NAME}.circom"
BUILD_DIR="build"
PTAU_FILE="powersOfTau28_hez_final_15.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau"

echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Monero Bridge Circuit Compilation (PLONK)${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"

# ════════════════════════════════════════════════════════════════════════════
# Step 1: Check Dependencies
# ════════════════════════════════════════════════════════════════════════════

echo -e "\n${YELLOW}[1/8]${NC} Checking dependencies..."

if ! command -v circom &> /dev/null; then
    echo -e "${RED}Error: circom is not installed${NC}"
    echo "Install it from: https://docs.circom.io/getting-started/installation/"
    exit 1
fi

if ! command -v snarkjs &> /dev/null; then
    echo -e "${RED}Error: snarkjs is not installed${NC}"
    echo "Install it with: npm install -g snarkjs"
    exit 1
fi

echo -e "${GREEN}✓ circom version: $(circom --version)${NC}"
echo -e "${GREEN}✓ snarkjs installed${NC}"

# ════════════════════════════════════════════════════════════════════════════
# Step 2: Install Circuit Dependencies
# ════════════════════════════════════════════════════════════════════════════

echo -e "\n${YELLOW}[2/8]${NC} Installing circuit dependencies..."

if [ ! -d "node_modules/circomlib" ]; then
    npm install --save circomlib
    echo -e "${GREEN}✓ circomlib installed${NC}"
else
    echo -e "${GREEN}✓ Dependencies already installed${NC}"
fi

# ════════════════════════════════════════════════════════════════════════════
# Step 3: Create Build Directory
# ════════════════════════════════════════════════════════════════════════════

echo -e "\n${YELLOW}[3/8]${NC} Setting up build directory..."

mkdir -p ${BUILD_DIR}
echo -e "${GREEN}✓ Build directory created${NC}"

# ════════════════════════════════════════════════════════════════════════════
# Step 4: Compile Circuit
# ════════════════════════════════════════════════════════════════════════════

echo -e "\n${YELLOW}[4/8]${NC} Compiling circuit..."

# Use -l flag to specify include path for circomlib
circom ${CIRCUIT_FILE} \
    --r1cs \
    --wasm \
    --sym \
    --c \
    -l node_modules \
    --output ${BUILD_DIR}

echo -e "${GREEN}✓ Circuit compiled successfully${NC}"

# Display circuit info
echo -e "\n${BLUE}Circuit Information:${NC}"
snarkjs r1cs info ${BUILD_DIR}/${CIRCUIT_NAME}.r1cs

# ════════════════════════════════════════════════════════════════════════════
# Step 5: Download Powers of Tau (if needed)
# ════════════════════════════════════════════════════════════════════════════

echo -e "\n${YELLOW}[5/8]${NC} Checking Powers of Tau ceremony file..."

if [ ! -f "${BUILD_DIR}/${PTAU_FILE}" ]; then
    echo "Downloading ${PTAU_FILE}..."
    echo "This may take a few minutes (approx 288 MB)..."
    wget -O ${BUILD_DIR}/${PTAU_FILE} ${PTAU_URL}
    echo -e "${GREEN}✓ Powers of Tau file downloaded${NC}"
else
    echo -e "${GREEN}✓ Powers of Tau file already exists${NC}"
fi

# ════════════════════════════════════════════════════════════════════════════
# Step 6: Setup PLONK
# ════════════════════════════════════════════════════════════════════════════

echo -e "\n${YELLOW}[6/8]${NC} Setting up PLONK..."

snarkjs plonk setup \
    ${BUILD_DIR}/${CIRCUIT_NAME}.r1cs \
    ${BUILD_DIR}/${PTAU_FILE} \
    ${BUILD_DIR}/${CIRCUIT_NAME}_final.zkey

echo -e "${GREEN}✓ PLONK setup completed${NC}"

# ════════════════════════════════════════════════════════════════════════════
# Step 7: Export Verification Key
# ════════════════════════════════════════════════════════════════════════════

echo -e "\n${YELLOW}[7/8]${NC} Exporting verification key..."

snarkjs zkey export verificationkey \
    ${BUILD_DIR}/${CIRCUIT_NAME}_final.zkey \
    ${BUILD_DIR}/verification_key.json

echo -e "${GREEN}✓ Verification key exported${NC}"

# ════════════════════════════════════════════════════════════════════════════
# Step 8: Export Solidity Verifier
# ════════════════════════════════════════════════════════════════════════════

echo -e "\n${YELLOW}[8/8]${NC} Generating Solidity verifier..."

snarkjs zkey export solidityverifier \
    ${BUILD_DIR}/${CIRCUIT_NAME}_final.zkey \
    ${BUILD_DIR}/MoneroBridgeVerifier.sol

echo -e "${GREEN}✓ Solidity verifier generated${NC}"

# Copy verifier to contracts folder for deployment
if [ -f "${BUILD_DIR}/MoneroBridgeVerifier.sol" ]; then
    cp ${BUILD_DIR}/MoneroBridgeVerifier.sol ../contracts/
    echo -e "${GREEN}✓ Verifier copied to contracts/ folder${NC}"
fi

# ════════════════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════════════════

echo -e "\n${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Compilation Complete!${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"

echo -e "\n${BLUE}Generated Files:${NC}"
echo -e "  • ${BUILD_DIR}/${CIRCUIT_NAME}.r1cs          - Constraint system"
echo -e "  • ${BUILD_DIR}/${CIRCUIT_NAME}.sym           - Symbol table"
echo -e "  • ${BUILD_DIR}/${CIRCUIT_NAME}_js/           - WASM witness calculator"
echo -e "  • ${BUILD_DIR}/${CIRCUIT_NAME}_cpp/          - C++ witness calculator"
echo -e "  • ${BUILD_DIR}/${CIRCUIT_NAME}_final.zkey    - PLONK proving key"
echo -e "  • ${BUILD_DIR}/verification_key.json         - Verification key"
echo -e "  • ../contracts/MoneroBridgeVerifier.sol      - Solidity verifier (deployed)"

echo -e "\n${BLUE}Next Steps:${NC}"
echo -e "  1. Test witness generation with sample inputs"
echo -e "  2. Generate a proof: snarkjs plonk prove"
echo -e "  3. Verify the proof: snarkjs plonk verify"
echo -e "  4. Deploy the Solidity verifier contract"

echo -e "\n${YELLOW}Note:${NC} The WASM witness calculator is in:"
echo -e "  ${BUILD_DIR}/${CIRCUIT_NAME}_js/${CIRCUIT_NAME}.wasm"

echo ""
