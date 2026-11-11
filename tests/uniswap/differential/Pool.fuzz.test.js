// Differential fuzzing of the pool: random sequences of operations (mint, burn, collect, swaps
// with exact input/output and price limits, flash loans and donations, protocol fees, oracle
// growth and observations, time) run on KoinDX (the compiled pool in the Koinos VM emulator) and
// on the Uniswap reference (the published Uniswap v3 bytecode in an EVM, tests/uniswap/evm).
// After every operation both must agree on:
// - the outcome: success, or failure with the same reason (mapped from the Uniswap codes)
// - the token amounts transferred
// - the whole state: slot0, liquidity, fee growth, protocol fees, balances, every used tick,
//   every position, the observations, observe and snapshotCumulativesInside
// The amounts are kept within the Koinos limits: both implementations start with 2^64 - 1 of
// each token (u64 token supply), the swap amounts go up to 2^64 - 1.
//
// POOL_FUZZ_RUNS (default 4) sequences of POOL_FUZZ_OPS (default 60) operations, starting with
// the seed POOL_FUZZ_SEED (default 1). A failure reports the seed and the operation.
const { TransactionError } = require("../../vm/koinos-vm");
const { callString } = require("../../harness");
const { UniswapEVM, EvmRevert } = require("../evm/uniswap-evm");
const { poolFixture, createPoolFunctions, transfers } = require("../shared/fixtures");
const { getMinTick, getMaxTick, MaxUint64 } = require("../shared/utilities");

const RUNS = Number(process.env.POOL_FUZZ_RUNS || 4);
const OPS = Number(process.env.POOL_FUZZ_OPS || 60);
const FIRST_SEED = Number(process.env.POOL_FUZZ_SEED || 1);

const FEE_TIERS = [
  [500, 10],
  [3000, 60],
  [10000, 200],
  [100, 1],
];

/** mulberry32 */
function prng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: (list) => list[int(0, list.length - 1)],
    chance: (p) => next() < p,
    /** log-uniform BigInt in [1, 10^maxExp] */
    amount: (maxExp) => {
      const value = BigInt(Math.floor(10 ** (next() * maxExp)));
      return value > 0n ? value : 1n;
    },
  };
}

const sqrtRatioAtTick = (tick) => BigInt(callString("getSqrtRatioAtTick", tick));

// revert reasons: KoinDX → Uniswap
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
  // Koinos: an amount above 2^64 can't be paid (Uniswap fails on the balance, which is u64 here)
  AMOUNT_OVERFLOW: "BALANCE",
  // Uniswap: require without a reason
  TICK_NOT_INITIALIZED: "",
  TICK_NOT_SPACED: "",
  ZERO_LIQUIDITY: "",
  INVALID_FEE_PROTOCOL: "",
  FORBIDDEN: "",
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

