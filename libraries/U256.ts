import { System } from "@koinos/sdk-as";

/**
 * Unsigned 256-bit integer.
 *
 * Solidity's uint256 (and the narrower uint160/uint128 used by Uniswap v3) have no native
 * equivalent in AssemblyScript, so every big number of the protocol (prices, liquidity,
 * fee growth accumulators...) is represented with this class.
 *
 * - The value is stored as 4 little-endian 64-bit limbs (`w0` is the least significant).
 * - Safe by default: `add`, `sub`, `mul` and `shl` revert if the result doesn't fit in 256 bits
 *   (like Solidity >= 0.8), so an unexpected overflow can never produce a silently wrong value.
 * - `wrappingAdd`, `wrappingSub` and `wrappingMul` compute modulo 2^256. They are only used
 *   where Uniswap relies on modular arithmetic on purpose (fee growth accumulators, uint160
 *   seconds per liquidity accumulators, two's complement in TickMath). See docs/OVERFLOW.md.
 * - Multiplication and division work with 32-bit digits so all intermediate products fit in
 *   native 64-bit WebAssembly integers. Division is Knuth's algorithm D, which also gives us a
 *   full precision 512-bit `mulDiv` (FullMath).
 * - Values are immutable: a function can return one of its arguments or a shared constant
 *   (`Q96`, `MIN_SQRT_RATIO`...), so the limbs of an existing value must never be written.
 */
export class U256 {
  constructor(
    public w0: u64 = 0,
    public w1: u64 = 0,
    public w2: u64 = 0,
    public w3: u64 = 0
  ) {}

  // ---------------------------------------------------------------------------
  // constructors
  // ---------------------------------------------------------------------------

  @inline
  static zero(): U256 {
    return new U256();
  }

  @inline
  static one(): U256 {
    return new U256(1);
  }

  @inline
  static fromU64(value: u64): U256 {
    return new U256(value);
  }

  @inline
  static fromU32(value: u32): U256 {
    return new U256(<u64>value);
  }

  static max(): U256 {
    return new U256(u64.MAX_VALUE, u64.MAX_VALUE, u64.MAX_VALUE, u64.MAX_VALUE);
  }

  /** 2^n - 1 (n in [0, 256]) */
  static maxBits(n: i32): U256 {
    if (n <= 0) return new U256();
    if (n >= 256) return U256.max();
    return U256.sub(U256.pow2(n), U256.one());
  }

  /** 2^n (n in [0, 255]) */
  static pow2(n: i32): U256 {
    const r = new U256();
    if (n < 0 || n > 255) return r;
    const limb = n >> 6;
    const bit: u64 = (<u64>1) << <u64>(n & 63);
    if (limb == 0) r.w0 = bit;
    else if (limb == 1) r.w1 = bit;
    else if (limb == 2) r.w2 = bit;
    else r.w3 = bit;
    return r;
  }

  clone(): U256 {
    return new U256(this.w0, this.w1, this.w2, this.w3);
  }

  // ---------------------------------------------------------------------------
  // inspection
  // ---------------------------------------------------------------------------

  @inline
  isZero(): bool {
    return (this.w0 | this.w1 | this.w2 | this.w3) == 0;
  }

  /** number of significant bits (0 for zero) */
  bitLength(): i32 {
    if (this.w3 != 0) return 256 - <i32>clz(this.w3);
    if (this.w2 != 0) return 192 - <i32>clz(this.w2);
    if (this.w1 != 0) return 128 - <i32>clz(this.w1);
    if (this.w0 != 0) return 64 - <i32>clz(this.w0);
    return 0;
  }

  /** true if the value is lower than 2^bits */
  @inline
  fitsBits(bits: i32): bool {
    return this.bitLength() <= bits;
  }

  /** index of the most significant bit (BitMath.mostSignificantBit), value must be > 0 */
  mostSignificantBit(): i32 {
    System.require(!this.isZero(), "KOINDX: MSB_ZERO");
    return this.bitLength() - 1;
  }

  /** index of the least significant bit (BitMath.leastSignificantBit), value must be > 0 */
  leastSignificantBit(): i32 {
    System.require(!this.isZero(), "KOINDX: LSB_ZERO");
    if (this.w0 != 0) return <i32>ctz(this.w0);
    if (this.w1 != 0) return 64 + <i32>ctz(this.w1);
    if (this.w2 != 0) return 128 + <i32>ctz(this.w2);
    return 192 + <i32>ctz(this.w3);
  }

