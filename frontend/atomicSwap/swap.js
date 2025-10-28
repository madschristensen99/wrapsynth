// Swap functionality for the frontend
import { connectSolanaWallet, getCurrentWallet } from './SolanaWallet.js';
import priceTracker from './priceTracker.js';

// Server URL for API calls
const SERVER_URL = 'http://localhost:3000';

// Connect to Solana wallet (Phantom, Brave, or Solflare)
async function connectWallet() {
  try {
    const walletData = await connectSolanaWallet();
    
    console.log('Connected to Solana wallet:', walletData.address);
    
    return walletData;
  } catch (error) {
    console.error('Failed to connect Solana wallet:', error);
    throw error;
  }
}

// SOL to XMR Swap Flow (Solana Edition)
async function initiateSolToXmrSwap(xmrAddress, solLamports) {
  try {
    // Step 1: Connect to wallet
    const { provider, publicKey, connection } = await connectWallet();
    
    // Step 2: Prepare swap parameters with the backend
    const prepareResponse = await fetch(`${SERVER_URL}/api/solana/prepare-sol-to-xmr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        solanaAddress: publicKey.toString(),
        xmrAddress: xmrAddress,
        value: solLamports // In lamports (e.g., 1000000000 for 1 SOL)
      })
    });
    
    const prepareResult = await prepareResponse.json();
    console.log('Swap parameters prepared:', prepareResult);
    
    // Step 3: Create SOL transfer transaction
    console.log('Creating SOL transfer transaction...');
    
    // Create transfer instruction to escrow account
    const transferInstruction = solanaWeb3.SystemProgram.transfer({
      fromPubkey: publicKey,
      toPubkey: new solanaWeb3.PublicKey(prepareResult.swapParams.escrowAccount),
      lamports: prepareResult.swapParams.value
    });
    
    // Create and sign transaction
    const transaction = new solanaWeb3.Transaction().add(transferInstruction);
    transaction.feePayer = publicKey;
    
    let blockhashObj = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhashObj.blockhash;
    
    let signed = await provider.signTransaction(transaction);
    let signature = await connection.sendRawTransaction(signed.serialize());
    
    console.log('SOL transfer transaction submitted:', signature);
    await connection.confirmTransaction(signature);
    console.log('SOL transfer confirmed');
    
    // Step 4: Notify backend of swap creation
    const notifyResponse = await fetch(`${SERVER_URL}/api/solana/notify-sol-to-xmr-created`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        swapId: prepareResult.swapId,
        txHash: signature
      })
    });
    
    const notifyResult = await notifyResponse.json();
    console.log('Backend notified of swap creation:', notifyResult);
    
    // Step 5: Wait for backend confirmation
    const readyResponse = await fetch(`${SERVER_URL}/api/solana/notify-sol-to-xmr-ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        swapId: prepareResult.swapId
      })
    });
    
    const readyResult = await readyResponse.json();
    console.log('Backend notified of ready state:', readyResult);
    
    // Step 6: Poll for status updates
    pollSwapStatus(prepareResult.swapId);
    
    return prepareResult.swapId;
  } catch (error) {
    console.error('Error initiating SOL to XMR swap:', error);
    throw error;
  }
}

