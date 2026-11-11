import { System } from "@koinos/sdk-as";
import { U256 } from "./U256";
import { SqrtPriceMath } from "./SqrtPriceMath";

/** result of a single swap step */
export class SwapStepResult {
  constructor(
    /** the price after swapping the amount in/out, not to exceed the price target */
    public sqrtRatioNextX96: U256,
    /** the amount to be swapped in, of either token0 or token1, based on the direction of the swap */
    public amountIn: U256,
    /** the amount to be received, of either token0 or token1, based on the direction of the swap */
    public amountOut: U256,
    /** the amount of input that will be taken as a fee */
    public feeAmount: U256
  ) {}
}

const ONE_MILLION: U256 = U256.fromU64(1000000);

/**
 * Port of Uniswap v3 SwapMath.
 *
 * Contains methods for computing the result of a swap within a single tick price range, i.e., a single tick.
 */
export namespace SwapMath {
  /**
   * Computes the result of swapping some amount in, or amount out, given the parameters of the swap.
   * The fee, plus the amount in, will never exceed the amount remaining if the swap's `amountSpecified` is positive
   *
   * @param sqrtRatioCurrentX96 the current sqrt price of the pool
   * @param sqrtRatioTargetX96 the price that cannot be exceeded, from which the direction of the swap is inferred
   * @param liquidity the usable liquidity
   * @param amountRemaining absolute value of how much input or output amount is remaining to be swapped in/out
   * @param exactIn true if `amountRemaining` is an input amount (Uniswap: amountRemaining >= 0)
   * @param feePips the fee taken from the input amount, expressed in hundredths of a bip
   */
  export function computeSwapStep(
    sqrtRatioCurrentX96: U256,
    sqrtRatioTargetX96: U256,
    liquidity: U256,
    amountRemaining: U256,
    exactIn: bool,
    feePips: u32
  ): SwapStepResult {
    System.require(feePips < 1000000, "KOINDX: INVALID_FEE");
    const zeroForOne = U256.gte(sqrtRatioCurrentX96, sqrtRatioTargetX96);
    const fee = U256.fromU32(feePips);
    const oneMinusFee = U256.fromU32(1000000 - feePips);

    let sqrtRatioNextX96: U256;
    let amountIn = U256.zero();
    let amountOut = U256.zero();

    if (exactIn) {
      const amountRemainingLessFee = U256.mulDiv(amountRemaining, oneMinusFee, ONE_MILLION);
      amountIn = zeroForOne
        ? SqrtPriceMath.getAmount0Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, true)
        : SqrtPriceMath.getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, true);
      if (U256.gte(amountRemainingLessFee, amountIn)) {
        sqrtRatioNextX96 = sqrtRatioTargetX96;
      } else {
        sqrtRatioNextX96 = SqrtPriceMath.getNextSqrtPriceFromInput(
          sqrtRatioCurrentX96,
          liquidity,
          amountRemainingLessFee,
          zeroForOne
        );
      }
    } else {
      amountOut = zeroForOne
        ? SqrtPriceMath.getAmount1Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, false)
        : SqrtPriceMath.getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, false);
      if (U256.gte(amountRemaining, amountOut)) {
        sqrtRatioNextX96 = sqrtRatioTargetX96;
      } else {
        sqrtRatioNextX96 = SqrtPriceMath.getNextSqrtPriceFromOutput(
          sqrtRatioCurrentX96,
          liquidity,
          amountRemaining,
          zeroForOne
        );
      }
    }

    const max = U256.eq(sqrtRatioTargetX96, sqrtRatioNextX96);

    // get the input/output amounts
    if (zeroForOne) {
      amountIn = max && exactIn
        ? amountIn
        : SqrtPriceMath.getAmount0Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, true);
      amountOut = max && !exactIn
        ? amountOut
        : SqrtPriceMath.getAmount1Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, false);
    } else {
      amountIn = max && exactIn
        ? amountIn
        : SqrtPriceMath.getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, true);
      amountOut = max && !exactIn
        ? amountOut
        : SqrtPriceMath.getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, false);
    }

    // cap the output amount to not exceed the remaining output amount
    if (!exactIn && U256.gt(amountOut, amountRemaining)) {
      amountOut = amountRemaining;
    }

    let feeAmount: U256;
    if (exactIn && U256.neq(sqrtRatioNextX96, sqrtRatioTargetX96)) {
      // we didn't reach the target, so take the remainder of the maximum input as fee
      feeAmount = U256.sub(amountRemaining, amountIn);
    } else {
      feeAmount = U256.mulDivRoundingUp(amountIn, fee, oneMinusFee);
    }

    return new SwapStepResult(sqrtRatioNextX96, amountIn, amountOut, feeAmount);
  }
}
