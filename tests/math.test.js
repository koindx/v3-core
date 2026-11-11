// Differential tests: the AssemblyScript math libraries (compiled to tests/build/harness.wasm)
// are compared against a BigInt transliteration of the Solidity code (tests/reference.js) and
// against the official @uniswap/v3-sdk.
const JSBI = require("jsbi");
const sdk = require("@uniswap/v3-sdk");
const ref = require("./reference");
const { call, callString, Revert } = require("./harness");

const MAX256 = ref.MAX256;
const N = Number(process.env.FUZZ_RUNS || 1500);

// deterministic PRNG (mulberry32)
let seed = 0x5eed1234;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function randInt(min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}
/** random BigInt with a random bit length in [0, maxBits], biased towards edge values */
function randBig(maxBits = 256) {
  const r = rand();
  if (r < 0.03) return 0n;
  if (r < 0.06) return 1n;
  if (r < 0.09) return (1n << BigInt(maxBits)) - 1n;
  const bits = randInt(1, maxBits);
  let v = 0n;
  for (let i = 0; i < bits; i += 30) v = (v << 30n) | BigInt(randInt(0, (1 << 30) - 1));
  v &= (1n << BigInt(bits)) - 1n;
  if (r < 0.2) {
    v = 1n << BigInt(bits - 1); // power of two
    if (r >= 0.15) v -= 1n; // or just below
  }
  return v;
}

const wrap = (x) => ((x % (1n << 256n)) + (1n << 256n)) % (1n << 256n);

/** runs the reference and the wasm implementation, both must revert or return the same value */
function same(refFn, wasmFn) {
  let expected, refReverted = false;
  try {
    expected = refFn();
  } catch (e) {
    if (!(e instanceof ref.Revert)) throw e;
    refReverted = true;
  }
  let actual, wasmReverted = false;
  try {
    actual = wasmFn();
  } catch (e) {
    if (!(e instanceof Revert)) throw e;
    wasmReverted = true;
  }
  if (refReverted || wasmReverted) {
    expect({ wasmReverted }).toEqual({ wasmReverted: refReverted });
    return undefined;
  }
  expect(actual).toEqual(expected);
  return actual;
}

