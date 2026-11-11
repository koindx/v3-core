import { U256 } from "./U256";

/** A library for handling binary fixed point numbers (Q64.96) */
export namespace FixedPoint96 {
  export const RESOLUTION: i32 = 96;
  /** 2^96 */
  export const Q96: U256 = new U256(0x0, 0x100000000, 0x0, 0x0);
}

/** A library for handling binary fixed point numbers (Q128.128) */
export namespace FixedPoint128 {
  /** 2^128 */
  export const Q128: U256 = new U256(0x0, 0x0, 0x1, 0x0);
}