  /** value of the bit at `index` */
  testBit(index: i32): bool {
    if (index < 0 || index > 255) return false;
    const limb = index >> 6;
    const shift = <u64>(index & 63);
    let w: u64;
    if (limb == 0) w = this.w0;
    else if (limb == 1) w = this.w1;
    else if (limb == 2) w = this.w2;
    else w = this.w3;
    return ((w >> shift) & 1) == 1;
  }

  /** returns the value as u64, reverts if it doesn't fit */
  toU64(): u64 {
    System.require((this.w1 | this.w2 | this.w3) == 0, "KOINDX: U256_TO_U64_OVERFLOW");
    return this.w0;
  }

  /** returns the low 64 bits without checks */
  @inline
  lowU64(): u64 {
    return this.w0;
  }

  // ---------------------------------------------------------------------------
  // comparison
  // ---------------------------------------------------------------------------

  static cmp(a: U256, b: U256): i32 {
    if (a.w3 != b.w3) return a.w3 > b.w3 ? 1 : -1;
    if (a.w2 != b.w2) return a.w2 > b.w2 ? 1 : -1;
    if (a.w1 != b.w1) return a.w1 > b.w1 ? 1 : -1;
    if (a.w0 != b.w0) return a.w0 > b.w0 ? 1 : -1;
    return 0;
  }

  @inline
  static eq(a: U256, b: U256): bool {
    return a.w0 == b.w0 && a.w1 == b.w1 && a.w2 == b.w2 && a.w3 == b.w3;
  }

  @inline
  static neq(a: U256, b: U256): bool {
    return !U256.eq(a, b);
  }

  @inline
  static lt(a: U256, b: U256): bool {
    return U256.cmp(a, b) < 0;
  }

  @inline
  static lte(a: U256, b: U256): bool {
    return U256.cmp(a, b) <= 0;
  }

  @inline
  static gt(a: U256, b: U256): bool {
    return U256.cmp(a, b) > 0;
  }

  @inline
  static gte(a: U256, b: U256): bool {
    return U256.cmp(a, b) >= 0;
  }

  static min(a: U256, b: U256): U256 {
    return U256.lt(a, b) ? a : b;
  }

  // ---------------------------------------------------------------------------
  // bitwise
  // ---------------------------------------------------------------------------

  static and(a: U256, b: U256): U256 {
    return new U256(a.w0 & b.w0, a.w1 & b.w1, a.w2 & b.w2, a.w3 & b.w3);
  }

  static or(a: U256, b: U256): U256 {
    return new U256(a.w0 | b.w0, a.w1 | b.w1, a.w2 | b.w2, a.w3 | b.w3);
  }

  static xor(a: U256, b: U256): U256 {
    return new U256(a.w0 ^ b.w0, a.w1 ^ b.w1, a.w2 ^ b.w2, a.w3 ^ b.w3);
  }

  static not(a: U256): U256 {
    return new U256(~a.w0, ~a.w1, ~a.w2, ~a.w3);
  }

  /** a << n, reverts if a non-zero bit is shifted out or n < 0 */
  static shl(a: U256, n: i32): U256 {
    if (n > 0 && !a.isZero()) {
      System.require(n <= 256 - a.bitLength(), "KOINDX: U256_SHL_OVERFLOW");
    }
    return U256.wrappingShl(a, n);
  }

  /** a << n mod 2^256 (bits shifted beyond 256 are discarded), reverts if n < 0 */
  static wrappingShl(a: U256, n: i32): U256 {
    System.require(n >= 0, "KOINDX: NEGATIVE_SHIFT");
    if (n == 0) return a.clone();
    if (n >= 256) return new U256();
    const limbs = n >> 6;
    const bits = <u64>(n & 63);
    let x0 = a.w0, x1 = a.w1, x2 = a.w2, x3 = a.w3;
    // shift whole limbs
    for (let i = 0; i < limbs; i++) {
      x3 = x2; x2 = x1; x1 = x0; x0 = 0;
    }
    if (bits == 0) return new U256(x0, x1, x2, x3);
    const inv = 64 - bits;
    return new U256(
      x0 << bits,
      (x1 << bits) | (x0 >> inv),
      (x2 << bits) | (x1 >> inv),
      (x3 << bits) | (x2 >> inv)
    );
  }

