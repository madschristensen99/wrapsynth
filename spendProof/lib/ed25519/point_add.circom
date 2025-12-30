// point_add.circom - Ed25519 Point Addition Wrapper
// Wraps the Electron-Labs ed25519-circom library
// The library already provides PointAdd template

pragma circom 2.1.0;

include "../../node_modules/@electron-labs/ed25519-circom/circuits/point-addition.circom";

// No wrapper needed - PointAdd is provided by the library
// Interface: signal input P[4][3], signal input Q[4][3], signal output out[4][3]
