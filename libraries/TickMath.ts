import { System } from "@koinos/sdk-as";
import { U256 } from "./U256";

/**
 * Port of Uniswap v3 TickMath.
 *
 * Computes sqrt price for ticks of size 1.0001, i.e. sqrt(1.0001^tick) as fixed point Q64.96
 * numbers. Supports prices between 2^-128 and 2^128.
 */
export namespace TickMath {
  /** the minimum tick that may be passed to getSqrtRatioAtTick computed from log base 1.0001 of 2^-128 */
  export const MIN_TICK: i32 = -887272;
  /** the maximum tick that may be passed to getSqrtRatioAtTick computed from log base 1.0001 of 2^128 */
  export const MAX_TICK: i32 = 887272;

  /** getSqrtRatioAtTick(MIN_TICK) = 4295128739 */
  export const MIN_SQRT_RATIO: U256 = new U256(0x1000276a3, 0x0, 0x0, 0x0);
  /** getSqrtRatioAtTick(MAX_TICK) = 1461446703485210103287273052203988822378723970342 */
  export const MAX_SQRT_RATIO: U256 = new U256(0x5d951d5263988d26, 0xefd1fc6a50648849, 0xfffd8963, 0x0);

  // ratio multipliers for each bit of the absolute tick (Q128.128)
  const RATIO_BIT_0: U256 = new U256(0xaa2d162d1a594001, 0xfffcb933bd6fad37, 0x0, 0x0);
  const Q128: U256 = new U256(0x0, 0x0, 0x1, 0x0);
  const RATIO_BITS: StaticArray<U256> = [
    new U256(0x59a46990580e213a, 0xfff97272373d4132, 0x0, 0x0), // 0x2
    new U256(0xef12357cf3c7fdcc, 0xfff2e50f5f656932, 0x0, 0x0), // 0x4
    new U256(0x1c3624eaa0941cd0, 0xffe5caca7e10e4e6, 0x0, 0x0), // 0x8
    new U256(0xc9db58835c926644, 0xffcb9843d60f6159, 0x0, 0x0), // 0x10
    new U256(0x472e6896dfb254c0, 0xff973b41fa98c081, 0x0, 0x0), // 0x20
    new U256(0x43ec78b326b52861, 0xff2ea16466c96a38, 0x0, 0x0), // 0x40
    new U256(0x11c461f1969c3053, 0xfe5dee046a99a2a8, 0x0, 0x0), // 0x80
    new U256(0xdcffc83b479aa3a4, 0xfcbe86c7900a88ae, 0x0, 0x0), // 0x100
    new U256(0x6f2b074cf7815e54, 0xf987a7253ac41317, 0x0, 0x0), // 0x200
    new U256(0x940c7a398e4b70f3, 0xf3392b0822b70005, 0x0, 0x0), // 0x400
    new U256(0x43b29c7fa6e889d9, 0xe7159475a2c29b74, 0x0, 0x0), // 0x800
    new U256(0x845ad8f792aa5825, 0xd097f3bdfd2022b8, 0x0, 0x0), // 0x1000
    new U256(0x8a65dc1f90e061e5, 0xa9f746462d870fdf, 0x0, 0x0), // 0x2000
    new U256(0x90bb3df62baf32f7, 0x70d869a156d2a1b8, 0x0, 0x0), // 0x4000
    new U256(0x81231505542fcfa6, 0x31be135f97d08fd9, 0x0, 0x0), // 0x8000
    new U256(0xc677de54f3e99bc9, 0x9aa508b5b7a84e1, 0x0, 0x0), // 0x10000
    new U256(0x6699c329225ee604, 0x5d6af8dedb8119, 0x0, 0x0), // 0x20000
    new U256(0x1ea926041bedfe98, 0x2216e584f5fa, 0x0, 0x0), // 0x40000
    new U256(0x91f7dc42444e8fa2, 0x48a1703, 0x0, 0x0), // 0x80000
  ];

