// LocalStorage manager for persisting swap state

import { STORAGE_KEYS } from './config.js';

/**
 * Save active swap state
 * @param {Object} swapState - Current swap state
 */
export function saveActiveSwap(swapState) {
    try {
        const data = {
            ...swapState,
            lastUpdated: Date.now()
        };
        localStorage.setItem(STORAGE_KEYS.activeSwap, JSON.stringify(data));
        console.log('Active swap saved:', data);
    } catch (error) {
        console.error('Error saving active swap:', error);
    }
}

/**
 * Load active swap state
 * @returns {Object|null} Swap state or null if none exists
 */
export function loadActiveSwap() {
    try {
        const data = localStorage.getItem(STORAGE_KEYS.activeSwap);
        if (!data) {
            return null;
        }
        
        const swapState = JSON.parse(data);
        console.log('Active swap loaded:', swapState);
        return swapState;
    } catch (error) {
        console.error('Error loading active swap:', error);
        return null;
    }
}

/**
 * Clear active swap
 */
export function clearActiveSwap() {
    try {
        localStorage.removeItem(STORAGE_KEYS.activeSwap);
        console.log('Active swap cleared');
    } catch (error) {
        console.error('Error clearing active swap:', error);
    }
}

/**
 * Check if there's an active swap
 * @returns {boolean}
 */
export function hasActiveSwap() {
    return localStorage.getItem(STORAGE_KEYS.activeSwap) !== null;
}

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
        
        // Keep only last 50 swaps
        const trimmedHistory = history.slice(0, 50);
        
        localStorage.setItem(STORAGE_KEYS.swapHistory, JSON.stringify(trimmedHistory));
        console.log('Swap saved to history');
    } catch (error) {
        console.error('Error saving to history:', error);
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
        console.error('Error loading swap history:', error);
        return [];
    }
}

/**
 * Clear swap history
 */
export function clearSwapHistory() {
    try {
        localStorage.removeItem(STORAGE_KEYS.swapHistory);
        console.log('Swap history cleared');
    } catch (error) {
        console.error('Error clearing swap history:', error);
    }
}

/**
 * Save user preferences
 * @param {Object} preferences - User preferences
 */
export function savePreferences(preferences) {
    try {
        localStorage.setItem(STORAGE_KEYS.userPreferences, JSON.stringify(preferences));
        console.log('Preferences saved');
    } catch (error) {
        console.error('Error saving preferences:', error);
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
        console.error('Error loading preferences:', error);
        return {
            defaultVault: null,
            slippageTolerance: 0.5,
            autoApprove: false
        };
    }
}

/**
 * Update swap state
 * @param {Object} updates - Partial state updates
 */
export function updateSwapState(updates) {
    const currentState = loadActiveSwap();
    if (!currentState) {
        console.warn('No active swap to update');
        return;
    }
    
    const newState = {
        ...currentState,
        ...updates,
        lastUpdated: Date.now()
    };
    
    saveActiveSwap(newState);
}

/**
 * Get swap state field
 * @param {string} field - Field name
 * @returns {any} Field value
 */
export function getSwapStateField(field) {
    const state = loadActiveSwap();
    return state ? state[field] : null;
}