  /** a >> n (logical shift), reverts if n < 0 */
  static shr(a: U256, n: i32): U256 {
    System.require(n >= 0, "KOINDX: NEGATIVE_SHIFT");
    if (n == 0) return a.clone();
    if (n >= 256) return new U256();
    const limbs = n >> 6;
    const bits = <u64>(n & 63);
    let x0 = a.w0, x1 = a.w1, x2 = a.w2, x3 = a.w3;
    for (let i = 0; i < limbs; i++) {
      x0 = x1; x1 = x2; x2 = x3; x3 = 0;
    }
    if (bits == 0) return new U256(x0, x1, x2, x3);
    const inv = 64 - bits;
    return new U256(
      (x0 >> bits) | (x1 << inv),
      (x1 >> bits) | (x2 << inv),
      (x2 >> bits) | (x3 << inv),
      x3 >> bits
    );
  }

  /**
   * arithmetic shift right: interprets `a` as a two's complement int256 and shifts
   * preserving the sign (Solidity `>>` on int256)
   */
  static sar(a: U256, n: i32): U256 {
    System.require(n >= 0, "KOINDX: NEGATIVE_SHIFT");
    const negative = (a.w3 >> 63) == 1;
    if (!negative) return U256.shr(a, n);
    if (n >= 256) return U256.max();
    // -(((-a) - 1) >> n) - 1 == ~((~a) >> n)
    return U256.not(U256.shr(U256.not(a), n));
  }

  /** keeps only the `bits` least significant bits (a mod 2^bits) */
  static truncate(a: U256, bits: i32): U256 {
    if (bits >= 256) return a.clone();
    return U256.and(a, U256.maxBits(bits));
  }

  // ---------------------------------------------------------------------------
  // arithmetic
  // ---------------------------------------------------------------------------

  /** a + b mod 2^256 */
  static wrappingAdd(a: U256, b: U256): U256 {
    const r0 = a.w0 + b.w0;
    let c: u64 = r0 < a.w0 ? 1 : 0;
    const t1 = a.w1 + b.w1;
    let c1: u64 = t1 < a.w1 ? 1 : 0;
    const r1 = t1 + c;
    c1 += r1 < t1 ? 1 : 0;
    const t2 = a.w2 + b.w2;
    let c2: u64 = t2 < a.w2 ? 1 : 0;
    const r2 = t2 + c1;
    c2 += r2 < t2 ? 1 : 0;
    const r3 = a.w3 + b.w3 + c2;
    return new U256(r0, r1, r2, r3);
  }

  /** a - b mod 2^256 */
  static wrappingSub(a: U256, b: U256): U256 {
    const r0 = a.w0 - b.w0;
    let br: u64 = a.w0 < b.w0 ? 1 : 0;
    const t1 = a.w1 - b.w1;
    let br1: u64 = a.w1 < b.w1 ? 1 : 0;
    const r1 = t1 - br;
    br1 += t1 < br ? 1 : 0;
    const t2 = a.w2 - b.w2;
    let br2: u64 = a.w2 < b.w2 ? 1 : 0;
    const r2 = t2 - br1;
    br2 += t2 < br1 ? 1 : 0;
    const r3 = a.w3 - b.w3 - br2;
    return new U256(r0, r1, r2, r3);
  }

  /** a + b, reverts on overflow */
  static add(a: U256, b: U256): U256 {
    const r = U256.wrappingAdd(a, b);
    System.require(U256.gte(r, a), "KOINDX: U256_ADD_OVERFLOW");
    return r;
  }

  /** a - b, reverts on underflow */
  static sub(a: U256, b: U256): U256 {
    System.require(U256.gte(a, b), "KOINDX: U256_SUB_UNDERFLOW");
    return U256.wrappingSub(a, b);
  }

  /** a * b mod 2^256 */
  static wrappingMul(a: U256, b: U256): U256 {
    loadDigits(a, DA, 0);
    loadDigits(b, DB, 0);
    mulDigits(DA, DB, PROD);
    return digitsToU256(PROD, 0);
  }

  /** a * b, reverts on overflow */
  static mul(a: U256, b: U256): U256 {
    loadDigits(a, DA, 0);
    loadDigits(b, DB, 0);
    mulDigits(DA, DB, PROD);
    for (let i = 8; i < 16; i++) {
      System.require(unchecked(PROD[i]) == 0, "KOINDX: U256_MUL_OVERFLOW");
    }
    return digitsToU256(PROD, 0);
  }

