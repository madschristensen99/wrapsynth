// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Ed25519
 * @notice Ed25519 elliptic curve operations for Solidity
 * @dev Based on https://github.com/javgh/ed25519-solidity
 * Using formulas from https://hyperelliptic.org/EFD/g1p/auto-twisted-projective.html
 * and constants from https://tools.ietf.org/html/draft-josefsson-eddsa-ed25519-03
 */
library Ed25519 {
    uint256 constant q = 2 ** 255 - 19;
    uint256 constant d = 37095705934669439343138083508754565189542113879843219016388785533085940283555;
    uint256 constant L = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed;
    uint256 constant Bx = 15112221349535400772501151409588531511454012693041857206046113283949847762202;
    uint256 constant By = 46316835694926478169428394003475163141307993866256225615783033603165251855960;

    struct Point {
        uint256 x;
        uint256 y;
        uint256 z;
    }

    struct Scratchpad {
        uint256 a;
        uint256 b;
        uint256 c;
        uint256 d;
        uint256 e;
        uint256 f;
        uint256 g;
        uint256 h;
    }

    function inv(uint256 a) internal view returns (uint256 invA) {
        uint256 e = q - 2;
        uint256 m = q;

        // Use bigModExp precompile (address 0x05) with explicit gas
        assembly {
            let p := mload(0x40)
            mstore(p, 0x20)             // length of base
            mstore(add(p, 0x20), 0x20)  // length of exponent  
            mstore(add(p, 0x40), 0x20)  // length of modulus
            mstore(add(p, 0x60), a)     // base
            mstore(add(p, 0x80), e)     // exponent
            mstore(add(p, 0xa0), m)     // modulus
            
            // Call precompile with enough gas
            if iszero(staticcall(200000, 0x05, p, 0xc0, p, 0x20)) {
                revert(0, 0)
            }
            invA := mload(p)
        }
    }

    function ecAdd(Point memory p1, Point memory p2) internal pure returns (Point memory p3) {
        Scratchpad memory tmp;

        tmp.a = mulmod(p1.z, p2.z, q);
        tmp.b = mulmod(tmp.a, tmp.a, q);
        tmp.c = mulmod(p1.x, p2.x, q);
        tmp.d = mulmod(p1.y, p2.y, q);
        tmp.e = mulmod(d, mulmod(tmp.c, tmp.d, q), q);
        tmp.f = addmod(tmp.b, q - tmp.e, q);
        tmp.g = addmod(tmp.b, tmp.e, q);
        p3.x = mulmod(mulmod(tmp.a, tmp.f, q),
                      addmod(addmod(mulmod(addmod(p1.x, p1.y, q),
                                           addmod(p2.x, p2.y, q), q),
                                    q - tmp.c, q), q - tmp.d, q), q);
        p3.y = mulmod(mulmod(tmp.a, tmp.g, q),
                      addmod(tmp.d, tmp.c, q), q);
        p3.z = mulmod(tmp.f, tmp.g, q);
    }

    function ecDouble(Point memory p1) internal pure returns (Point memory p2) {
        Scratchpad memory tmp;

        tmp.a = addmod(p1.x, p1.y, q);
        tmp.b = mulmod(tmp.a, tmp.a, q);
        tmp.c = mulmod(p1.x, p1.x, q);
        tmp.d = mulmod(p1.y, p1.y, q);
        tmp.e = q - tmp.c;
        tmp.f = addmod(tmp.e, tmp.d, q);
        tmp.h = mulmod(p1.z, p1.z, q);
        tmp.g = addmod(tmp.f, q - mulmod(2, tmp.h, q), q);
        p2.x = mulmod(addmod(addmod(tmp.b, q - tmp.c, q), q - tmp.d, q),
                      tmp.g, q);
        p2.y = mulmod(tmp.f, addmod(tmp.e, q - tmp.d, q), q);
        p2.z = mulmod(tmp.f, tmp.g, q);
    }

    function scalarMult(Point memory p, uint256 s) internal view returns (Point memory result) {
        result.x = 0;
        result.y = 1;
        result.z = 1;

        Point memory temp = p;

        while (s > 0) {
            if (s & 1 == 1) {
                result = ecAdd(result, temp);
            }
            s = s >> 1;
            temp = ecDouble(temp);
        }

        // Convert from projective to affine coordinates
        uint256 invZ = inv(result.z);
        result.x = mulmod(result.x, invZ, q);
        result.y = mulmod(result.y, invZ, q);
        result.z = 1;
    }

    function scalarMultBase(uint256 s) internal view returns (uint256, uint256) {
        Point memory b;
        Point memory result;
        b.x = Bx;
        b.y = By;
        b.z = 1;
        result.x = 0;
        result.y = 1;
        result.z = 1;

        while (s > 0) {
            if (s & 1 == 1) {
                result = ecAdd(result, b);
            }
            s = s >> 1;
            b = ecDouble(b);
        }

        uint256 invZ = inv(result.z);
        result.x = mulmod(result.x, invZ, q);
        result.y = mulmod(result.y, invZ, q);

        return (result.x, result.y);
    }

    /**
     * @notice Verify DLEQ proof
     * @dev Proves log_G(R) = log_A(S) = r without revealing r
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
    ) internal view returns (bool) {
        // Verify s < L (curve order)
        if (s >= L) return false;

        // Compute s*G
        Point memory sG = scalarMult(G, s);

        // Compute c*R
        Point memory cR = scalarMult(R, c);

        // Compute K1 + c*R
        Point memory rhs1 = ecAdd(K1, cR);

        // Convert to affine for comparison
        uint256 invZ1 = inv(rhs1.z);
        rhs1.x = mulmod(rhs1.x, invZ1, q);
        rhs1.y = mulmod(rhs1.y, invZ1, q);

        // Verify s*G = K1 + c*R
        if (sG.x != rhs1.x || sG.y != rhs1.y) {
            return false;
        }

        // Compute s*A
        Point memory sA = scalarMult(A, s);

        // Compute c*S
        Point memory cS = scalarMult(S, c);

        // Compute K2 + c*S
        Point memory rhs2 = ecAdd(K2, cS);

        // Convert to affine for comparison
        uint256 invZ2 = inv(rhs2.z);
        rhs2.x = mulmod(rhs2.x, invZ2, q);
        rhs2.y = mulmod(rhs2.y, invZ2, q);

        // Verify s*A = K2 + c*S
        if (sA.x != rhs2.x || sA.y != rhs2.y) {
            return false;
        }

        // Verify challenge (Fiat-Shamir)
        // Note: S parameter is actually rA for standard DLEQ
        uint256 c_check = uint256(keccak256(abi.encodePacked(
            G.x, G.y,
            A.x, A.y,
            R.x, R.y,
            S.x, S.y,  // This is rA, not 8*rA
            K1.x, K1.y,
            K2.x, K2.y
        ))) % L;

        return c == c_check;
    }
}
