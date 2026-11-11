import { System } from "@koinos/sdk-as";
import { U256 } from "./U256";
import { I256 } from "./I256";
import { FixedPoint96 } from "./FixedPoint";
import { SafeCast } from "./SafeCast";

/**
 * Port of Uniswap v3 SqrtPriceMath.
 *
 * Functions based on Q64.96 sqrt price and liquidity. Contains the math that uses square root
 * of price as a Q64.96 and liquidity to compute deltas.
 */
export namespace SqrtPriceMath {
  /**
   * Gets the next sqrt price given a delta of token0.
   * Always rounds up, because in the exact output case (increasing price) we need to move the
   * price at least far enough to get the desired output amount, and in the exact input case
   * (decreasing price) we need to move the price less in order to not send too much output.
   * The most precise formula for this is liquidity * sqrtPX96 / (liquidity +- amount * sqrtPX96),
   * if this is impossible because of overflow, we calculate liquidity / (liquidity / sqrtPX96 +- amount).
   */
  export function getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96: U256, liquidity: U256, amount: U256, add: bool): U256 {
    // we short circuit amount == 0 because the result is otherwise not guaranteed to equal the input price
    if (amount.isZero()) return sqrtPX96;
    const numerator1 = U256.shl(liquidity, FixedPoint96.RESOLUTION);

    if (add) {
      const product = U256.tryMul(amount, sqrtPX96);
      if (product !== null) {
        // wrapping on purpose: an overflow is detected by the comparison below
        const denominator = U256.wrappingAdd(numerator1, product);
        if (U256.gte(denominator, numerator1)) {
          // always fits in 160 bits
          return U256.mulDivRoundingUp(numerator1, sqrtPX96, denominator);
        }
      }
      return U256.divRoundingUp(numerator1, U256.add(U256.div(numerator1, sqrtPX96), amount));
    } else {
      // if the product overflows, we know the denominator underflows
      // in addition, we must check that the denominator does not underflow
      const product = U256.tryMul(amount, sqrtPX96);
      System.require(product !== null && U256.gt(numerator1, product), "KOINDX: PRICE_UNDERFLOW");
      const denominator = U256.sub(numerator1, product!);
      return SafeCast.toUint160(U256.mulDivRoundingUp(numerator1, sqrtPX96, denominator));
    }
  }

  /**
   * Gets the next sqrt price given a delta of token1.
   * Always rounds down, because in the exact output case (decreasing price) we need to move the
   * price at least far enough to get the desired output amount, and in the exact input case
   * (increasing price) we need to move the price less in order to not send too much output.
   * The formula we compute is within <1 wei of the lossless version: sqrtPX96 +- amount / liquidity
   */
  export function getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96: U256, liquidity: U256, amount: U256, add: bool): U256 {
    // if we're adding (subtracting), rounding down requires rounding the quotient down (up)
    if (add) {
      const quotient = U256.mulDiv(amount, FixedPoint96.Q96, liquidity);
      return SafeCast.toUint160(U256.add(sqrtPX96, quotient));
    } else {
      const quotient = U256.mulDivRoundingUp(amount, FixedPoint96.Q96, liquidity);
      System.require(U256.gt(sqrtPX96, quotient), "KOINDX: PRICE_UNDERFLOW");
      // always fits 160 bits
      return U256.sub(sqrtPX96, quotient);
    }
  }

  /**
   * Gets the next sqrt price given an input amount of token0 or token1.
   * Throws if price or liquidity are 0, or if the next price is out of bounds
   */
  export function getNextSqrtPriceFromInput(sqrtPX96: U256, liquidity: U256, amountIn: U256, zeroForOne: bool): U256 {
    System.require(!sqrtPX96.isZero(), "KOINDX: ZERO_PRICE");
    System.require(!liquidity.isZero(), "KOINDX: ZERO_LIQUIDITY");

    // round to make sure that we don't pass the target price
    return zeroForOne
      ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
      : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
  }

  /**
   * Gets the next sqrt price given an output amount of token0 or token1.
   * Throws if price or liquidity are 0 or the next price is out of bounds
   */
  export function getNextSqrtPriceFromOutput(sqrtPX96: U256, liquidity: U256, amountOut: U256, zeroForOne: bool): U256 {
    System.require(!sqrtPX96.isZero(), "KOINDX: ZERO_PRICE");
    System.require(!liquidity.isZero(), "KOINDX: ZERO_LIQUIDITY");

    // round to make sure that we pass the target price
    return zeroForOne
      ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
      : getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false);
  }

  /**
   * Gets the amount0 delta between two prices.
   * Calculates liquidity / sqrt(lower) - liquidity / sqrt(upper),
   * i.e. liquidity * (sqrt(upper) - sqrt(lower)) / (sqrt(upper) * sqrt(lower))
   */
  export function getAmount0Delta(sqrtRatioAX96: U256, sqrtRatioBX96: U256, liquidity: U256, roundUp: bool): U256 {
    if (U256.gt(sqrtRatioAX96, sqrtRatioBX96)) {
      const tmp = sqrtRatioAX96;
      sqrtRatioAX96 = sqrtRatioBX96;
      sqrtRatioBX96 = tmp;
    }

    const numerator1 = U256.shl(liquidity, FixedPoint96.RESOLUTION);
    const numerator2 = U256.sub(sqrtRatioBX96, sqrtRatioAX96);

    System.require(!sqrtRatioAX96.isZero(), "KOINDX: ZERO_PRICE");

    return roundUp
      ? U256.divRoundingUp(U256.mulDivRoundingUp(numerator1, numerator2, sqrtRatioBX96), sqrtRatioAX96)
      : U256.div(U256.mulDiv(numerator1, numerator2, sqrtRatioBX96), sqrtRatioAX96);
  }

  /**
   * Gets the amount1 delta between two prices.
   * Calculates liquidity * (sqrt(upper) - sqrt(lower))
   */
  export function getAmount1Delta(sqrtRatioAX96: U256, sqrtRatioBX96: U256, liquidity: U256, roundUp: bool): U256 {
    if (U256.gt(sqrtRatioAX96, sqrtRatioBX96)) {
      const tmp = sqrtRatioAX96;
      sqrtRatioAX96 = sqrtRatioBX96;
      sqrtRatioBX96 = tmp;
    }

    return roundUp
      ? U256.mulDivRoundingUp(liquidity, U256.sub(sqrtRatioBX96, sqrtRatioAX96), FixedPoint96.Q96)
      : U256.mulDiv(liquidity, U256.sub(sqrtRatioBX96, sqrtRatioAX96), FixedPoint96.Q96);
  }

  /**
   * Helper that gets signed token0 delta.
   * Rounds up when liquidity is added (amount owed to the pool) and down when removed.
   */
  export function getAmount0DeltaSigned(sqrtRatioAX96: U256, sqrtRatioBX96: U256, liquidity: I256): I256 {
    return liquidity.isNegative()
      ? new I256(true, getAmount0Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity.abs, false))
      : new I256(false, getAmount0Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity.abs, true));
  }

  /**
   * Helper that gets signed token1 delta.
   * Rounds up when liquidity is added (amount owed to the pool) and down when removed.
   */
  export function getAmount1DeltaSigned(sqrtRatioAX96: U256, sqrtRatioBX96: U256, liquidity: I256): I256 {
    return liquidity.isNegative()
      ? new I256(true, getAmount1Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity.abs, false))
      : new I256(false, getAmount1Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity.abs, true));
  }
}
