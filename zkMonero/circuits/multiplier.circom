pragma circom 2.0.0;

/*
 * Simple multiplier circuit - takes two inputs and outputs their product
 * This is a basic circuit to demonstrate circom functionality
 */
template Multiplier() {
    // Input signals
    signal input a;
    signal input b;
    
    // Output signal
    signal output c;
    
    // The actual multiplication constraint
    c <== a * b;
}

// Main component instantiation
component main = Multiplier();