describe("U256", () => {
  test("add / sub (checked by default, explicit wrapping variants)", () => {
    for (let i = 0; i < N; i++) {
      const a = randBig(), b = randBig();
      expect(callString("u256WrappingAdd", a, b)).toEqual(wrap(a + b).toString());
      expect(callString("u256WrappingSub", a, b)).toEqual(wrap(a - b).toString());
      same(() => { if (a + b > MAX256) throw new ref.Revert(); return (a + b).toString(); }, () => callString("u256Add", a, b));
      same(() => { if (a < b) throw new ref.Revert(); return (a - b).toString(); }, () => callString("u256Sub", a, b));
    }
  });

  test("mul (checked by default, explicit wrapping variant)", () => {
    for (let i = 0; i < N; i++) {
      const a = randBig(), b = randBig();
      expect(callString("u256WrappingMul", a, b)).toEqual(wrap(a * b).toString());
      same(() => { if (a * b > MAX256) throw new ref.Revert(); return (a * b).toString(); }, () => callString("u256Mul", a, b));
    }
  });

  test("div / mod / divRoundingUp", () => {
    for (let i = 0; i < N; i++) {
      const a = randBig(), b = randBig();
      same(() => { ref.divRoundingUp(a, b); return (a / b).toString(); }, () => callString("u256Div", a, b));
      same(() => { ref.divRoundingUp(a, b); return (a % b).toString(); }, () => callString("u256Mod", a, b));
      same(() => ref.divRoundingUp(a, b).toString(), () => callString("u256DivRoundingUp", a, b));
    }
  });

  test("mulDiv / mulDivRoundingUp (512-bit intermediate)", () => {
    for (let i = 0; i < N * 2; i++) {
      const a = randBig(), b = randBig(), d = randBig();
      same(() => ref.mulDiv(a, b, d).toString(), () => callString("u256MulDiv", a, b, d));
      same(() => ref.mulDivRoundingUp(a, b, d).toString(), () => callString("u256MulDivRoundingUp", a, b, d));
    }
  });

  test("mulDiv known vectors (FullMath.spec)", () => {
    const Q128 = 1n << 128n;
    expect(callString("u256MulDiv", Q128, 50n * Q128 / 100n, 150n * Q128 / 100n)).toEqual((Q128 / 3n).toString());
    expect(callString("u256MulDiv", MAX256, MAX256, MAX256)).toEqual(MAX256.toString());
    expect(callString("u256MulDiv", Q128, 35n * Q128, 8n * Q128)).toEqual((4375n * Q128 / 1000n).toString());
    expect(callString("u256MulDiv", Q128, 1000n * Q128, 3000n * Q128)).toEqual("113427455640312821154458202477256070485");
    expect(() => call("u256MulDiv", Q128, 5n, 0n)).toThrow(Revert);
    expect(() => call("u256MulDiv", Q128, Q128, 0n)).toThrow(Revert);
    expect(() => call("u256MulDiv", Q128, Q128, 1n)).toThrow(Revert);
    expect(() => call("u256MulDiv", MAX256, MAX256, MAX256 - 1n)).toThrow(Revert);
    expect(() => call("u256MulDivRoundingUp", 535006138814359n, 432862656469423142931042426214547535783388063929571229938474969n, 2n)).toThrow(Revert);
  });

  test("shifts, comparison, bit length, bytes", () => {
    for (let i = 0; i < N; i++) {
      const a = randBig(), b = randBig();
      const n = randInt(0, 300);
      expect(callString("u256WrappingShl", a, n)).toEqual(wrap(a << BigInt(n)).toString());
      same(() => { if ((a << BigInt(n)) > MAX256) throw new ref.Revert(); return (a << BigInt(n)).toString(); }, () => callString("u256Shl", a, n));
      expect(callString("u256Shr", a, n)).toEqual((a >> BigInt(n)).toString());
      const signed = a >= 1n << 255n ? a - (1n << 256n) : a;
      expect(callString("u256Sar", a, n)).toEqual(wrap(signed >> BigInt(n)).toString());
      expect(call("u256Cmp", a, b)).toEqual(a > b ? 1 : a < b ? -1 : 0);
      expect(call("u256BitLength", a)).toEqual(a === 0n ? 0 : a.toString(2).length);
      if (a > 0n) {
        let lsb = 0;
        while (((a >> BigInt(lsb)) & 1n) === 0n) lsb++;
        expect(call("u256Lsb", a)).toEqual(lsb);
      }
      expect(callString("u256BytesRoundTrip", a)).toEqual(a.toString());
      expect(call("u256BytesLength", a)).toEqual(a === 0n ? 0 : Math.ceil(a.toString(2).length / 8));
    }
  });

  test("string parsing rejects invalid numbers", () => {
    expect(() => call("u256Add", "12a", "1")).toThrow(Revert);
    expect(() => call("u256Add", "", "1")).toThrow(Revert);
    expect(() => call("u256WrappingAdd", (MAX256 + 1n).toString(), "0")).toThrow(Revert);
    expect(callString("u256Add", MAX256.toString(), "0")).toEqual(MAX256.toString());
    // the characters next to the digits in ASCII, signs, spaces, hexadecimal
    for (const invalid of ["/", ":", "1/", "1:", "+1", "-1", " 1", "1 ", "0x1"]) {
      expect(() => call("u256Add", invalid, "1")).toThrow(Revert);
    }
  });

  test("shl overflow check with huge shifts", () => {
    expect(() => call("u256Shl", 1n, 2147483647)).toThrow(Revert);
    expect(() => call("u256Shl", 1n << 255n, 2147483646)).toThrow(Revert);
    expect(() => call("u256Shl", 1n, 256)).toThrow(Revert);
    expect(callString("u256Shl", 1n, 255)).toEqual((1n << 255n).toString());
    expect(callString("u256Shl", 0n, 2147483647)).toEqual("0");
  });
});

describe("I256", () => {
  test("add / sub / int128 range", () => {
    const rnd = () => (rand() < 0.5 ? -1n : 1n) * randBig(130);
    for (let i = 0; i < N; i++) {
      const a = rnd(), b = rnd();
      expect(callString("i256Add", a, b)).toEqual((a + b).toString());
      expect(callString("i256Sub", a, b)).toEqual((a - b).toString());
      same(() => { if (a < -(1n << 127n) || a > (1n << 127n) - 1n) throw new ref.Revert(); return a.toString(); }, () => callString("i256CheckInt128", a));
      expect(callString("i256BytesRoundTrip", a)).toEqual(a.toString());
    }
    // int128 bounds
    expect(callString("i256CheckInt128", -(1n << 127n))).toEqual((-(1n << 127n)).toString());
    expect(callString("i256CheckInt128", (1n << 127n) - 1n)).toEqual(((1n << 127n) - 1n).toString());
    expect(() => call("i256CheckInt128", -(1n << 127n) - 1n)).toThrow(Revert);
    expect(() => call("i256CheckInt128", 1n << 127n)).toThrow(Revert);
  });
});

