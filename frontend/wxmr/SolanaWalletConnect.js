// SolanaApp.js
const connectBtn = document.getElementById("connectWallet");
const disconnectBtn = document.getElementById("disconnectWallet");
const walletInfo = document.getElementById("walletInfo");
const walletAddressEl = document.getElementById("walletAddress");
const balanceEl = document.getElementById("balance");
const refreshBtn = document.getElementById("refreshBalance");
const transferForm = document.getElementById("transferForm");

let provider = null;
let connection = new solanaWeb3.Connection(solanaWeb3.clusterApiUrl("devnet"), "confirmed");
let publicKey = null;

function getProvider() {
  if ("solana" in window) {
    // Brave and Phantom both inject into window.solana
    const anyProvider = window.solana;

    // Brave Wallet identifies itself like this:
    if (anyProvider.isBraveWallet) {
      return anyProvider;
    }

    // Phantom identifies itself like this:
    if (anyProvider.isPhantom) {
      return anyProvider;
    }
  }

  alert("No Solana wallet found! Please install Phantom or Brave.");
  return null;
}

connectBtn.addEventListener("click", async () => {
  provider = getProvider();
  if (!provider) return;

  try {
    const resp = await provider.connect();
    publicKey = resp.publicKey;
    walletAddressEl.textContent = publicKey.toString();
    walletInfo.style.display = "block";
    connectBtn.style.display = "none";
    disconnectBtn.style.display = "inline-block";
    await refreshBalance();
  } catch (err) {
    console.error("Connection failed", err);
  }
});

disconnectBtn.addEventListener("click", async () => {
  if (provider) {
    await provider.disconnect();
    publicKey = null;
    walletInfo.style.display = "none";
    connectBtn.style.display = "inline-block";
    disconnectBtn.style.display = "none";
    balanceEl.textContent = "-";
  }
});

async function refreshBalance() {
  if (!publicKey) return;
  const balanceLamports = await connection.getBalance(publicKey);
  balanceEl.textContent = balanceLamports / solanaWeb3.LAMPORTS_PER_SOL;
}
refreshBtn.addEventListener("click", refreshBalance);

transferForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!publicKey) return alert("Please connect your wallet first.");

  const recipient = document.getElementById("recipient").value;
  const amount = parseFloat(document.getElementById("amount").value);
  const lamports = amount * solanaWeb3.LAMPORTS_PER_SOL;

  try {
    const transaction = new solanaWeb3.Transaction().add(
      solanaWeb3.SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: new solanaWeb3.PublicKey(recipient),
        lamports,
      })
    );

    transaction.feePayer = publicKey;
    let blockhashObj = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhashObj.blockhash;

    let signed = await provider.signTransaction(transaction);
    let signature = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(signature);

    document.getElementById("successText").textContent = `Success! Tx: ${signature}`;
    document.getElementById("success").style.display = "block";
    await refreshBalance();
  } catch (err) {
    console.error(err);
    document.getElementById("errorText").textContent = err.message;
    document.getElementById("error").style.display = "block";
  }
});