  /** a * b, or null if the product overflows 256 bits */
  static tryMul(a: U256, b: U256): U256 | null {
    loadDigits(a, DA, 0);
    loadDigits(b, DB, 0);
    mulDigits(DA, DB, PROD);
    for (let i = 8; i < 16; i++) {
      if (unchecked(PROD[i]) != 0) return null;
    }
    return digitsToU256(PROD, 0);
  }

  /** a * small + addend, reverts on overflow */
  static mulSmallAdd(a: U256, small: u32, addend: u32): U256 {
    loadDigits(a, DA, 0);
    let carry: u64 = <u64>addend;
    for (let i = 0; i < 8; i++) {
      const t = <u64>unchecked(DA[i]) * <u64>small + carry;
      unchecked(DA[i] = <u32>t);
      carry = t >> 32;
    }
    System.require(carry == 0, "KOINDX: U256_MUL_OVERFLOW");
    return digitsToU256(DA, 0);
  }

  /** floor(a / b), reverts if b == 0 */
  static div(a: U256, b: U256): U256 {
    System.require(!b.isZero(), "KOINDX: DIVISION_BY_ZERO");
    loadDigits(a, PROD, 0);
    for (let i = 8; i < 16; i++) unchecked(PROD[i] = 0);
    divideProduct(b);
    return digitsToU256(QUO, 0);
  }

  /** a mod b, reverts if b == 0 */
  static mod(a: U256, b: U256): U256 {
    System.require(!b.isZero(), "KOINDX: DIVISION_BY_ZERO");
    loadDigits(a, PROD, 0);
    for (let i = 8; i < 16; i++) unchecked(PROD[i] = 0);
    divideProduct(b);
    return digitsToU256(REM, 0);
  }

  /** UnsafeMath.divRoundingUp: ceil(a / b), reverts if b == 0 */
  static divRoundingUp(a: U256, b: U256): U256 {
    System.require(!b.isZero(), "KOINDX: DIVISION_BY_ZERO");
    loadDigits(a, PROD, 0);
    for (let i = 8; i < 16; i++) unchecked(PROD[i] = 0);
    divideProduct(b);
    const q = digitsToU256(QUO, 0);
    if (!remainderIsZero()) return U256.add(q, U256.one());
    return q;
  }

  /**
   * FullMath.mulDiv: floor(a * b / denominator) with full 512-bit precision.
   * Reverts if denominator == 0 or the result overflows 256 bits.
   */
  static mulDiv(a: U256, b: U256, denominator: U256): U256 {
    System.require(!denominator.isZero(), "KOINDX: DIVISION_BY_ZERO");
    loadDigits(a, DA, 0);
    loadDigits(b, DB, 0);
    mulDigits(DA, DB, PROD);
    divideProduct(denominator);
    for (let i = 8; i < 16; i++) {
      System.require(unchecked(QUO[i]) == 0, "KOINDX: MULDIV_OVERFLOW");
    }
    return digitsToU256(QUO, 0);
  }

  /** FullMath.mulDivRoundingUp: ceil(a * b / denominator) */
  static mulDivRoundingUp(a: U256, b: U256, denominator: U256): U256 {
    const result = U256.mulDiv(a, b, denominator);
    // the remainder of the last division is still in REM
    if (!remainderIsZero()) {
      System.require(U256.lt(result, U256.max()), "KOINDX: MULDIV_OVERFLOW");
      return U256.add(result, U256.one());
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // conversion
  // ---------------------------------------------------------------------------

  /** decimal representation */
  toString(): string {
    if (this.isZero()) return "0";
    loadDigits(this, DA, 0);
    let len = 8;
    while (len > 0 && unchecked(DA[len - 1]) == 0) len--;
    let out = "";
    while (len > 0) {
      // divide DA by 10^9 in place, keep the remainder
      let rem: u64 = 0;
      for (let i = len - 1; i >= 0; i--) {
        const cur = (rem << 32) | <u64>unchecked(DA[i]);
        unchecked(DA[i] = <u32>(cur / 1000000000));
        rem = cur % 1000000000;
      }
      while (len > 0 && unchecked(DA[len - 1]) == 0) len--;
      let chunk = rem.toString();
      if (len > 0) {
        // pad inner chunks to 9 digits
        while (chunk.length < 9) chunk = "0" + chunk;
      }
      out = chunk + out;
    }
    return out;
  }

  /** parses a decimal string, reverts if it is not a valid uint256 */
  static fromString(value: string): U256 {
    System.require(value.length > 0 && value.length <= 78, "KOINDX: INVALID_NUMBER");
    let r = new U256();
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      System.require(c >= 48 && c <= 57, "KOINDX: INVALID_NUMBER");
      r = U256.mulSmallAdd(r, 10, <u32>(c - 48));
    }
    return r;
  }

  /** big endian bytes without leading zeros (zero is encoded as an empty array) */
  toBytes(): Uint8Array {
    const len = (this.bitLength() + 7) >> 3;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const byteIndex = len - 1 - i; // position of the i-th least significant byte
      const limb = i >> 3;
      const shift = <u64>((i & 7) << 3);
      let w: u64;
      if (limb == 0) w = this.w0;
      else if (limb == 1) w = this.w1;
      else if (limb == 2) w = this.w2;
      else w = this.w3;
      out[byteIndex] = <u8>(w >> shift);
    }
    return out;
  }