  // log_sqrt(1.0001) of 2 as a Q128.128 number = 255738958999603826347141
  const LOG_SQRT10001_MULTIPLIER: U256 = new U256(0xa301d71055774c85, 0x3627, 0x0, 0x0);
  // 3402992956809132418596140100660247210
  const TICK_LOW_ERROR: U256 = new U256(0x5af012a19d003aaa, 0x28f6481ab7f045a, 0x0, 0x0);
  // 291339464771989622907027621153398088495
  const TICK_HI_ERROR: U256 = new U256(0x455e260799a0632f, 0xdb2df09e81959a81, 0x0, 0x0);

  /**
   * Calculates sqrt(1.0001^tick) * 2^96
   * @param tick the input tick for the above formula
   * @returns a Fixed point Q64.96 number representing the sqrt of the ratio of the two assets (token1/token0)
   */
  export function getSqrtRatioAtTick(tick: i32): U256 {
    // Uniswap: int24 tick, |tick| <= MAX_TICK (checked before the absolute value: -i32.MIN_VALUE overflows)
    System.require(tick >= MIN_TICK && tick <= MAX_TICK, "KOINDX: TICK_OUT_OF_RANGE");
    const absTick: i32 = tick < 0 ? -tick : tick;

    let ratio: U256 = (absTick & 0x1) != 0 ? RATIO_BIT_0 : Q128;
    for (let i = 1; i < 20; i++) {
      if ((absTick & (1 << i)) != 0) {
        ratio = U256.shr(U256.mul(ratio, unchecked(RATIO_BITS[i - 1])), 128);
      }
    }

    if (tick > 0) ratio = U256.div(U256.max(), ratio);

    // this divides by 1<<32 rounding up to go from a Q128.128 to a Q128.96.
    // the result always fits within 160 bits due to the tick input constraint
    const rounding: u64 = (ratio.w0 & 0xFFFFFFFF) == 0 ? 0 : 1;
    return U256.add(U256.shr(ratio, 32), U256.fromU64(rounding));
  }

  /**
   * Calculates the greatest tick value such that getRatioAtTick(tick) <= ratio
   * @param sqrtPriceX96 the sqrt ratio for which to compute the tick as a Q64.96
   * @returns the greatest tick for which the ratio is less than or equal to the input ratio
   */
  export function getTickAtSqrtRatio(sqrtPriceX96: U256): i32 {
    // second inequality must be < because the price can never reach the price at the max tick
    System.require(
      U256.gte(sqrtPriceX96, MIN_SQRT_RATIO) && U256.lt(sqrtPriceX96, MAX_SQRT_RATIO),
      "KOINDX: SQRT_PRICE_OUT_OF_RANGE"
    );
    const ratio = U256.shl(sqrtPriceX96, 32);

    const msb = ratio.bitLength() - 1;
    let r: U256 = msb >= 128 ? U256.shr(ratio, msb - 127) : U256.shl(ratio, 127 - msb);

    // integer part of log_2, as a two's complement int256 shifted by 64 bits (may be negative)
    let log2: U256 = msb >= 128
      ? U256.shl(U256.fromU64(<u64>(msb - 128)), 64)
      : U256.wrappingSub(U256.zero(), U256.shl(U256.fromU64(<u64>(128 - msb)), 64));

    // fractional part of log_2 (14 bits of precision, from bit 63 down to bit 50)
    let fraction: u64 = 0;
    for (let bit = 63; bit >= 50; bit--) {
      r = U256.shr(U256.mul(r, r), 127);
      if (r.testBit(128)) {
        fraction |= (<u64>1) << (<u64>bit);
        r = U256.shr(r, 1);
      }
    }
    log2 = U256.or(log2, U256.fromU64(fraction));

    // 128.128 number (two's complement arithmetic: log2 may be negative, wrapping is intended)
    const logSqrt10001 = U256.wrappingMul(log2, LOG_SQRT10001_MULTIPLIER);

    const tickLow = toInt24(U256.sar(U256.wrappingSub(logSqrt10001, TICK_LOW_ERROR), 128));
    const tickHi = toInt24(U256.sar(U256.wrappingAdd(logSqrt10001, TICK_HI_ERROR), 128));

    if (tickLow == tickHi) return tickLow;
    return U256.lte(getSqrtRatioAtTick(tickHi), sqrtPriceX96) ? tickHi : tickLow;
  }

  /** interprets the low bits of a two's complement value as a signed integer */
  function toInt24(value: U256): i32 {
    return <i32>(<i64>value.w0);
  }
}