const nonZero = (list) => list.map((t) => t.value).filter((v) => v !== 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** KoinDX in the Koinos VM emulator */
function koindxDriver(fee, tickSpacing) {
  const fixture = poolFixture();
  const { wallet, other, token0, token1 } = fixture;
  const pool = fixture.createPool(fee, tickSpacing);
  const fns = createPoolFunctions({ fixture, swapTarget: fixture.swapTargetCallee, token0, token1, pool });
  const who = (name) => (name === "other" ? other : wallet);
  const run = (fn) => {
    // Koinos tokens (KCS-4) decrement every allowance, also the max u64: the accounts approve the
    // test callee again, like the unlimited allowance of the reference (2^256 - 1)
    fixture.approve(fixture.swapTargetCallee);
    try {
      const { events } = fn();
      return { ok: true, transfers: [nonZero(transfers(events, token0)), nonZero(transfers(events, token1))] };
    } catch (e) {
      if (!(e instanceof TransactionError)) throw e;
      // the original message, not compared
      return Object.defineProperty({ ok: false, reason: koindxReason(e.message) }, "message", { value: e.message });
    }
  };
  const read = (fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      if (!(e instanceof TransactionError)) throw e;
      return { ok: false, reason: koindxReason(e.message) };
    }
  };
  return {
    initialize: (price) => run(() => pool.initialize(price)),
    mint: (owner, tickLower, tickUpper, liquidity) => run(() => fns.mint(who(owner), tickLower, tickUpper, liquidity)),
    burn: (owner, tickLower, tickUpper, amount) => run(() => pool.burn(tickLower, tickUpper, amount, who(owner))),
    collect: (owner, tickLower, tickUpper, amount0, amount1) => run(() => pool.collect(other, tickLower, tickUpper, amount0, amount1, who(owner))),
    swap: (zeroForOne, amountSpecified, limit) => {
      const f = zeroForOne ? (amountSpecified > 0n ? fns.swapExact0For1 : fns.swap0ForExact1) : amountSpecified > 0n ? fns.swapExact1For0 : fns.swap1ForExact0;
      return run(() => f(amountSpecified > 0n ? amountSpecified : -amountSpecified, other, limit));
    },
    flash: (amount0, amount1, pay0, pay1) => run(() => fns.flash(amount0, amount1, other, pay0, pay1)),
    increaseObservationCardinalityNext: (next) => run(() => pool.increaseObservationCardinalityNext(next)),
    setFeeProtocol: (fee0, fee1, owner) => run(() => pool.setFeeProtocol(fee0, fee1, who(owner))),
    collectProtocol: (amount0, amount1) => run(() => pool.collectProtocol(other, amount0, amount1)),
    advanceTime: (seconds) => pool.advanceTime(seconds),
    observe: (secondsAgos) => read(() => pool.observe(secondsAgos)),
    snapshotCumulativesInside: (tickLower, tickUpper) => read(() => pool.snapshotCumulativesInside(tickLower, tickUpper)),
    state(ticks, positions) {
      const slot0 = pool.slot0();
      delete slot0.unlocked;
      const observations = [];
      for (let i = 0; i < Math.min(slot0.observationCardinalityNext, 40); i++) observations.push(pool.observations(i));
      return {
        slot0,
        liquidity: pool.liquidity(),
        feeGrowthGlobal0X128: pool.feeGrowthGlobal0X128(),
        feeGrowthGlobal1X128: pool.feeGrowthGlobal1X128(),
        protocolFees: pool.protocolFees(),
        balances: [token0.balanceOf(pool.address), token1.balanceOf(pool.address)],
        accounts: [wallet, other].map((a) => [token0.balanceOf(a.address), token1.balanceOf(a.address)]),
        ticks: ticks.map((t) => [t, pool.ticks(t)]),
        positions: positions.map(({ owner, tickLower, tickUpper }) => [owner, tickLower, tickUpper, pool.positions(who(owner), tickLower, tickUpper)]),
        observations,
      };
    },
  };
}

/** the Uniswap reference */
async function uniswapDriver(fee, tickSpacing) {
  // no block gas limit: a swap through many empty words of the tick bitmap runs to the end
  const uni = await UniswapEVM.create({ tokenSupply: MaxUint64, gasLimit: 10n ** 10n });
  const pool = await uni.createPool(fee, tickSpacing);
  const who = (name) => (name === "other" ? uni.other : uni.wallet);
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
    initialize: (price) => run(() => pool.initialize(price)),
    mint: (owner, tickLower, tickUpper, liquidity) => run(() => pool.mint(who(owner), tickLower, tickUpper, liquidity)),
    burn: (owner, tickLower, tickUpper, amount) => run(() => pool.burn(tickLower, tickUpper, amount, who(owner))),
    collect: (owner, tickLower, tickUpper, amount0, amount1) => run(() => pool.collect(uni.other, tickLower, tickUpper, amount0, amount1, who(owner))),
    swap: (zeroForOne, amountSpecified, limit) => run(() => pool.swap(zeroForOne, amountSpecified, uni.other, limit)),
    flash: (amount0, amount1, pay0, pay1) => run(() => pool.flash(amount0, amount1, uni.other, pay0, pay1)),
    increaseObservationCardinalityNext: (next) => run(() => pool.increaseObservationCardinalityNext(next)),
    setFeeProtocol: (fee0, fee1, owner) => run(() => pool.setFeeProtocol(fee0, fee1, who(owner))),
    collectProtocol: (amount0, amount1) => run(() => pool.collectProtocol(uni.other, amount0, amount1)),
    advanceTime: (seconds) => pool.advanceTime(seconds),
    observe: (secondsAgos) => read(() => pool.observe(secondsAgos)),
    snapshotCumulativesInside: (tickLower, tickUpper) => read(() => pool.snapshotCumulativesInside(tickLower, tickUpper)),
    async state(ticks, positions) {
      const slot0 = await pool.slot0();
      delete slot0.unlocked;
      const observations = [];
      for (let i = 0; i < Math.min(slot0.observationCardinalityNext, 40); i++) observations.push(await pool.observations(i));
      const tickStates = [];
      for (const t of ticks) tickStates.push([t, await pool.ticks(t)]);
      const positionStates = [];
      for (const { owner, tickLower, tickUpper } of positions) positionStates.push([owner, tickLower, tickUpper, await pool.positions(who(owner), tickLower, tickUpper)]);
      return {
        slot0,
        liquidity: await pool.liquidity(),
        feeGrowthGlobal0X128: await pool.feeGrowthGlobal0X128(),
        feeGrowthGlobal1X128: await pool.feeGrowthGlobal1X128(),
        protocolFees: await pool.protocolFees(),
        balances: [await uni.token0.balanceOf(pool.address), await uni.token1.balanceOf(pool.address)],
        accounts: [[await uni.token0.balanceOf(uni.wallet), await uni.token1.balanceOf(uni.wallet)], [await uni.token0.balanceOf(uni.other), await uni.token1.balanceOf(uni.other)]],
        ticks: tickStates,
        positions: positionStates,
        observations,
      };
    },
  };
}

