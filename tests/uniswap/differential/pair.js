// Paired drivers of the edge case tests (PoolEdges.test.js): every operation runs on KoinDX (the
// compiled pool in the Koinos VM emulator) and on the Uniswap reference (the Uniswap v3 bytecode in
// an EVM), the outcomes and the whole states must be equal, and quote_swap must predict each swap.
const { TransactionError } = require("../../vm/koinos-vm");
const { UniswapEVM, EvmRevert, MIN_SQRT_RATIO, MAX_SQRT_RATIO } = require("../evm/uniswap-evm");
const { poolFixture, createPoolFunctions, transfers } = require("../shared/fixtures");
const { getMinTick, getMaxTick, MaxUint64 } = require("../shared/utilities");
const { callString } = require("../../harness");

const sqrtRatioAtTick = (tick) => BigInt(callString("getSqrtRatioAtTick", tick));

const KOINDX_REASONS = {
  LOCKED: "LOK",
  ALREADY_INITIALIZED: "AI",
  LIQUIDITY_OVERFLOW: "LO",
  LIQUIDITY_SUB: "LS",
  LIQUIDITY_ADD: "LA",
  NO_POSITION: "NP",
  OBSERVATION_TOO_OLD: "OLD",
  OBSERVATIONS_NOT_INITIALIZED: "I",
  SQRT_PRICE_OUT_OF_RANGE: "R",
  TICK_OUT_OF_RANGE: "T",
  AMOUNT_OVERFLOW: "BALANCE",
  TICK_NOT_INITIALIZED: "",
  TICK_NOT_SPACED: "",
  ZERO_LIQUIDITY: "",
  INVALID_FEE_PROTOCOL: "",
  FORBIDDEN: "",
  SPL: "SPL",
  AS: "AS",
  TLU: "TLU",
  TLM: "TLM",
  TUM: "TUM",
  L: "L",
  F0: "F0",
  F1: "F1",
  M0: "M0",
  M1: "M1",
  IIA: "IIA",
};
function koindxReason(message) {
  if (message.includes("insufficient balance")) return "BALANCE";
  const reason = message.replace(/^KOINDX: /, "");
  return reason in KOINDX_REASONS ? KOINDX_REASONS[reason] : reason;
}
function uniswapReason(message) {
  if (message === "reverted without a reason") return "";
  if (message === "insufficient balance" || message === "TF") return "BALANCE";
  return message;
}
const nonZero = (list) =>
  list
    .map((t) => t.value)
    .filter((v) => v !== 0n)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const S = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

function koindx(fee, tickSpacing) {
  const fixture = poolFixture();
  const { wallet, other, token0, token1 } = fixture;
  const pool = fixture.createPool(fee, tickSpacing);
  const fns = createPoolFunctions({ fixture, swapTarget: fixture.swapTargetCallee, token0, token1, pool });
  const who = (n) => (n === "other" ? other : wallet);
  const run = (fn) => {
    fixture.approve(fixture.swapTargetCallee);
    try {
      const { events } = fn();
      return { ok: true, transfers: [nonZero(transfers(events, token0)), nonZero(transfers(events, token1))] };
    } catch (e) {
      if (!(e instanceof TransactionError)) throw e;
      return Object.defineProperty({ ok: false, reason: koindxReason(e.message) }, "message", { value: e.message });
    }
  };
  const read = (fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      if (!(e instanceof TransactionError)) throw e;
      return Object.defineProperty({ ok: false, reason: koindxReason(e.message) }, "message", { value: e.message });
    }
  };
  return {
    fixture,
    pool,
    fns,
    initialize: (p) => run(() => pool.initialize(p)),
    mint: (o, l, u, liq) => run(() => fns.mint(who(o), l, u, liq)),
    burn: (o, l, u, a) => run(() => pool.burn(l, u, a, who(o))),
    collect: (o, l, u, a0, a1) => run(() => pool.collect(other, l, u, a0, a1, who(o))),
    swap: (z, amt, limit) => {
      const f = z ? (amt > 0n ? fns.swapExact0For1 : fns.swap0ForExact1) : amt > 0n ? fns.swapExact1For0 : fns.swap1ForExact0;
      return run(() => f(amt > 0n ? amt : -amt, other, limit));
    },
    quote: (z, amt, limit) =>
      read(() => {
        if (limit === undefined) limit = z ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
        const r = pool.read("quote_swap", {
          zeroForOne: z,
          exactInput: amt > 0n,
          amountSpecified: (amt > 0n ? amt : -amt).toString(),
          sqrtPriceLimitX96: limit.toString(),
        });
        return {
          amountIn: BigInt(r.amountIn || 0),
          amountOut: BigInt(r.amountOut || 0),
          sqrtPriceX96After: BigInt(r.sqrtPriceX96After),
          tickAfter: r.tickAfter || 0,
          crossed: r.initializedTicksCrossed || 0,
        };
      }),
    flash: (a0, a1, p0, p1) => run(() => fns.flash(a0, a1, other, p0, p1)),
    grow: (n) => run(() => pool.increaseObservationCardinalityNext(n)),
    setFeeProtocol: (f0, f1, o) => run(() => pool.setFeeProtocol(f0, f1, who(o))),
    collectProtocol: (a0, a1) => run(() => pool.collectProtocol(other, a0, a1)),
    advanceTime: (s) => pool.advanceTime(s),
    observe: (sa) => read(() => pool.observe(sa)),
    snapshot: (l, u) => read(() => pool.snapshotCumulativesInside(l, u)),
    setFeeGrowthGlobal0X128: (v) => pool.setFeeGrowthGlobal0X128(v),
    setFeeGrowthGlobal1X128: (v) => pool.setFeeGrowthGlobal1X128(v),
    state(ticks, positions, nObs = 40) {
      const slot0 = pool.slot0();
      const observations = [];
      for (let i = 0; i < Math.min(slot0.observationCardinalityNext, nObs); i++) observations.push(pool.observations(i));
      return {
        slot0,
        liquidity: pool.liquidity(),
        feeGrowthGlobal0X128: pool.feeGrowthGlobal0X128(),
        feeGrowthGlobal1X128: pool.feeGrowthGlobal1X128(),
        protocolFees: pool.protocolFees(),
        balances: [token0.balanceOf(pool.address), token1.balanceOf(pool.address)],
        ticks: ticks.map((t) => [t, pool.ticks(t)]),
        positions: positions.map(([o, l, u]) => [o, l, u, pool.positions(who(o), l, u)]),
        observations,
      };
    },
  };
}

