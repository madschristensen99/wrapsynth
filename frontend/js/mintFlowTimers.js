// Deadline timer and status polling for MintFlow

export async function startDeadlineTimer(mintFlow) {
    console.log('[Timer] Starting deadline timer for', mintFlow.requestId);

    // Always re-read the on-chain request — the source of truth for the
    // deadline. A stale cached timeout from a previous mint on a reused
    // flow object (or a wrong-domain value) would otherwise misfire the
    // expiry branch against a live mint.
    const { readHub } = await import('./viemClient.js?v=3.54');
    try {
        const mintReq = await readHub('getMintRequest', [mintFlow.requestId]);
        // A zero timeout (or zero status) means the RPC returned the empty
        // struct — i.e. the node is lagging behind the just-mined initiate
        // tx, not that the deadline is block 0. Never start counting from 0.
        if (mintReq.timeout === 0n) {
            console.warn('[Timer] On-chain timeout read as 0 (RPC lag?) — retrying in 5s');
            setTimeout(() => startDeadlineTimer(mintFlow), 5000);
            return;
        }
        mintFlow.timeout = mintReq.timeout;
        console.log('[Timer] Queried on-chain timeout (block):', mintFlow.timeout.toString());
    } catch (e) {
        if (!mintFlow.timeout) {
            console.warn('[Timer] Could not query on-chain timeout, aborting timer:', e.message);
            return;
        }
        console.warn('[Timer] On-chain timeout read failed, using cached value:', mintFlow.timeout.toString());
    }

    const timerElement = document.getElementById('mint-time-remaining');
    const warningElement = document.getElementById('mint-deadline-warning');
    const timerContainer = document.getElementById('mint-deadline-timer');
    const depositInfo = document.getElementById('mint-deposit-info');
    
    console.log('[Timer] Elements found:', {
        timerElement: !!timerElement,
        warningElement: !!warningElement,
        timerContainer: !!timerContainer,
        depositInfo: !!depositInfo
    });
    
    if (!timerElement) {
        console.error('[Timer] mint-time-remaining element not found!');
        return;
    }

    // Prevent duplicate timers
    if (mintFlow.deadlineInterval) {
        console.log('Timer: already running, skipping duplicate start');
        timerContainer?.classList.remove('hidden');
        warningElement?.classList.add('hidden');
        return;
    }

    // Clear any previously-set stopped flag so a reused flow can restart its timer
    mintFlow.timersStopped = false;

    // Show timer
    timerContainer?.classList.remove('hidden');
    warningElement?.classList.add('hidden');
    console.log('[Timer] Timer container shown, classes:', timerContainer?.className);

    let running = true;

    const updateTimer = async () => {
        if (!running) return;
        try {
            const { getContractBlockNumber, getDeadlineBlockTimeSec } = await import('./viemClient.js?v=3.54');
            const currentBlock = await getContractBlockNumber();

            const blocksRemaining = Number(mintFlow.timeout) - Number(currentBlock);
            console.log('[Timer] Blocks remaining:', blocksRemaining, 'Current:', currentBlock.toString(), 'Timeout:', mintFlow.timeout.toString());
            
            if (blocksRemaining <= 0) {
                // Deadline math says expired — but VERIFY against the on-chain
                // mint before flipping the UI. If the LP already responded
                // (KEY_PROVIDED=2, READY=3, SECRET_REVEALED=4) or it completed
                // (5), the mint is live: don't hide the deposit UI or inject a
                // refund button. A transient bad read must never nuke a mint.
                let onChainStatus = null;
                let onChainTimeout = 0n;
                try {
                    const verifyReq = await readHub('getMintRequest', [mintFlow.requestId]);
                    onChainStatus = Number(verifyReq.status);
                    onChainTimeout = verifyReq.timeout;
                } catch (statusErr) {
                    console.warn('[Timer] Could not verify on-chain status, skipping expiry tick:', statusErr.message);
                    // reschedule below — don't expire on an unverifiable read
                    return;
                }
                // Empty-struct read (RPC lag behind the initiate tx): status 0 +
                // timeout 0 — the request exists but the node hasn't caught up.
                // Never expire on that; retry the tick instead.
                if (onChainStatus === 0 || onChainTimeout === 0n) {
                    console.warn(`[Timer] Verify read returned empty struct (status ${onChainStatus}, timeout ${onChainTimeout.toString()}) — RPC lag, skipping expiry tick`);
                    return; // keep ticking
                }
                if (onChainStatus === 2 || onChainStatus === 3 || onChainStatus === 4) {
                    console.log(`[Timer] Deadline passed but mint is live on-chain (status ${onChainStatus}) — keeping deposit UI, not expiring`);
                    timerElement.textContent = '0m 0s (0 blocks)';
                    timerContainer?.classList.add('alert-error');
                    timerContainer?.classList.remove('alert-warning');
                    return; // keep ticking
                }
                if (onChainStatus === 5) {
                    timerElement.innerHTML = '<strong style="color:var(--success-color);">Mint Completed</strong>';
                    running = false;
                    mintFlow.deadlineInterval = null;
                    mintFlow.timersStopped = true;
                    return;
                }

                // EXPIRED! (status 1 PENDING past deadline, or terminal 6/7)
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
                        refundBtn.textContent = 'Checking status...';
                        try {
                            const { readHub, writeHub } = await import('./viemClient.js?v=3.54');
                            
                            // Check current on-chain status before deciding action
                            const mintReq = await readHub('getMintRequest', [mintFlow.requestId]);
                            const status = Number(mintReq.status);
                            // MintStatus: 0=INVALID, 1=PENDING, 2=KEY_PROVIDED, 3=READY, 4=SECRET_REVEALED, 5=COMPLETED, 6=CANCELLED, 7=EXPIRED_READY
                            
                            if (status === 6) {
                                // Already cancelled by LP node; claim refund via withdrawReturns
                                refundBtn.textContent = 'Claiming refund...';
                                const receipt = await writeHub('withdrawReturns', ['0x0000000000000000000000000000000000000000']);
                                console.log('withdrawReturns tx:', receipt.transactionHash);
                                timerElement.innerHTML = '<strong style="color:var(--success-color);">Refunded</strong>';
                                refundBtn.remove();
                                const { clearActiveSwap } = await import('./storage.js?v=3.54');
                                clearActiveSwap();
                                const { resetMintUI } = await import('./ui.js?v=3.54');
                                resetMintUI();
                            } else if (status === 7) {
                                // EXPIRED_READY — LP has a claim window
                                const claimWindowEnd = Number(mintReq.timeout);
                                const { getContractBlockNumber } = await import('./viemClient.js?v=3.54');
                                const currentBlock = await getContractBlockNumber();
                                if (currentBlock >= claimWindowEnd) {
                                    // LP claim window expired — sweep to recover deposit + slashed collateral
                                    refundBtn.textContent = 'Sweeping expired mint...';
                                    await writeHub('sweepUnclaimedExpiredMint', [mintFlow.requestId]);
                                    await writeHub('withdrawReturns', ['0x0000000000000000000000000000000000000000']);
                                    // Also withdraw slashed collateral (active chain's share token)
                                    try {
                                        const { CONTRACTS } = await import('./config.js?v=3.54');
                                        await writeHub('withdrawReturns', [CONTRACTS.stataUSDe]);
                                    } catch (e) { /* may have no collateral returns */ }
                                    timerElement.innerHTML = '<strong style="color:var(--success-color);">Deposit + Collateral Recovered</strong>';
                                    refundBtn.remove();
                                    const { clearActiveSwap } = await import('./storage.js?v=3.54');
                                    clearActiveSwap();
                                    const { resetMintUI } = await import('./ui.js?v=3.54');
                                    resetMintUI();
                                } else {
                                    // LP still has time to claim
                                    const blocksRemaining = claimWindowEnd - Number(currentBlock);
                                    const { getDeadlineBlockTimeSec } = await import('./viemClient.js?v=3.54');
                                    const minutes = Math.ceil(blocksRemaining * getDeadlineBlockTimeSec() / 60);
                                    refundBtn.disabled = true;
                                    refundBtn.textContent = `Waiting for LP claim window (~${minutes} min)`;
                                    timerElement.innerHTML += `<br><span style="font-size:0.75rem;color:var(--warning-color);">LP can claim deposit for ~${minutes} more minutes. After that, you can sweep it back.</span>`;
                                }
                            } else if (status === 1 || status === 2 || status === 3) {
                                // Still cancellable; call cancelMint
                                refundBtn.textContent = 'Cancelling...';
                                const userSecret = mintFlow.agent ? mintFlow.agent.getSecret() : '0x0000000000000000000000000000000000000000000000000000000000000000';
                                const cancelReceipt = await writeHub('cancelMint', [mintFlow.requestId, userSecret]);
                                console.log('cancelMint tx:', cancelReceipt.transactionHash);
                                // KEY_PROVIDED cancels park the griefing deposit (KEY_CANCELLED) —
                                // no collateral is slashed. The LP may claim it via
                                // abandonKeyProvidedMint; otherwise it is reclaimable after the window.
                                let slashedMsg = '';
                                if (status === 2) {
                                    slashedMsg = ' — deposit parked (reclaimable if LP doesn\'t claim)';
                                }
                                // Withdraw griefing deposit
                                try {
                                    await writeHub('withdrawReturns', ['0x0000000000000000000000000000000000000000']);
                                } catch (e) { /* may have none */ }
                                timerElement.innerHTML = `<strong style="color:var(--success-color);">Cancelled & Refunded${slashedMsg}</strong>`;
                                refundBtn.remove();
                                const { clearActiveSwap } = await import('./storage.js?v=3.54');
                                clearActiveSwap();
                                const { resetMintUI } = await import('./ui.js?v=3.54');
                                resetMintUI();
                            } else if (status === 5) {
                                // Already completed
                                timerElement.innerHTML = '<strong style="color:var(--success-color);">Mint Completed</strong>';
                                refundBtn.remove();
                                const { clearActiveSwap } = await import('./storage.js?v=3.54');
                                clearActiveSwap();
                                const { resetMintUI } = await import('./ui.js?v=3.54');
                                resetMintUI();
                            } else {
                                throw new Error(`Unexpected mint status: ${status}`);
                            }
                        } catch (err) {
                            console.error('Cancel/claim refund failed:', err);
                            refundBtn.disabled = false;
                            refundBtn.textContent = 'Cancel Mint & Refund Deposit';
                            if (err.message && err.message.includes('TimeoutNotReached')) {
                                timerElement.innerHTML += `<br><span style="font-size:0.75rem;color:var(--error-color);">The timeout block has not been reached on-chain yet. Please wait a moment and try again.</span>`;
                            } else {
                                timerElement.innerHTML += `<br><span style="font-size:0.75rem;color:var(--error-color);">${err.message}</span>`;
                            }
                        }
                    };
                    timerContainer.appendChild(refundBtn);
                }
                
                console.error('⚠️ MINT EXPIRED - DO NOT SEND XMR');
                return;
            }
            
            // Calculate time remaining (deadline-domain block time is per-chain —
            // L1 cadence on Orbit chains)
            const secondsRemaining = Math.round(blocksRemaining * getDeadlineBlockTimeSec());
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
        if (running && !mintFlow.timersStopped) {
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
    mintFlow.timersStopped = true;
    if (mintFlow.deadlineInterval) {
        clearTimeout(mintFlow.deadlineInterval);
        mintFlow.deadlineInterval = null;
    }
    if (mintFlow.statusPollInterval) {
        clearInterval(mintFlow.statusPollInterval);
    }
}
