// Port of Uniswap v3-core test/SqrtPriceMath.spec.ts (libraries/SqrtPriceMath.ts compiled in
// tests/build/harness.wasm). Not applicable: the gas cost tests.
const { callString, Revert } = require("../../harness");
const { encodePriceSqrt, expandTo18Decimals, MaxUint128, MaxUint256 } = require("../shared/utilities");

const s = (x) => BigInt(x).toString();
const sqrtPriceMath = {
  getNextSqrtPriceFromInput: (sqrtP, liquidity, amountIn, zeroForOne) =>
    BigInt(callString("getNextSqrtPriceFromInput", s(sqrtP), s(liquidity), s(amountIn), zeroForOne)),
  getNextSqrtPriceFromOutput: (sqrtP, liquidity, amountOut, zeroForOne) =>
    BigInt(callString("getNextSqrtPriceFromOutput", s(sqrtP), s(liquidity), s(amountOut), zeroForOne)),
  getAmount0Delta: (a, b, liquidity, roundUp) => BigInt(callString("getAmount0Delta", s(a), s(b), s(liquidity), roundUp)),
  getAmount1Delta: (a, b, liquidity, roundUp) => BigInt(callString("getAmount1Delta", s(a), s(b), s(liquidity), roundUp)),
};

describe("SqrtPriceMath", () => {
  describe("#getNextSqrtPriceFromInput", () => {
    it("fails if price is zero", () => {
      expect(() => sqrtPriceMath.getNextSqrtPriceFromInput(0, 0, expandTo18Decimals(1) / 10n, false)).toThrow(Revert);
    });

    it("fails if liquidity is zero", () => {
      expect(() => sqrtPriceMath.getNextSqrtPriceFromInput(1, 0, expandTo18Decimals(1) / 10n, true)).toThrow(Revert);
    });

    it("fails if input amount overflows the price", () => {
      const price = 2n ** 160n - 1n;
      const liquidity = 1024;
      const amountIn = 1024;
      expect(() => sqrtPriceMath.getNextSqrtPriceFromInput(price, liquidity, amountIn, false)).toThrow(Revert);
    });

    it("any input amount cannot underflow the price", () => {
      const price = 1;
      const liquidity = 1;
      const amountIn = 2n ** 255n;
      expect(sqrtPriceMath.getNextSqrtPriceFromInput(price, liquidity, amountIn, true)).toEqual(1n);
    });

    it("returns input price if amount in is zero and zeroForOne = true", () => {
      const price = encodePriceSqrt(1, 1);
      expect(sqrtPriceMath.getNextSqrtPriceFromInput(price, expandTo18Decimals(1) / 10n, 0, true)).toEqual(price);
    });

    it("returns input price if amount in is zero and zeroForOne = false", () => {
      const price = encodePriceSqrt(1, 1);
      expect(sqrtPriceMath.getNextSqrtPriceFromInput(price, expandTo18Decimals(1) / 10n, 0, false)).toEqual(price);
    });

    it("returns the minimum price for max inputs", () => {
      const sqrtP = 2n ** 160n - 1n;
      const liquidity = MaxUint128;
      const maxAmountNoOverflow = MaxUint256 - (liquidity << 96n) / sqrtP;
      expect(sqrtPriceMath.getNextSqrtPriceFromInput(sqrtP, liquidity, maxAmountNoOverflow, true)).toEqual(1n);
    });

    it("input amount of 0.1 token1", () => {
      const sqrtQ = sqrtPriceMath.getNextSqrtPriceFromInput(encodePriceSqrt(1, 1), expandTo18Decimals(1), expandTo18Decimals(1) / 10n, false);
      expect(sqrtQ).toEqual(87150978765690771352898345369n);
    });

    it("input amount of 0.1 token0", () => {
      const sqrtQ = sqrtPriceMath.getNextSqrtPriceFromInput(encodePriceSqrt(1, 1), expandTo18Decimals(1), expandTo18Decimals(1) / 10n, true);
      expect(sqrtQ).toEqual(72025602285694852357767227579n);
    });

    it("amountIn > type(uint96).max and zeroForOne = true", () => {
      // perfect answer:
      // https://www.wolframalpha.com/input/?i=624999999995069620+-+%28%281e19+*+1+%2F+%281e19+%2B+2%5E100+*+1%29%29+*+2%5E96%29
      expect(sqrtPriceMath.getNextSqrtPriceFromInput(encodePriceSqrt(1, 1), expandTo18Decimals(10), 2n ** 100n, true)).toEqual(624999999995069620n);
    });

    it("can return 1 with enough amountIn and zeroForOne = true", () => {
      expect(sqrtPriceMath.getNextSqrtPriceFromInput(encodePriceSqrt(1, 1), 1, MaxUint256 / 2n, true)).toEqual(1n);
    });
  });

  describe("#getNextSqrtPriceFromOutput", () => {
    it("fails if price is zero", () => {
      expect(() => sqrtPriceMath.getNextSqrtPriceFromOutput(0, 0, expandTo18Decimals(1) / 10n, false)).toThrow(Revert);
    });

    it("fails if liquidity is zero", () => {
      expect(() => sqrtPriceMath.getNextSqrtPriceFromOutput(1, 0, expandTo18Decimals(1) / 10n, true)).toThrow(Revert);
    });

    it("fails if output amount is exactly the virtual reserves of token0", () => {
      const price = "20282409603651670423947251286016";
      expect(() => sqrtPriceMath.getNextSqrtPriceFromOutput(price, 1024, 4, false)).toThrow(Revert);
    });

    it("fails if output amount is greater than virtual reserves of token0", () => {
      const price = "20282409603651670423947251286016";
      expect(() => sqrtPriceMath.getNextSqrtPriceFromOutput(price, 1024, 5, false)).toThrow(Revert);
    });

    it("fails if output amount is greater than virtual reserves of token1", () => {
      const price = "20282409603651670423947251286016";
      expect(() => sqrtPriceMath.getNextSqrtPriceFromOutput(price, 1024, 262145, true)).toThrow(Revert);
    });

    it("fails if output amount is exactly the virtual reserves of token1", () => {
      const price = "20282409603651670423947251286016";
      expect(() => sqrtPriceMath.getNextSqrtPriceFromOutput(price, 1024, 262144, true)).toThrow(Revert);
    });

    it("succeeds if output amount is just less than the virtual reserves of token1", () => {
      const price = "20282409603651670423947251286016";
      const sqrtQ = sqrtPriceMath.getNextSqrtPriceFromOutput(price, 1024, 262143, true);
      expect(sqrtQ).toEqual(77371252455336267181195264n);
    });

    it("puzzling echidna test", () => {
      const price = "20282409603651670423947251286016";
      expect(() => sqrtPriceMath.getNextSqrtPriceFromOutput(price, 1024, 4, false)).toThrow(Revert);
    });

    it("returns input price if amount in is zero and zeroForOne = true", () => {
      const price = encodePriceSqrt(1, 1);
      expect(sqrtPriceMath.getNextSqrtPriceFromOutput(price, expandTo18Decimals(1) / 10n, 0, true)).toEqual(price);
    });

    it("returns input price if amount in is zero and zeroForOne = false", () => {
      const price = encodePriceSqrt(1, 1);
      expect(sqrtPriceMath.getNextSqrtPriceFromOutput(price, expandTo18Decimals(1) / 10n, 0, false)).toEqual(price);
    });

    it("output amount of 0.1 token1", () => {
      const sqrtQ = sqrtPriceMath.getNextSqrtPriceFromOutput(encodePriceSqrt(1, 1), expandTo18Decimals(1), expandTo18Decimals(1) / 10n, false);
      expect(sqrtQ).toEqual(88031291682515930659493278152n);
    });

    it("output amount of 0.1 token1 (zeroForOne = true)", () => {
      const sqrtQ = sqrtPriceMath.getNextSqrtPriceFromOutput(encodePriceSqrt(1, 1), expandTo18Decimals(1), expandTo18Decimals(1) / 10n, true);
      expect(sqrtQ).toEqual(71305346262837903834189555302n);
    });

    it("reverts if amountOut is impossible in zero for one direction", () => {
      expect(() => sqrtPriceMath.getNextSqrtPriceFromOutput(encodePriceSqrt(1, 1), 1, MaxUint256, true)).toThrow(Revert);
    });

    it("reverts if amountOut is impossible in one for zero direction", () => {
      expect(() => sqrtPriceMath.getNextSqrtPriceFromOutput(encodePriceSqrt(1, 1), 1, MaxUint256, false)).toThrow(Revert);
    });
  });

  describe("#getAmount0Delta", () => {
    it("returns 0 if liquidity is 0", () => {
      expect(sqrtPriceMath.getAmount0Delta(encodePriceSqrt(1, 1), encodePriceSqrt(2, 1), 0, true)).toEqual(0n);
    });
    it("returns 0 if prices are equal", () => {
      expect(sqrtPriceMath.getAmount0Delta(encodePriceSqrt(1, 1), encodePriceSqrt(1, 1), 0, true)).toEqual(0n);
    });

    it("returns 0.1 amount1 for price of 1 to 1.21", () => {
      const amount0 = sqrtPriceMath.getAmount0Delta(encodePriceSqrt(1, 1), encodePriceSqrt(121, 100), expandTo18Decimals(1), true);
      expect(amount0).toEqual(90909090909090910n);

      const amount0RoundedDown = sqrtPriceMath.getAmount0Delta(encodePriceSqrt(1, 1), encodePriceSqrt(121, 100), expandTo18Decimals(1), false);
      expect(amount0RoundedDown).toEqual(amount0 - 1n);
    });

    it("works for prices that overflow", () => {
      const amount0Up = sqrtPriceMath.getAmount0Delta(encodePriceSqrt(2n ** 90n, 1), encodePriceSqrt(2n ** 96n, 1), expandTo18Decimals(1), true);
      const amount0Down = sqrtPriceMath.getAmount0Delta(encodePriceSqrt(2n ** 90n, 1), encodePriceSqrt(2n ** 96n, 1), expandTo18Decimals(1), false);
      expect(amount0Up).toEqual(amount0Down + 1n);
    });
  });

  describe("#getAmount1Delta", () => {
    it("returns 0 if liquidity is 0", () => {
      expect(sqrtPriceMath.getAmount1Delta(encodePriceSqrt(1, 1), encodePriceSqrt(2, 1), 0, true)).toEqual(0n);
    });
    it("returns 0 if prices are equal", () => {
      expect(sqrtPriceMath.getAmount0Delta(encodePriceSqrt(1, 1), encodePriceSqrt(1, 1), 0, true)).toEqual(0n);
    });

    it("returns 0.1 amount1 for price of 1 to 1.21", () => {
      const amount1 = sqrtPriceMath.getAmount1Delta(encodePriceSqrt(1, 1), encodePriceSqrt(121, 100), expandTo18Decimals(1), true);
      expect(amount1).toEqual(100000000000000000n);
      const amount1RoundedDown = sqrtPriceMath.getAmount1Delta(encodePriceSqrt(1, 1), encodePriceSqrt(121, 100), expandTo18Decimals(1), false);
      expect(amount1RoundedDown).toEqual(amount1 - 1n);
    });
  });

  describe("swap computation", () => {
    it("sqrtP * sqrtQ overflows", () => {
      // getNextSqrtPriceInvariants(1025574284609383690408304870162715216695788925244,50015962439936049619261659728067971248,406,true)
      const sqrtP = "1025574284609383690408304870162715216695788925244";
      const liquidity = "50015962439936049619261659728067971248";
      const zeroForOne = true;
      const amountIn = "406";

      const sqrtQ = sqrtPriceMath.getNextSqrtPriceFromInput(sqrtP, liquidity, amountIn, zeroForOne);
      expect(sqrtQ).toEqual(1025574284609383582644711336373707553698163132913n);

      const amount0Delta = sqrtPriceMath.getAmount0Delta(sqrtQ, sqrtP, liquidity, true);
      expect(amount0Delta).toEqual(406n);
    });
  });
});
