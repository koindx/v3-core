// Test vectors of btc-vision/as-bignum (audited 256-bit integer library for AssemblyScript,
// https://github.com/btc-vision/as-bignum, v1.0.0) ported to the KoinDX U256:
//   u256.spec.ts, u256_2.spec.ts, u256_complement.spec.ts, audit.spec.ts, global.spec.ts and
//   the u128.spec.ts vectors that are also valid 256-bit operations.
//
// Semantic differences (by design, the KoinDX U256 is safe by default like Solidity >= 0.8):
// - as-bignum wraps on overflow: here `add`, `sub`, `mul` and `shl` must revert and the
//   `wrapping*` variants must return the as-bignum result
// - negative shift amounts return zero in as-bignum, they revert here
// - `fromString` only parses decimal numbers (no hex, sign or empty string) and reverts on
//   invalid characters or values above 2^256 - 1 instead of ignoring them or truncating
// - bytes are big endian without leading zeros (Koinos storage format), up to 32 bytes
// - toU64 reverts instead of truncating, leastSignificantBit/mostSignificantBit revert on zero
//   (Uniswap BitMath)
// Not applicable (not implemented because not used by Uniswap v3): float conversions,
// signed constructors, hex strings, popcnt, rotations, pow, sqrt, i128.
//
// Every expected value is also checked against BigInt, so a wrong vector can't hide a bug.
const { call, callString, Revert } = require("./harness");

const M64 = (1n << 64n) - 1n;
const MAX = (1n << 256n) - 1n;
const MAX128 = (1n << 128n) - 1n;
const MOD = 1n << 256n;

/** as-bignum u256 constructor: new u256(lo1, lo2, hi1, hi2), limbs as u64 */
const W = (lo1, lo2 = 0n, hi1 = 0n, hi2 = 0n) =>
  BigInt.asUintN(64, BigInt(lo1)) |
  (BigInt.asUintN(64, BigInt(lo2)) << 64n) |
  (BigInt.asUintN(64, BigInt(hi1)) << 128n) |
  (BigInt.asUintN(64, BigInt(hi2)) << 192n);
/** as-bignum u128 constructor: new u128(lo, hi) */
const W128 = (lo, hi = 0n) => W(lo, hi);
const not64 = (x) => BigInt.asUintN(64, ~BigInt(x));
const wrap = (x) => ((x % MOD) + MOD) % MOD;

const big = (name, ...args) => BigInt(callString(name, ...args));
const reverts = (name, ...args) => expect(() => call(name, ...args)).toThrow(Revert);

/** checked add must equal the exact sum or revert, wrappingAdd must equal the as-bignum result */
function add(a, b, expected) {
  expect(wrap(a + b)).toBe(expected);
  expect(big("u256WrappingAdd", a, b)).toBe(expected);
  expect(big("u256WrappingAdd", b, a)).toBe(expected);
  if (a + b > MAX) reverts("u256Add", a, b);
  else expect(big("u256Add", a, b)).toBe(expected);
}

function sub(a, b, expected) {
  expect(wrap(a - b)).toBe(expected);
  expect(big("u256WrappingSub", a, b)).toBe(expected);
  if (a < b) reverts("u256Sub", a, b);
  else expect(big("u256Sub", a, b)).toBe(expected);
}

function mul(a, b, expected) {
  expect(wrap(a * b)).toBe(expected);
  expect(big("u256WrappingMul", a, b)).toBe(expected);
  expect(big("u256WrappingMul", b, a)).toBe(expected);
  if (a * b > MAX) {
    reverts("u256Mul", a, b);
    reverts("u256Mul", b, a);
  } else {
    expect(big("u256Mul", a, b)).toBe(expected);
    expect(big("u256Mul", b, a)).toBe(expected);
  }
}

function shl(a, n, expected) {
  expect(wrap(a << BigInt(n))).toBe(expected);
  expect(big("u256WrappingShl", a, n)).toBe(expected);
  if ((a << BigInt(n)) > MAX) reverts("u256Shl", a, n);
  else expect(big("u256Shl", a, n)).toBe(expected);
}

function shr(a, n, expected) {
  expect(a >> BigInt(n)).toBe(expected);
  expect(big("u256Shr", a, n)).toBe(expected);
}

function div(a, b, expected) {
  expect(a / b).toBe(expected);
  expect(big("u256Div", a, b)).toBe(expected);
}

function mod(a, b, expected) {
  expect(a % b).toBe(expected);
  expect(big("u256Mod", a, b)).toBe(expected);
}

function mulDiv(a, b, c, expected) {
  expect((a * b) / c).toBe(expected);
  expect(big("u256MulDiv", a, b, c)).toBe(expected);
}

const neg = (a) => big("u256WrappingSub", 0n, a); // as-bignum unary minus (two's complement)
const clz = (a) => 256 - call("u256BitLength", a);
const ctz = (a) => (a === 0n ? 256 : call("u256Lsb", a));
const hex = (bytes) => Buffer.from(bytes).toString("hex");
/** big endian bytes without leading zeros (KoinDX U256.toBytes) */
const minimalHex = (value) => (value === 0n ? "" : (value.toString(16).length % 2 ? "0" : "") + value.toString(16));

