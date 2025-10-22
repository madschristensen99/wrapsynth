// Solana wallet connection management for atomic swaps
class SolanaWalletManager {
  constructor() {
    this.provider = null;
    this.connection = null;
    this.publicKey = null;
    this.network = 'devnet';
    
    // USDC token details on Solana
    this.USDC_MINT_ADDRESS = {
      devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Test USDC on devnet
      mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'  // Real USDC on mainnet
    };
  }

  initConnection() {
    this.connection = new solanaWeb3.Connection(
      solanaWeb3.clusterApiUrl(this.network), 
      "confirmed"
    );
  }

  getProvider() {
    if ("solana" in window) {
      const anyProvider = window.solana;
      
      // Check for Brave Wallet
      if (anyProvider.isBraveWallet) {
        return anyProvider;
      }
      
      // Check for Phantom
      if (anyProvider.isPhantom) {
        return anyProvider;
      }
      
      // Check for other Solana wallets
      if (anyProvider.isSolflare) {
        return anyProvider;
      }
    }
    
    console.error("No Solana wallet found! Please install Phantom, Brave Wallet, or Solflare.");
    return null;
  }

  async connectWallet() {
    this.initConnection();
    this.provider = this.getProvider();
    
    if (!this.provider) {
      throw new Error("No Solana wallet found. Please install Phantom, Brave Wallet, or Solflare.");
    }

    try {
      const resp = await this.provider.connect();
      this.publicKey = resp.publicKey;
      
      console.log('Connected to Solana wallet:', this.publicKey.toString());
      
      return {
        connection: this.connection,
        publicKey: this.publicKey,
        provider: this.provider,
        address: this.publicKey.toString()
      };
    } catch (err) {
      console.error("Connection failed:", err);
      throw new Error("Failed to connect to Solana wallet");
    }
  }

  async disconnectWallet() {
    if (this.provider) {
      await this.provider.disconnect();
      this.publicKey = null;
      this.provider = null;
    }
  }

  async getSOLBalance() {
    if (!this.publicKey || !this.connection) return 0;
    
    try {
      const balance = await this.connection.getBalance(this.publicKey);
      return balance / solanaWeb3.LAMPORTS_PER_SOL;
    } catch (error) {
      console.error("Error getting SOL balance:", error);
      return 0;
    }
  }

  async getUSDCBalance() {
    if (!this.publicKey || !this.connection) return 0;
    
    try {
      const usdcMint = new solanaWeb3.PublicKey(this.USDC_MINT_ADDRESS[this.network]);
      
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        this.publicKey,
        { mint: usdcMint }
      );

      if (tokenAccounts.value.length === 0) return 0;

      const accountInfo = await this.connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
      return parseFloat(accountInfo.value.uiAmountString) || 0;
    } catch (error) {
      console.error("Error getting USDC balance:", error);
      return 0;
    }
  }

  getUSDCMint() {
    return new solanaWeb3.PublicKey(this.USDC_MINT_ADDRESS[this.network]);
  }
}

// Create a global instance
const solanaWallet = new SolanaWalletManager();

// Utility functions for use in swap.js
export async function connectSolanaWallet() {
  return await solanaWallet.connectWallet();
}

export function getCurrentWallet() {
  return {
    publicKey: solanaWallet.publicKey,
    connection: solanaWallet.connection,
    provider: solanaWallet.provider
  };
}

export { solanaWallet as default };