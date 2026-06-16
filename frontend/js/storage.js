// LocalStorage manager for persisting swap state
// Supports multiple concurrent active swaps

import { STORAGE_KEYS } from './config.js';

const ACTIVE_SWAPS_KEY = 'wrapsynth_active_swaps_v2';

// ─── Internal helpers ───────────────────────────────────────────────────────

function getSwapsArray() {
    try {
        // Migrate old single-swap data if present
        const oldData = localStorage.getItem(STORAGE_KEYS.activeSwap);
        if (oldData) {
            try {
                const oldSwap = JSON.parse(oldData);
                localStorage.setItem(ACTIVE_SWAPS_KEY, JSON.stringify([oldSwap]));
                localStorage.removeItem(STORAGE_KEYS.activeSwap);
                console.log('[STORAGE] Migrated old single-swap to multi-swap array');
                return [oldSwap];
            } catch {
                localStorage.removeItem(STORAGE_KEYS.activeSwap);
            }
        }
        const data = localStorage.getItem(ACTIVE_SWAPS_KEY);
        return data ? JSON.parse(data) : [];
    } catch {
        return [];
    }
}

export function setSwapsArray(swaps) {
    localStorage.setItem(ACTIVE_SWAPS_KEY, JSON.stringify(swaps));
}

// ─── Multi-swap API (new) ───────────────────────────────────────────────────

/**
 * Load all active swaps
 * @returns {Array} Array of active swap states
 */
export function loadActiveSwaps() {
    return getSwapsArray();
}

/**
 * Add or update a swap in the active swaps array (keyed by requestId)
 * @param {Object} swap - Swap state (must include requestId if updating existing)
 */
export function addOrUpdateActiveSwap(swap) {
    try {
        let swaps = getSwapsArray();
        const requestId = swap.requestId;
        const enriched = { ...swap, lastUpdated: Date.now() };

        if (requestId) {
            // Remove any duplicate entries for this requestId first
            swaps = swaps.filter((s, i) => s.requestId !== requestId || i === swaps.findIndex(x => x.requestId === requestId));
            const idx = swaps.findIndex(s => s.requestId === requestId);
            if (idx >= 0) {
                swaps[idx] = { ...swaps[idx], ...enriched };
            } else {
                // New swap with requestId: replace any temporary entry of same type
                const tempIdx = swaps.findIndex(s => !s.requestId && s.type === swap.type);
                if (tempIdx >= 0) {
                    swaps[tempIdx] = enriched;
                } else {
                    swaps.push(enriched);
                }
            }
        } else {
            swaps.push(enriched);
        }
        setSwapsArray(swaps);
        console.log('[STORAGE] Active swap updated:', enriched);
    } catch (error) {
        console.error('[STORAGE] Error saving active swap:', error);
    }
}

/**
 * Remove a specific swap by requestId
 * @param {string} requestId
 */
export function removeActiveSwap(requestId) {
    try {
        const swaps = getSwapsArray().filter(s => s.requestId !== requestId);
        setSwapsArray(swaps);
        console.log('[STORAGE] Removed swap:', requestId);
    } catch (error) {
        console.error('[STORAGE] Error removing swap:', error);
    }
}

/**
 * Check if any active swaps exist
 * @returns {boolean}
 */
export function hasActiveSwaps() {
    return getSwapsArray().length > 0;
}

/**
 * Get the most recent active swap
 * @returns {Object|null}
 */
export function getMostRecentActiveSwap() {
    const swaps = getSwapsArray();
    return swaps.length > 0 ? swaps[swaps.length - 1] : null;
}

/**
 * Get a specific swap by requestId
 * @param {string} requestId
 * @returns {Object|null}
 */
export function getActiveSwapByRequestId(requestId) {
    return getSwapsArray().find(s => s.requestId === requestId) || null;
}

// ─── Backward-compatible single-swap API ─────────────────────────────────────

/**
 * Save active swap state (adds/updates most recent)
 * @param {Object} swapState - Current swap state
 */
export function saveActiveSwap(swapState) {
    addOrUpdateActiveSwap(swapState);
}

/**
 * Load active swap state (most recent)
 * @returns {Object|null}
 */
