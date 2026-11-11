// Port of Uniswap v3-core test/FullMath.spec.ts: FullMath of Uniswap is U256.mulDiv /
// mulDivRoundingUp (libraries/U256.ts compiled in tests/build/harness.wasm). The fuzzer that
// Uniswap skips is run with 1000 random inputs.
const crypto = require("crypto");
const { callString, Revert } = require("../../harness");

const MaxUint256 = 2n ** 256n - 1n;
const Q128 = 2n ** 128n;

const mulDiv = (a, b, d) => BigInt(callString("u256MulDiv", BigInt(a).toString(), BigInt(b).toString(), BigInt(d).toString()));
const mulDivRoundingUp = (a, b, d) => BigInt(callString("u256MulDivRoundingUp", BigInt(a).toString(), BigInt(b).toString(), BigInt(d).toString()));

describe("FullMath", () => {
  describe("#mulDiv", () => {
    it("reverts if denominator is 0", () => {
      expect(() => mulDiv(Q128, 5, 0)).toThrow(Revert);
    });
    it("reverts if denominator is 0 and numerator overflows", () => {
      expect(() => mulDiv(Q128, Q128, 0)).toThrow(Revert);
    });
    it("reverts if output overflows uint256", () => {
      expect(() => mulDiv(Q128, Q128, 1)).toThrow(Revert);
    });
    it("reverts on overflow with all max inputs", () => {
      expect(() => mulDiv(MaxUint256, MaxUint256, MaxUint256 - 1n)).toThrow(Revert);
    });

    it("all max inputs", () => {
      expect(mulDiv(MaxUint256, MaxUint256, MaxUint256)).toEqual(MaxUint256);
    });

    it("accurate without phantom overflow", () => {
      const result = Q128 / 3n;
      expect(mulDiv(Q128, /*0.5=*/ (50n * Q128) / 100n, /*1.5=*/ (150n * Q128) / 100n)).toEqual(result);
    });

    it("accurate with phantom overflow", () => {
      const result = (4375n * Q128) / 1000n;
      expect(mulDiv(Q128, 35n * Q128, 8n * Q128)).toEqual(result);
    });

    it("accurate with phantom overflow and repeating decimal", () => {
      const result = (1n * Q128) / 3n;
      expect(mulDiv(Q128, 1000n * Q128, 3000n * Q128)).toEqual(result);
    });
  });

  describe("#mulDivRoundingUp", () => {
    it("reverts if denominator is 0", () => {
      expect(() => mulDivRoundingUp(Q128, 5, 0)).toThrow(Revert);
    });
    it("reverts if denominator is 0 and numerator overflows", () => {
      expect(() => mulDivRoundingUp(Q128, Q128, 0)).toThrow(Revert);
    });
    it("reverts if output overflows uint256", () => {
      expect(() => mulDivRoundingUp(Q128, Q128, 1)).toThrow(Revert);
    });
    it("reverts on overflow with all max inputs", () => {
      expect(() => mulDivRoundingUp(MaxUint256, MaxUint256, MaxUint256 - 1n)).toThrow(Revert);
    });

    it("reverts if mulDiv overflows 256 bits after rounding up", () => {
      expect(() => mulDivRoundingUp("535006138814359", "432862656469423142931042426214547535783388063929571229938474969", "2")).toThrow(Revert);
    });

    it("reverts if mulDiv overflows 256 bits after rounding up case 2", () => {
      expect(() =>
        mulDivRoundingUp(
          "115792089237316195423570985008687907853269984659341747863450311749907997002549",
          "115792089237316195423570985008687907853269984659341747863450311749907997002550",
          "115792089237316195423570985008687907853269984653042931687443039491902864365164"
        )
      ).toThrow(Revert);
    });

    it("all max inputs", () => {
      expect(mulDivRoundingUp(MaxUint256, MaxUint256, MaxUint256)).toEqual(MaxUint256);
    });

    it("accurate without phantom overflow", () => {
      const result = Q128 / 3n + 1n;
      expect(mulDivRoundingUp(Q128, /*0.5=*/ (50n * Q128) / 100n, /*1.5=*/ (150n * Q128) / 100n)).toEqual(result);
    });

    it("accurate with phantom overflow", () => {
      const result = (4375n * Q128) / 1000n;
      expect(mulDivRoundingUp(Q128, 35n * Q128, 8n * Q128)).toEqual(result);
    });

    it("accurate with phantom overflow and repeating decimal", () => {
      const result = (1n * Q128) / 3n + 1n;
      expect(mulDivRoundingUp(Q128, 1000n * Q128, 3000n * Q128)).toEqual(result);
    });
  });

  // Uniswap: tiny fuzzer, skipped. Run here.
  it("check a bunch of random inputs against JS implementation", () => {
    const pseudoRandomBigNumber = () => {
      // random size so that the products cover small and overflowing values
      const bits = 1 + crypto.randomInt(256);
      return BigInt("0x" + crypto.randomBytes(32).toString("hex")) >> BigInt(256 - bits);
    };
    for (let i = 0; i < 1000; i++) {
      const [x, y, d] = [pseudoRandomBigNumber(), pseudoRandomBigNumber(), pseudoRandomBigNumber()];
      if (d === 0n) {
        expect(() => mulDiv(x, y, d)).toThrow(Revert);
        expect(() => mulDivRoundingUp(x, y, d)).toThrow(Revert);
        continue;
      }
      const floored = (x * y) / d;
      const ceiled = floored + ((x * y) % d > 0n ? 1n : 0n);
      if (floored > MaxUint256) {
        expect(() => mulDiv(x, y, d)).toThrow(Revert);
      } else {
        expect(mulDiv(x, y, d)).toEqual(floored);
      }
      if (ceiled > MaxUint256) {
        expect(() => mulDivRoundingUp(x, y, d)).toThrow(Revert);
      } else {
        expect(mulDivRoundingUp(x, y, d)).toEqual(ceiled);
      }
    }
  });
});
