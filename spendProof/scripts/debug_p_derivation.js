// Debug script to verify P derivation formula
const { ed25519 } = require('@noble/curves/ed25519');
const { keccak_256 } = require('@noble/hashes/sha3');

// From witness generator output
const r_hex = "4cbf8f2cfb622ee126f08df053e99b96aa2e8c1cfd575d2a651f3343b465800a";
const A_hex = "4b3b20221b57a7f34aeea3c407d8b5a15489629907ddbb0d8313bc184aa17f81";
const B_hex = "2753a9a1b21dd803c69f7597f3d73599f3b08b27f134d9a29b6f20f787f7842c";
const output_index = 0;

// Expected P from transaction (little-endian compressed format)
const P_expected_hex = "60942c5e4f3201d345a16bae3d41cf91775739da38771e0611655aa0971ce418";

console.log("🔍 Debugging P Derivation\n");

// Step 1: Compute derivation = 8·r·A
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const r_bytes = Buffer.from(r_hex, 'hex');
const A_point = ed25519.ExtendedPoint.fromHex(A_hex);

// Reduce r mod L first
let r_bigint = 0n;
for (let i = 0; i < 32; i++) {
    r_bigint |= BigInt(r_bytes[i]) << BigInt(i * 8);
}
r_bigint = r_bigint % L;

console.log("r (mod L):", r_bigint.toString(16));

// Multiply r * A
const rA = A_point.multiply(r_bigint);

// Multiply by cofactor 8
const derivation = rA.multiply(8n);
const derivation_hex = Buffer.from(derivation.toRawBytes()).toString('hex');

console.log("Derivation (8·r·A):", derivation_hex);

// Step 2: Hash derivation with output_index
const derivation_bytes = Buffer.from(derivation_hex, 'hex');
const output_index_byte = Buffer.from([output_index]);
const hash_input = Buffer.concat([derivation_bytes, output_index_byte]);
const hash = keccak_256(hash_input);

console.log("Hash input:", hash_input.toString('hex').substring(0, 40) + "...");
console.log("Hash output:", Buffer.from(hash).toString('hex'));

// Step 3: Convert hash to scalar (mod L)
let scalar = 0n;
for (let i = 0; i < 32; i++) {
    scalar |= BigInt(hash[i]) << BigInt(i * 8);
}
scalar = scalar % L;

console.log("H_s scalar (mod L):", scalar.toString(16));

// Step 4: Compute H_s · G
const G = ed25519.ExtendedPoint.BASE;
const HsG = G.multiply(scalar);

console.log("H_s·G:", Buffer.from(HsG.toRawBytes()).toString('hex'));

// Step 5: Add B
const B_point = ed25519.ExtendedPoint.fromHex(B_hex);
const P_derived = HsG.add(B_point);

console.log("\n✅ Derived P:", Buffer.from(P_derived.toRawBytes()).toString('hex'));
console.log("Expected P:", P_expected_hex);
console.log("Match:", Buffer.from(P_derived.toRawBytes()).toString('hex') === P_expected_hex);
