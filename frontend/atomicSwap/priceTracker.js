// CoinGecko API integration for real-time XMR price
const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';

class PriceTracker {
  constructor() {
    this.currentPrice = null;
    this.priceChange24h = null;
    this.lastUpdate = null;
    this.updateInterval = null;
    this.updateFrequency = 30000; // 30 seconds
    this.listeners = [];
  }

  // Fetch current XMR price from CoinGecko
  async fetchXmrPrice() {
    try {
      const response = await fetch(`${COINGECKO_API_BASE}/simple/price?ids=monero&vs_currencies=usd&include_24hr_change=true`);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.monero) {
        this.currentPrice = data.monero.usd;
        this.priceChange24h = data.monero.usd_24h_change;
        this.lastUpdate = new Date();
        
        // Notify all registered listeners
        this.notifyListeners();
        
        return {
          price: this.currentPrice,
          change24h: this.priceChange24h,
          lastUpdate: this.lastUpdate
        };
      }
      
      throw new Error('Invalid response format from CoinGecko');
    } catch (error) {
      console.error('Error fetching XMR price:', error);
      return null;
    }
  }

  // Start automatic price updates
  startAutoUpdate() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    // Initial fetch
    this.fetchXmrPrice();
    
    // Set up recurring updates
    this.updateInterval = setInterval(() => {
      this.fetchXmrPrice();
    }, this.updateFrequency);
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
          price: this.currentPrice,
          change24h: this.priceChange24h,
          lastUpdate: this.lastUpdate
        });
      } catch (error) {
        console.error('Error in price update listener:', error);
      }
    });
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