// Port of Uniswap v3-core test/SwapMath.spec.ts (libraries/SwapMath.ts compiled in
// tests/build/harness.wasm). Not applicable: the gas cost tests.
const { callString } = require("../../harness");
const { encodePriceSqrt, expandTo18Decimals } = require("../shared/utilities");

const s = (x) => BigInt(x).toString();
const swapMath = {
  computeSwapStep(price, priceTarget, liquidity, amountRemaining, feePips) {
    const [sqrtQ, amountIn, amountOut, feeAmount] = callString("computeSwapStep", s(price), s(priceTarget), s(liquidity), s(amountRemaining), feePips)
      .split(",")
      .map(BigInt);
    return { sqrtQ, amountIn, amountOut, feeAmount };
  },
};
const sqrtPriceMath = {
  getNextSqrtPriceFromInput: (sqrtP, liquidity, amountIn, zeroForOne) =>
    BigInt(callString("getNextSqrtPriceFromInput", s(sqrtP), s(liquidity), s(amountIn), zeroForOne)),
  getNextSqrtPriceFromOutput: (sqrtP, liquidity, amountOut, zeroForOne) =>
    BigInt(callString("getNextSqrtPriceFromOutput", s(sqrtP), s(liquidity), s(amountOut), zeroForOne)),
};

