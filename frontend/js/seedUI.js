// Seed Phrase UI Components for WrapSynth

import { generateSeedPhrase, validateSeedPhrase, createKeySet } from './seedManager.js';
import { storeSeed, hasStoredSeed, loadSeed } from './seedStorage.js';

/**
 * Show seed generation modal
 * Returns a promise that resolves with the generated key set
 */
export async function showSeedGenerationModal() {
    return new Promise((resolve, reject) => {
        // Generate new seed
        const seed = generateSeedPhrase(12);
        const words = seed.split(' ');
        
        // Create modal HTML
        const modalHTML = `
            <div id="seed-modal-overlay" class="modal-overlay">
                <div class="modal-content seed-modal">
                    <div class="modal-header">
                        <h2><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle; margin-right: 6px;"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Backup Your Seed Phrase</h2>
                        <button class="btn-close" id="seed-modal-close">×</button>
                    </div>
                    
                    <div class="modal-body">
                        <div class="warning-box">
                            <strong><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle; margin-right: 4px;"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>Important:</strong>
                            <ul>
                                <li>Write down these 12 words in order</li>
                                <li>Store them safely offline</li>
                                <li>Never share them with anyone</li>
                                <li>You'll need them to complete swaps</li>
                            </ul>
                        </div>
                        
                        <div class="seed-words-grid">
                            ${words.map((word, i) => `
                                <div class="seed-word">
                                    <span class="seed-word-number">${i + 1}.</span>
                                    <span class="seed-word-text">${word}</span>
                                </div>
                            `).join('')}
                        </div>
                        
                        <div class="seed-actions">
                            <button class="btn-secondary" id="seed-copy-btn">
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle; margin-right: 4px;"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>Copy to Clipboard
                            </button>
                            <label class="checkbox-label">
                                <input type="checkbox" id="seed-confirm-checkbox">
                                I have safely backed up my seed phrase
                            </label>
                        </div>
                        
                        <div class="seed-verification" id="seed-verification" style="display: none;">
                            <h3>Verify Your Backup</h3>
                            <p>Please enter words #3, #7, and #11 to confirm:</p>
                            <div class="verification-inputs">
                                <input type="text" id="verify-word-3" placeholder="Word #3" data-index="2">
                                <input type="text" id="verify-word-7" placeholder="Word #7" data-index="6">
                                <input type="text" id="verify-word-11" placeholder="Word #11" data-index="10">
                            </div>
                            <div id="verification-error" class="error-message" style="display: none;"></div>
                        </div>
                    </div>
                    
                    <div class="modal-footer">
                        <button class="btn-secondary" id="seed-cancel-btn">Cancel</button>
                        <button class="btn-primary" id="seed-continue-btn" disabled>Continue</button>
                    </div>
                </div>
            </div>
        `;
        
        // Add to DOM
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        const overlay = document.getElementById('seed-modal-overlay');
        const closeBtn = document.getElementById('seed-modal-close');
        const cancelBtn = document.getElementById('seed-cancel-btn');
        const continueBtn = document.getElementById('seed-continue-btn');
        const copyBtn = document.getElementById('seed-copy-btn');
        const confirmCheckbox = document.getElementById('seed-confirm-checkbox');
        const verification = document.getElementById('seed-verification');
        const verificationError = document.getElementById('verification-error');
        
        // Copy to clipboard
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(seed);
                copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle; margin-right: 4px;"><polyline points="20 6 9 17 4 12"/></svg>Copied!';
                setTimeout(() => {
                    copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle; margin-right: 4px;"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>Copy to Clipboard';
                }, 2000);
            } catch (error) {
                console.error('Failed to copy:', error);
            }
        });
        
        // Show verification when checkbox is checked
        confirmCheckbox.addEventListener('change', () => {
            if (confirmCheckbox.checked) {
                verification.style.display = 'block';
                continueBtn.disabled = false;
            } else {
                verification.style.display = 'none';
                continueBtn.disabled = true;
            }
        });
        
        // Verify and continue
        continueBtn.addEventListener('click', async () => {
            const word3 = document.getElementById('verify-word-3').value.trim().toLowerCase();
            const word7 = document.getElementById('verify-word-7').value.trim().toLowerCase();
            const word11 = document.getElementById('verify-word-11').value.trim().toLowerCase();
            
            if (word3 === words[2] && word7 === words[6] && word11 === words[10]) {
                // Verification successful
                try {
                    const keySet = createKeySet(seed);
                    
                    // Ask if user wants to store encrypted in browser
                    const shouldStore = confirm(
                        'Would you like to store this seed encrypted in your browser?\n\n' +
                        '✓ Convenient: Auto-loads for future swaps\n' +
                        '⚠ Browser-specific: Only works on this device\n' +
                        '� Secure: Requires wallet signature to decrypt'
                    );
                    
                    if (shouldStore) {
                        const { toHex } = await import('https://esm.sh/viem@2.7.0');
                        const stored = await storeSeed(seed, toHex(keySet.publicSpendKey));
                        if (!stored) {
                            alert('Failed to store seed. You can still use it manually.');
                        }
                    }
                    
                    overlay.remove();
                    resolve({ seed, keySet });
                } catch (error) {
                    verificationError.textContent = 'Error generating keys: ' + error.message;
                    verificationError.style.display = 'block';
                }
            } else {
                verificationError.textContent = 'Incorrect words. Please check your backup and try again.';
                verificationError.style.display = 'block';
            }
        });
        
        // Cancel
        const cancel = () => {
            overlay.remove();
            reject(new Error('User cancelled seed generation'));
        };
        
        closeBtn.addEventListener('click', cancel);
        cancelBtn.addEventListener('click', cancel);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cancel();
        });
    });
}

