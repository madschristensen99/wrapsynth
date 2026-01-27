require("@nomicfoundation/hardhat-toolbox");
require('dotenv').config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      viaIR: true
    }
  },
  networks: {
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 84532
    },
    gnosis: {
      url: process.env.RPC_URL || process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 100,
      gasPrice: 2000000000  // 2 gwei
    },
    hardhat: {
      chainId: 31337,
      forking: {
        url: process.env.FORK_NETWORK === "gnosis" 
          ? (process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com")
          : (process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc"),
        enabled: process.env.FORK === "true"
      },
      initialBaseFeePerGas: 0
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  etherscan: {
    apiKey: process.env.BASESCAN_API_KEY || "",
    customChains: [
      {
        network: "gnosis",
        chainId: 100,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=100",
          browserURL: "https://gnosisscan.io"
        }
      }
    ]
  },
  sourcify: {
    enabled: false
  }
};
