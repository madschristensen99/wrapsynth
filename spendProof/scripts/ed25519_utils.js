const crypto = require('crypto');

// Ed25519 curve parameters
const CURVE = {
    // Prime: 2^255 - 19
    p: BigInt('57896044618658097711785492504343953926634992332820282019728792003956564819949'),
    // Order: 2^252 + 27742317777372353535851937790883648493
    l: BigInt('7237005577332262213973186563042994240857116359379907606001950938285454250989'),
    // d = -121665/121666
    d: BigInt('37095705934669439343138083508754565189542113879843219016388785533085940283555'),
    // Base point
    Gx: BigInt('15112221349535400772501151409588531511454012693041857206046113283949847762202'),
    Gy: BigInt('46316835694926478169428394003475163141307993866256225615783033603165251855960'),
};

/**
 * Modular inverse using Extended Euclidean Algorithm
 */
function modInverse(a, m) {
    a = BigInt(a);
    m = BigInt(m);
    
    if (a < 0n) a = ((a % m) + m) % m;
    
    let [old_r, r] = [a, m];
    let [old_s, s] = [1n, 0n];
    
    while (r !== 0n) {
        const quotient = old_r / r;
        [old_r, r] = [r, old_r - quotient * r];
        [old_s, s] = [s, old_s - quotient * s];
    }
    
    if (old_r > 1n) throw new Error('Not invertible');
    if (old_s < 0n) old_s += m;
    
    return old_s;
}

/**
 * Modular square root (Tonelli-Shanks for p ≡ 5 (mod 8))
 */
function modSqrt(n, p) {
    n = BigInt(n);
    p = BigInt(p);
    
    // For p ≡ 5 (mod 8), we can use: x = n^((p+3)/8)
    // If x^2 = n, return x, else return x * 2^((p-1)/4)
    
    const exp1 = (p + 3n) / 8n;
    let x = modPow(n, exp1, p);
    
    if ((x * x) % p !== n % p) {
        const exp2 = (p - 1n) / 4n;
        const c = modPow(2n, exp2, p);
        x = (x * c) % p;
    }
    
    return x;
}

/**
 * Modular exponentiation
 */
function modPow(base, exp, mod) {
    base = BigInt(base);
    exp = BigInt(exp);
    mod = BigInt(mod);
    
    if (mod === 1n) return 0n;
    
    let result = 1n;
    base = base % mod;
    
    while (exp > 0n) {
        if (exp % 2n === 1n) {
            result = (result * base) % mod;
        }
        exp = exp / 2n;
        base = (base * base) % mod;
    }
    
    return result;
}

/**
 * Decompress Ed25519 point from 32-byte compressed format
 * Returns affine coordinates (x, y)
 */
function decompressPoint(compressedHex) {
    if (compressedHex.length !== 64) {
        throw new Error('Compressed point must be 32 bytes (64 hex chars)');
    }
    
    const bytes = Buffer.from(compressedHex, 'hex');
    
    // Extract sign bit from last byte
    const signBit = (bytes[31] & 0x80) !== 0;
    
    // Clear sign bit to get y coordinate
    bytes[31] &= 0x7F;
    
    // Convert to BigInt (little-endian)
    let y = 0n;
    for (let i = 0; i < 32; i++) {
        y |= BigInt(bytes[i]) << BigInt(i * 8);
    }
    
    // Verify y is in field
    if (y >= CURVE.p) {
        throw new Error('y coordinate out of range');
    }
    
    // Recover x from y using curve equation: x^2 = (y^2 - 1) / (d*y^2 + 1)
    const y2 = (y * y) % CURVE.p;
    const numerator = (y2 - 1n + CURVE.p) % CURVE.p;
    const denominator = (CURVE.d * y2 + 1n) % CURVE.p;
    
    const denominatorInv = modInverse(denominator, CURVE.p);
    const x2 = (numerator * denominatorInv) % CURVE.p;
    
    // Compute square root
    let x = modSqrt(x2, CURVE.p);
    
    // Adjust sign
    const xIsNegative = (x & 1n) === 1n;
    if (xIsNegative !== signBit) {
        x = CURVE.p - x;
    }
    
    // Verify point is on curve
    const lhs = (x * x) % CURVE.p;
    const rhs = (y2 - 1n - CURVE.d * x2 * y2) % CURVE.p;
    const lhsNorm = ((lhs % CURVE.p) + CURVE.p) % CURVE.p;
    const rhsNorm = ((rhs % CURVE.p) + CURVE.p) % CURVE.p;
    
    if (lhsNorm !== rhsNorm) {
        throw new Error('Point not on curve');
    }
    
    return { x, y };
}

/**
 * Convert affine coordinates (x, y) to extended coordinates (X:Y:Z:T)
 * where x = X/Z, y = Y/Z, x*y = T/Z
 */
function affineToExtended(x, y) {
    x = BigInt(x);
    y = BigInt(y);
    
    return {
        X: x,
        Y: y,
        Z: 1n,
        T: (x * y) % CURVE.p
    };
}

/**
 * Convert a BigInt to base 2^85 representation with 3 limbs
 * Each limb is 85 bits, total 255 bits
 */
function toBase85Limbs(value) {
    value = BigInt(value);
    const base = 1n << 85n; // 2^85
    
    const limb0 = value % base;
    const limb1 = (value >> 85n) % base;
    const limb2 = (value >> 170n) % base;
    
    return [
        limb0.toString(),
        limb1.toString(),
        limb2.toString()
    ];
}

/**
 * Full decompression: compressed hex -> extended coordinates in base 2^85
 */
function decompressToExtendedBase85(compressedHex) {
    console.log(`\n🔧 Decompressing point: ${compressedHex.substring(0, 16)}...`);
    
    // Step 1: Decompress to affine coordinates
    const { x, y } = decompressPoint(compressedHex);
    console.log(`   ✓ Affine x: ${x.toString(16).substring(0, 16)}...`);
    console.log(`   ✓ Affine y: ${y.toString(16).substring(0, 16)}...`);
    
    // Step 2: Convert to extended coordinates
    const extended = affineToExtended(x, y);
    console.log(`   ✓ Extended coordinates computed`);
    
    // Step 3: Convert each coordinate to base 2^85 (3 limbs)
    const result = {
        X: toBase85Limbs(extended.X),
        Y: toBase85Limbs(extended.Y),
        Z: toBase85Limbs(extended.Z),
        T: toBase85Limbs(extended.T)
    };
    
    console.log(`   ✓ Converted to base 2^85 representation`);
    
    return result;
}

/**
 * Format extended coordinates for circuit input
 * Circuit expects: point[4][3] where point[i][j] is coordinate i, limb j
 */
function formatForCircuit(extended) {
    return [
        extended.X, // [X0, X1, X2]
        extended.Y, // [Y0, Y1, Y2]
        extended.Z, // [Z0, Z1, Z2]
        extended.T  // [T0, T1, T2]
    ];
}

module.exports = {
    decompressPoint,
    affineToExtended,
    toBase85Limbs,
    decompressToExtendedBase85,
    formatForCircuit,
    CURVE
};