  /** parses big endian bytes (up to 32) */
  static fromBytes(bytes: Uint8Array): U256 {
    System.require(bytes.length <= 32, "KOINDX: INVALID_U256_BYTES");
    const r = new U256();
    const len = bytes.length;
    for (let i = 0; i < len; i++) {
      const b = <u64>bytes[len - 1 - i];
      const limb = i >> 3;
      const shift = <u64>((i & 7) << 3);
      if (limb == 0) r.w0 |= b << shift;
      else if (limb == 1) r.w1 |= b << shift;
      else if (limb == 2) r.w2 |= b << shift;
      else r.w3 |= b << shift;
    }
    return r;
  }
}

// -----------------------------------------------------------------------------
// internal multi-precision helpers working with 32-bit digits (little endian)
// -----------------------------------------------------------------------------

// operands
const DA = new StaticArray<u32>(8);
const DB = new StaticArray<u32>(8);
// 512-bit product / dividend
const PROD = new StaticArray<u32>(16);
// quotient and remainder of the last division
const QUO = new StaticArray<u32>(16);
const REM = new StaticArray<u32>(8);
// normalized dividend (m + 1 digits) and divisor
const UN = new StaticArray<u32>(17);
const VN = new StaticArray<u32>(8);
const DV = new StaticArray<u32>(8);

@inline
function loadDigits(a: U256, out: StaticArray<u32>, offset: i32): void {
  unchecked(out[offset + 0] = <u32>a.w0);
  unchecked(out[offset + 1] = <u32>(a.w0 >> 32));
  unchecked(out[offset + 2] = <u32>a.w1);
  unchecked(out[offset + 3] = <u32>(a.w1 >> 32));
  unchecked(out[offset + 4] = <u32>a.w2);
  unchecked(out[offset + 5] = <u32>(a.w2 >> 32));
  unchecked(out[offset + 6] = <u32>a.w3);
  unchecked(out[offset + 7] = <u32>(a.w3 >> 32));
}

@inline
function digitsToU256(d: StaticArray<u32>, offset: i32): U256 {
  return new U256(
    <u64>unchecked(d[offset + 0]) | (<u64>unchecked(d[offset + 1]) << 32),
    <u64>unchecked(d[offset + 2]) | (<u64>unchecked(d[offset + 3]) << 32),
    <u64>unchecked(d[offset + 4]) | (<u64>unchecked(d[offset + 5]) << 32),
    <u64>unchecked(d[offset + 6]) | (<u64>unchecked(d[offset + 7]) << 32)
  );
}

/** schoolbook multiplication of two 8-digit numbers into a 16-digit product */
function mulDigits(a: StaticArray<u32>, b: StaticArray<u32>, out: StaticArray<u32>): void {
  for (let i = 0; i < 16; i++) unchecked(out[i] = 0);
  let nb = 8;
  while (nb > 0 && unchecked(b[nb - 1]) == 0) nb--;
  if (nb == 0) return;
  for (let i = 0; i < 8; i++) {
    const ai = <u64>unchecked(a[i]);
    if (ai == 0) continue;
    let carry: u64 = 0;
    for (let j = 0; j < nb; j++) {
      const t = ai * <u64>unchecked(b[j]) + <u64>unchecked(out[i + j]) + carry;
      unchecked(out[i + j] = <u32>t);
      carry = t >> 32;
    }
    unchecked(out[i + nb] = <u32>carry);
  }
}