/** a random operation, from the current state */
function randomOperation(rand, ctx) {
  const { tickSpacing, state, positions } = ctx;
  const minTick = getMinTick(tickSpacing);
  const maxTick = getMaxTick(tickSpacing);
  const align = (tick) => Math.max(minTick, Math.min(maxTick, Math.round(tick / tickSpacing) * tickSpacing));
  const current = state.slot0.tick;
  const randomRange = () => {
    switch (rand.pick([0, 1, 1, 1, 2, 2, 3])) {
      case 0:
        return [minTick, maxTick];
      case 1: {
        // around the current price
        const width = rand.int(1, 50) * tickSpacing;
        const lower = align(current - rand.int(0, width));
        return [lower, Math.min(maxTick, lower + width)];
      }
      case 2: {
        // above or below the current price
        const side = rand.chance(0.5) ? 1 : -1;
        const a = align(current + side * rand.int(1, 3000));
        const b = align(a + side * rand.int(1, 100) * tickSpacing);
        return [Math.min(a, b), Math.max(a, b)];
      }
      default: {
        // anywhere (sometimes not spaced or reversed)
        let a = rand.int(minTick, maxTick);
        let b = rand.int(minTick, maxTick);
        if (!rand.chance(0.1)) [a, b] = [align(a), align(b)];
        if (!rand.chance(0.05) && a > b) [a, b] = [b, a];
        return [a, b];
      }
    }
  };
  const knownPosition = () => (positions.length && !rand.chance(0.05) ? rand.pick(positions) : { owner: rand.pick(["wallet", "other"]), tickLower: align(current - 100), tickUpper: align(current + 100) });
  const limit = (zeroForOne) => {
    if (rand.chance(0.6)) return undefined;
    const ticks = rand.int(1, 2000) * (rand.chance(0.9) ? 1 : -1); // sometimes on the wrong side
    const tick = Math.max(-887271, Math.min(887271, zeroForOne ? current - ticks : current + ticks));
    return sqrtRatioAtTick(tick) + BigInt(rand.int(0, 1000));
  };

  const r = rand.next();
  if (r < 0.22) {
    const [tickLower, tickUpper] = randomRange();
    const liquidity = rand.chance(0.02) ? 0n : rand.amount(rand.chance(0.85) ? 16 : 18);
    return { op: "mint", args: [rand.pick(["wallet", "other"]), tickLower, tickUpper, liquidity] };
  }
  if (r < 0.32) {
    const p = knownPosition();
    const liquidity = ctx.positionLiquidity(p);
    const amount = rand.pick([0n, liquidity, liquidity / 2n, liquidity + 1n, rand.amount(18)]);
    return { op: "burn", args: [p.owner, p.tickLower, p.tickUpper, amount] };
  }
  if (r < 0.4) {
    const p = knownPosition();
    return { op: "collect", args: [p.owner, p.tickLower, p.tickUpper, rand.chance(0.7) ? MaxUint64 : rand.amount(17), rand.chance(0.7) ? MaxUint64 : rand.amount(17)] };
  }
  if (r < 0.7) {
    const zeroForOne = rand.chance(0.5);
    // up to 2^64 - 1 (10^19.27)
    let amount = rand.amount(rand.chance(0.8) ? 17 : 19.3);
    if (amount > MaxUint64) amount = MaxUint64;
    return { op: "swap", args: [zeroForOne, rand.chance(0.5) ? amount : -amount, limit(zeroForOne)] };
  }
  if (r < 0.76) {
    const [b0, b1] = state.balances;
    const portion = (balance) => (balance === 0n || rand.chance(0.4) ? 0n : (balance * BigInt(rand.int(0, 1000))) / 1000n);
    const amount0 = portion(b0);
    const amount1 = portion(b1);
    // exact payment, donation or underpayment
    const pay = (amount) => (rand.chance(0.8) ? undefined : rand.chance(0.7) ? amount * 2n + BigInt(rand.int(0, 1000)) : amount);
    return { op: "flash", args: [amount0, amount1, pay(amount0), pay(amount1)] };
  }
  if (r < 0.86) return { op: "advanceTime", args: [rand.chance(0.9) ? rand.int(0, 3600) : rand.int(0, 2 ** 22)] };
  if (r < 0.89) return { op: "increaseObservationCardinalityNext", args: [rand.int(1, 30)] };
  if (r < 0.92) {
    const fee = () => (rand.chance(0.1) ? rand.pick([1, 3, 11]) : rand.pick([0, 4, 5, 6, 7, 8, 9, 10]));
    return { op: "setFeeProtocol", args: [fee(), fee(), rand.chance(0.9) ? "wallet" : "other"] };
  }
  if (r < 0.95) return { op: "collectProtocol", args: [rand.chance(0.7) ? MaxUint64 : rand.amount(14), rand.chance(0.7) ? MaxUint64 : rand.amount(14)] };
  if (r < 0.98) return { op: "observe", args: [[0, rand.int(0, 7200), rand.int(0, 100)]] };
  const p = knownPosition();
  return { op: "snapshotCumulativesInside", args: [p.tickLower, p.tickUpper] };
}

