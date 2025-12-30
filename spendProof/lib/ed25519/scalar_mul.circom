// scalar_mul.circom - Ed25519 Scalar Multiplication Wrapper
// Wraps the Electron-Labs ed25519-circom library
// The library already provides ScalarMul template

pragma circom 2.1.0;

include "../../node_modules/@electron-labs/ed25519-circom/circuits/scalarmul.circom";

// No wrapper needed - ScalarMul is provided by the library
// Interface: signal input s[255], signal input P[4][3], signal output sP[4][3]
// Note: The library uses 255 bits for scalar, not 256