describe("TickMath", () => {
  test("getSqrtRatioAtTick bounds", () => {
    expect(callString("getSqrtRatioAtTick", ref.MIN_TICK)).toEqual("4295128739");
    expect(callString("getSqrtRatioAtTick", ref.MAX_TICK)).toEqual("1461446703485210103287273052203988822378723970342");
    expect(callString("getSqrtRatioAtTick", 0)).toEqual((1n << 96n).toString());
    expect(() => call("getSqrtRatioAtTick", ref.MIN_TICK - 1)).toThrow(Revert);
    expect(() => call("getSqrtRatioAtTick", ref.MAX_TICK + 1)).toThrow(Revert);
    // the i32 extremes (-i32.MIN_VALUE overflows)
    expect(() => call("getSqrtRatioAtTick", -2147483648)).toThrow(Revert);
    expect(() => call("getSqrtRatioAtTick", 2147483647)).toThrow(Revert);
  });

  test("getSqrtRatioAtTick matches reference and v3-sdk", () => {
    const ticks = [ref.MIN_TICK, ref.MIN_TICK + 1, -1, 0, 1, ref.MAX_TICK - 1, ref.MAX_TICK];
    for (let i = 0; i < N; i++) ticks.push(randInt(ref.MIN_TICK, ref.MAX_TICK));
    for (let i = 0; i < 20; i++) { ticks.push(1 << i); ticks.push(-(1 << i)); }
    for (const tick of ticks) {
      if (Math.abs(tick) > ref.MAX_TICK) continue;
      const expected = ref.getSqrtRatioAtTick(tick).toString();
      expect(callString("getSqrtRatioAtTick", tick)).toEqual(expected);
      expect(sdk.TickMath.getSqrtRatioAtTick(tick).toString()).toEqual(expected);
    }
  });

  test("getTickAtSqrtRatio matches reference and v3-sdk", () => {
    const prices = [ref.MIN_SQRT_RATIO, ref.MIN_SQRT_RATIO + 1n, ref.MAX_SQRT_RATIO - 1n, 1n << 96n];
    for (let i = 0; i < N; i++) {
      const tick = randInt(ref.MIN_TICK, ref.MAX_TICK - 1);
      const p = ref.getSqrtRatioAtTick(tick);
      prices.push(p, p + 1n, p - 1n);
      // random price in range
      let r = randBig(160);
      if (r >= ref.MIN_SQRT_RATIO && r < ref.MAX_SQRT_RATIO) prices.push(r);
    }
    for (const price of prices) {
      if (price < ref.MIN_SQRT_RATIO || price >= ref.MAX_SQRT_RATIO) continue;
      const expected = ref.getTickAtSqrtRatio(price);
      expect(call("getTickAtSqrtRatio", price)).toEqual(expected);
      expect(sdk.TickMath.getTickAtSqrtRatio(JSBI.BigInt(price.toString()))).toEqual(expected);
    }
    expect(() => call("getTickAtSqrtRatio", ref.MIN_SQRT_RATIO - 1n)).toThrow(Revert);
    expect(() => call("getTickAtSqrtRatio", ref.MAX_SQRT_RATIO)).toThrow(Revert);
  });
});

describe("SqrtPriceMath", () => {
  const randPrice = () => {
    if (rand() < 0.5) return ref.getSqrtRatioAtTick(randInt(ref.MIN_TICK, ref.MAX_TICK));
    return randBig(160);
  };
  const randLiquidity = () => randBig(128);
  const randAmount = () => randBig(rand() < 0.8 ? 64 : 256);

  test("getNextSqrtPriceFromInput / Output", () => {
    for (let i = 0; i < N; i++) {
      const p = randPrice(), l = randLiquidity(), amt = randAmount(), z = rand() < 0.5;
      const a = same(() => ref.getNextSqrtPriceFromInput(p, l, amt, z).toString(), () => callString("getNextSqrtPriceFromInput", p, l, amt, z));
      if (a !== undefined) {
        expect(sdk.SqrtPriceMath.getNextSqrtPriceFromInput(JSBI.BigInt(p.toString()), JSBI.BigInt(l.toString()), JSBI.BigInt(amt.toString()), z).toString()).toEqual(a);
      }
      same(() => ref.getNextSqrtPriceFromOutput(p, l, amt, z).toString(), () => callString("getNextSqrtPriceFromOutput", p, l, amt, z));
    }
  });

  test("known vectors (SqrtPriceMath.spec)", () => {
    const e18 = 10n ** 18n;
    const p1 = 79228162514264337593543950336n; // price 1
    expect(callString("getNextSqrtPriceFromInput", p1, e18, e18 / 10n, false)).toEqual("87150978765690771352898345369");
    expect(callString("getNextSqrtPriceFromInput", p1, e18, e18 / 10n, true)).toEqual("72025602285694852357767227579");
    expect(callString("getNextSqrtPriceFromOutput", p1, e18, e18 / 10n, false)).toEqual("88031291682515930659493278152");
    expect(callString("getNextSqrtPriceFromOutput", p1, e18, e18 / 10n, true)).toEqual("71305346262837903834189555302");
    expect(() => call("getNextSqrtPriceFromInput", 0n, 1n, e18 / 10n, false)).toThrow(Revert);
    expect(() => call("getNextSqrtPriceFromInput", 1n, 0n, e18 / 10n, true)).toThrow(Revert);
    expect(callString("getNextSqrtPriceFromInput", 1n, 1n, 1n << 255n, true)).toEqual("1");
  });

  test("getAmount0Delta / getAmount1Delta", () => {
    for (let i = 0; i < N; i++) {
      const a = randPrice(), b = randPrice(), l = randLiquidity(), up = rand() < 0.5;
      const r0 = same(() => ref.getAmount0Delta(a, b, l, up).toString(), () => callString("getAmount0Delta", a, b, l, up));
      if (r0 !== undefined) {
        expect(sdk.SqrtPriceMath.getAmount0Delta(JSBI.BigInt(a.toString()), JSBI.BigInt(b.toString()), JSBI.BigInt(l.toString()), up).toString()).toEqual(r0);
      }
      const r1 = same(() => ref.getAmount1Delta(a, b, l, up).toString(), () => callString("getAmount1Delta", a, b, l, up));
      if (r1 !== undefined) {
        expect(sdk.SqrtPriceMath.getAmount1Delta(JSBI.BigInt(a.toString()), JSBI.BigInt(b.toString()), JSBI.BigInt(l.toString()), up).toString()).toEqual(r1);
      }
    }
  });
});

