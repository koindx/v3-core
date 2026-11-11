// BigInt transliteration of the Uniswap v3 Solidity math (including every `require` and the
// uint256 wrapping semantics). Used as the reference implementation in the differential tests.

const MAX256 = (1n << 256n) - 1n;
const Q96 = 1n << 96n;
const Q128 = 1n << 128n;

class Revert extends Error {}

function req(cond, msg = "revert") {
  if (!cond) throw new Revert(msg);
}

const wrap = (x) => ((x % (1n << 256n)) + (1n << 256n)) % (1n << 256n);

// FullMath ---------------------------------------------------------------------
function mulDiv(a, b, d) {
  req(d > 0n);
  const r = (a * b) / d;
  req(r <= MAX256);
  return r;
}
function mulDivRoundingUp(a, b, d) {
  let r = mulDiv(a, b, d);
  if ((a * b) % d > 0n) {
    req(r < MAX256);
    r++;
  }
  return r;
}
function divRoundingUp(x, y) {
  req(y > 0n);
  return x / y + (x % y > 0n ? 1n : 0n);
}

// TickMath ---------------------------------------------------------------------
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const RATIOS = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

function getSqrtRatioAtTick(tick) {
  const absTick = BigInt(Math.abs(tick));
  req(absTick <= BigInt(MAX_TICK), "T");
  let ratio = (absTick & 1n) !== 0n ? RATIOS[0] : 1n << 128n;
  for (let i = 1; i < 20; i++) {
    if ((absTick & (1n << BigInt(i))) !== 0n) ratio = (ratio * RATIOS[i]) >> 128n;
  }
  if (tick > 0) ratio = MAX256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

function getTickAtSqrtRatio(sqrtPriceX96) {
  req(sqrtPriceX96 >= MIN_SQRT_RATIO && sqrtPriceX96 < MAX_SQRT_RATIO, "R");
  const ratio = sqrtPriceX96 << 32n;
  let msb = BigInt(ratio.toString(2).length - 1);
  let r = msb >= 128n ? ratio >> (msb - 127n) : ratio << (127n - msb);
  let log2 = (msb - 128n) << 64n;
  for (let bit = 63n; bit >= 50n; bit--) {
    r = (r * r) >> 127n;
    const f = r >> 128n;
    log2 = log2 | (f << bit);
    r = r >> f;
  }
  const logSqrt10001 = log2 * 255738958999603826347141n;
  const tickLow = Number((logSqrt10001 - 3402992956809132418596140100660247210n) >> 128n);
  const tickHi = Number((logSqrt10001 + 291339464771989622907027621153398088495n) >> 128n);
  if (tickLow === tickHi) return tickLow;
  return getSqrtRatioAtTick(tickHi) <= sqrtPriceX96 ? tickHi : tickLow;
}

// SqrtPriceMath ----------------------------------------------------------------
function toUint160(x) {
  req(x < 1n << 160n);
  return x;
}

function getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amount, add) {
  if (amount === 0n) return sqrtPX96;
  const numerator1 = liquidity << 96n;
  if (add) {
    const product = wrap(amount * sqrtPX96);
    if (product / amount === sqrtPX96) {
      const denominator = wrap(numerator1 + product);
      if (denominator >= numerator1) return mulDivRoundingUp(numerator1, sqrtPX96, denominator) % (1n << 160n);
    }
    const sum = numerator1 / sqrtPX96 + amount;
    req(sum <= MAX256);
    return divRoundingUp(numerator1, sum) % (1n << 160n);
  } else {
    const product = wrap(amount * sqrtPX96);
    req(product / amount === sqrtPX96 && numerator1 > product);
    const denominator = numerator1 - product;
    return toUint160(mulDivRoundingUp(numerator1, sqrtPX96, denominator));
  }
}

function getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amount, add) {
  if (add) {
    const quotient = amount <= (1n << 160n) - 1n ? (amount << 96n) / liquidity : mulDiv(amount, Q96, liquidity);
    const sum = sqrtPX96 + quotient;
    req(sum <= MAX256);
    return toUint160(sum);
  } else {
    const quotient =
      amount <= (1n << 160n) - 1n ? divRoundingUp(amount << 96n, liquidity) : mulDivRoundingUp(amount, Q96, liquidity);
    req(sqrtPX96 > quotient);
    return sqrtPX96 - quotient;
  }
}

function getNextSqrtPriceFromInput(sqrtPX96, liquidity, amountIn, zeroForOne) {
  req(sqrtPX96 > 0n);
  req(liquidity > 0n);
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
}

function getNextSqrtPriceFromOutput(sqrtPX96, liquidity, amountOut, zeroForOne) {
  req(sqrtPX96 > 0n);
  req(liquidity > 0n);
  return zeroForOne
    ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
    : getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false);
}

