// Swap functionality for the frontend
import { connectSolanaWallet, getCurrentWallet } from './SolanaWallet.js';

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

// USDC to XMR Swap Flow (Solana Edition)
async function initiateUsdcToXmrSwap(xmrAddress, usdcAmount) {
  try {
    // Step 1: Connect to wallet
    const { provider, publicKey, connection } = await connectWallet();
    
    // Step 2: Prepare swap parameters with the backend
    const prepareResponse = await fetch(`${SERVER_URL}/api/solana/prepare-usdc-to-xmr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        solanaAddress: publicKey.toString(),
        xmrAddress: xmrAddress,
        value: usdcAmount // In atomic units (e.g., 10000 for 0.01 USDC)
      })
    });
    
    const prepareResult = await prepareResponse.json();
    console.log('Swap parameters prepared:', prepareResult);
    
    // Step 3: Create USDC transfer transaction
    // Get USDC token account for the sender
    const usdcMint = new solanaWeb3.PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'); // Devnet USDC
    const programId = new solanaWeb3.PublicKey(prepareResult.swapParams.programId || '11111111111111111111111111111111');
    
    // Create transfer instruction
    const transferInstruction = splToken.createTransferInstruction(
      prepareResult.swapParams.fromTokenAccount,
      prepareResult.swapParams.toTokenAccount,
      publicKey,
      prepareResult.swapParams.value
    );
    
    console.log('Creating USDC transfer transaction...');
    
    // Create and sign transaction
    const transaction = new solanaWeb3.Transaction().add(transferInstruction);
    transaction.feePayer = publicKey;
    
    let blockhashObj = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhashObj.blockhash;
    
    let signed = await provider.signTransaction(transaction);
    let signature = await connection.sendRawTransaction(signed.serialize());
    
    console.log('USDC transfer transaction submitted:', signature);
    await connection.confirmTransaction(signature);
    console.log('USDC transfer confirmed');
    
    // Step 4: Notify backend of swap creation
    const notifyResponse = await fetch(`${SERVER_URL}/api/solana/notify-usdc-to-xmr-created`, {
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
    const readyResponse = await fetch(`${SERVER_URL}/api/solana/notify-usdc-to-xmr-ready`, {
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
    console.error('Error initiating USDC to XMR swap:', error);
    throw error;
  }
}

// XMR to USDC Swap Flow (Solana Edition)
async function initiateXmrToUsdcSwap(xmrAmount, usdcAmount) {
  try {
    // Step 1: Connect to wallet
    const { publicKey } = await connectWallet();
    
    // Step 2: Prepare swap parameters with the backend
    const prepareResponse = await fetch(`${SERVER_URL}/api/solana/prepare-xmr-to-usdc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        solanaAddress: publicKey.toString(),
        value: usdcAmount, // In atomic units (e.g., 10000 for 0.01 USDC)
        xmrAmount: xmrAmount // As a string (e.g., "0.001")
      })
    });
    
    const prepareResult = await prepareResponse.json();
    console.log('Swap parameters prepared:', prepareResult);
    
    // Step 3: Send XMR (backend operation)
    const sendXmrResponse = await fetch(`${SERVER_URL}/api/solana/xmr-to-usdc/${prepareResult.swapId}/send-xmr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    
    const sendXmrResult = await sendXmrResponse.json();
    console.log('XMR sent:', sendXmrResult);
    
    // Step 4: Notify backend of Solana swap creation
    // For Solana, this would create a transaction that will release USDC on XMR confirmation
    const notifyResponse = await fetch(`${SERVER_URL}/api/solana/notify-xmr-to-usdc-created`, {
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
    console.error('Error initiating XMR to USDC swap:', error);
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
  // Connect wallet button
  const connectWalletBtn = document.getElementById('connectWalletBtn');
  if (connectWalletBtn) {
    connectWalletBtn.addEventListener('click', async () => {
      try {
        const { address } = await connectWallet();
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
        
        if (sendCurrency === 'USDC' && receiveCurrency === 'XMR') {
          if (!receiverAddress) {
            alert('Please enter your XMR wallet address');
            return;
          }
          
          // Convert USDC to atomic units (6 decimals)
          const usdcAtomicUnits = Math.floor(parseFloat(sendAmount) * 1e6).toString();
          
          const swapId = await initiateUsdcToXmrSwap(receiverAddress, usdcAtomicUnits);
          alert(`USDC to XMR swap initiated with ID: ${swapId}`);
        } else if (sendCurrency === 'XMR' && receiveCurrency === 'USDC') {
          // Convert USDC to atomic units (6 decimals)
          const usdcAtomicUnits = Math.floor(parseFloat(receiveAmount) * 1e6).toString();
          
          const swapId = await initiateXmrToUsdcSwap(sendAmount, usdcAtomicUnits);
          alert(`XMR to USDC swap initiated with ID: ${swapId}`);
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
      
      // Swap currencies
      const tempCurrency = sendCurrency.innerHTML;
      sendCurrency.innerHTML = receiveCurrency.innerHTML;
      receiveCurrency.innerHTML = tempCurrency;
      
      // Swap amounts
      const tempAmount = sendAmount.value;
      sendAmount.value = receiveAmount.value;
      receiveAmount.value = tempAmount;
      
      // Show/hide XMR address field based on receive currency
      const receiverAddressField = document.querySelector('.swap-step:nth-child(2)');
      if (receiveCurrency.innerText.includes('XMR')) {
        receiverAddressField.style.display = 'block';
      } else {
        receiverAddressField.style.display = 'none';
      }
    });
  }
  
  // Initialize UI
  const receiveCurrency = document.getElementById('receiveCurrency');
  if (receiveCurrency && receiveCurrency.innerText.includes('XMR')) {
    const receiverAddressField = document.querySelector('.swap-step:nth-child(2)');
    if (receiverAddressField) {
      receiverAddressField.style.display = 'block';
    }
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

// Export functions for external use
export {
  connectWallet,
  initiateUsdcToXmrSwap,
  initiateXmrToUsdcSwap,
  pollSwapStatus,
  formatAddress,
  formatSolanaAddress
};