describe("SwapMath", () => {
  describe("#computeSwapStep", () => {
    it("exact amount in that gets capped at price target in one for zero", () => {
      const price = encodePriceSqrt(1, 1);
      const priceTarget = encodePriceSqrt(101, 100);
      const liquidity = expandTo18Decimals(2);
      const amount = expandTo18Decimals(1);
      const fee = 600;
      const zeroForOne = false;

      const { amountIn, amountOut, sqrtQ, feeAmount } = swapMath.computeSwapStep(price, priceTarget, liquidity, amount, fee);

      expect(amountIn).toEqual(9975124224178055n);
      expect(feeAmount).toEqual(5988667735148n);
      expect(amountOut).toEqual(9925619580021728n);
      expect(amountIn + feeAmount < amount).toBe(true); // entire amount is not used

      const priceAfterWholeInputAmount = sqrtPriceMath.getNextSqrtPriceFromInput(price, liquidity, amount, zeroForOne);

      expect(sqrtQ).toEqual(priceTarget); // price is capped at price target
      expect(sqrtQ < priceAfterWholeInputAmount).toBe(true); // price is less than price after whole input amount
    });

    it("exact amount out that gets capped at price target in one for zero", () => {
      const price = encodePriceSqrt(1, 1);
      const priceTarget = encodePriceSqrt(101, 100);
      const liquidity = expandTo18Decimals(2);
      const amount = -expandTo18Decimals(1);
      const fee = 600;
      const zeroForOne = false;

      const { amountIn, amountOut, sqrtQ, feeAmount } = swapMath.computeSwapStep(price, priceTarget, liquidity, amount, fee);

      expect(amountIn).toEqual(9975124224178055n);
      expect(feeAmount).toEqual(5988667735148n);
      expect(amountOut).toEqual(9925619580021728n);
      expect(amountOut < -amount).toBe(true); // entire amount out is not returned

      const priceAfterWholeOutputAmount = sqrtPriceMath.getNextSqrtPriceFromOutput(price, liquidity, -amount, zeroForOne);

      expect(sqrtQ).toEqual(priceTarget); // price is capped at price target
      expect(sqrtQ < priceAfterWholeOutputAmount).toBe(true); // price is less than price after whole output amount
    });

    it("exact amount in that is fully spent in one for zero", () => {
      const price = encodePriceSqrt(1, 1);
      const priceTarget = encodePriceSqrt(1000, 100);
      const liquidity = expandTo18Decimals(2);
      const amount = expandTo18Decimals(1);
      const fee = 600;
      const zeroForOne = false;

      const { amountIn, amountOut, sqrtQ, feeAmount } = swapMath.computeSwapStep(price, priceTarget, liquidity, amount, fee);

      expect(amountIn).toEqual(999400000000000000n);
      expect(feeAmount).toEqual(600000000000000n);
      expect(amountOut).toEqual(666399946655997866n);
      expect(amountIn + feeAmount).toEqual(amount); // entire amount is used

      const priceAfterWholeInputAmountLessFee = sqrtPriceMath.getNextSqrtPriceFromInput(price, liquidity, amount - feeAmount, zeroForOne);

      expect(sqrtQ < priceTarget).toBe(true); // price does not reach price target
      expect(sqrtQ).toEqual(priceAfterWholeInputAmountLessFee); // price is equal to price after whole input amount
    });

    it("exact amount out that is fully received in one for zero", () => {
      const price = encodePriceSqrt(1, 1);
      const priceTarget = encodePriceSqrt(10000, 100);
      const liquidity = expandTo18Decimals(2);
      const amount = -expandTo18Decimals(1);
      const fee = 600;
      const zeroForOne = false;

      const { amountIn, amountOut, sqrtQ, feeAmount } = swapMath.computeSwapStep(price, priceTarget, liquidity, amount, fee);

      expect(amountIn).toEqual(2000000000000000000n);
      expect(feeAmount).toEqual(1200720432259356n);
      expect(amountOut).toEqual(-amount);

      const priceAfterWholeOutputAmount = sqrtPriceMath.getNextSqrtPriceFromOutput(price, liquidity, -amount, zeroForOne);

      expect(sqrtQ < priceTarget).toBe(true); // price does not reach price target
      expect(sqrtQ).toEqual(priceAfterWholeOutputAmount); // price is less than price after whole output amount
    });

    it("amount out is capped at the desired amount out", () => {
      const { amountIn, amountOut, sqrtQ, feeAmount } = swapMath.computeSwapStep(
        417332158212080721273783715441582n,
        1452870262520218020823638996n,
        "159344665391607089467575320103",
        "-1",
        1
      );
      expect(amountIn).toEqual(1n);
      expect(feeAmount).toEqual(1n);
      expect(amountOut).toEqual(1n); // would be 2 if not capped
      expect(sqrtQ).toEqual(417332158212080721273783715441581n);
    });

    it("target price of 1 uses partial input amount", () => {
      const { amountIn, amountOut, sqrtQ, feeAmount } = swapMath.computeSwapStep(2n, 1n, "1", "3915081100057732413702495386755767", 1);
      expect(amountIn).toEqual(39614081257132168796771975168n);
      expect(feeAmount).toEqual(39614120871253040049813n);
      expect(amountIn + feeAmount <= 3915081100057732413702495386755767n).toBe(true);
      expect(amountOut).toEqual(0n);
      expect(sqrtQ).toEqual(1n);
    });

    it("entire input amount taken as fee", () => {
      const { amountIn, amountOut, sqrtQ, feeAmount } = swapMath.computeSwapStep("2413", "79887613182836312", "1985041575832132834610021537970", "10", 1872);
      expect(amountIn).toEqual(0n);
      expect(feeAmount).toEqual(10n);
      expect(amountOut).toEqual(0n);
      expect(sqrtQ).toEqual(2413n);
    });

    it("handles intermediate insufficient liquidity in zero for one exact output case", () => {
      const sqrtP = 20282409603651670423947251286016n;
      const sqrtPTarget = (sqrtP * 11n) / 10n;
      const liquidity = 1024;
      // virtual reserves of one are only 4
      // https://www.wolframalpha.com/input/?i=1024+%2F+%2820282409603651670423947251286016+%2F+2**96%29
      const amountRemaining = -4;
      const feePips = 3000;
      const { amountIn, amountOut, sqrtQ, feeAmount } = swapMath.computeSwapStep(sqrtP, sqrtPTarget, liquidity, amountRemaining, feePips);
      expect(amountOut).toEqual(0n);
      expect(sqrtQ).toEqual(sqrtPTarget);
      expect(amountIn).toEqual(26215n);
      expect(feeAmount).toEqual(79n);
    });

    it("handles intermediate insufficient liquidity in one for zero exact output case", () => {
      const sqrtP = 20282409603651670423947251286016n;
      const sqrtPTarget = (sqrtP * 9n) / 10n;
      const liquidity = 1024;
      // virtual reserves of zero are only 262144
      // https://www.wolframalpha.com/input/?i=1024+*+%2820282409603651670423947251286016+%2F+2**96%29
      const amountRemaining = -263000;
      const feePips = 3000;
      const { amountIn, amountOut, sqrtQ, feeAmount } = swapMath.computeSwapStep(sqrtP, sqrtPTarget, liquidity, amountRemaining, feePips);
      expect(amountOut).toEqual(26214n);
      expect(sqrtQ).toEqual(sqrtPTarget);
      expect(amountIn).toEqual(1n);
      expect(feeAmount).toEqual(1n);
    });
  });
});
