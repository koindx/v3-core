// Port of Uniswap v3-core test/shared/utilities.ts (BigInt instead of ethers BigNumber)

const MaxUint128 = (1n << 128n) - 1n;
const MaxUint256 = (1n << 256n) - 1n;
const MaxUint64 = (1n << 64n) - 1n; // Koinos token balances

const getMinTick = (tickSpacing) => Math.ceil(-887272 / tickSpacing) * tickSpacing;
const getMaxTick = (tickSpacing) => Math.floor(887272 / tickSpacing) * tickSpacing;
const getMaxLiquidityPerTick = (tickSpacing) =>
  MaxUint128 / BigInt((getMaxTick(tickSpacing) - getMinTick(tickSpacing)) / tickSpacing + 1);

const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const FeeAmount = { LOW: 500, MEDIUM: 3000, HIGH: 10000 };
const TICK_SPACINGS = { [FeeAmount.LOW]: 10, [FeeAmount.MEDIUM]: 60, [FeeAmount.HIGH]: 200 };

const expandTo18Decimals = (n) => BigInt(n) * 10n ** 18n;

function isqrt(n) {
  if (n < 2n) return n;
  // Newton's method from an initial value above the square root
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * returns the sqrt price as a Q64.96, exactly like Uniswap's encodePriceSqrt, which uses
 * bignumber.js with 40 decimal places: sqrt(round(reserve1 / reserve0)) rounded half up to 40
 * decimals, times 2^96, rounded down
 */
function encodePriceSqrt(reserve1, reserve0) {
  const SCALE = 10n ** 40n;
  let r1 = BigInt(reserve1);
  let r0 = BigInt(reserve0);
  // the ratio of 2 negative amounts (execution prices)
  if (r0 < 0n) [r1, r0] = [-r1, -r0];
  // division rounded half up to 40 decimals
  let q = (r1 * SCALE) / r0;
  if ((r1 * SCALE) % r0 * 2n >= r0) q += 1n;
  // sqrt rounded half up to 40 decimals: sqrt(q / 10^40) * 10^40 = sqrt(q * 10^40)
  const n = q * SCALE;
  let s = isqrt(n);
  if (4n * n >= (2n * s + 1n) ** 2n) s += 1n;
  return (s << 96n) / SCALE;
}

/** Koinos tokens and amounts are 64 bits: Uniswap tests above this limit are not applicable */
const fitsU64 = (x) => x >= 0n && x <= MaxUint64;

module.exports = {
  MaxUint128,
  MaxUint256,
  MaxUint64,
  getMinTick,
  getMaxTick,
  getMaxLiquidityPerTick,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  FeeAmount,
  TICK_SPACINGS,
  expandTo18Decimals,
  encodePriceSqrt,
  isqrt,
  fitsU64,
};
