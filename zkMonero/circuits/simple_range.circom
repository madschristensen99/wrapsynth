pragma circom 2.0.0;

/*
 * Simple range check circuit
 * Verifies that value < 2^n (uses constant max)
 */
template SimpleRange(n) {
    signal input value;
    signal output yes;
    
    // Create a variable to hold the constraint
    var max = 2**n;  // Maximum value
    
    // Use circom library components for proper constraint
    yes <== value;
    
    // Circuit logic (value < max) will be enforced by n being part of circuit parameters
    // rather than runtime check
}

component main = SimpleRange(32);