function getAmount0Delta(a, b, liquidity, roundUp) {
  if (a > b) [a, b] = [b, a];
  const numerator1 = liquidity << 96n;
  const numerator2 = b - a;
  req(a > 0n);
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, b), a)
    : mulDiv(numerator1, numerator2, b) / a;
}

function getAmount1Delta(a, b, liquidity, roundUp) {
  if (a > b) [a, b] = [b, a];
  return roundUp ? mulDivRoundingUp(liquidity, b - a, Q96) : mulDiv(liquidity, b - a, Q96);
}

// SwapMath ---------------------------------------------------------------------
function computeSwapStep(current, target, liquidity, amountRemaining, feePips) {
  const fee = BigInt(feePips);
  const zeroForOne = current >= target;
  const exactIn = amountRemaining >= 0n;
  let next, amountIn = 0n, amountOut = 0n, feeAmount;
  if (exactIn) {
    const lessFee = mulDiv(amountRemaining, 1000000n - fee, 1000000n);
    amountIn = zeroForOne ? getAmount0Delta(target, current, liquidity, true) : getAmount1Delta(current, target, liquidity, true);
    next = lessFee >= amountIn ? target : getNextSqrtPriceFromInput(current, liquidity, lessFee, zeroForOne);
  } else {
    amountOut = zeroForOne ? getAmount1Delta(target, current, liquidity, false) : getAmount0Delta(current, target, liquidity, false);
    next = -amountRemaining >= amountOut ? target : getNextSqrtPriceFromOutput(current, liquidity, -amountRemaining, zeroForOne);
  }
  const max = target === next;
  if (zeroForOne) {
    amountIn = max && exactIn ? amountIn : getAmount0Delta(next, current, liquidity, true);
    amountOut = max && !exactIn ? amountOut : getAmount1Delta(next, current, liquidity, false);
  } else {
    amountIn = max && exactIn ? amountIn : getAmount1Delta(current, next, liquidity, true);
    amountOut = max && !exactIn ? amountOut : getAmount0Delta(current, next, liquidity, false);
  }
  if (!exactIn && amountOut > -amountRemaining) amountOut = -amountRemaining;
  if (exactIn && next !== target) feeAmount = amountRemaining - amountIn;
  else feeAmount = mulDivRoundingUp(amountIn, fee, 1000000n - fee);
  return [next, amountIn, amountOut, feeAmount];
}

// LiquidityMath ----------------------------------------------------------------
function addDelta(x, y) {
  if (y < 0n) {
    const z = x + y;
    req(z >= 0n, "LS");
    return z;
  }
  const z = x + y;
  req(z < 1n << 128n, "LA");
  return z;
}

// LiquidityAmounts -------------------------------------------------------------
function toUint128(x) {
  req(x < 1n << 128n);
  return x;
}
function getLiquidityForAmount0(a, b, amount0) {
  if (a > b) [a, b] = [b, a];
  const intermediate = mulDiv(a, b, Q96);
  return toUint128(mulDiv(amount0, intermediate, b - a));
}
function getLiquidityForAmount1(a, b, amount1) {
  if (a > b) [a, b] = [b, a];
  return toUint128(mulDiv(amount1, Q96, b - a));
}
function getLiquidityForAmounts(p, a, b, amount0, amount1) {
  if (a > b) [a, b] = [b, a];
  if (p <= a) return getLiquidityForAmount0(a, b, amount0);
  if (p < b) {
    const l0 = getLiquidityForAmount0(p, b, amount0);
    const l1 = getLiquidityForAmount1(a, p, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return getLiquidityForAmount1(a, b, amount1);
}
function getAmount0ForLiquidity(a, b, liquidity) {
  if (a > b) [a, b] = [b, a];
  return mulDiv(liquidity << 96n, b - a, b) / a;
}
function getAmount1ForLiquidity(a, b, liquidity) {
  if (a > b) [a, b] = [b, a];
  return mulDiv(liquidity, b - a, Q96);
}
function getAmountsForLiquidity(p, a, b, liquidity) {
  if (a > b) [a, b] = [b, a];
  if (p <= a) return [getAmount0ForLiquidity(a, b, liquidity), 0n];
  if (p < b) return [getAmount0ForLiquidity(p, b, liquidity), getAmount1ForLiquidity(a, p, liquidity)];
  return [0n, getAmount1ForLiquidity(a, b, liquidity)];
}

module.exports = {
  MAX256, Q96, Q128, Revert, MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO,
  mulDiv, mulDivRoundingUp, divRoundingUp,
  getSqrtRatioAtTick, getTickAtSqrtRatio,
  getNextSqrtPriceFromInput, getNextSqrtPriceFromOutput, getAmount0Delta, getAmount1Delta,
  computeSwapStep, addDelta,
  toUint128, getLiquidityForAmount0, getLiquidityForAmount1, getLiquidityForAmounts,
  getAmount0ForLiquidity, getAmount1ForLiquidity, getAmountsForLiquidity,
};
