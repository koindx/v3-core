// Port of Uniswap v3-core test/BitMath.spec.ts: BitMath of Uniswap is mostSignificantBit /
// leastSignificantBit of U256 (libraries/U256.ts, compiled in tests/build/harness.wasm).
// Not applicable: the gas cost tests.
const { call, Revert } = require("../../harness");

const mostSignificantBit = (x) => call("u256Msb", BigInt(x));
const leastSignificantBit = (x) => call("u256Lsb", BigInt(x));

describe("BitMath", () => {
  describe("#mostSignificantBit", () => {
    it("0", () => {
      expect(() => mostSignificantBit(0)).toThrow(Revert);
    });
    it("1", () => {
      expect(mostSignificantBit(1)).toEqual(0);
    });
    it("2", () => {
      expect(mostSignificantBit(2)).toEqual(1);
    });
    it("all powers of 2", () => {
      const results = [...Array(255)].map((_, i) => mostSignificantBit(2n ** BigInt(i)));
      expect(results).toEqual([...Array(255)].map((_, i) => i));
    });
    it("uint256(-1)", () => {
      expect(mostSignificantBit(2n ** 256n - 1n)).toEqual(255);
    });
  });

  describe("#leastSignificantBit", () => {
    it("0", () => {
      expect(() => leastSignificantBit(0)).toThrow(Revert);
    });
    it("1", () => {
      expect(leastSignificantBit(1)).toEqual(0);
    });
    it("2", () => {
      expect(leastSignificantBit(2)).toEqual(1);
    });
    it("all powers of 2", () => {
      const results = [...Array(255)].map((_, i) => leastSignificantBit(2n ** BigInt(i)));
      expect(results).toEqual([...Array(255)].map((_, i) => i));
    });
    it("uint256(-1)", () => {
      expect(leastSignificantBit(2n ** 256n - 1n)).toEqual(0);
    });
  });
});
