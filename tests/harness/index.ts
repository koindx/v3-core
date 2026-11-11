// Test harness: exposes the pure math libraries with string based inputs/outputs so they can be
// compared (differential testing) against BigInt and the official @uniswap/v3-sdk from Node.js.
import { U256 } from "../../libraries/U256";
import { I256 } from "../../libraries/I256";
import { TickMath } from "../../libraries/TickMath";
import { SqrtPriceMath } from "../../libraries/SqrtPriceMath";
import { SwapMath } from "../../libraries/SwapMath";
import { LiquidityMath } from "../../libraries/LiquidityMath";
import { SafeCast } from "../../libraries/SafeCast";

function u(s: string): U256 {
  return U256.fromString(s);
}

// U256 (tests/harness/u256.ts, shared with v3-periphery) ----------------------

export * from "./u256";

// I256 -------------------------------------------------------------------------

export function i256Add(a: string, b: string): string { return I256.add(I256.fromString(a), I256.fromString(b)).toString(); }
export function i256Sub(a: string, b: string): string { return I256.sub(I256.fromString(a), I256.fromString(b)).toString(); }
export function i256CheckInt128(a: string): string { return I256.fromString(a).checkInt128().toString(); }
export function i256BytesRoundTrip(a: string): string { return I256.fromBytes(I256.fromString(a).toBytes()).toString(); }

// TickMath ---------------------------------------------------------------------

export function getSqrtRatioAtTick(tick: i32): string { return TickMath.getSqrtRatioAtTick(tick).toString(); }
export function getTickAtSqrtRatio(sqrtPriceX96: string): i32 { return TickMath.getTickAtSqrtRatio(u(sqrtPriceX96)); }

// SqrtPriceMath ----------------------------------------------------------------

export function getNextSqrtPriceFromInput(sqrtP: string, liquidity: string, amountIn: string, zeroForOne: bool): string {
  return SqrtPriceMath.getNextSqrtPriceFromInput(u(sqrtP), u(liquidity), u(amountIn), zeroForOne).toString();
}
export function getNextSqrtPriceFromOutput(sqrtP: string, liquidity: string, amountOut: string, zeroForOne: bool): string {
  return SqrtPriceMath.getNextSqrtPriceFromOutput(u(sqrtP), u(liquidity), u(amountOut), zeroForOne).toString();
}
export function getAmount0Delta(a: string, b: string, liquidity: string, roundUp: bool): string {
  return SqrtPriceMath.getAmount0Delta(u(a), u(b), u(liquidity), roundUp).toString();
}
export function getAmount1Delta(a: string, b: string, liquidity: string, roundUp: bool): string {
  return SqrtPriceMath.getAmount1Delta(u(a), u(b), u(liquidity), roundUp).toString();
}

// SwapMath ---------------------------------------------------------------------

export function computeSwapStep(current: string, target: string, liquidity: string, amountRemaining: string, feePips: u32): string {
  const remaining = I256.fromString(amountRemaining);
  const res = SwapMath.computeSwapStep(u(current), u(target), u(liquidity), remaining.abs, !remaining.isNegative(), feePips);
  return res.sqrtRatioNextX96.toString() + "," + res.amountIn.toString() + "," + res.amountOut.toString() + "," + res.feeAmount.toString();
}

// LiquidityMath ----------------------------------------------------------------

export function addDelta(x: string, y: string): string { return LiquidityMath.addDelta(u(x), I256.fromString(y)).toString(); }

// SafeCast ---------------------------------------------------------------------

export function addUint128(a: string, b: string): string { return SafeCast.addUint128(u(a), u(b)).toString(); }
export function toU64(a: string): string { return SafeCast.toU64(u(a)).toString(); }
