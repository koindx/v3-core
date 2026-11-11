// Port of Uniswap v3-core test/LiquidityMath.spec.ts (libraries/LiquidityMath.ts compiled in
// tests/build/harness.wasm). Not applicable: the gas cost tests.
const { callString } = require("../../harness");

const addDelta = (x, y) => BigInt(callString("addDelta", BigInt(x).toString(), BigInt(y).toString()));

describe("LiquidityMath", () => {
  describe("#addDelta", () => {
    it("1 + 0", () => {
      expect(addDelta(1, 0)).toEqual(1n);
    });
    it("1 + -1", () => {
      expect(addDelta(1, -1)).toEqual(0n);
    });
    it("1 + 1", () => {
      expect(addDelta(1, 1)).toEqual(2n);
    });
    it("2**128-15 + 15 overflows", () => {
      expect(() => addDelta(2n ** 128n - 15n, 15)).toThrow("KOINDX: LIQUIDITY_ADD");
    });
    it("0 + -1 underflows", () => {
      expect(() => addDelta(0, -1)).toThrow("KOINDX: LIQUIDITY_SUB");
    });
    it("3 + -4 underflows", () => {
      expect(() => addDelta(3, -4)).toThrow("KOINDX: LIQUIDITY_SUB");
    });
  });
});
