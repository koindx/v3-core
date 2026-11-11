import { System } from "@koinos/sdk-as";
import { U256 } from "./U256";

/** Port of Uniswap v3 SafeCast: safe casting methods that revert instead of truncating */
export namespace SafeCast {
  /** reverts if `value` doesn't fit in an uint128 */
  export function toUint128(value: U256): U256 {
    System.require(value.fitsBits(128), "KOINDX: UINT128_OVERFLOW");
    return value;
  }

  /** reverts if `value` doesn't fit in an uint160 */
  export function toUint160(value: U256): U256 {
    System.require(value.fitsBits(160), "KOINDX: UINT160_OVERFLOW");
    return value;
  }

  /**
   * a + b, reverts if the result doesn't fit in an uint128. Not used by the pool: like Uniswap,
   * the uint128 accumulators (tokens owed, protocol fees) wrap around, see docs/OVERFLOW.md
   */
  export function addUint128(a: U256, b: U256): U256 {
    return toUint128(U256.add(a, b));
  }

  /** converts a token amount to u64, reverts if it doesn't fit (Koinos tokens use 64 bits) */
  export function toU64(value: U256): u64 {
    System.require(value.fitsBits(64), "KOINDX: AMOUNT_OVERFLOW");
    return value.w0;
  }
}
