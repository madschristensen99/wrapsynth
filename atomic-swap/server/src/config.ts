export const CONFIG = {
  SOLANA: {
    RPC_URL: process.env.SOL_RPC_URL || 'https://api.devnet.solana.com',
    KEYPAIR_PATH: process.env.SOL_KEYPAIR_PATH || '/home/remsee/.config/solana/id.json',
    DESTINATION_ADDRESS: process.env.SOL_DESTINATION_ADDRESS || '89dWsvEmLpNDkDArfaVzKr9yT97XTJdQXWSExi8Ldnhi',
    PROGRAM_ID: process.env.PROGRAM_ID || 'G1BVSiFojnXFaPG1WUgJAcYaB7aGKLKWtSqhMreKgA82',
    USDC_MINT: process.env.USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  },
  MONERO: {
    WALLET_RPC_URL: process.env.MONERO_WALLET_RPC || 'http://localhost:18082/json_rpc',
    WALLET_PATH: process.env.XMR_WALLET_PATH || '/home/remsee/Monero/wallets/wallet_5',
    DESTINATION_ADDRESS: process.env.XMR_DESTINATION_ADDRESS || '9tun7VYAVwa9Pqpu2k8HHdqXz6h1bP9FWLQ76dC8hxv3vXkxZVJcvUyMQXu2xhvDkmB4B51sX8dvFm7zWbbzJYm9ABvYwVBnt',
    NODE_URL: process.env.MONERO_NODE || 'http://node.monerodevs.org:38089',
  },
  SERVER: {
    PORT: parseInt(process.env.PORT || '3000'),
  }
};