const describeOp = ({ op, args }) => `${op}(${args.map((a) => (a === undefined ? "default" : Array.isArray(a) ? `[${a}]` : a.toString())).join(", ")})`;

// POOL_FUZZ_STATS=1: prints the outcomes of the operations
const STATS = {};

describe("pool differential fuzzing (KoinDX vs Uniswap)", () => {
  afterAll(() => {
    if (process.env.POOL_FUZZ_STATS) console.log(JSON.stringify(STATS, null, 1));
  });

  for (let run = 0; run < RUNS; run++) {
    const seed = FIRST_SEED + run;
    it(`seed ${seed}: ${OPS} random operations`, async () => {
      const rand = prng(seed);
      const [fee, tickSpacing] = rand.pick(FEE_TIERS);
      const koindx = koindxDriver(fee, tickSpacing);
      const uniswap = await uniswapDriver(fee, tickSpacing);

      // initial price: a random tick (the amounts must fit in u64)
      const initialPrice = sqrtRatioAtTick(rand.int(-50000, 50000)) + BigInt(rand.int(0, 1e9));
      expect(koindx.initialize(initialPrice)).toEqual(await uniswap.initialize(initialPrice));
      // some liquidity in the full range
      const [minTick, maxTick] = [getMinTick(tickSpacing), getMaxTick(tickSpacing)];
      const baseLiquidity = rand.amount(16);
      expect(koindx.mint("wallet", minTick, maxTick, baseLiquidity)).toEqual(await uniswap.mint("wallet", minTick, maxTick, baseLiquidity));

      const positions = [{ owner: "wallet", tickLower: minTick, tickUpper: maxTick }];
      const ticks = new Set([minTick, maxTick]);
      let state = koindx.state([...ticks], positions);
      const ctx = {
        tickSpacing,
        positions,
        get state() {
          return state;
        },
        positionLiquidity: (p) => {
          const found = state.positions.find(([owner, l, u]) => owner === p.owner && l === p.tickLower && u === p.tickUpper);
          return found ? found[3].liquidity : 0n;
        },
      };

      const log = [];
      for (let i = 0; i < OPS; i++) {
        const operation = randomOperation(rand, ctx);
        log.push(describeOp(operation));
        const where = `seed ${seed}, operation ${i}: ${describeOp(operation)}\n  previous: ${log.slice(-6, -1).join("; ")}`;
        const { op, args } = operation;

        if (op === "advanceTime") {
          koindx.advanceTime(args[0]);
          uniswap.advanceTime(args[0]);
        } else {
          const expected = await uniswap[op](...args);
          const result = koindx[op](...args);
          if (JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v)) !== JSON.stringify(expected, (_, v) => (typeof v === "bigint" ? v.toString() : v))) {
            throw new Error(`${where}\n  KoinDX: ${JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v))} ${result.message || ""}\n  Uniswap: ${JSON.stringify(expected, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
          }
          const outcome = result.ok ? "ok" : `fail ${result.reason}`;
          STATS[op] = STATS[op] || {};
          STATS[op][outcome] = (STATS[op][outcome] || 0) + 1;
          if (op === "mint" && result.ok) {
            const [owner, tickLower, tickUpper] = args;
            if (!positions.some((p) => p.owner === owner && p.tickLower === tickLower && p.tickUpper === tickUpper)) positions.push({ owner, tickLower, tickUpper });
            ticks.add(tickLower).add(tickUpper);
          }
        }

        state = koindx.state([...ticks], positions);
        const expectedState = await uniswap.state([...ticks], positions);
        try {
          expect(state).toEqual(expectedState);
        } catch (e) {
          throw new Error(`${where}\n${e.message}`);
        }
      }
    }, 600000);
  }
});
