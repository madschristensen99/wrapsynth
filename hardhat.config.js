require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // viaIR enabled to resolve stack too deep errors in complex contracts
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    unichain_testnet: {
      url: process.env.UNICHAIN_RPC_URL || "https://sepolia.unichain.org",
      chainId: 1301,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: "auto",
    },
    gnosis: {
      url: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com",
      chainId: 100,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: "auto",
    },
  },
  etherscan: {
    apiKey: process.env.GNOSISSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "abc123",
    customChains: [
      {
        network: "unichain_testnet",
        chainId: 1301,
        urls: {
          apiURL: "https://api-sepolia.uniscan.xyz/api",
          browserURL: "https://sepolia.uniscan.xyz"
        }
      },
      {
        network: "gnosis",
        chainId: 100,
        urls: {
          apiURL: "https://api.gnosisscan.io/api",
          browserURL: "https://gnosisscan.io"
        }
      }
    ]
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
};
