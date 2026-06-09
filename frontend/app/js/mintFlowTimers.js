// Deadline timer and status polling for MintFlow

export async function startDeadlineTimer(mintFlow) {
    // If we don't have the on-chain timeout yet, query it now
    if (!mintFlow.timeout) {
        try {
            const { readHub } = await import('./viemClient.js');
            const mintReq = await readHub('getMintRequest', [mintFlow.requestId]);
            mintFlow.timeout = mintReq.timeout;
            console.log('Timer: queried on-chain timeout (block):', mintFlow.timeout.toString());
        } catch (e) {
            console.warn('Timer: could not query on-chain timeout, aborting timer:', e.message);
            return;
        }
    }

    const timerElement = document.getElementById('mint-time-remaining');
    const warningElement = document.getElementById('mint-deadline-warning');
    const timerContainer = document.getElementById('mint-deadline-timer');
    const depositInfo = document.getElementById('mint-deposit-info');
    
    if (!timerElement) return;

    // Prevent duplicate timers
    if (mintFlow.deadlineInterval) {
        console.log('Timer: already running, skipping duplicate start');
        timerContainer?.classList.remove('hidden');
        warningElement?.classList.add('hidden');
        return;
    }

    // Show timer
    timerContainer?.classList.remove('hidden');
    warningElement?.classList.add('hidden');

    let running = true;

    const updateTimer = async () => {
        if (!running) return;
        try {
            const { getPublicClient } = await import('./viemClient.js');
            const publicClient = getPublicClient();
            const currentBlock = await publicClient.getBlockNumber();
            
            const blocksRemaining = Number(mintFlow.timeout) - Number(currentBlock);
            
            if (blocksRemaining <= 0) {
                // EXPIRED!
                running = false;
                mintFlow.deadlineInterval = null;
                
                // Show inline Cancel & Refund UI instead of modal
                timerContainer?.classList.remove('hidden');
                timerContainer?.classList.add('alert-error');
                timerContainer?.classList.remove('alert-warning');
                timerElement.innerHTML = '<strong>EXPIRED</strong> &mdash; Mint timeout reached';
                
                // Hide deposit info to prevent user from sending XMR
                depositInfo?.classList.add('hidden');
                
                // Show Cancel & Refund button inside the timer container
                let refundBtn = timerContainer?.querySelector('.btn-refund');
                if (timerContainer && !refundBtn) {
                    refundBtn = document.createElement('button');
                    refundBtn.className = 'btn btn-secondary btn-refund';
                    refundBtn.style.marginTop = '0.75rem';
                    refundBtn.textContent = 'Cancel Mint & Refund Deposit';
                    refundBtn.onclick = async () => {
                        refundBtn.disabled = true;
                        refundBtn.textContent = 'Cancelling...';
                        try {
                            const { writeHub } = await import('./viemClient.js');
                            const receipt = await writeHub('cancelMint', [mintFlow.requestId]);
                            console.log('cancelMint tx:', receipt.transactionHash);
                            timerElement.innerHTML = '<strong style="color:var(--success-color);">Cancelled & Refunded</strong>';
                            refundBtn.remove();
                            const { clearActiveSwap } = await import('./storage.js');
                            clearActiveSwap();
                            const { resetMintUI } = await import('./ui.js');
                            resetMintUI();
                        } catch (err) {
                            console.error('Cancel mint failed:', err);
                            refundBtn.disabled = false;
                            refundBtn.textContent = 'Cancel Mint & Refund Deposit';
                            timerElement.innerHTML += `<br><span style="font-size:0.75rem;color:var(--error-color);">${err.message}</span>`;
                        }
                    };
                    timerContainer.appendChild(refundBtn);
                }
                
                console.error('⚠️ MINT EXPIRED - DO NOT SEND XMR');
                return;
            }
            
            // Calculate time remaining (5 seconds per block)
            const secondsRemaining = blocksRemaining * 5;
            const hours = Math.floor(secondsRemaining / 3600);
            const minutes = Math.floor((secondsRemaining % 3600) / 60);
            const seconds = secondsRemaining % 60;
            
            let timeStr = '';
            if (hours > 0) timeStr += `${hours}h `;
            timeStr += `${minutes}m ${seconds}s`;
            timerElement.textContent = `${timeStr} (${blocksRemaining} blocks)`;
            
            // Warning if less than 10 minutes
            if (secondsRemaining < 600) {
                timerContainer?.classList.add('alert-error');
                timerContainer?.classList.remove('alert-warning');
            } else {
                timerContainer?.classList.add('alert-warning');
                timerContainer?.classList.remove('alert-error');
            }
            
        } catch (error) {
            console.error('Error updating timer:', error);
        }
        
        // Self-reschedule for robust async polling (prevents stacking if RPC is slow)
        if (running) {
            mintFlow.deadlineInterval = setTimeout(updateTimer, 5000);
        }
    };

    // Kick off the first update; subsequent ones self-schedule
    updateTimer();
}

export function startStatusPolling(mintFlow) {
    // REMOVED: UI should not poll LP server
    // The UI watches for on-chain events (MintReady, etc.) instead
    // LP server is only for LP's internal operations
    console.log('Status polling disabled - watching on-chain events only');
}

export function stopTimers(mintFlow) {
    if (mintFlow.deadlineInterval) {
        clearTimeout(mintFlow.deadlineInterval);
        mintFlow.deadlineInterval = null;
    }
    if (mintFlow.statusPollInterval) {
        clearInterval(mintFlow.statusPollInterval);
    }
}