/**
 * Show seed input modal for existing seed
 * Returns a promise that resolves with the key set
 */
export async function showSeedInputModal(publicSpendKey = null) {
    // Check if we have a stored seed (do this before Promise to avoid async issues)
    let hasStored = false;
    let publicSpendKeyHex = null;
    if (publicSpendKey) {
        const { toHex } = await import('https://esm.sh/viem@2.7.0');
        publicSpendKeyHex = toHex(publicSpendKey);
        hasStored = hasStoredSeed(publicSpendKeyHex);
    }
    
    return new Promise((resolve, reject) => {
        
        const modalHTML = `
            <div id="seed-input-overlay" class="modal-overlay">
                <div class="modal-content seed-modal">
                    <div class="modal-header">
                        <h2><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle; margin-right: 6px;"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>Enter Seed Phrase</h2>
                        <button class="btn-close" id="seed-input-close">×</button>
                    </div>
                    
                    <div class="modal-body">
                        ${hasStored ? `
                            <div class="info-box">
                                <p><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle; margin-right: 4px;"><polyline points="20 6 9 17 4 12"/></svg>Found encrypted seed in browser storage</p>
                                <button class="btn-primary" id="load-stored-seed-btn">
                                    Load Stored Seed
                                </button>
                                <p class="text-muted">Or enter seed manually below:</p>
                            </div>
                        ` : ''}
                        
                        <div class="seed-input-container">
                            <label for="seed-phrase-input">Enter your 12 or 24 word seed phrase:</label>
                            <textarea 
                                id="seed-phrase-input" 
                                rows="3" 
                                placeholder="word1 word2 word3 ..."
                                class="seed-input"
                            ></textarea>
                            <div id="seed-input-error" class="error-message" style="display: none;"></div>
                        </div>
                    </div>
                    
                    <div class="modal-footer">
                        <button class="btn-secondary" id="seed-input-cancel-btn">Cancel</button>
                        <button class="btn-primary" id="seed-input-continue-btn">Continue</button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        const overlay = document.getElementById('seed-input-overlay');
        const closeBtn = document.getElementById('seed-input-close');
        const cancelBtn = document.getElementById('seed-input-cancel-btn');
        const continueBtn = document.getElementById('seed-input-continue-btn');
        const seedInput = document.getElementById('seed-phrase-input');
        const errorDiv = document.getElementById('seed-input-error');
        const loadStoredBtn = document.getElementById('load-stored-seed-btn');
        
        // Load stored seed
        if (loadStoredBtn) {
            loadStoredBtn.addEventListener('click', async () => {
                try {
                    loadStoredBtn.disabled = true;
                    loadStoredBtn.textContent = 'Loading...';
                    
                    const seed = await loadSeed(publicSpendKeyHex);
                    if (seed) {
                        const keySet = createKeySet(seed);
                        overlay.remove();
                        resolve({ seed, keySet });
                    } else {
                        errorDiv.textContent = 'Failed to load stored seed. Please enter manually.';
                        errorDiv.style.display = 'block';
                        loadStoredBtn.disabled = false;
                        loadStoredBtn.textContent = 'Load Stored Seed';
                    }
                } catch (error) {
                    errorDiv.textContent = 'Error loading seed: ' + error.message;
                    errorDiv.style.display = 'block';
                    loadStoredBtn.disabled = false;
                    loadStoredBtn.textContent = 'Load Stored Seed';
                }
            });
        }
        
        // Continue with manual input
        continueBtn.addEventListener('click', () => {
            const seed = seedInput.value.trim();
            
            if (!validateSeedPhrase(seed)) {
                errorDiv.textContent = 'Invalid seed phrase. Please check and try again.';
                errorDiv.style.display = 'block';
                return;
            }
            
            try {
                const keySet = createKeySet(seed);
                overlay.remove();
                resolve({ seed, keySet });
            } catch (error) {
                errorDiv.textContent = 'Error generating keys: ' + error.message;
                errorDiv.style.display = 'block';
            }
        });
        
        // Cancel
        const cancel = () => {
            overlay.remove();
            reject(new Error('User cancelled'));
        };
        
        closeBtn.addEventListener('click', cancel);
        cancelBtn.addEventListener('click', cancel);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cancel();
        });
    });
}