async function uniswap(fee, tickSpacing) {
  const uni = await UniswapEVM.create({ tokenSupply: MaxUint64, gasLimit: 10n ** 10n });
  const pool = await uni.createPool(fee, tickSpacing);
  const who = (n) => (n === "other" ? uni.other : uni.wallet);
  const run = async (fn) => {
    try {
      const { events } = await fn();
      return { ok: true, transfers: [nonZero(uni.transfers(events, uni.token0)), nonZero(uni.transfers(events, uni.token1))] };
    } catch (e) {
      if (!(e instanceof EvmRevert)) throw e;
      return { ok: false, reason: uniswapReason(e.message) };
    }
  };
  const read = async (fn) => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (!(e instanceof EvmRevert)) throw e;
      return { ok: false, reason: uniswapReason(e.message) };
    }
  };
  return {
    uni,
    pool,
    initialize: (p) => run(() => pool.initialize(p)),
    mint: (o, l, u, liq) => run(() => pool.mint(who(o), l, u, liq)),
    burn: (o, l, u, a) => run(() => pool.burn(l, u, a, who(o))),
    collect: (o, l, u, a0, a1) => run(() => pool.collect(uni.other, l, u, a0, a1, who(o))),
    swap: (z, amt, limit) => run(() => pool.swap(z, amt, uni.other, limit)),
    flash: (a0, a1, p0, p1) => run(() => pool.flash(a0, a1, uni.other, p0, p1)),
    grow: (n) => run(() => pool.increaseObservationCardinalityNext(n)),
    setFeeProtocol: (f0, f1, o) => run(() => pool.setFeeProtocol(f0, f1, who(o))),
    collectProtocol: (a0, a1) => run(() => pool.collectProtocol(uni.other, a0, a1)),
    advanceTime: (s) => pool.advanceTime(s),
    observe: (sa) => read(() => pool.observe(sa)),
    snapshot: (l, u) => read(() => pool.snapshotCumulativesInside(l, u)),
    setFeeGrowthGlobal0X128: (v) => pool.setFeeGrowthGlobal0X128(v),
    setFeeGrowthGlobal1X128: (v) => pool.setFeeGrowthGlobal1X128(v),
    async state(ticks, positions, nObs = 40) {
      const slot0 = await pool.slot0();
      const observations = [];
      for (let i = 0; i < Math.min(slot0.observationCardinalityNext, nObs); i++) observations.push(await pool.observations(i));
      const ts = [];
      for (const t of ticks) ts.push([t, await pool.ticks(t)]);
      const ps = [];
      for (const [o, l, u] of positions) ps.push([o, l, u, await pool.positions(who(o), l, u)]);
      return {
        slot0,
        liquidity: await pool.liquidity(),
        feeGrowthGlobal0X128: await pool.feeGrowthGlobal0X128(),
        feeGrowthGlobal1X128: await pool.feeGrowthGlobal1X128(),
        protocolFees: await pool.protocolFees(),
        balances: [await uni.token0.balanceOf(pool.address), await uni.token1.balanceOf(pool.address)],
        ticks: ts,
        positions: ps,
        observations,
      };
    },
  };
}

