// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Ed25519
 * @notice Ed25519 elliptic curve operations for Solidity
 * @dev Implements point addition, scalar multiplication, and DLEQ verification
 * 
 * Ed25519 curve: -x^2 + y^2 = 1 + d*x^2*y^2
 * where d = -121665/121666 mod p
 * p = 2^255 - 19 (field prime)
 * L = 2^252 + 27742317777372353535851937790883648493 (curve order)
 */
library Ed25519 {
    
    // Field prime: p = 2^255 - 19
    uint256 constant P = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed;
    
    // Curve order: L = 2^252 + 27742317777372353535851937790883648493
    uint256 constant L = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed;
    
    // Curve parameter d = -121665/121666 mod p
    uint256 constant D = 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3;
    
    // Base point G
    uint256 constant GX = 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a;
    uint256 constant GY = 0x6666666666666666666666666666666666666666666666666666666666666658;
    
    struct Point {
        uint256 x;
        uint256 y;
    }
    
    /**
     * @notice Add two Ed25519 points
     * @dev Uses unified addition formula for Edwards curves
     */
    function pointAdd(Point memory p1, Point memory p2) internal pure returns (Point memory) {
        uint256 x1 = p1.x;
        uint256 y1 = p1.y;
        uint256 x2 = p2.x;
        uint256 y2 = p2.y;
        
        // x3 = (x1*y2 + y1*x2) / (1 + d*x1*x2*y1*y2)
        // y3 = (y1*y2 - x1*x2) / (1 - d*x1*x2*y1*y2)
        
        uint256 x1y2 = mulmod(x1, y2, P);
        uint256 y1x2 = mulmod(y1, x2, P);
        uint256 y1y2 = mulmod(y1, y2, P);
        uint256 x1x2 = mulmod(x1, x2, P);
        
        uint256 dx1x2y1y2 = mulmod(mulmod(D, x1x2, P), mulmod(y1, y2, P), P);
        
        uint256 x3_num = addmod(x1y2, y1x2, P);
        uint256 x3_den = addmod(1, dx1x2y1y2, P);
        
        uint256 y3_num = addmod(y1y2, P - x1x2, P);
        uint256 y3_den = addmod(1, P - dx1x2y1y2, P);
        
        return Point({
            x: mulmod(x3_num, modInv(x3_den, P), P),
            y: mulmod(y3_num, modInv(y3_den, P), P)
        });
    }
    
    /**
     * @notice Scalar multiplication using double-and-add
     * @dev Multiplies point P by scalar s
     */
    function scalarMul(Point memory p, uint256 s) internal pure returns (Point memory) {
        if (s == 0) {
            return Point({x: 0, y: 1}); // Identity point
        }
        
        Point memory result = Point({x: 0, y: 1}); // Identity
        Point memory temp = p;
        
        while (s > 0) {
            if (s & 1 == 1) {
                result = pointAdd(result, temp);
            }
            temp = pointAdd(temp, temp); // Double
            s >>= 1;
        }
        
        return result;
    }
    
    /**
     * @notice Verify DLEQ proof
     * @dev Proves log_G(R) = log_A(S) = r without revealing r
     * 
     * Verification equations:
     * 1. s*G = K1 + c*R
     * 2. s*A = K2 + c*S
     * 3. c = Hash(G, A, R, S, K1, K2)
     */
    function verifyDLEQ(
        Point memory G,
        Point memory A,
        Point memory R,
        Point memory S,
        uint256 c,
        uint256 s,
        Point memory K1,
        Point memory K2
    ) internal pure returns (bool) {
        // Verify s < L (curve order)
        if (s >= L) return false;
        
        // Compute s*G
        Point memory sG = scalarMul(G, s);
        
        // Compute c*R
        Point memory cR = scalarMul(R, c);
        
        // Compute K1 + c*R
        Point memory rhs1 = pointAdd(K1, cR);
        
        // Verify s*G = K1 + c*R
        if (sG.x != rhs1.x || sG.y != rhs1.y) {
            return false;
        }
        
        // Compute s*A
        Point memory sA = scalarMul(A, s);
        
        // Compute c*S
        Point memory cS = scalarMul(S, c);
        
        // Compute K2 + c*S
        Point memory rhs2 = pointAdd(K2, cS);
        
        // Verify s*A = K2 + c*S
        if (sA.x != rhs2.x || sA.y != rhs2.y) {
            return false;
        }
        
        // Verify challenge (Fiat-Shamir)
        uint256 c_check = uint256(keccak256(abi.encodePacked(
            G.x, G.y,
            A.x, A.y,
            R.x, R.y,
            S.x, S.y,
            K1.x, K1.y,
            K2.x, K2.y
        ))) % L;
        
        return c == c_check;
    }
    
    /**
     * @notice Verify R = r*G using public R
     * @dev Used to verify transaction public key
     */
    function verifyScalarMul(
        Point memory G,
        Point memory R,
        uint256 r
    ) internal pure returns (bool) {
        Point memory computed = scalarMul(G, r);
        return computed.x == R.x && computed.y == R.y;
    }
    
    /**
     * @notice Modular inverse using Fermat's little theorem
     * @dev a^(-1) = a^(p-2) mod p
     */
    function modInv(uint256 a, uint256 m) internal pure returns (uint256) {
        return modExp(a, m - 2, m);
    }
    
    /**
     * @notice Modular exponentiation
     * @dev Computes (base^exp) mod m
     */
    function modExp(uint256 base, uint256 exp, uint256 m) internal pure returns (uint256) {
        uint256 result = 1;
        base = base % m;
        
        while (exp > 0) {
            if (exp & 1 == 1) {
                result = mulmod(result, base, m);
            }
            exp >>= 1;
            base = mulmod(base, base, m);
        }
        
        return result;
    }
    
    /**
     * @notice Decompress Ed25519 point from y-coordinate
     * @dev Recovers x from y using curve equation
     */
    function decompress(uint256 y_coord, bool x_sign) internal pure returns (Point memory) {
        // Solve for x: x^2 = (y^2 - 1) / (d*y^2 + 1)
        
        uint256 y2 = mulmod(y_coord, y_coord, P);
        uint256 num = addmod(y2, P - 1, P); // y^2 - 1
        uint256 den = addmod(mulmod(D, y2, P), 1, P); // d*y^2 + 1
        
        uint256 x2 = mulmod(num, modInv(den, P), P);
        
        // Compute square root using Tonelli-Shanks or direct method
        // For p = 2^255 - 19, we can use x = x2^((p+3)/8)
        uint256 x = modExp(x2, (P + 3) / 8, P);
        
        // Verify x^2 = x2
        if (mulmod(x, x, P) != x2) {
            // Try x = x * sqrt(-1) = x * 2^((p-1)/4)
            x = mulmod(x, modExp(2, (P - 1) / 4, P), P);
        }
        
        // Apply sign
        if ((x & 1) != (x_sign ? 1 : 0)) {
            x = P - x;
        }
        
        return Point({x: x, y: y_coord});
    }
}
