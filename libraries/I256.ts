import { System } from "@koinos/sdk-as";
import { U256 } from "./U256";

const INT128_MAX = U256.maxBits(127); // 2^127 - 1
const INT128_MIN_ABS = U256.pow2(127); // |-2^127|

/**
 * Signed integer represented as sign + magnitude.
 *
 * Uniswap v3 uses signed integers for liquidity deltas (int128) and for the net liquidity
 * stored in each tick. `I256` keeps the sign apart from the absolute value (an `U256`) and
 * exposes explicit range checks equivalent to Solidity's SafeCast.toInt128.
 */
export class I256 {
  neg: bool;
  abs: U256;

  constructor(neg: bool = false, abs: U256 = new U256()) {
    // zero is always positive
    this.neg = abs.isZero() ? false : neg;
    this.abs = abs;
  }

  @inline
  static zero(): I256 {
    return new I256(false, new U256());
  }

  @inline
  static fromU256(value: U256, neg: bool = false): I256 {
    return new I256(neg, value);
  }

  @inline
  isZero(): bool {
    return this.abs.isZero();
  }

  @inline
  isNegative(): bool {
    return this.neg;
  }

  @inline
  static negate(a: I256): I256 {
    return new I256(!a.neg, a.abs);
  }

  /** a + b */
  static add(a: I256, b: I256): I256 {
    if (a.neg == b.neg) {
      return new I256(a.neg, U256.add(a.abs, b.abs));
    }
    // different signs: subtract the smaller magnitude from the bigger one
    if (U256.gte(a.abs, b.abs)) {
      return new I256(a.neg, U256.sub(a.abs, b.abs));
    }
    return new I256(b.neg, U256.sub(b.abs, a.abs));
  }

  /** a - b */
  @inline
  static sub(a: I256, b: I256): I256 {
    return I256.add(a, I256.negate(b));
  }

  static eq(a: I256, b: I256): bool {
    return a.neg == b.neg && U256.eq(a.abs, b.abs);
  }

  /** SafeCast.toInt128: reverts if the value doesn't fit in an int128 */
  checkInt128(): I256 {
    if (this.neg) {
      System.require(U256.lte(this.abs, INT128_MIN_ABS), "KOINDX: INT128_OVERFLOW");
    } else {
      System.require(U256.lte(this.abs, INT128_MAX), "KOINDX: INT128_OVERFLOW");
    }
    return this;
  }

  toString(): string {
    if (this.neg) return "-" + this.abs.toString();
    return this.abs.toString();
  }

  static fromString(value: string): I256 {
    if (value.length > 0 && value.charCodeAt(0) == 45) {
      return new I256(true, U256.fromString(value.substring(1)));
    }
    return new I256(false, U256.fromString(value));
  }

  /** compact binary encoding: 1 byte sign followed by the big endian magnitude */
  toBytes(): Uint8Array {
    const mag = this.abs.toBytes();
    if (mag.length == 0) return mag;
    const out = new Uint8Array(mag.length + 1);
    out[0] = this.neg ? 1 : 0;
    out.set(mag, 1);
    return out;
  }

  static fromBytes(bytes: Uint8Array): I256 {
    if (bytes.length == 0) return I256.zero();
    return new I256(bytes[0] == 1, U256.fromBytes(bytes.subarray(1)));
  }
}