/**
 * Pair: every operation runs on both, outcomes must be equal; `check()` compares the whole state.
 * For swaps, KoinDX's quote_swap (read-only simulation) is also compared with the real swap.
 */
class Pair {
  static async create(fee, tickSpacing) {
    const p = new Pair();
    p.k = koindx(fee, tickSpacing);
    p.u = await uniswap(fee, tickSpacing);
    p.ticks = new Set();
    p.positions = [];
    p.log = [];
    p.diffs = [];
    return p;
  }
  track(owner, l, u) {
    this.ticks.add(l).add(u);
    if (!this.positions.some(([o, a, b]) => o === owner && a === l && b === u)) this.positions.push([owner, l, u]);
  }
  async op(name, ...args) {
    this.log.push(`${name}(${args.map((a) => (a === undefined ? "default" : Array.isArray(a) ? `[${a}]` : String(a))).join(", ")})`);
    let quote;
    if (name === "swap") quote = this.k.quote(...args);
    if (name === "advanceTime") {
      this.k.advanceTime(args[0]);
      this.u.advanceTime(args[0]);
      return { ok: true };
    }
    if (name === "setFeeGrowthGlobal0X128" || name === "setFeeGrowthGlobal1X128") {
      this.k[name](args[0]);
      await this.u[name](args[0]);
      return { ok: true };
    }
    const expected = await this.u[name](...args);
    const result = this.k[name](...args);
    if (S(result) !== S(expected)) {
      this.diffs.push({ where: this.log.slice(-4).join("; "), koindx: S(result) + " " + (result.message || ""), uniswap: S(expected) });
    }
    if (name === "mint" && result.ok) this.track(args[0], args[1], args[2]);
    if (name === "swap" && quote) {
      // the quote must predict the swap: same amounts if the swap succeeded, a failure otherwise
      if (result.ok) {
        const [t0, t1] = result.transfers;
        const z = args[0];
        const paid = (z ? t0 : t1).reduce((a, b) => a + b, 0n);
        const got = (z ? t1 : t0).reduce((a, b) => a + b, 0n);
        const slot0 = this.k.pool.slot0();
        if (
          !quote.ok ||
          quote.value.amountIn !== paid ||
          quote.value.amountOut !== got ||
          quote.value.sqrtPriceX96After !== slot0.sqrtPriceX96 ||
          quote.value.tickAfter !== slot0.tick
        ) {
          this.diffs.push({
            where: "quote_swap vs swap: " + this.log.slice(-1)[0],
            koindx: S(quote),
            uniswap: S({ paid, got, price: slot0.sqrtPriceX96, tick: slot0.tick }),
          });
        }
      }
    }
    return { result, expected };
  }
  /** both revert (Uniswap's SafeCast reverts without a reason, KoinDX names the error) */
  async bothRevert(name, ...args) {
    this.log.push(`${name}(${args.join(", ")})`);
    const expected = await this.u[name](...args);
    const result = this.k[name](...args);
    if (result.ok || expected.ok) this.diffs.push({ where: this.log.slice(-1)[0], koindx: S(result), uniswap: S(expected) });
  }
  async read(name, ...args) {
    const expected = await this.u[name](...args);
    const result = this.k[name](...args);
    if (S(result) !== S(expected)) this.diffs.push({ where: `${name}(${args})`, koindx: S(result) + " " + (result.message || ""), uniswap: S(expected) });
    return { result, expected };
  }
  async check(nObs) {
    const a = this.k.state([...this.ticks], this.positions, nObs);
    const b = await this.u.state([...this.ticks], this.positions, nObs);
    if (S(a) !== S(b)) this.diffs.push({ where: "state after " + this.log.slice(-3).join("; "), koindx: S(a), uniswap: S(b) });
    return a;
  }
}

module.exports = { Pair, koindx, uniswap, sqrtRatioAtTick, getMinTick, getMaxTick, MaxUint64, MIN_SQRT_RATIO, MAX_SQRT_RATIO, S };