export function loadActiveSwap() {
    return getMostRecentActiveSwap();
}

/**
 * Clear ALL active swaps
 */
export function clearActiveSwap() {
    try {
        localStorage.removeItem(ACTIVE_SWAPS_KEY);
        localStorage.removeItem(STORAGE_KEYS.activeSwap);
        console.log('[STORAGE] All active swaps cleared');
    } catch (error) {
        console.error('[STORAGE] Error clearing swaps:', error);
    }
}

/**
 * Check if there's an active swap
 * @returns {boolean}
 */
export function hasActiveSwap() {
    return hasActiveSwaps();
}

/**
 * Update swap state.
 * If updates contains a requestId, updates that specific swap.
 * Otherwise updates the most recent swap.
 * @param {Object} updates - Partial state updates
 */
export function updateSwapState(updates) {
    const swaps = getSwapsArray();
    const requestId = updates.requestId;

    if (requestId) {
        const idx = swaps.findIndex(s => s.requestId === requestId);
        if (idx >= 0) {
            swaps[idx] = { ...swaps[idx], ...updates, lastUpdated: Date.now() };
            setSwapsArray(swaps);
            return;
        }
        // requestId provided but not found — add as new swap
        addOrUpdateActiveSwap(updates);
        return;
    }

    if (swaps.length === 0) {
        addOrUpdateActiveSwap(updates);
    } else {
        const mostRecent = swaps[swaps.length - 1];
        Object.assign(mostRecent, updates, { lastUpdated: Date.now() });
        setSwapsArray(swaps);
    }
}

/**
 * Get swap state field from most recent swap
 * @param {string} field - Field name
 * @returns {any} Field value
 */
export function getSwapStateField(field) {
    const state = loadActiveSwap();
    return state ? state[field] : null;
}

// ─── History & Preferences (unchanged) ──────────────────────────────────────

/**
 * Save swap to history
 * @param {Object} swap - Completed swap data
 */
export function saveToHistory(swap) {
    try {
        const history = getSwapHistory();
        history.unshift({
            ...swap,
            completedAt: Date.now()
        });
        const trimmedHistory = history.slice(0, 50);
        localStorage.setItem(STORAGE_KEYS.swapHistory, JSON.stringify(trimmedHistory));
        console.log('[STORAGE] Swap saved to history');
    } catch (error) {
        console.error('[STORAGE] Error saving to history:', error);
    }
}

/**
 * Get swap history
 * @returns {Array} Array of completed swaps
 */
export function getSwapHistory() {
    try {
        const data = localStorage.getItem(STORAGE_KEYS.swapHistory);
        return data ? JSON.parse(data) : [];
    } catch (error) {
        console.error('[STORAGE] Error loading swap history:', error);
        return [];
    }
}

/**
 * Load swap history (alias for getSwapHistory)
 * @returns {Array} Array of completed swaps
 */
export function loadSwapHistory() {
    return getSwapHistory();
}

/**
 * Clear swap history
 */
export function clearSwapHistory() {
    try {
        localStorage.removeItem(STORAGE_KEYS.swapHistory);
        console.log('[STORAGE] Swap history cleared');
    } catch (error) {
        console.error('[STORAGE] Error clearing swap history:', error);
    }
}

/**
 * Save user preferences
 * @param {Object} preferences - User preferences
 */
export function savePreferences(preferences) {
    try {
        localStorage.setItem(STORAGE_KEYS.userPreferences, JSON.stringify(preferences));
        console.log('[STORAGE] Preferences saved');
    } catch (error) {
        console.error('[STORAGE] Error saving preferences:', error);
    }
}

/**
 * Load user preferences
 * @returns {Object} User preferences
 */
export function loadPreferences() {
    try {
        const data = localStorage.getItem(STORAGE_KEYS.userPreferences);
        return data ? JSON.parse(data) : {
            defaultVault: null,
            slippageTolerance: 0.5,
            autoApprove: false
        };
    } catch (error) {
        console.error('[STORAGE] Error loading preferences:', error);
        return {
            defaultVault: null,
            slippageTolerance: 0.5,
            autoApprove: false
        };
    }
}
