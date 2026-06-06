// Deadline timer and status polling for MintFlow

export function startDeadlineTimer(mintFlow) {
    if (!mintFlow.timeout) {
        console.warn('No timeout set for mint');
        return;
    }

    const timerElement = document.getElementById('mint-time-remaining');
    const warningElement = document.getElementById('mint-deadline-warning');
    const timerContainer = document.getElementById('mint-deadline-timer');
    const depositInfo = document.getElementById('mint-deposit-info');
    
    if (!timerElement) return;

    // Show timer
    timerContainer?.classList.remove('hidden');

    const updateTimer = async () => {
        try {
            const { getPublicClient } = await import('./viemClient.js');
            const publicClient = await getPublicClient();
            const currentBlock = await publicClient.getBlockNumber();
            
            const blocksRemaining = Number(mintFlow.timeout) - Number(currentBlock);
            
            if (blocksRemaining <= 0) {
                // EXPIRED!
                clearInterval(mintFlow.deadlineInterval);
                timerElement.textContent = 'EXPIRED';
                timerContainer?.classList.add('hidden');
                warningElement?.classList.remove('hidden');
                
                // Hide deposit info to prevent user from sending XMR
                depositInfo?.classList.add('hidden');
                
                console.error('⚠️ MINT EXPIRED - DO NOT SEND XMR');
                
                // Show error
                const { showError } = await import('./ui.js');
                showError('Mint Expired', 'This mint has expired. Please cancel and start a new mint.');
                
                return;
            }
            
            // Calculate time remaining (5 seconds per block)
            const secondsRemaining = blocksRemaining * 5;
            const minutes = Math.floor(secondsRemaining / 60);
            const seconds = secondsRemaining % 60;
            
            timerElement.textContent = `${minutes}m ${seconds}s (${blocksRemaining} blocks)`;
            
            // Warning if less than 10 minutes
            if (minutes < 10) {
                timerContainer?.classList.add('alert-error');
                timerContainer?.classList.remove('alert-warning');
            }
            
        } catch (error) {
            console.error('Error updating timer:', error);
        }
    };

    // Update immediately and then every 5 seconds
    updateTimer();
    mintFlow.deadlineInterval = setInterval(updateTimer, 5000);
}

export function startStatusPolling(mintFlow) {
    // REMOVED: UI should not poll LP server
    // The UI watches for on-chain events (MintReady, etc.) instead
    // LP server is only for LP's internal operations
    console.log('Status polling disabled - watching on-chain events only');
}

export function stopTimers(mintFlow) {
    if (mintFlow.deadlineInterval) {
        clearInterval(mintFlow.deadlineInterval);
    }
    if (mintFlow.statusPollInterval) {
        clearInterval(mintFlow.statusPollInterval);
    }
}
