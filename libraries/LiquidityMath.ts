import { System } from "@koinos/sdk-as";
import { U256 } from "./U256";
import { I256 } from "./I256";

const UINT128_BITS = 128;

/** Port of Uniswap v3 LiquidityMath: math library for liquidity */
export namespace LiquidityMath {
  /**
   * Add a signed liquidity delta to liquidity and revert if it overflows (uint128) or underflows
   * @param x the liquidity before change
   * @param y the delta by which liquidity should be changed
   * @returns the liquidity delta
   */
  export function addDelta(x: U256, y: I256): U256 {
    if (y.isNegative()) {
      System.require(U256.lte(y.abs, x), "KOINDX: LIQUIDITY_SUB");
      return U256.sub(x, y.abs);
    }
    const z = U256.add(x, y.abs);
    System.require(z.fitsBits(UINT128_BITS) && U256.gte(z, x), "KOINDX: LIQUIDITY_ADD");
    return z;
  }
}