describe("as-bignum u256.spec.ts", () => {
  test("String Conversion", () => {
    expect(callString("u256Parse", W(10248516654965971928n, 5n))).toBe("102482237023513730008");
    expect(callString("u256Parse", W(1n, 1n, 1n, 1n))).toBe("6277101735386680764176071790128604879584176795969512275969");
    expect(callString("u256Parse", MAX)).toBe("115792089237316195423570985008687907853269984665640564039457584007913129639935");
    expect(callString("u256Parse", 0n)).toBe("0");
  });

  test("Buffer Conversion (big endian; little endian = reversed bytes)", () => {
    const arr = [
      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x12,
      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x12,
    ];
    const le = W(0x8877665544332211n, 0x12ffeeddccbbaa99n, 0x8877665544332211n, 0x12ffeeddccbbaa99n);
    const be = W(0x99aabbccddeeff12n, 0x1122334455667788n, 0x99aabbccddeeff12n, 0x1122334455667788n);
    // fromBytes Big Endian 1/2 and toBytes Big Endian 1/2
    expect(big("u256FromBytesHex", hex(arr))).toBe(be);
    expect(callString("u256ToBytesHex", be)).toBe(hex(arr));
    // fromBytes / toBytes Little Endian 1/2: same bytes in the opposite order
    const reversed = [...arr].reverse();
    expect(big("u256FromBytesHex", hex(reversed))).toBe(le);
    expect(callString("u256ToBytesHex", le)).toBe(hex(reversed));
  });

  test("Basic Operations: zero, not, negation, or, xor, and", () => {
    expect(call("u256IsZero", 0n)).toBeTruthy();
    expect(call("u256IsZero", 1n)).toBeFalsy();
    expect(big("u256Not", W(1n, 2n, 3n, 4n))).toBe(W(not64(1n), not64(2n), not64(3n), not64(4n)));
    expect(neg(0n)).toBe(0n);
    expect(neg(1n)).toBe(MAX);
    expect(neg(MAX)).toBe(1n);
    expect(neg(W(M64, 0n, M64, 0n))).toBe(W(1n, M64, 0n, M64));
    const a = W(1n, 3n, 0n, 4n);
    const b = W(2n, 4n, 3n, 3n);
    expect(big("u256Or", a, b)).toBe(W(1n | 2n, 3n | 4n, 0n | 3n, 4n | 3n));
    expect(big("u256Or", b, a)).toBe(W(1n | 2n, 3n | 4n, 0n | 3n, 4n | 3n));
    expect(big("u256Xor", a, b)).toBe(W(1n ^ 2n, 3n ^ 4n, 0n ^ 3n, 4n ^ 3n));
    expect(big("u256Xor", b, a)).toBe(W(1n ^ 2n, 3n ^ 4n, 0n ^ 3n, 4n ^ 3n));
    expect(big("u256And", a, b)).toBe(W(1n & 2n, 3n & 4n, 0n & 3n, 4n & 3n));
    expect(big("u256And", b, a)).toBe(W(1n & 2n, 3n & 4n, 0n & 3n, 4n & 3n));
  });

  test("Basic Operations: add", () => {
    add(1n, W(M64), W(0n, 1n));
    add(1n, W(M64, M64), W(0n, 0n, 1n));
    add(1n, W(M64, M64, M64), W(0n, 0n, 0n, 1n));
    add(W(1n, 1n, 1n, 1n), W(M64 - 1n, M64 - 1n, M64 - 1n, M64 - 1n), MAX);
  });

  test("Basic Operations: sub", () => {
    sub(1n, 1n, 0n);
    sub(W(2n, 2n, 2n, 2n), W(1n, 1n, 1n, 1n), W(1n, 1n, 1n, 1n));
    sub(MAX, W(1n, 2n, 3n, 4n), W(M64 - 1n, M64 - 2n, M64 - 3n, M64 - 4n));
    sub(0n, W(1n, 1n, 1n, 1n), W(M64, M64 - 1n, M64 - 1n, M64 - 1n));
    sub(0n, MAX, 1n);
    sub(MAX, 1n, W(M64 - 1n, M64, M64, M64));
    sub(W(1n, 2n, 3n, 4n), W(M64 - 1n, M64 - 2n, M64 - 3n, M64 - 4n), W(3n, 4n, 6n, 8n));
  });

  test("Basic Operations: multiply", () => {
    mul(3n, 3n, 9n);
    mul(43545453452n, 2353454354n, W(10248516654965971928n, 5n));
    mul(11n, W(0n, 2n), W(0n, 22n));
    mul(W(0n, 3n), W(0n, 0n, 3n), W(0n, 0n, 0n, 9n));
    mul(W128(14083847773837265618n, 6692605942n), W128(18444665141527514289n, 5354084802n),
      W(5659639222556316466n, 4474720309748468391n, 17386035696907167262n, 1n));
    mul(MAX, 1n, MAX);
    mul(W(5656466n, 447478468391n, 17386907167262n, 1n), 0n, 0n);
    // with overflow
    mul(W(0n, 0n, 1n), W(0n, 0n, 1n), 0n);
    mul(W(1n, 0n, 1n), W(1n, 0n, 1n), W(1n, 0n, 2n));
    mul(W(6n, 0n, 0n, 420n), W(0n, 7n, 0n, 0n), W(0n, 42n, 0n, 0n));
    mul(W(2n, 666n, 666n, 666n), W(0n, 0n, 0n, 3n), W(0n, 0n, 0n, 6n));
  });

  test("Right Shift Operations", () => {
    for (const [value, n, expected] of [
      [0n, 1, 0n], [0n, 64, 0n], [1n, 1, 0n], [1n, 64, 0n], [10n, 1, 5n], [10n, 64, 0n],
      [100n, 1, 50n], [100n, 64, 0n], [1000n, 1, 500n], [1000n, 64, 0n],
      [1234567890n, 1, 617283945n], [1234567890n, 64, 0n], [4294967296n, 1, 2147483648n], [4294967296n, 64, 0n],
      [9223372036854775808n, 1, 4611686018427387904n], [9223372036854775808n, 64, 0n],
      [18446744073709551616n, 1, 9223372036854775808n], [18446744073709551616n, 64, 1n],
      [36893488147419103232n, 1, 18446744073709551616n], [36893488147419103232n, 64, 2n],
      [1267650600228229401496703205376n, 64, 68719476736n],
    ]) {
      shr(value, n, expected);
    }
  });

  test("fromString", () => {
    expect(big("u256Parse", "123")).toBe(123n);
    expect(big("u256Parse", "18446744073709551615")).toBe(M64);
    expect(big("u256Parse", "0")).toBe(0n);
    expect(big("u256Parse", "0000")).toBe(0n);
    expect(big("u256Parse", "340282366920938463463374607431768211455")).toBe(MAX128);
    // invalid decimal digits: as-bignum throws, so do we
    reverts("u256Parse", "12a");
    reverts("u256Parse", "12x");
    // hex strings are not supported (the KoinDX API only uses decimal strings)
    reverts("u256Parse", "FF");
    reverts("u256Parse", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  });

  test("Comparison Tests", () => {
    expect(call("u256Eq", 100n, 100n)).toBeTruthy();
    expect(call("u256Eq", 100n, 101n)).toBeFalsy();
    expect(call("u256Gt", 1000n, 999n)).toBeTruthy();
    expect(call("u256Lt", 1000n, 999n)).toBeFalsy();
    expect(call("u256Lt", 1000n, 1000n)).toBeFalsy();
    expect(call("u256Gt", 1000n, 1000n)).toBeFalsy();
    expect(call("u256Lt", 999n, 1000n)).toBeTruthy();
    expect(call("u256Lte", 500n, 500n)).toBeTruthy();
    expect(call("u256Gte", 500n, 500n)).toBeTruthy();
    expect(call("u256Lte", 500n, 501n)).toBeTruthy();
    expect(call("u256Gte", 500n, 501n)).toBeFalsy();
    expect(call("u256Lte", 501n, 500n)).toBeFalsy();
    expect(call("u256Gte", 501n, 500n)).toBeTruthy();
  });

  test("Bit Counting Functions (clz = 256 - bitLength, ctz = leastSignificantBit)", () => {
    expect(clz(1n)).toBe(255);
    expect(clz(MAX)).toBe(0);
    expect(clz(18446744073709551616n)).toBe(191);
    expect(ctz(16n)).toBe(4);
    expect(ctz(MAX)).toBe(0);
    expect(ctz(36893488147419103232n)).toBe(65);
  });

  test("Conversion to Smaller Types (toU64 reverts instead of truncating)", () => {
    reverts("u256ToU64", 18446744073709551616n);
    expect(big("u256ToU64", M64)).toBe(M64);
    expect(big("u256Truncate", 18446744073709551616n, 64)).toBe(0n); // as-bignum toU64
    expect(big("u256Truncate", 0xffffffffffffn, 32)).toBe(0xffffffffn); // as-bignum toU32
  });

  test("Increment and Decrement", () => {
    add(99n, 1n, 100n);
    sub(100n, 1n, 99n);
    add(200n, 1n, 201n);
    sub(300n, 1n, 299n);
    add(MAX, 1n, 0n); // overflow on incrementing max: checked add reverts
    sub(0n, 1n, MAX); // underflow on decrementing zero: checked sub reverts
  });

  test("Additional Shifts", () => {
    shr(100000000000000000000n, 127, 0n);
    shr(MAX, 255, 1n);
  });

  test("Potential Exploits and Vulnerabilities", () => {
    reverts("u256Parse", "12x");
    reverts("u256Parse", "g1");
    // as-bignum truncates huge numbers mod 2^256, the KoinDX U256 rejects them
    reverts("u256Parse", "9".repeat(500));
    reverts("u256Parse", "1" + "0".repeat(10000));
    reverts("u256Parse", "f".repeat(512));
    // the largest 78 digit number that fits and the first ones that don't
    expect(big("u256Parse", MAX.toString())).toBe(MAX);
    reverts("u256Parse", (MAX + 1n).toString());
    reverts("u256Parse", "9".repeat(78));
    expect(big("u256Parse", "0".repeat(77) + "1")).toBe(1n);
    add(MAX, 1n, 0n);
    sub(0n, 1n, MAX);
  });

  test("Division (div) Tests", () => {
    div(123456789n, 1n, 123456789n);
    div(0n, 10n, 0n);
    div(10n, 1000n, 0n);
    div(999999n, 999999n, 1n);
    div(MAX, 2n, MAX >> 1n);
    div(MAX, 100000000000000000000n, MAX / 100000000000000000000n);
    reverts("u256Div", 10n, 0n);
    div(5000n, 50n, 100n);
    div(1000000n, 1000n, 1000n);
  });

  test("Shift Left (shl) Tests", () => {
    shl(123456n, 0, 123456n);
    shl(50n, 1, 100n);
    shl(1n, 63, 9223372036854775808n);
    shl(0x12345678n, 64, W(0n, 0x12345678n));
    shl(100000000000000000000n, 200, wrap(100000000000000000000n << 200n));
    shl(MAX, 1, wrap(MAX << 1n)); // discards the top bit: checked shl reverts
  });

  test("Shift Left (shl) Tests for all shifts 0 to 255", () => {
    const pattern = W(0x0000ffff0000ffffn, 0x0000ffff0000ffffn);
    for (let i = 0; i <= 255; i++) shl(pattern, i, wrap(pattern << BigInt(i)));
  });
});

describe("as-bignum u256_2.spec.ts", () => {
  test("Constants", () => {
    expect(big("u256Parse", "0")).toBe(W(0n));
    expect(big("u256Not", 0n)).toBe(W(M64, M64, M64, M64));
  });

  test("Addition", () => {
    add(10n, 20n, 30n);
    add(W(M64), 1n, W(0n, 1n));
    add(W(0n, M64), W(0n, 1n), W(0n, 0n, 1n));
    add(W(0n, 0n, M64), W(0n, 0n, 1n), W(0n, 0n, 0n, 1n));
    add(MAX, 1n, 0n);
  });

  test("Subtraction", () => {
    sub(30n, 10n, 20n);
    sub(W(0n, 1n), 1n, W(M64));
    sub(0n, 1n, MAX);
  });

  test("Multiplication", () => {
    mul(10n, 10n, 100n);
    mul(W(0n, 1n), W(0n, 1n), W(0n, 0n, 1n));
    mul(MAX, 2n, W(M64 - 1n, M64, M64, M64));
  });

  test("Division", () => {
    reverts("u256Div", 10n, 0n);
    div(5n, 10n, 0n);
    div(123n, 123n, 1n);
    div(W(0n, 0n, 0n, 0x8000000000000000n), W(0n, 0n, 1n, 0n), W(0n, 0x8000000000000000n));
    div(MAX, MAX, 1n);
    div(MAX, 1n, MAX);
  });

  test("Bitwise ops", () => {
    expect(big("u256Or", 0xf0f0f0f0n, 0x0f0f0f0fn)).toBe(0xffffffffn);
    expect(big("u256And", 0xf0f0f0f0n, 0x0f0f0f0fn)).toBe(0n);
    expect(big("u256Xor", 0xf0f0f0f0n, 0x0f0f0f0fn)).toBe(0xffffffffn);
    expect(big("u256Not", 0n)).toBe(MAX);
  });

  test("Shifts", () => {
    shl(1n, 64, W(0n, 1n));
    shl(1n, 256, 0n);
    shl(1n, 33, 8589934592n);
    shl(1n, 0, 1n);
    shr(W(0n, 1n), 64, 1n);
    shr(W(0n, 1n), 65, 0n);
    shr(MAX, 0, MAX);
  });

  test("Comparison", () => {
    expect(call("u256Eq", 10n, 10n)).toBeTruthy();
    expect(call("u256Eq", 10n, 20n)).toBeFalsy();
    expect(call("u256Lt", 10n, 20n)).toBeTruthy();
    expect(call("u256Gt", 20n, 10n)).toBeTruthy();
    expect(call("u256Lte", 10n, 10n)).toBeTruthy();
    expect(call("u256Gte", 20n, 10n)).toBeTruthy();
    expect(call("u256Lt", 20n, 10n)).toBeFalsy();
    expect(call("u256IsZero", 0n)).toBeTruthy();
    expect(call("u256IsZero", 1n)).toBeFalsy();
  });

  test("Conversions", () => {
    expect(callString("u256Parse", 12345n)).toBe("12345");
    expect(big("u256Parse", "123456789")).toBe(123456789n);
    // fromBytes: 32 bytes big endian with the last byte set
    const bytes = new Array(32).fill(0);
    bytes[31] = 1;
    expect(big("u256FromBytesHex", hex(bytes))).toBe(1n);
    // little endian [1, 0, ..., 0] is 1: big endian [0, ..., 0, 1]
    // invalid length: more than 32 bytes reverts (shorter encodings are valid, leading zeros are omitted)
    reverts("u256FromBytesHex", "00".repeat(33));
    expect(big("u256FromBytesHex", "00".repeat(31))).toBe(0n);
  });

  test("Helpers", () => {
    expect(clz(1n)).toBe(255);
    expect(clz(0n)).toBe(256);
    expect(ctz(W(0n, 1n))).toBe(64);
    reverts("u256Lsb", 0n); // Uniswap BitMath.leastSignificantBit requires x > 0
    expect(neg(1n)).toBe(MAX);
    add(1n, 1n, 2n);
    sub(2n, 1n, 1n);
  });

  test("Edge Cases", () => {
    shr(MAX, 256, 0n);
    shr(MAX, 500, 0n);
    shl(MAX, 256, 0n);
    reverts("u256Div", 1n, 0n);
    sub(W(0n, 0n, 1n), 1n, W(M64, M64));
  });
});

describe("as-bignum u256_complement.spec.ts", () => {
  test("String Conversions", () => {
    expect(callString("u256Parse", 0n)).toBe("0");
    expect(callString("u256Parse", 12345n)).toBe("12345");
    expect(callString("u256Parse", "1000000000000000000")).toBe("1000000000000000000");
    expect(callString("u256Parse", "999999")).toBe("999999");
    // as-bignum parses "" as zero, the KoinDX U256 rejects it
    reverts("u256Parse", "");
    for (const v of [12345n, MAX, W(0n, 0n, 0n, 0x123n), W(0x1234567890abcdefn)]) {
      expect(big("u256Parse", v.toString())).toBe(v);
    }
  });

  test("Addition", () => {
    add(100n, 200n, 300n);
    add(W(M64), 1n, W(0n, 1n));
    add(W(0n, M64), W(0n, 1n), W(0n, 0n, 1n));
    add(W(0n, 0n, M64), W(0n, 0n, 1n), W(0n, 0n, 0n, 1n));
    add(MAX, 1n, 0n);
    add(W(M64, M64, M64, 0n), 1n, W(0n, 0n, 0n, 1n));
  });

  test("Subtraction", () => {
    sub(200n, 100n, 100n);
    sub(W(0n, 1n), 1n, W(M64));
    sub(W(0n, 0n, 1n), W(0n, 1n), W(0n, M64));
    sub(W(0n, 0n, 0n, 1n), W(0n, 0n, 1n), W(0n, 0n, M64));
    sub(0n, 1n, MAX);
  });

  test("Multiplication", () => {
    mul(10n, 20n, 200n);
    mul(12345n, 0n, 0n);
    mul(12345n, 1n, 12345n);
    mul(123n, 456n, 56088n);
    mul(W(0n, 1n), W(0n, 1n), W(0n, 0n, 1n));
    mul(W(0n, 0n, 0n, M64), 10n, wrap(W(0n, 0n, 0n, M64) * 10n));
  });

  test("Division", () => {
    reverts("u256Div", 100n, 0n);
    div(200n, 10n, 20n);
    div(0n, 10n, 0n);
    div(10n, 100n, 0n);
    div(12345n, 12345n, 1n);
    div(12345n, 1n, 12345n);
    div(1000n, 10n, 100n);
  });

  test("Bitwise Operations", () => {
    expect(big("u256And", 0xffn, 0x0fn)).toBe(0x0fn);
    expect(big("u256Or", 0xf0n, 0x0fn)).toBe(0xffn);
    expect(big("u256Xor", 0xffn, 0x0fn)).toBe(0xf0n);
    expect(big("u256Not", 0n)).toBe(MAX);
    expect(big("u256And", W(0xffn, 0xff00n, 0xff0000n, 0xff000000n), W(0x0fn, 0x0f00n, 0x0f0000n, 0x0f000000n)))
      .toBe(W(0x0fn, 0x0f00n, 0x0f0000n, 0x0f000000n));
    expect(big("u256Or", W(0xf0n, 0xf000n, 0xf00000n, 0xf0000000n), W(0x0fn, 0x0f00n, 0x0f0000n, 0x0f000000n)))
      .toBe(W(0xffn, 0xff00n, 0xff0000n, 0xff000000n));
    expect(big("u256Xor", W(0xffn, 0xff00n, 0xff0000n, 0xff000000n), W(0xffn, 0xff00n, 0xff0000n, 0xff000000n))).toBe(0n);
  });

  test("Shift Operations", () => {
    shl(5n, 0, 5n);
    shl(5n, 1, 10n);
    shl(5n, 64, W(0n, 5n));
    shl(5n, 128, W(0n, 0n, 5n));
    shl(5n, 192, W(0n, 0n, 0n, 5n));
    shl(5n, 256, 0n);
    shl(1n, 10, 1024n);
    shl(1n, 70, W(0n, 64n));
    shl(1n, 134, W(0n, 0n, 64n));
    shl(1n, 198, W(0n, 0n, 0n, 64n));
    shr(5n, 0, 5n);
    shr(10n, 1, 5n);
    shr(W(0n, 5n), 64, 5n);
    shr(W(0n, 0n, 5n), 128, 5n);
    shr(W(0n, 0n, 0n, 5n), 192, 5n);
    shr(5n, 256, 0n);
    shr(1024n, 10, 1n);
    // negative shift amounts: as-bignum returns zero, the KoinDX U256 reverts
    reverts("u256Shl", 5n, -1);
    reverts("u256WrappingShl", 5n, -1);
    reverts("u256Shr", 5n, -1);
    reverts("u256Sar", 5n, -1);
  });

  test("Comparisons", () => {
    expect(call("u256Eq", 100n, 100n)).toBeTruthy();
    expect(call("u256Eq", 100n, 200n)).toBeFalsy();
    expect(call("u256Lt", 100n, 200n)).toBeTruthy();
    expect(call("u256Lt", W(0n, 100n), W(0n, 200n))).toBeTruthy();
    expect(call("u256Lt", W(0n, 0n, 100n), W(0n, 0n, 200n))).toBeTruthy();
    expect(call("u256Lt", W(0n, 0n, 0n, 100n), W(0n, 0n, 0n, 200n))).toBeTruthy();
    expect(call("u256Gt", 200n, 100n)).toBeTruthy();
    expect(call("u256Lte", 100n, 100n)).toBeTruthy();
    expect(call("u256Gte", 100n, 100n)).toBeTruthy();
    const a = W(100n, 200n, 300n, 400n);
    for (const b of [W(100n, 200n, 300n, 401n), W(100n, 200n, 301n, 400n), W(100n, 201n, 300n, 400n), W(101n, 200n, 300n, 400n)]) {
      expect(call("u256Lt", a, b)).toBeTruthy();
      expect(call("u256Cmp", a, b)).toBe(-1);
      expect(call("u256Cmp", b, a)).toBe(1);
    }
  });

  test("Increment and Decrement", () => {
    add(5n, 1n, 6n);
    sub(5n, 1n, 4n);
    add(W(M64, M64, M64, 0n), 1n, W(0n, 0n, 0n, 1n));
    sub(W(0n, 0n, 0n, 1n), 1n, W(M64, M64, M64, 0n));
    add(W(M64, 10n), 1n, W(0n, 11n));
    sub(W(0n, 10n), 1n, W(M64, 9n));
    add(W(M64, M64, 10n), 1n, W(0n, 0n, 11n));
    sub(W(0n, 0n, 10n), 1n, W(M64, M64, 9n));
    add(W(M64, M64, M64, 10n), 1n, W(0n, 0n, 0n, 11n));
    sub(W(0n, 0n, 0n, 10n), 1n, W(M64, M64, M64, 9n));
  });

  test("Negation", () => {
    expect(neg(0n)).toBe(0n);
    expect(neg(1n)).toBe(MAX);
    expect(neg(W(0n, 1n))).toBe(W(0n, M64, M64, M64));
    expect(neg(W(1n))).toBe(W(M64, M64, M64, M64));
    expect(neg(W(0n, 0n, 1n))).toBe(W(0n, 0n, M64, M64));
  });

  test("Bit Counting", () => {
    expect(clz(0n)).toBe(256);
    expect(clz(W(0n, 0n, 0n, 1n))).toBe(63);
    expect(clz(W(0n, 0n, 1n, 0n))).toBe(127);
    expect(clz(W(0n, 1n, 0n, 0n))).toBe(191);
    expect(clz(W(1n, 0n, 0n, 0n))).toBe(255);
    expect(ctz(W(1n, 0n, 0n, 0n))).toBe(0);
    expect(ctz(W(0n, 1n, 0n, 0n))).toBe(64);
    expect(ctz(W(0n, 0n, 1n, 0n))).toBe(128);
    expect(ctz(W(0n, 0n, 0n, 1n))).toBe(192);
    expect(call("u256Msb", W(0n, 0n, 0n, 1n))).toBe(192);
    reverts("u256Msb", 0n);
  });
});

describe("as-bignum audit.spec.ts (u256)", () => {
  test("Multi-limb carry when adding", () => {
    add(W(M64, M64, M64, 0xfffffffffffffffen), 1n, W(0n, 0n, 0n, M64));
  });

  test("Multi-limb borrow when subtracting", () => {
    sub(W(0n, 0n, 0n, 1n), W(1n, 0n, 0n, 0n), W(M64, M64, M64, 0n));
  });

  test("Division edge case with multi-limb borrows in the shift-sub steps", () => {
    const numerator = W(M64, 0n, M64, 0x7fffffffffffffffn);
    const denominator = W(M64, 0n, M64, 0x3fffffffffffffffn);
    div(numerator, denominator, 2n);
    mod(numerator, denominator, numerator - 2n * denominator);
  });
});

describe("as-bignum global.spec.ts (__mul256, 128-bit primitives)", () => {
  test("__mul256 limb combinations (wrapping multiplication)", () => {
    mul(W(2n), W(3n), 6n);
    mul(W(1n), W(0n, 1n), W(0n, 1n));
    mul(W(5n), W(7n), 35n);
    mul(W(0n, 2n), W(3n), W(0n, 6n));
    mul(W(2n), W(0n, 3n), W(0n, 6n));
    mul(W(0n, 2n), W(0n, 3n), W(0n, 0n, 6n));
    mul(W(0n, 0n, 2n), W(3n), W(0n, 0n, 6n));
    mul(W(2n), W(0n, 0n, 3n), W(0n, 0n, 6n));
    mul(W(0n, 0n, 2n), W(0n, 3n), W(0n, 0n, 0n, 6n));
    mul(W(0n, 2n), W(0n, 0n, 3n), W(0n, 0n, 0n, 6n));
    mul(W(7n), W(11n), 77n);
    mul(W(0n, 3n), W(0n, 5n), W(0n, 0n, 15n));
    // products of limbs beyond 256 bits are discarded
    mul(W(0n, 0n, 0n, 1n), W(0n, 0n, 0n, 1n), 0n);
    mul(W(0n, 0n, 5n), W(0n, 0n, 7n), 0n);
    mul(W(0n, 0n, 0n, 5n), W(0n, 7n), 0n);
    mul(W(0n, 5n), W(0n, 0n, 0n, 7n), 0n);
  });

  test("__multi3 (128-bit multiplication)", () => {
    mul(1n, 1n, 1n);
    mul(M64, 2n, W(M64 - 1n, 1n));
  });

  test("__clz128 / __ctz128", () => {
    expect(clz(0n) - 128).toBe(128);
    expect(clz(W(0n, 0x8000000000000000n)) - 128).toBe(0);
    expect(clz(W(1n, 0n)) - 128).toBe(127);
    expect(clz(W(0n, 1n)) - 128).toBe(63);
    expect(ctz(W(0n, 0x8000000000000000n))).toBe(127);
    expect(ctz(W(1n, 0n))).toBe(0);
    expect(ctz(W(0n, 1n))).toBe(64);
  });

  test("__udivmod128 / __udivmod128_10", () => {
    reverts("u256Div", 10n, 0n);
    reverts("u256Mod", 10n, 0n);
    const divmod = (a, b, q, r) => {
      div(a, b, q);
      mod(a, b, r);
    };
    divmod(0n, 10n, 0n, 0n);
    divmod(W128(123n, 456n), 1n, W128(123n, 456n), 0n);
    divmod(W128(10n, 20n), W128(10n, 20n), 1n, 0n);
    divmod(100n, 4n, 25n, 0n);
    divmod(100n, 3n, 33n, 1n);
    divmod(W128(0n, 0x8000000000000000n), 3n, W128(0xaaaaaaaaaaaaaaaan, 0x2aaaaaaaaaaaaaaan), 2n);
    divmod(5n, W128(10n, 1n), 0n, 5n);
    divmod(123n, 10n, 12n, 3n);
    divmod(W128(0n, 1n), 10n, 1844674407370955161n, 6n);
  });
});

describe("as-bignum u128.spec.ts (vectors valid for 256 bits)", () => {
  test("Audit fixes: rem10, ord, muldiv, sqr", () => {
    mod(W128(2n, 0n), 10n, 2n);
    mod(W128(16222495557571259006n, 18092382526624944601n), 10n, 2n);
    expect(call("u256Cmp", W128(11862732932339670732n), W128(11791870301324684439n, 10039605328933046698n))).toBe(-1);
    mulDiv(W128(15168594103972142211n, 13112993984347045001n), W128(3336517327n), W128(2932175525583687935n, 10692182455030519441n), 4091936498n);
    // u128.sqr = a * a mod 2^128
    const a = W128(17448461305379225827n, 14768026361276340486n);
    expect(big("u256Truncate", big("u256Mul", a, a), 128)).toBe(W128(12113794852041967945n, 18342544934353289530n));
  });

  test("String Conversion", () => {
    expect(callString("u256Parse", W128(10248516654965971928n, 5n))).toBe("102482237023513730008");
    expect(callString("u256Parse", MAX128)).toBe("340282366920938463463374607431768211455");
    expect(callString("u256Parse", 90n)).toBe("90");
    expect(callString("u256Parse", W128(M64))).toBe("18446744073709551615");
    expect(callString("u256Parse", W128(M64 - 1n, M64 - 1n))).toBe("340282366920938463444927863358058659838");
    expect(big("u256Parse", "123456789")).toBe(123456789n);
    expect(big("u256Parse", "340282366920938463463374607431768211455")).toBe(MAX128);
    expect(big("u256Parse", "01")).toBe(1n);
    // as-bignum's u128.from(string) accepts signs, prefixes and stops at invalid characters:
    // the KoinDX U256 only accepts plain decimal numbers
    for (const s of ["", "-123456789", "+123456789", "+0001", "00000123abc", "x00000123abc", "-x", "--01234", "123〒", String.fromCodePoint(0x10000), "{0123", "/0123", "0xabcdefABCDEF", "0o01234567", "0b10101010101010101010"]) {
      reverts("u256Parse", s);
    }
  });

  test("Basic Operations (results mod 2^128 compared when u128 wraps)", () => {
    const lo128 = (x) => x & MAX128;
    expect(big("u256Or", W128(0n, 123n), W128(111n, 222n))).toBe(W128(0n | 111n, 123n | 222n));
    expect(big("u256Xor", W128(111n, 123n), W128(111n, 0n))).toBe(W128(0n, 123n));
    expect(big("u256And", W128(0xff00n, 123n), W128(0x00ffn, 234n))).toBe(W128(0n, 123n & 234n));
    add(W128(100n, 255n), W128(255n, 100n), W128(355n, 355n));
    add(W128(M64 - 1n, M64), 1n, MAX128); // u128.from(-2) + 1
    add(W128(M64), 1n, W128(0n, 1n));
    expect(lo128(big("u256Add", MAX128, W128(1n, 1n)))).toBe(W128(0n, 1n)); // u128 wraps
    sub(W128(355n, 355n), W128(100n, 255n), W128(255n, 100n));
    expect(lo128(big("u256WrappingSub", 0n, W128(1n, 1n)))).toBe(W128(M64, M64 - 1n));
    expect(lo128(big("u256WrappingSub", 0n, MAX128))).toBe(1n);
    sub(MAX128, 1n, W128(M64 - 1n, M64));
    expect(lo128(big("u256WrappingSub", W128(1n, 2n), W128(M64 - 1n, M64 - 2n)))).toBe(W128(3n, 4n));
    shl(W128(1n, 0n), 65, W128(0n, 2n));
    shl(W128(1n, 1n), 0, W128(1n, 1n));
    shr(W128(0n, 100n), 65, 50n);
    shr(W128(1n, 1n), 0, W128(1n, 1n));
    mul(43545453452n, 2353454354n, W128(10248516654965971928n, 5n));
    mul(MAX128, 1n, MAX128);
    expect(lo128(big("u256Mul", W128(0n, 1n), W128(0n, 1n)))).toBe(0n);
    expect(lo128(big("u256Mul", W128(1n, 1n), W128(1n, 1n)))).toBe(W128(1n, 2n));
    add(W128(10248516654965971928n, 5n), 1n, W128(10248516654965971929n, 5n));
    add(W128(M64, 0n), 1n, W128(0n, 1n));
    add(W128(M64 - 1n, M64), 1n, MAX128);
    sub(W128(10248516654965971928n, 5n), 1n, W128(10248516654965971927n, 5n));
    sub(W128(0n, 1n), 1n, W128(M64, 0n));
  });

  test("Division And Mod Operation", () => {
    div(W128(10248516657319426282n, 5n), 2353454354n, 43545453453n);
    div(W128(10248516654965971928n, 5n), 43545453452n, 2353454354n);
    div(W128(3152652666208173568n, 2n), 4354545345312n, 9196400n);
    div(9801427805542018869750100000000n, 10n, 980142780554201886975010000000n);
    div(W128(3152652666208173568n, 2n), 43543534534534n, 919680n);
    div(W128(3152652666208178n, 0n), 43543534534534n, 72n);
    div(0n, W128(10248516654965971928n, 5n), 0n);
    div(W128(10248516654965971928n, 5n), 1n, W128(10248516654965971928n, 5n));
    mod(W128(10248516657319426282n, 5n), 2353454354n, 0n);
    mod(W128(10248516654965971928n, 5n), 43545453452n, 0n);
    mod(W128(3152652666208173568n, 2n), 43543534534534n, 22972907047680n);
    mod(W128(3152652666208178n), 43543534534534n, 17518179721730n);
    mod(W128(987775983032474055n, 5421010862427527591n), W128(1000000000011111n), 344332109866679n);
    mod(W128(10248516654965971928n, 5n), 1n, 0n);
    mod(19n, 2n, 1n);
    mod(111n, 4n, 3n);
    mod(4n, 128n, 4n);
    mod(8n, 8n, 0n);
    mod(W128(10248516654965971928n, 5n), W128(10248516654965971928n, 5n), 0n);
    div(W128(10248516654965971928n, 5n), W128(10248516654965971928n, 5n), 1n);
    mod(MAX128, MAX128, 0n);
    div(MAX128, MAX128, 1n);
  });

  test("Multiply and Division without Overflow (muldiv)", () => {
    mulDiv(W128(10248516654965971928n, 5n), 0n, W128(22972907047680n), 0n);
    mulDiv(0n, 1n, W128(22972907047680n), 0n);
    mulDiv(W128(10248516654965971928n, 5n), W128(22972907047680n), W128(22972907047680n), W128(10248516654965971928n, 5n));
    mulDiv(MAX128, W128(M64, 0n), W128(M64, 0n), MAX128); // new u128(-1): lo = u64 max, hi = 0
    mulDiv(MAX128, MAX128, MAX128, MAX128);
    mulDiv(W128(498419840516515123n), W128(6132198419878046132n), W128(9156498145135109843n), W128(333796753956109993n));
    mulDiv(W128(9223372032559808512n), W128(9223372036854775807n), W128(12n), W128(11529215046426383701n, 384307168023325354n));
    mulDiv(W128(9223372032559808512n, 123456n), W128(123456n), W128(M64, 123456n), W128(123455n));
    // the results of these two don't fit in 128 bits: u128.muldiv returns them mod 2^128, the
    // KoinDX mulDiv returns the exact value (here < 2^256)
    const mulDivLow128 = (a, b, c, expectedLow128) => {
      const exact = (a * b) / c;
      expect(exact > MAX128).toBe(true);
      expect(exact & MAX128).toBe(expectedLow128);
      expect(big("u256MulDiv", a, b, c)).toBe(exact);
    };
    mulDivLow128(W128(17368525644200112449n, 244614n), W128(4017580189248773693n, 12699n), W128(3434515n), W128(12770041117111790654n, 8684128842189806128n));
    mulDivLow128(MAX128, W128(0x7fffffffffffffffn, 0x8111111111111111n), W128(0x3333333333333333n), W128(9223372036854775803n, 384307168202282322n));
  });

  test("Throwable", () => {
    reverts("u256FromBytesHex", "00".repeat(33));
    reverts("u256Div", W128(1n, 1n), 0n);
    reverts("u256Mod", W128(1n, 1n), 0n);
    reverts("u256Div", 0n, 0n);
    reverts("u256Mod", 0n, 0n);
    reverts("u256MulDiv", W128(1n, 1n), W128(1n, 1n), 0n);
  });
});

describe("as-bignum audit report (Verichains, v1.1)", () => {
  test("H-01 inadequate overflow detection in a checked add (u128Safe.add)", () => {
    // the u128 vector of the report, moved to the top 128 bits so it overflows 2^256
    const a = W128(14578515230910040473n, 11834292359786415467n);
    const b = W128(9202606200622059783n, 8690157821842247249n);
    expect(a + b > MAX128).toBe(true);
    add(a << 128n, b << 128n, wrap((a + b) << 128n));
    // and with every lower limb set, so the carry comes from the lower limbs
    add((a << 128n) | MAX128, (b << 128n) | 1n, wrap(((a << 128n) | MAX128) + ((b << 128n) | 1n)));
    // in the low 128 bits it is a valid 256-bit addition
    add(a, b, a + b);
  });

  test("H-02 remainder of the division by 10 (u128.rem10), H-03 comparison (u128.ord)", () => {
    for (const v of [2n, 9n, 10n, 11n, W128(16222495557571259006n, 18092382526624944601n), MAX128, MAX]) {
      mod(v, 10n, v % 10n);
      div(v, 10n, v / 10n);
    }
    const a = W128(11862732932339670732n);
    const b = W128(11791870301324684439n, 10039605328933046698n);
    expect(call("u256Cmp", a, b)).toBe(-1);
    expect(call("u256Cmp", b, a)).toBe(1);
    expect(call("u256Cmp", a << 128n, b << 128n)).toBe(-1);
  });

  test("H-04 overflow in the intermediate steps of muldiv, H-05 squaring", () => {
    const a = W128(15168594103972142211n, 13112993984347045001n);
    const b = W128(3336517327n);
    const c = W128(2932175525583687935n, 10692182455030519441n);
    mulDiv(a, b, c, 4091936498n);
    // same operands scaled to 256 bits: the product needs the 512-bit intermediate
    mulDiv(a << 128n, b << 64n, c << 64n, ((a << 128n) * (b << 64n)) / (c << 64n));
    const x = W128(17448461305379225827n, 14768026361276340486n);
    mul(x, x, x * x);
    expect(big("u256Truncate", x * x, 128)).toBe(W128(12113794852041967945n, 18342544934353289530n));
  });
});

describe("KoinDX U256 bytes format (Koinos storage)", () => {
  test("big endian without leading zeros, round trip", () => {
    for (const v of [0n, 1n, 255n, 256n, M64, 1n << 64n, MAX128, 1n << 255n, MAX, W(0x8877665544332211n, 0x12ffeeddccbbaa99n)]) {
      expect(callString("u256ToBytesHex", v)).toBe(minimalHex(v));
      expect(big("u256FromBytesHex", minimalHex(v))).toBe(v);
      // leading zeros are accepted when parsing (up to 32 bytes)
      if (minimalHex(v).length < 64) expect(big("u256FromBytesHex", "00" + minimalHex(v))).toBe(v);
    }
  });
});
