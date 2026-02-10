const { ethers } = require("hardhat");

/**
 * Sign a mint intent for relayed execution
 * @param {Object} params - Intent parameters
 * @param {string} params.signer - Address of user who sent XMR
 * @param {string} params.recipient - Fresh address to receive wXMR
 * @param {string} params.lp - LP address to use
 * @param {string} params.expectedAmount - Expected wXMR amount (in piconero)
 * @param {number} params.nonce - Current nonce for signer
 * @param {number} params.deadline - Intent expiry timestamp
 * @param {string} params.maxRelayerFee - Max relayer fee (in piconero)
 * @param {string} relayerAddress - MintRelayer contract address
 * @param {Object} signerWallet - Ethers wallet to sign with
 * @returns {Object} Signed intent
 */
async function signMintIntent(params, relayerAddress, signerWallet) {
    const {
        signer,
        recipient,
        lp,
        expectedAmount,
        nonce,
        deadline,
        maxRelayerFee
    } = params;

    // Get domain separator from contract
    const relayerContract = await ethers.getContractAt("MintRelayer", relayerAddress);
    const chainId = (await ethers.provider.getNetwork()).chainId;

    // EIP-712 Domain
    const domain = {
        name: "HookedMoneroMintRelayer",
        version: "1",
        chainId: chainId,
        verifyingContract: relayerAddress
    };

    // EIP-712 Types
    const types = {
        MintIntent: [
            { name: "signer", type: "address" },
            { name: "recipient", type: "address" },
            { name: "lp", type: "address" },
            { name: "expectedAmount", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
            { name: "maxRelayerFee", type: "uint256" }
        ]
    };

    // Intent data
    const intent = {
        signer,
        recipient,
        lp,
        expectedAmount,
        nonce,
        deadline,
        maxRelayerFee
    };

    // Sign
    const signature = await signerWallet.signTypedData(domain, types, intent);

    return {
        intent,
        signature
    };
}

/**
 * Generate a fresh recipient address
 * @returns {Object} New wallet with address and private key
 */
function generateFreshAddress() {
    const wallet = ethers.Wallet.createRandom();
    return {
        address: wallet.address,
        privateKey: wallet.privateKey
    };
}

/**
 * Calculate relayer fee for a given amount
 * @param {string} amount - Amount in piconero
 * @param {number} relayerFeeBps - Relayer fee in basis points
 * @returns {string} Relayer fee in piconero
 */
function calculateRelayerFee(amount, relayerFeeBps) {
    return (BigInt(amount) * BigInt(relayerFeeBps) / BigInt(10000)).toString();
}

/**
 * Full flow: Generate fresh address and sign intent
 * @param {Object} params - Intent parameters (without recipient)
 * @param {string} relayerAddress - MintRelayer contract address
 * @param {Object} signerWallet - Ethers wallet to sign with
 * @returns {Object} Fresh address and signed intent
 */
async function createPrivateMintIntent(params, relayerAddress, signerWallet) {
    // Generate fresh recipient address
    const freshAddress = generateFreshAddress();
    
    // Get current nonce
    const relayerContract = await ethers.getContractAt("MintRelayer", relayerAddress);
    const nonce = await relayerContract.getNonce(params.signer);
    
    // Set deadline (1 hour from now)
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    
    // Calculate max relayer fee (e.g., 1% of amount)
    const maxRelayerFee = calculateRelayerFee(params.expectedAmount, 100);
    
    // Sign intent
    const { intent, signature } = await signMintIntent(
        {
            ...params,
            recipient: freshAddress.address,
            nonce,
            deadline,
            maxRelayerFee
        },
        relayerAddress,
        signerWallet
    );
    
    return {
        freshAddress,
        intent,
        signature
    };
}

module.exports = {
    signMintIntent,
    generateFreshAddress,
    calculateRelayerFee,
    createPrivateMintIntent
};
