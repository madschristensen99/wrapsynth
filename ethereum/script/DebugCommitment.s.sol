// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../contracts/Ed25519Helper.sol";
import "../contracts/interfaces/swap/IMintOperations.sol";
import "../contracts/core/wsXmrStorage.sol";

contract DebugCommitment is Script {
    function run() external view {
        // Ed25519Helper address from deployment
        Ed25519Helper helper = Ed25519Helper(0xaECa36374039EAb9e267B5daa48bAb9Ab0e50F00);
        
        // Test secret from the error
        bytes32 secret = 0x057e581e1182afd422b732e2f3b22d24ce29a7d983adfdac407e0973546b04cf;
        
        console.log("Testing secret:");
        console.logBytes32(secret);
        
        // Get the commitment from Solidity
        bytes32 solidityCommitment = helper.computeCommitment(secret);
        console.log("\nSolidity commitment:");
        console.logBytes32(solidityCommitment);
        
        // Get the public key point from Solidity
        (uint256 px, uint256 py) = helper.scalarMultBase(uint256(secret));
        console.log("\nSolidity px:");
        console.log(px);
        console.log("\nSolidity py:");
        console.log(py);
        
        // Manually compute commitment to verify
        bytes32 manualCommitment = keccak256(abi.encodePacked(px, py));
        console.log("\nManual commitment:");
        console.logBytes32(manualCommitment);
        console.log("Match:", solidityCommitment == manualCommitment);
        
        // Now check what was stored in the mint request
        bytes32 requestId = 0x97704b6cd0cd9196204717e50dd4ffea33ef12a95666f5d9b4c56f3f23afa399;
        IMintOperations hub = IMintOperations(0xc0B772BD1b4260DF2e49CCc4161C9FF2E101ed0d);
        
        wsXmrStorage.MintRequest memory mintRequest = hub.getMintRequest(requestId);
        
        console.log("\n=== Mint Request Info ===");
        console.log("Stored commitment:");
        console.logBytes32(mintRequest.claimCommitment);
        console.log("User public key:");
        console.logBytes32(mintRequest.userPublicKey);
        console.log("Status:", uint256(mintRequest.status));
        
        console.log("\n=== Comparison ===");
        console.log("Secret generates commitment:");
        console.logBytes32(solidityCommitment);
        console.log("Stored commitment:         ");
        console.logBytes32(mintRequest.claimCommitment);
        console.log("Match:", solidityCommitment == mintRequest.claimCommitment);
        
        if (solidityCommitment != mintRequest.claimCommitment) {
            console.log("\n!!! MISMATCH DETECTED !!!");
            console.log("The secret does not match the stored commitment.");
            console.log("This means either:");
            console.log("1. The wrong secret is being used");
            console.log("2. The seed was not properly restored from storage");
            console.log("3. The commitment was computed differently during initiateMint");
        }
    }
}
