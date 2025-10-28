// CoinGecko API integration for real-time XMR and SOL prices
const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';

class PriceTracker {
  constructor() {
    this.prices = {
      xmr: { price: null, change: null },
      sol: { price: null, change: null }
    };
    this.exchangeRate = null;
    this.lastUpdate = null;
    this.updateInterval = null;
    this.updateFrequency = 30000; // 30 seconds
    this.listeners = [];
  }

  // Fetch both XMR and SOL prices from CoinGecko
  async fetchPrices() {
    try {
      const response = await fetch(`${COINGECKO_API_BASE}/simple/price?ids=solana,monero&vs_currencies=usd&include_24hr_change=true`);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.solana && data.monero) {
        // Update SOL prices
        this.prices.sol.price = data.solana.usd;
        this.prices.sol.change = data.solana.usd_24h_change;
        
        // Update XMR prices
        this.prices.xmr.price = data.monero.usd;
        this.prices.xmr.change = data.monero.usd_24h_change;
        
        // Update exchange rate
        this.exchangeRate = this.calculateExchangeRate('xmr', 'sol');
        this.lastUpdate = new Date();
        
        // Notify all registered listeners
        this.notifyListeners();
        
        return {
          prices: this.prices,
          exchangeRate: this.exchangeRate,
          lastUpdate: this.lastUpdate
        };
      }
      
      throw new Error('Invalid response format from CoinGecko');
    } catch (error) {
      console.error('Error fetching prices:', error);
      return null;
    }
  }

  // Start automatic price updates
  startAutoUpdate() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    // Initial fetch
    this.fetchPrices();
    
    // Set up recurring updates
    this.updateInterval = setInterval(() => {
      this.fetchPrices();
    }, this.updateFrequency);
  }

  // Deprecated: use fetchPrices() instead
  async fetchXmrPrice() {
    return this.fetchPrices();
  }

  // Stop automatic price updates
  stopAutoUpdate() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  // Add a listener for price updates
  addListener(callback) {
    this.listeners.push(callback);
  }

  // Remove a listener
  removeListener(callback) {
    const index = this.listeners.indexOf(callback);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }

  // Notify all listeners of price updates
  notifyListeners() {
    this.listeners.forEach(callback => {
      try {
        callback({
          prices: this.prices,
          exchangeRate: this.exchangeRate,
          lastUpdate: this.lastUpdate
        });
      } catch (error) {
        console.error('Error in price update listener:', error);
      }
    });
  }

  // Get cached prices
  getPrices() {
    return {
      prices: this.prices,
      exchangeRate: this.exchangeRate,
      lastUpdate: this.lastUpdate
    };
  }

  // Calculate exchange rate
  calculateExchangeRate(fromCurrency, toCurrency) {
    if (!this.prices[fromCurrency] || !this.prices[toCurrency] || 
        this.prices[fromCurrency].price === null || this.prices[toCurrency].price === null) {
      return null;
    }
    
    // Convert from one currency to another
    const fromPrice = this.prices[fromCurrency].price;
    const toPrice = this.prices[toCurrency].price;
    
    return fromPrice ? toPrice / fromPrice : null;
  }

  // Format exchange rate for display
  formatExchangeRate(rate) {
    if (!rate) return 'Calculating...';
    return `${rate.toFixed(6)}`;
  }

  // Get current cached price data
  getCurrentPrice() {
    return {
      price: this.currentPrice,
      change24h: this.priceChange24h,
      lastUpdate: this.lastUpdate
    };
  }

  // Format price with appropriate number of decimal places
  formatPrice(price) {
    if (price === null || price === undefined) return 'N/A';
    
    if (price < 0.01) {
      return `$${price.toFixed(6)}`;
    } else if (price < 1) {
      return `$${price.toFixed(4)}`;
    } else {
      return `$${price.toFixed(2)}`;
    }
  }

  // Format price change percentage
  formatChange(change) {
    if (change === null || change === undefined) return '';
    
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(2)}%`;
  }

  // Get price change indicator (up/down)
  getPriceIndicator(change) {
    if (change === null || change === undefined) return '';
    
    return change >= 0 ? '📈' : '📉';
  }
}

// Create a global instance
const priceTracker = new PriceTracker();

// Export for use in other modules
export { priceTracker as default };
export { PriceTracker };