// Port of Uniswap v3-core test/shared/format.ts (decimal.js) with exact BigInt arithmetic

/**
 * exactly like decimal.js toPrecision(5) with toExpNeg -500 / toExpPos 500 (Uniswap's format.ts),
 * for the rational n / d (rounded half up)
 */
function toPrecision5(n, d) {
  if (d < 0n) [n, d] = [-n, -d];
  if (d === 0n) return n > 0n ? "Infinity" : n < 0n ? "-Infinity" : "NaN";
  if (n === 0n) return "0.0000";
  const negative = n < 0n;
  if (negative) n = -n;
  // exponent e such that 10^e <= n/d < 10^(e+1)
  let e = n.toString().length - d.toString().length;
  const pow = (k) => 10n ** BigInt(k);
  const ge = (k) => (k >= 0 ? n >= d * pow(k) : n * pow(-k) >= d);
  if (!ge(e)) e--;
  // 5 significant digits, rounded half up
  const scaled = (num, den) => {
    const q = num / den;
    return (num % den) * 2n >= den ? q + 1n : q;
  };
  let digits = 4 - e >= 0 ? scaled(n * pow(4 - e), d) : scaled(n, d * pow(e - 4));
  if (digits === 100000n) {
    digits = 10000n;
    e++;
  }
  const s = digits.toString();
  let str;
  if (e >= 5) str = `${s[0]}.${s.slice(1)}e+${e}`;
  else if (e >= 0) str = e === 4 ? s : `${s.slice(0, e + 1)}.${s.slice(e + 1)}`;
  else str = `0.${"0".repeat(-e - 1)}${s}`;
  return negative ? `-${str}` : str;
}

const formatTokenAmount = (num) => toPrecision5(BigInt(num), 10n ** 18n);
const formatPrice = (price) => toPrecision5(BigInt(price) ** 2n, 1n << 192n);

module.exports = { toPrecision5, formatTokenAmount, formatPrice };
