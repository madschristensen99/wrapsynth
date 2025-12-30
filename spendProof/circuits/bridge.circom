pragma circom 2.0.0;

template MoneroBridge() {
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
    
    verified_binding <== bridge_tx_binding;
    verified_amount <== v;
}

component main {public [R_x, P_compressed, C_compressed, ecdhAmount, B_compressed, monero_tx_hash, bridge_tx_binding, chain_id]} = MoneroBridge();