function remainderIsZero(): bool {
  for (let i = 0; i < 8; i++) {
    if (unchecked(REM[i]) != 0) return false;
  }
  return true;
}

/**
 * Divides the 16-digit number in PROD by `divisor`, leaving the quotient in QUO (16 digits)
 * and the remainder in REM (8 digits). Knuth's algorithm D (Hacker's Delight `divmnu`).
 */
function divideProduct(divisor: U256): void {
  loadDigits(divisor, DV, 0);
  for (let i = 0; i < 16; i++) unchecked(QUO[i] = 0);
  for (let i = 0; i < 8; i++) unchecked(REM[i] = 0);

  let n = 8;
  while (n > 0 && unchecked(DV[n - 1]) == 0) n--;
  let m = 16;
  while (m > 0 && unchecked(PROD[m - 1]) == 0) m--;

  // dividend smaller than divisor: quotient 0, remainder = dividend
  if (m < n) {
    for (let i = 0; i < m; i++) unchecked(REM[i] = PROD[i]);
    return;
  }

  const B: u64 = 0x100000000;

  // single digit divisor
  if (n == 1) {
    const d = <u64>unchecked(DV[0]);
    let rem: u64 = 0;
    for (let i = m - 1; i >= 0; i--) {
      const cur = (rem << 32) | <u64>unchecked(PROD[i]);
      unchecked(QUO[i] = <u32>(cur / d));
      rem = cur % d;
    }
    unchecked(REM[0] = <u32>rem);
    return;
  }

  // normalize so that the top digit of the divisor has its high bit set
  const s = <u32>clz(unchecked(DV[n - 1]));
  if (s > 0) {
    for (let i = n - 1; i > 0; i--) {
      unchecked(VN[i] = (DV[i] << s) | (DV[i - 1] >> (32 - s)));
    }
    unchecked(VN[0] = DV[0] << s);
    unchecked(UN[m] = PROD[m - 1] >> (32 - s));
    for (let i = m - 1; i > 0; i--) {
      unchecked(UN[i] = (PROD[i] << s) | (PROD[i - 1] >> (32 - s)));
    }
    unchecked(UN[0] = PROD[0] << s);
  } else {
    for (let i = 0; i < n; i++) unchecked(VN[i] = DV[i]);
    for (let i = 0; i < m; i++) unchecked(UN[i] = PROD[i]);
    unchecked(UN[m] = 0);
  }

  const vTop = <u64>unchecked(VN[n - 1]);
  const vNext = <u64>unchecked(VN[n - 2]);

  for (let j = m - n; j >= 0; j--) {
    // estimate the quotient digit
    const num = (<u64>unchecked(UN[j + n]) << 32) | <u64>unchecked(UN[j + n - 1]);
    let qhat = num / vTop;
    let rhat = num - qhat * vTop;
    while (qhat >= B || qhat * vNext > ((rhat << 32) | <u64>unchecked(UN[j + n - 2]))) {
      qhat -= 1;
      rhat += vTop;
      if (rhat >= B) break;
    }

    // multiply and subtract
    let k: i64 = 0;
    let t: i64 = 0;
    for (let i = 0; i < n; i++) {
      const p = qhat * <u64>unchecked(VN[i]);
      t = <i64>unchecked(UN[i + j]) - k - <i64>(p & 0xFFFFFFFF);
      unchecked(UN[i + j] = <u32>t);
      k = <i64>(p >> 32) - (t >> 32);
    }
    t = <i64>unchecked(UN[j + n]) - k;
    unchecked(UN[j + n] = <u32>t);

    if (t < 0) {
      // we subtracted too much, add back
      qhat -= 1;
      let c: u64 = 0;
      for (let i = 0; i < n; i++) {
        const sum = <u64>unchecked(UN[i + j]) + <u64>unchecked(VN[i]) + c;
        unchecked(UN[i + j] = <u32>sum);
        c = sum >> 32;
      }
      unchecked(UN[j + n] = <u32>(<u64>unchecked(UN[j + n]) + c));
    }
    unchecked(QUO[j] = <u32>qhat);
  }

  // denormalize the remainder
  if (s > 0) {
    for (let i = 0; i < n - 1; i++) {
      unchecked(REM[i] = (UN[i] >> s) | (UN[i + 1] << (32 - s)));
    }
    unchecked(REM[n - 1] = UN[n - 1] >> s);
  } else {
    for (let i = 0; i < n; i++) unchecked(REM[i] = UN[i]);
  }
}
