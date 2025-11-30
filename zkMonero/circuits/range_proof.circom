pragma circom 2.0.0;

/*
 * Range proof circuit - proves that a value is within a range [min, max]
 * Inputs: value, min, max
 * Output: isValid (1 if value is in range, 0 otherwise)
 */
template RangeProof(n) {
    // Input signals
    signal input value;
    signal input min;
    signal input max;
    
    // Output signal
    signal output isValid;
    
    // Compute isValid = 1 if min <= value <= max, else 0
    isValid <== (value >= min) * (value <= max);
}

// Main component instantiation
component main = RangeProof(32);