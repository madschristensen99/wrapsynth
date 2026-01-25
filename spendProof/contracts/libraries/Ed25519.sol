// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Ed25519
 * @notice Ed25519 elliptic curve operations for Monero stealth address verification
 * 
 * Implements:
 * - Point addition: P + Q
 * - Scalar multiplication: k·G (using double-and-add)
 * - Point validation
 * 
 * Ed25519 Parameters:
 * - Prime: p = 2^255 - 19
 * - Order: l = 2^252 + 27742317777372353535851937790883648493
 * - Base point G: (x, 4/5 mod p)
 * - Curve equation: -x^2 + y^2 = 1 + d·x^2·y^2
 * - d = -121665/121666 mod p
 */
library Ed25519 {
    
    // Ed25519 prime: 2^255 - 19
    uint256 constant P = 0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed;
    
    // Ed25519 order
    uint256 constant L = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed;
    
    // Curve parameter d = -121665/121666 mod p
    uint256 constant D = 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3;
    
    // Base point G
    uint256 constant G_X = 0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a;
    uint256 constant G_Y = 0x6666666666666666666666666666666666666666666666666666666666666658;
    
    /**
     * @notice Add two Ed25519 points
     * @param x1 First point x-coordinate
     * @param y1 First point y-coordinate
     * @param x2 Second point x-coordinate
     * @param y2 Second point y-coordinate
     * @return x3 Result x-coordinate
     * @return y3 Result y-coordinate
     */
    function pointAdd(
        uint256 x1,
        uint256 y1,
        uint256 x2,
        uint256 y2
    ) internal pure returns (uint256 x3, uint256 y3) {
        // Edwards addition formula:
        // x3 = (x1*y2 + y1*x2) / (1 + d*x1*x2*y1*y2)
        // y3 = (y1*y2 - x1*x2) / (1 - d*x1*x2*y1*y2)
        
        uint256 x1y2 = mulmod(x1, y2, P);
        uint256 y1x2 = mulmod(y1, x2, P);
        uint256 x1x2 = mulmod(x1, x2, P);
        uint256 y1y2 = mulmod(y1, y2, P);
        
        uint256 dx1x2y1y2 = mulmod(D, mulmod(x1x2, y1y2, P), P);
        
        // x3 numerator
        uint256 x3_num = addmod(x1y2, y1x2, P);
        // x3 denominator
        uint256 x3_den = addmod(1, dx1x2y1y2, P);
        
        // y3 numerator  
        uint256 y3_num = submod(y1y2, x1x2, P);
        // y3 denominator
        uint256 y3_den = submod(1, dx1x2y1y2, P);
        
        // Compute x3 = x3_num / x3_den (mod p)
        x3 = mulmod(x3_num, invmod(x3_den, P), P);
        
        // Compute y3 = y3_num / y3_den (mod p)
        y3 = mulmod(y3_num, invmod(y3_den, P), P);
    }
    
    /**
     * @notice Scalar multiplication using double-and-add
     * @param k Scalar
     * @param x Point x-coordinate
     * @param y Point y-coordinate
     * @return rx Result x-coordinate
     * @return ry Result y-coordinate
     */
    function scalarMul(
        uint256 k,
        uint256 x,
        uint256 y
    ) internal pure returns (uint256 rx, uint256 ry) {
        // Identity point (0, 1)
        rx = 0;
        ry = 1;
        
        uint256 px = x;
        uint256 py = y;
        
        // Double-and-add algorithm
        while (k > 0) {
            if (k & 1 == 1) {
                (rx, ry) = pointAdd(rx, ry, px, py);
            }
            (px, py) = pointAdd(px, py, px, py); // Double
            k >>= 1;
        }
    }
    
    /**
     * @notice Verify point is on Ed25519 curve
     * @param x Point x-coordinate
     * @param y Point y-coordinate
     * @return bool True if point is on curve
     */
    function isOnCurve(uint256 x, uint256 y) internal pure returns (bool) {
        // Curve equation: -x^2 + y^2 = 1 + d*x^2*y^2
        uint256 x2 = mulmod(x, x, P);
        uint256 y2 = mulmod(y, y, P);
        
        uint256 lhs = submod(y2, x2, P);
        uint256 rhs = addmod(1, mulmod(D, mulmod(x2, y2, P), P), P);
        
        return lhs == rhs;
    }
    
    /**
     * @notice Modular inverse using Fermat's little theorem
     * @param a Value to invert
     * @param m Modulus
     * @return result a^(-1) mod m
     */
    function invmod(uint256 a, uint256 m) internal pure returns (uint256 result) {
        // Fermat's little theorem: a^(p-1) = 1 (mod p)
        // Therefore: a^(-1) = a^(p-2) (mod p)
        return expmod(a, m - 2, m);
    }
    
    /**
     * @notice Modular exponentiation
     * @param base Base
     * @param exp Exponent
     * @param mod Modulus
     * @return result base^exp mod mod
     */
    function expmod(uint256 base, uint256 exp, uint256 mod) internal pure returns (uint256 result) {
        result = 1;
        base = base % mod;
        
        while (exp > 0) {
            if (exp & 1 == 1) {
                result = mulmod(result, base, mod);
            }
            base = mulmod(base, base, mod);
            exp >>= 1;
        }
    }
    
    /**
     * @notice Modular subtraction
     * @param a First value
     * @param b Second value
     * @param m Modulus
     * @return result (a - b) mod m
     */
    function submod(uint256 a, uint256 b, uint256 m) internal pure returns (uint256 result) {
        if (a >= b) {
            return (a - b) % m;
        } else {
            return (m - ((b - a) % m)) % m;
        }
    }
    
    /**
     * @notice Verify stealth address derivation: P = H_s·G + B
     * @param H_s Scalar H_s
     * @param B_x Recipient view key x-coordinate
     * @param B_y Recipient view key y-coordinate
     * @param P_x Claimed stealth address x-coordinate
     * @param P_y Claimed stealth address y-coordinate
     * @return bool True if P = H_s·G + B
     */
    function verifyStealthAddress(
        uint256 H_s,
        uint256 B_x,
        uint256 B_y,
        uint256 P_x,
        uint256 P_y
    ) internal pure returns (bool) {
        // Compute S = H_s·G
        (uint256 S_x, uint256 S_y) = scalarMul(H_s, G_X, G_Y);
        
        // Compute P' = S + B
        (uint256 P_prime_x, uint256 P_prime_y) = pointAdd(S_x, S_y, B_x, B_y);
        
        // Verify P' == P
        return (P_prime_x == P_x && P_prime_y == P_y);
    }
}