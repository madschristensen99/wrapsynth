// point_compress.circom - Ed25519 Point Compression Wrapper
// Wraps the Electron-Labs ed25519-circom library
// The library already provides PointCompress template

pragma circom 2.1.0;

include "../../node_modules/@electron-labs/ed25519-circom/circuits/pointcompress.circom";

// No wrapper needed - PointCompress is provided by the library
// Interface: signal input P[4][3], signal output out[256]
