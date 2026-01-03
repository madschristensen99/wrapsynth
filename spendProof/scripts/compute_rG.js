// Compute R = r·G using Monero's method
const { decompressPoint, affineToExtended, toBase85Limbs } = require('./ed25519_utils');

// Ed25519 curve parameters
const CURVE = {
    p: BigInt('57896044618658097711785492504343953926634992332820282019728792003956564819949'),
    l: BigInt('7237005577332262213973186563042994240857116359379907606001950938285454250989'),
    d: BigInt('37095705934669439343138083508754565189542113879843219016388785533085940283555'),
    Gx: BigInt('15112221349535400772501151409588531511454012693041857206046113283949847762202'),
    Gy: BigInt('46316835694926478169428394003475163141307993866256225615783033603165251855960'),
};

// Scalar multiplication on Ed25519 (double-and-add)
function scalarMult(scalar, point) {
    let result = { x: 0n, y: 1n }; // Identity point
    let temp = { x: point.x, y: point.y };
    
    for (let i = 0; i < 255; i++) {
        if ((scalar >> BigInt(i)) & 1n) {
            result = pointAdd(result, temp);
        }
        temp = pointDouble(temp);
    }
    
    return result;
}

function pointAdd(P, Q) {
    if (P.x === 0n && P.y === 1n) return Q;
    if (Q.x === 0n && Q.y === 1n) return P;
    
    const { x: x1, y: y1 } = P;
    const { x: x2, y: y2 } = Q;
    
    const x1y2 = (x1 * y2) % CURVE.p;
    const x2y1 = (x2 * y1) % CURVE.p;
    const y1y2 = (y1 * y2) % CURVE.p;
    const x1x2 = (x1 * x2) % CURVE.p;
    
    const dx1x2y1y2 = (CURVE.d * x1x2 % CURVE.p * y1y2) % CURVE.p;
    
    const x3_num = (x1y2 + x2y1) % CURVE.p;
    const x3_den = modInv((1n + dx1x2y1y2) % CURVE.p, CURVE.p);
    const x3 = (x3_num * x3_den) % CURVE.p;
    
    const y3_num = (y1y2 + x1x2) % CURVE.p;
    const y3_den = modInv((1n - dx1x2y1y2 + CURVE.p) % CURVE.p, CURVE.p);
    const y3 = (y3_num * y3_den) % CURVE.p;
    
    return { x: x3, y: y3 };
}

function pointDouble(P) {
    return pointAdd(P, P);
}

function modInv(a, m) {
    a = ((a % m) + m) % m;
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

// Compute R = r·G
function computeRFromSecret(secretKeyHex) {
    const secretBytes = Buffer.from(secretKeyHex, 'hex');
    
    // Convert to scalar (little-endian)
    let r_scalar = 0n;
    for (let i = 0; i < secretBytes.length; i++) {
        r_scalar |= BigInt(secretBytes[i]) << BigInt(i * 8);
    }
    
    // Reduce modulo curve order
    r_scalar = r_scalar % CURVE.l;
    
    console.log("Scalar r:", r_scalar.toString(16));
    
    // Compute R = r·G
    const G = { x: CURVE.Gx, y: CURVE.Gy };
    const R = scalarMult(r_scalar, G);
    
    console.log("R.x:", R.x.toString(16));
    console.log("R.y:", R.y.toString(16));
    
    // Compress R
    const y_bytes = [];
    let y_temp = R.y;
    for (let i = 0; i < 32; i++) {
        y_bytes.push(Number(y_temp & 0xFFn));
        y_temp >>= 8n;
    }
    
    // Set sign bit
    if ((R.x & 1n) === 1n) {
        y_bytes[31] |= 0x80;
    }
    
    const R_compressed = Buffer.from(y_bytes).toString('hex');
    console.log("R compressed:", R_compressed);
    
    return R_compressed;
}

module.exports = { computeRFromSecret };
