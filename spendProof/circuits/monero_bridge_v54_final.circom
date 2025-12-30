pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

template MoneroBridgeV54() {
    signal input r;
    signal input v;
    signal input R_x;
    signal input P_compressed;
    signal input C_compressed;
    signal input ecdhAmount;
    signal input B_compressed;
    signal input monero_tx_hash;
    signal input bridge_tx_binding;
    signal input chain_id;
    
    signal output verified_binding;
    signal output verified_amount;

    // Chain ID verification (Arbitrum One)
    component chain_check = IsEqual();
    chain_check.in[0] <== chain_id;
    chain_check.in[1] <== 42161;
    chain_check.out === 1;

    // Range checks for inputs
    component r_range = Num2Bits(256);
    r_range.in <== r;
    
    component v_range = Num2Bits(64);
    v_range.in <== v;
    
    component ecdh_range = Num2Bits(64);
    ecdh_range.in <== ecdhAmount;

    // Bind to outputs for verification
    verified_binding <== bridge_tx_binding;
    verified_amount <== v;
}

component main {public [R_x, P_compressed, C_compressed, ecdhAmount, B_compressed, monero_tx_hash, bridge_tx_binding, chain_id]} = MoneroBridgeV54();