describe("SwapMath", () => {
  test("computeSwapStep known vectors (SwapMath.spec)", () => {
    const e18 = 10n ** 18n;
    const p1 = 79228162514264337593543950336n;
    // exact amount in that gets capped at price target in one for zero
    expect(callString("computeSwapStep", p1, 79623317895830914510639640423n, 2n * e18, e18, 600)).toEqual(
      "79623317895830914510639640423,9975124224178055,9925619580021728,5988667735148"
    );
    // amount out is capped at the desired amount out
    expect(callString("computeSwapStep", 417332158212080721273783715441582n, 1452870262520218020823638996n, 159344665391607089467575320103n, -1n, 1)).toEqual(
      "417332158212080721273783715441581,1,1,1"
    );
    // entire input amount taken as fee
    expect(callString("computeSwapStep", 2413n, 79887613182836312n, 1985041575832132834610021537970n, 10n, 1872)).toEqual(
      "2413,0,0,10"
    );
  });

  test("computeSwapStep matches reference and v3-sdk", () => {
    const fees = [100, 500, 3000, 10000, 1, 999999, 0];
    for (let i = 0; i < N * 2; i++) {
      const cur = ref.getSqrtRatioAtTick(randInt(ref.MIN_TICK, ref.MAX_TICK));
      const tgt = rand() < 0.2 ? ref.getSqrtRatioAtTick(randInt(ref.MIN_TICK, ref.MAX_TICK)) : cur + (rand() < 0.5 ? -1n : 1n) * randBig(Math.max(1, cur.toString(2).length - 4));
      if (tgt < ref.MIN_SQRT_RATIO || tgt > ref.MAX_SQRT_RATIO) continue;
      const l = randBig(128);
      const amt = (rand() < 0.5 ? -1n : 1n) * randBig(rand() < 0.8 ? 64 : 200);
      const fee = fees[randInt(0, fees.length - 1)];
      const res = same(
        () => ref.computeSwapStep(cur, tgt, l, amt, fee).join(","),
        () => callString("computeSwapStep", cur, tgt, l, amt, fee)
      );
      if (res !== undefined && fee < 1000000) {
        const s = sdk.SwapMath.computeSwapStep(JSBI.BigInt(cur.toString()), JSBI.BigInt(tgt.toString()), JSBI.BigInt(l.toString()), JSBI.BigInt(amt.toString()), fee);
        expect(s.map(String).join(",")).toEqual(res);
      }
    }
  });
});

describe("LiquidityMath", () => {
  test("addDelta", () => {
    expect(callString("addDelta", 1n, 0n)).toEqual("1");
    expect(callString("addDelta", 1n, -1n)).toEqual("0");
    expect(() => call("addDelta", (1n << 128n) - 15n, 15n)).toThrow(Revert);
    expect(() => call("addDelta", 0n, -1n)).toThrow(Revert);
    expect(() => call("addDelta", 3n, -4n)).toThrow(Revert);
    for (let i = 0; i < N; i++) {
      const x = randBig(128), y = (rand() < 0.5 ? -1n : 1n) * randBig(127);
      same(() => ref.addDelta(x, y).toString(), () => callString("addDelta", x, y));
    }
  });
});