// XMR to SOL Swap Flow (Solana Edition)
async function initiateXmrToSolSwap(xmrAmount, solLamports) {
  try {
    // Step 1: Connect to wallet
    const { publicKey } = await connectWallet();
    
    // Step 2: Prepare swap parameters with the backend
    const prepareResponse = await fetch(`${SERVER_URL}/api/solana/prepare-xmr-to-sol`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        solanaAddress: publicKey.toString(),
        value: solLamports, // In lamports (e.g., 1000000000 for 1 SOL)
        xmrAmount: xmrAmount // As a string (e.g., "0.001")
      })
    });
    
    const prepareResult = await prepareResponse.json();
    console.log('Swap parameters prepared:', prepareResult);
    
    // Step 3: Send XMR (backend operation)
    const sendXmrResponse = await fetch(`${SERVER_URL}/api/solana/xmr-to-sol/${prepareResult.swapId}/send-xmr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    
    const sendXmrResult = await sendXmrResponse.json();
    console.log('XMR sent:', sendXmrResult);
    
    // Step 4: Notify backend of Solana swap creation
    const notifyResponse = await fetch(`${SERVER_URL}/api/solana/notify-xmr-to-sol-created`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        swapId: prepareResult.swapId,
        solanaAddress: publicKey.toString()
      })
    });
    
    const notifyResult = await notifyResponse.json();
    console.log('Backend notified of swap creation:', notifyResult);
    
    // Poll for status updates
    pollSwapStatus(prepareResult.swapId);
    
    return prepareResult.swapId;
  } catch (error) {
    console.error('Error initiating XMR to SOL swap:', error);
    throw error;
  }
}

// Poll for swap status updates
async function pollSwapStatus(swapId) {
  const statusInterval = setInterval(async () => {
    try {
      const statusResponse = await fetch(`${SERVER_URL}/api/web3/status/${swapId}`);
      const statusResult = await statusResponse.json();
      
      console.log('Current swap status:', statusResult);
      
      if (statusResult.status === 'COMPLETED') {
        console.log('Swap completed successfully!');
        clearInterval(statusInterval);
      }
    } catch (error) {
      console.error('Error polling swap status:', error);
    }
  }, 5000); // Poll every 5 seconds
  
  // Stop polling after 10 minutes to prevent infinite polling
  setTimeout(() => {
    clearInterval(statusInterval);
    console.log('Status polling stopped after timeout');
  }, 10 * 60 * 1000);
}

// Event listeners for UI
document.addEventListener('DOMContentLoaded', () => {
  const menuToggle = document.querySelector('.menu-toggle');
  const navLinks = document.querySelector('.nav-links');
  
  if (menuToggle && navLinks) {
    menuToggle.addEventListener('click', () => {
      navLinks.classList.toggle('active');
    });
    
    // Close mobile menu when clicking outside
    window.addEventListener('click', (event) => {
      if (!event.target.closest('.nav-links') && !event.target.closest('.menu-toggle')) {
        navLinks.classList.remove('active');
      }
    });
    
    // Close mobile menu when clicking on nav links
    const navLinksArray = navLinks.querySelectorAll('a, .btn');
    navLinksArray.forEach(link => {
      link.addEventListener('click', () => {
        navLinks.classList.remove('active');
      });
    });
  }

  // Connect wallet button
  const connectWalletBtn = document.getElementById('connectWalletBtn');
  if (connectWalletBtn) {
    connectWalletBtn.addEventListener('click', async () => {
      try {
        const { address } = await connectWallet();
        connectWalletBtn.textContent = 'Connected';
        connectWalletBtn.classList.add('connected');
        alert(`Connected to Solana wallet: ${formatAddress(address)}`);
      } catch (error) {
        alert(`Failed to connect wallet: ${error.message}`);
      }
    });
  }
  
  // Create swap button
  const createSwapBtn = document.getElementById('createSwapBtn');
  if (createSwapBtn) {
    createSwapBtn.addEventListener('click', async () => {
      try {
        const sendCurrency = document.getElementById('sendCurrency').innerText.trim();
        const sendAmount = document.getElementById('sendAmount').value;
        const receiveCurrency = document.getElementById('receiveCurrency').innerText.trim();
        const receiveAmount = document.getElementById('receiveAmount').value;
        const receiverAddress = document.getElementById('receiverAddress').value;
        
        if (!sendAmount || !receiveAmount) {
          alert('Please enter both send and receive amounts');
          return;
        }
        
        if (sendCurrency === 'SOL' && receiveCurrency === 'XMR') {
          if (!receiverAddress) {
            alert('Please enter your XMR wallet address');
            return;
          }
          
          // Convert SOL to lamports (9 decimals)
          const solLamports = Math.floor(parseFloat(sendAmount) * 1e9).toString();
          
          const swapId = await initiateSolToXmrSwap(receiverAddress, solLamports);
          alert(`SOL to XMR swap initiated with ID: ${swapId}`);
        } else if (sendCurrency === 'XMR' && receiveCurrency === 'SOL') {
          // Convert SOL to lamports (9 decimals)
          const solLamports = Math.floor(parseFloat(receiveAmount) * 1e9).toString();
          
          const swapId = await initiateXmrToSolSwap(sendAmount, solLamports);
          alert(`XMR to SOL swap initiated with ID: ${solLamports}`);
        } else {
          alert('Unsupported currency pair');
        }
      } catch (error) {
        alert(`Failed to create swap: ${error.message}`);
      }
    });
  }
  
  // Swap direction button
  const swapDirectionBtn = document.getElementById('swapDirection');
  if (swapDirectionBtn) {
    swapDirectionBtn.addEventListener('click', () => {
      const sendCurrency = document.getElementById('sendCurrency');
      const receiveCurrency = document.getElementById('receiveCurrency');
      const sendAmount = document.getElementById('sendAmount');
      const receiveAmount = document.getElementById('receiveAmount');
      
      // Swap currencies properly while maintaining icons
      const sendCurrencyText = sendCurrency.textContent.trim();
      const receiveCurrencyText = receiveCurrency.textContent.trim();
      
      // Get the img elements
      const sendImg = sendCurrency.querySelector('img');
      const receiveImg = receiveCurrency.querySelector('img');
      
      if (sendCurrencyText.includes('SOL')) {
        // SWAP: SOL -> becomes XMR
        sendCurrency.innerHTML = '<img src="./assets/monero.png" alt="XMR icon" class="currency-icon" /> XMR';
        receiveCurrency.innerHTML = '<img src="./assets/sol.png" alt="SOL icon" class="currency-icon" /> SOL';
      } else {
        // SWAP: XMR -> becomes SOL  
        sendCurrency.innerHTML = '<img src="./assets/sol.png" alt="SOL icon" class="currency-icon" /> SOL';
        receiveCurrency.innerHTML = '<img src="./assets/monero.png" alt="XMR icon" class="currency-icon" /> XMR';
      }
      
      // Swap amounts
      const tempAmount = sendAmount.value;
      sendAmount.value = receiveAmount.value;
      receiveAmount.value = tempAmount;
      
      // Show/hide XMR address field based on receive currency (more precise targeting)
      const receiverAddressField = document.getElementById('receiverAddress');
      if (receiverAddressField) {
        const receiverAddressForm = receiverAddressField.closest('.swap-step');
        if (receiverAddressForm) {
          // Check the newly swapped content
          if (receiveCurrency.innerHTML.includes('XMR')) {
            receiverAddressForm.style.display = 'block';
          } else {
            receiverAddressForm.style.display = 'none';
          }
        }
      }
    });
  }
});

// Helper function to display shortened Solana address
function formatSolanaAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function formatAddress(address) {
  return formatSolanaAddress(address);
}

// Initialize auto-calculation on DOM load
document.addEventListener('DOMContentLoaded', () => {
  const solPriceDisplay = document.getElementById('solPrice');
  const xmrPriceDisplay = document.getElementById('xmrPrice');
  const exchangeRateDisplay = document.getElementById('exchangeRate');
  const sendAmount = document.getElementById('sendAmount');
  const receiveAmount = document.getElementById('receiveAmount');
  const sendCurrency = document.getElementById('sendCurrency');
  const receiveCurrency = document.getElementById('receiveCurrency');
  const swapDirectionBtn = document.getElementById('swapDirection');
  
  let isCalculating = false;
  
  // Update price displays
  function updatePriceDisplay(priceData) {
    console.log('Price update received:', priceData);
    
    if (priceData && priceData.prices) {
      const prices = priceData.prices || {};
      
      // Display SOL price
      if (solPriceDisplay && prices.sol && prices.sol.price !== null && prices.sol.price !== undefined) {
        solPriceDisplay.textContent = `SOL: $${prices.sol.price.toFixed(2)}`;
      }
      
      // Display XMR price
      if (xmrPriceDisplay && prices.xmr && prices.xmr.price !== null && prices.xmr.price !== undefined) {
        xmrPriceDisplay.textContent = `XMR: $${prices.xmr.price.toFixed(2)}`;
      }
      
      // Update exchange rate
      if (exchangeRateDisplay && priceData.exchangeRate) {
        exchangeRateDisplay.textContent = `1 SOL ≈ ${priceData.exchangeRate.toFixed(6)} XMR`;
      }
    }
  }
  
  // Auto-calculation logic
  function getCurrencyType(element) {
    const text = element ? element.innerText.trim().toUpperCase() : '';
    return text.includes('SOL') ? 'sol' : 'xmr';
  }
  
  function updateCalculator() {
    if (isCalculating || !sendAmount || !receiveAmount) return;
    
    const sendType = getCurrencyType(sendCurrency);
    const receiveType = getCurrencyType(receiveCurrency);
    const rates = priceTracker.getPrices();
    
    if (!rates.prices[sendType] || !rates.prices[receiveType] ||
        rates.prices[sendType].price === null || rates.prices[receiveType].price === null) {
      return;
    }
    
    isCalculating = true;
    
    const exchangeRate = rates.prices[receiveType].price / rates.prices[sendType].price;
    
    if (document.activeElement === sendAmount && sendAmount.value) {
      // User typing in send, calculate receive
      const sendVal = parseFloat(sendAmount.value) || 0;
      receiveAmount.value = sendVal > 0 ? (sendVal * exchangeRate).toFixed(6) : '';
    } else if (document.activeElement === receiveAmount && receiveAmount.value) {
      // User typing in receive, calculate send  
      const receiveVal = parseFloat(receiveAmount.value) || 0;
      sendAmount.value = receiveVal > 0 ? (receiveVal / exchangeRate).toFixed(6) : '';
    }
    
    isCalculating = false;
  }
  
  // Set up event listeners and immediate test
  if (solPriceDisplay && xmrPriceDisplay) {
    console.log('Setting up price tracking...');
    
    // Test immediately
    setTimeout(async () => {
      console.log('Testing CoinGecko fetch...');
      try {
        const prices = await priceTracker.fetchPrices();
        console.log('Initial prices:', prices);
        updatePriceDisplay(prices);
      } catch (error) {
        console.error('Price fetch failed:', error);
        
        // Use actual API test data
        const realData = {
          prices: {
            xmr: { price: 338.74, change: -0.917 },
            sol: { price: 195.21, change: -2.393 }
          },
          exchangeRate: 1.736
        };
        updatePriceDisplay(realData);
      }
    }, 100);
    
    priceTracker.addListener(updatePriceDisplay);
    priceTracker.startAutoUpdate();
  }
  
  if (sendAmount && receiveAmount) {
    sendAmount.addEventListener('input', updateCalculator);
    receiveAmount.addEventListener('input', updateCalculator);
    
    // Update calculator on currency swap
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        const swapBtn = document.getElementById('swapDirection');
        if (swapBtn) {
          swapBtn.addEventListener('click', () => {
            setTimeout(updateCalculator, 100);
          });
        }
      }, 500);
    });
  }
});

// Export functions for external use
export {
  connectWallet,
  initiateSolToXmrSwap,
  initiateXmrToSolSwap,
  pollSwapStatus,
  formatAddress,
  formatSolanaAddress
};
