// Differential tests of the edge cases that the random fuzzer (Pool.fuzz.test.js) rarely reaches,
// from an adversarial review of the pool against UniswapV3Pool.sol: MIN/MAX ticks and sqrt price
// limits, swaps ending exactly on initialized ticks, zero liquidity regions, maxLiquidityPerTick
// and int128 bounds, oracle growth and ring wrap-around, observe beyond the oldest observation,
// 32-bit timestamp wrap, snapshotCumulativesInside branches, flash and protocol fees switched
// mid-life, pokes, fee growth wrapping (uint256), AMOUNT_OVERFLOW atomicity, quote_swap and
// get_populated_ticks. Every operation runs on KoinDX and on the Uniswap reference (pair.js).
const L = require("./pair");
const { Pair, koindx, sqrtRatioAtTick: R, MaxUint64, MIN_SQRT_RATIO: MIN, MAX_SQRT_RATIO: MAX, S } = L;

const MIN_TICK = -887272,
  MAX_TICK = 887272;

/** a test that runs `body` on a pair of pools and expects no difference */
function scenario(name, fee, spacing, body) {
  it(name, async () => {
    const p = await Pair.create(fee, spacing);
    await body(p);
    expect(p.diffs).toEqual([]);
  });
}

describe("Pool edge cases: KoinDX vs Uniswap", () => {
  describe("ticks and prices", () => {
    // 1. price at MIN_SQRT_RATIO, positions touching MIN_TICK/MAX_TICK, swaps to the limits
    scenario("MIN price, spacing 1, edge positions", 100, 1, async (p) => {
      await p.op("initialize", MIN);
      await p.check();
      await p.op("swap", true, 1000n, undefined); // SPL on both (limit must be < price and > MIN)
      await p.op("mint", "wallet", MIN_TICK, MIN_TICK + 1, 10n ** 18n);
      await p.op("mint", "other", MIN_TICK, MAX_TICK, 10n ** 9n);
      await p.op("mint", "wallet", MAX_TICK - 1, MAX_TICK, 10n ** 6n);
      await p.check();
      await p.op("swap", false, 10n ** 6n, MIN + 1n); // limit below price -> SPL
      await p.op("swap", false, 10n ** 6n, R(MIN_TICK + 1)); // exactly to the next tick
      await p.check();
      await p.op("swap", true, 10n ** 6n, MIN + 1n);
      await p.check();
      await p.op("swap", false, -(10n ** 3n), MAX - 1n);
      await p.op("swap", false, L.MaxUint64, MAX - 1n);
      await p.check();
      await p.op("swap", true, L.MaxUint64, MIN + 1n);
      await p.check();
      await p.op("swap", false, -(10n ** 18n), undefined);
      await p.check();
      await p.op("burn", "wallet", MIN_TICK, MIN_TICK + 1, 10n ** 18n);
      await p.op("burn", "wallet", MAX_TICK - 1, MAX_TICK, 10n ** 6n);
      await p.op("burn", "other", MIN_TICK, MAX_TICK, 10n ** 9n);
      await p.check();
      await p.op("collect", "wallet", MIN_TICK, MIN_TICK + 1, L.MaxUint64, L.MaxUint64);
      await p.op("collect", "other", MIN_TICK, MAX_TICK, L.MaxUint64, L.MaxUint64);
      await p.check();
    });

    // 2. price at MAX_SQRT_RATIO - 1
    scenario("MAX-1 price, spacing 1", 100, 1, async (p) => {
      await p.op("initialize", MAX - 1n);
      await p.op("initialize", MAX - 1n); // AI
      await p.op("swap", false, 1n, MAX - 1n); // SPL
      await p.op("mint", "wallet", MAX_TICK - 2, MAX_TICK, 10n ** 18n);
      await p.op("mint", "wallet", MIN_TICK, MAX_TICK, 10n ** 9n);
      await p.check();
      await p.op("swap", true, -(10n ** 9n), undefined);
      await p.check();
      await p.op("swap", false, -(10n ** 9n), undefined);
      await p.check();
      await p.op("swap", true, L.MaxUint64, R(MAX_TICK - 1));
      await p.check();
      await p.op("swap", false, L.MaxUint64, MAX - 1n);
      await p.check();
    });

    // 3. swaps ending exactly on initialized ticks and reversing from there
    for (const [fee, spacing] of [
      [3000, 60],
      [100, 1],
      [10000, 200],
    ]) {
      scenario(`exact tick endings, spacing ${spacing}`, fee, spacing, async (p) => {
        await p.op("initialize", R(0));
        const s = spacing;
        await p.op("mint", "wallet", -10 * s, 10 * s, 10n ** 15n);
        await p.op("mint", "other", -2 * s, 0, 10n ** 14n);
        await p.op("mint", "other", 0, 3 * s, 10n ** 14n);
        await p.op("mint", "wallet", -3 * s, -2 * s, 10n ** 13n);
        await p.check();
        // price is exactly at tick 0 (initialized): zeroForOne to exactly -2s, crossing 0 and -2s
        await p.op("swap", true, L.MaxUint64, R(-2 * s));
        await p.check();
        // positions starting at -2s are now "below" (tick = -2s - 1) while the price is exactly on -2s
        await p.op("mint", "wallet", -2 * s, -s, 10n ** 12n);
        await p.op("mint", "other", -4 * s, -2 * s, 10n ** 12n);
        await p.op("snapshot", -2 * s, -s);
        await p.op("snapshot", -4 * s, -2 * s);
        await p.check();
        await p.op("advanceTime", 13);
        // oneForZero from exactly -2s: crosses -2s again with zero amounts
        await p.op("swap", false, 1n, R(-2 * s) + 1n);
        await p.check();
        await p.op("swap", false, -1n, undefined);
        await p.check();
        // back down to exactly -2s with exact output = amount to reach the tick
        await p.op("swap", true, L.MaxUint64, R(-2 * s));
        await p.check();
        await p.op("burn", "wallet", -2 * s, -s, 0n); // poke at the boundary
        await p.op("burn", "other", -4 * s, -2 * s, 10n ** 12n);
        await p.check();
        // up to exactly 3s (upper tick of a position, initialized): oneForZero crossing ticks
        await p.op("swap", false, L.MaxUint64, R(3 * s));
        await p.check();
        await p.op("swap", true, 1n, R(3 * s) - 1n);
        await p.check();
        await p.op("swap", false, L.MaxUint64, R(3 * s) + 1n);
        await p.check();
        // exact output sized to end on the tick 10s
        await p.op("swap", false, L.MaxUint64, R(10 * s));
        await p.op("swap", true, L.MaxUint64, R(10 * s) - 1n);
        await p.check();
        await p.op("advanceTime", 7);
        for (const [o, l, u] of [...p.positions]) {
          await p.op("burn", o, l, u, 0n);
          await p.op("collect", o, l, u, L.MaxUint64, L.MaxUint64);
        }
        await p.check();
      });
    }

    // 4. zero liquidity regions: swaps through empty words, exact output through a gap
    scenario("zero liquidity gaps", 3000, 60, async (p) => {
      await p.op("initialize", R(0));
      await p.op("mint", "wallet", -120, 120, 10n ** 12n);
      await p.op("mint", "wallet", 60000, 60060, 10n ** 12n);
      await p.op("mint", "wallet", -60060, -60000, 10n ** 12n);
      await p.check();
      await p.op("swap", false, -(10n ** 9n), undefined); // crosses the gap
      await p.check();
      await p.op("swap", true, -(10n ** 18n), undefined); // all the way down, more than available
      await p.check();
      await p.op("swap", false, 10n ** 6n, R(30000)); // through empty region, ends inside it
      await p.check();
      await p.op("swap", true, 1n, R(29999)); // price in the gap, liquidity 0
      await p.check();
      await p.op("flash", 0n, 0n, 0n, 0n); // L (no liquidity)
      await p.op("mint", "other", 29940, 30060, 10n ** 10n);
      await p.check();
    });

    // 5. maxLiquidityPerTick (positions near MAX_TICK need few tokens)
    for (const [fee, spacing] of [
      [3000, 60],
      [10000, 200],
      [100, 1],
    ]) {
      scenario(`maxLiquidityPerTick, spacing ${spacing}`, fee, spacing, async (p) => {
        await p.op("initialize", R(0));
        const maxLiq = BigInt(p.k.pool.immutables().maxLiquidityPerTick);
        const top = Math.floor(887272 / spacing) * spacing;
        await p.op("mint", "wallet", top - spacing, top, maxLiq);
        await p.op("mint", "wallet", top - spacing, top, 1n); // LO
        await p.op("mint", "other", top - 2 * spacing, top - spacing, maxLiq); // upper tick shares top - spacing
        await p.op("mint", "other", top - 3 * spacing, top - spacing, 1n); // LO at top - spacing
        await p.op("mint", "other", top - 3 * spacing, top - 2 * spacing, maxLiq);
        await p.check();
        // move the price up through these ticks (liquidityNet extremes)
        await p.op("mint", "wallet", 0, top - 3 * spacing, 10n ** 6n);
        await p.op("swap", false, L.MaxUint64, MAX - 1n);
        await p.check();
        await p.op("swap", true, L.MaxUint64, R(top - 2 * spacing));
        await p.check();
        await p.op("burn", "wallet", top - spacing, top, maxLiq);
        await p.op("burn", "other", top - 2 * spacing, top - spacing, maxLiq);
        await p.check();
        await p.op("collect", "wallet", top - spacing, top, L.MaxUint64, L.MaxUint64);
        await p.check();
        // int128 bounds: liquidity above int128 max
        await p.bothRevert("mint", "wallet", -spacing, spacing, 1n << 127n);
        await p.bothRevert("burn", "wallet", -spacing, spacing, 1n << 127n);
      });
    }
  });

  describe("oracle and fees", () => {
    scenario("oracle growth + wrap-around + observe edges", 3000, 60, async (p) => {
      await p.op("initialize", R(100));
      await p.op("mint", "wallet", -6000, 6000, 10n ** 15n);
      await p.op("mint", "other", 0, 600, 10n ** 14n);
      // observe before any growth: index 0, cardinality 1
      await p.read("observe", [0, 1]);
      await p.op("grow", 4);
      await p.check();
      // writes in the same block (no new observation), then across blocks so the index wraps twice
      for (let i = 0; i < 14; i++) {
        await p.op("swap", i % 2 === 0, 10n ** 11n + BigInt(i) * 7919n, undefined);
        if (i % 3 === 0) await p.op("swap", i % 2 !== 0, 10n ** 9n, undefined); // same block
        await p.op("advanceTime", 5 + i);
        if (i === 6) await p.op("grow", 7); // grow when index != cardinality - 1
        await p.check();
        const s = p.k.pool.slot0();
        const now = p.k.pool.time();
        const oldest = (() => {
          const o = p.k.pool.observations((s.observationIndex + 1) % s.observationCardinality);
          return o.initialized ? o.blockTimestamp : p.k.pool.observations(0).blockTimestamp;
        })();
        const age = now - oldest;
        // exactly the oldest, one beyond, the middle, the newest, transforms after newest
        await p.read("observe", [age]);
        await p.read("observe", [age + 1]);
        await p.read("observe", [0, 1, Math.floor(age / 2), Math.max(0, age - 1)]);
        await p.read("observe", [2 ** 32 - 1]);
        await p.read("snapshot", 0, 600);
        await p.read("snapshot", -6000, 6000);
      }
    });

    scenario("32-bit timestamp wrap", 500, 10, async (p) => {
      await p.op("initialize", R(-500));
      await p.op("mint", "wallet", -1000, 1000, 10n ** 15n);
      await p.op("mint", "other", -700, -300, 10n ** 14n);
      await p.op("grow", 5);
      const toWrap = 2 ** 32 - p.k.pool.time() - 20;
      await p.op("advanceTime", toWrap);
      for (let i = 0; i < 8; i++) {
        await p.op("swap", i % 2 === 0, 10n ** 12n, undefined);
        await p.op("advanceTime", 9);
        await p.check();
        await p.read("observe", [0, 5, 10, 20, 30, 40, 50, 60, 70]);
        await p.read("snapshot", -700, -300);
        await p.read("snapshot", -1000, 1000);
      }
    });

    scenario("snapshotCumulativesInside branches + crossings", 3000, 60, async (p) => {
      await p.op("initialize", R(0));
      await p.op("mint", "wallet", -1200, 1200, 10n ** 15n);
      await p.op("mint", "other", -600, -300, 10n ** 13n);
      await p.op("mint", "other", 300, 600, 10n ** 13n);
      await p.op("advanceTime", 100);
      for (const target of [-450, -900, 450, 900, 0, -300, 300, 600, -600]) {
        const z = target < p.k.pool.slot0().tick;
        await p.op("swap", z, MaxUint64, R(target));
        await p.op("advanceTime", 37);
        await p.check();
        for (const [l, u] of [
          [-600, -300],
          [300, 600],
          [-1200, 1200],
          [-300, 300],
          [-600, 600],
        ])
          await p.read("snapshot", l, u);
      }
    });

    scenario("flash + protocol fee switches + collectProtocol", 3000, 60, async (p) => {
      await p.op("initialize", R(0));
      await p.op("mint", "wallet", -6000, 6000, 10n ** 15n);
      await p.op("flash", 10n ** 9n, 10n ** 9n, undefined, undefined);
      await p.op("setFeeProtocol", 4, 10, "wallet");
      await p.op("setFeeProtocol", 4, 10, "other"); // not the owner
      await p.op("setFeeProtocol", 3, 11, "wallet"); // invalid
      await p.op("flash", 10n ** 9n, 0n, undefined, undefined);
      await p.op("flash", 0n, 0n, 7n, 13n); // donation only
      await p.op("flash", 1n, 1n, undefined, undefined); // fee rounding up on dust
      await p.op("flash", 10n ** 9n, 10n ** 9n, 10n ** 9n, 10n ** 9n); // no fee paid -> F0
      await p.op("swap", true, 10n ** 12n, undefined);
      await p.op("setFeeProtocol", 0, 6, "wallet");
      await p.op("swap", false, -(10n ** 11n), undefined);
      await p.op("flash", 10n ** 6n, 10n ** 6n, 2n * 10n ** 6n + 5n, 3n * 10n ** 6n);
      await p.check();
      await p.op("collectProtocol", 1n, 1n);
      await p.op("collectProtocol", MaxUint64, MaxUint64);
      await p.op("collectProtocol", MaxUint64, MaxUint64); // 1 unit left each, nothing more
      await p.check();
      await p.op("setFeeProtocol", 0, 0, "wallet");
      await p.op("swap", true, 10n ** 12n, undefined);
      await p.op("collectProtocol", MaxUint64, MaxUint64);
      await p.check();
    });

    scenario("pokes, collect more than owed, owed tokens with zero liquidity", 500, 10, async (p) => {
      await p.op("initialize", R(0));
      await p.op("burn", "wallet", -100, 100, 0n); // NP (no position)
      await p.op("collect", "wallet", -100, 100, MaxUint64, MaxUint64); // nothing owed, ok
      await p.op("collect", "wallet", 100, -100, 1n, 1n); // invalid ticks, nothing owed: ok on both
      await p.op("mint", "wallet", -100, 100, 10n ** 12n);
      await p.op("swap", true, 10n ** 8n, undefined);
      await p.op("burn", "wallet", -100, 100, 0n);
      await p.check();
      await p.op("burn", "wallet", -100, 100, 10n ** 12n);
      await p.op("burn", "wallet", -100, 100, 0n); // NP: liquidity 0 but owed tokens
      await p.op("burn", "wallet", -100, 100, 1n); // LS
      await p.check();
      await p.op("collect", "wallet", -100, 100, 1n, 0n);
      await p.op("collect", "wallet", -100, 100, MaxUint64, 1n);
      await p.op("collect", "wallet", -100, 100, MaxUint64, MaxUint64);
      await p.op("collect", "wallet", -100, 100, MaxUint64, MaxUint64);
      await p.check();
    });

    scenario("fee growth wrapping (uint256 overflow)", 3000, 60, async (p) => {
      await p.op("initialize", R(0));
      await p.op("mint", "wallet", -600, 600, 10n ** 9n);
      await p.op("mint", "other", -1200, 60, 10n ** 9n);
      const near = (1n << 256n) - 10n ** 30n;
      await p.op("setFeeGrowthGlobal0X128", near);
      await p.op("setFeeGrowthGlobal1X128", near);
      await p.op("mint", "wallet", -120, 120, 10n ** 9n); // ticks initialized with feeGrowthOutside near max
      for (let i = 0; i < 6; i++) {
        await p.op("swap", i % 2 === 0, 10n ** 10n, undefined);
        await p.check();
      }
      await p.op("flash", 10n ** 8n, 10n ** 8n, undefined, undefined);
      for (const [o, l, u] of [...p.positions]) {
        await p.op("burn", o, l, u, 0n);
        await p.op("collect", o, l, u, MaxUint64, MaxUint64);
      }
      await p.check();
    });

    scenario("AMOUNT_OVERFLOW atomicity (state unchanged after revert)", 3000, 60, async (p) => {
      await p.op("initialize", R(0));
      await p.op("mint", "wallet", -887220, 887220, 4n * 10n ** 18n);
      const before = await p.check();
      // exact output needing > 2^64 - 1 input
      await p.op("swap", false, -(4n * 10n ** 18n - 1n), undefined);
      await p.op("swap", true, -(4n * 10n ** 18n - 1n), undefined);
      // mint whose amounts exceed u64
      await p.op("mint", "other", -60, 60, 10n ** 30n);
      // crossing ticks then failing: add ticks to cross
      await p.op("mint", "wallet", 600, 1200, 10n ** 12n);
      await p.op("swap", false, -3999999999999999999n, undefined);
      const after = await p.check();
      if (L.S(before.slot0) !== L.S(after.slot0)) p.diffs.push({ where: "slot0 changed by reverted ops", koindx: L.S(after.slot0) });
    });

    scenario("oracle accumulation with zero in-range liquidity", 3000, 60, async (p) => {
      await p.op("initialize", R(0));
      await p.op("mint", "wallet", 6000, 12000, 10n ** 13n); // all liquidity ABOVE current -> in-range liquidity 0
      await p.op("grow", 5);
      await p.op("advanceTime", 100);
      await p.op("swap", false, 1n, R(60)); // tiny move, still below the position, liquidity stays 0
      await p.check();
      for (let i = 0; i < 5; i++) {
        await p.op("advanceTime", 200 + i * 10);
        await p.op("swap", false, 1n, R(120 + i * 60));
        await p.check();
        await p.read("observe", [0, 50, 150, 400, 800]);
      }
      // now move price up into the position (liquidity becomes nonzero) and observe across the boundary
      await p.op("swap", false, MaxUint64, R(9000));
      await p.op("advanceTime", 300);
      await p.op("swap", true, 10n ** 6n, undefined);
      await p.check();
      await p.read("observe", [0, 100, 500, 1500, 3000]);
      await p.read("snapshot", 6000, 12000);
    });

    scenario("collectProtocol boundaries", 3000, 60, async (p) => {
      await p.op("initialize", R(0));
      await p.op("mint", "wallet", -60000, 60000, 10n ** 15n);
      await p.op("setFeeProtocol", 4, 4, "wallet");
      for (let i = 0; i < 6; i++) await p.op("swap", i % 2 === 0, 10n ** 12n, undefined);
      await p.check();
      const pf = p.k.pool.protocolFees();
      // request exactly the available amount (the "1 unit stays" rule), then request that leftover
      await p.op("collectProtocol", pf.token0, pf.token1);
      await p.check();
      await p.op("collectProtocol", MaxUint64, MaxUint64);
      await p.check();
      // accumulate again, collect exactly one less than available, then the rest
      for (let i = 0; i < 4; i++) await p.op("swap", i % 2 === 0, 10n ** 12n, undefined);
      const pf2 = p.k.pool.protocolFees();
      await p.op("collectProtocol", pf2.token0 - 1n, pf2.token1 - 1n);
      await p.check();
      await p.op("collectProtocol", 5n, 5n);
      await p.check();
      // switch protocol fee off, collect remainder
      await p.op("setFeeProtocol", 0, 0, "wallet");
      await p.op("swap", true, 10n ** 12n, undefined);
      await p.op("collectProtocol", MaxUint64, MaxUint64);
      await p.check();
    });

    scenario("protocol fee switched every swap", 500, 10, async (p) => {
      await p.op("initialize", R(0));
      await p.op("mint", "wallet", -20000, 20000, 10n ** 15n);
      const fees = [
        [0, 0],
        [4, 10],
        [10, 4],
        [0, 6],
        [6, 0],
        [7, 8],
      ];
      for (let i = 0; i < fees.length; i++) {
        await p.op("setFeeProtocol", fees[i][0], fees[i][1], "wallet");
        await p.op("swap", i % 2 === 0, 10n ** 12n, undefined);
        await p.op("swap", i % 2 !== 0, -(10n ** 11n), undefined);
        await p.check();
      }
      await p.op("collectProtocol", MaxUint64, MaxUint64);
      await p.check();
    });
  });

  it("quote_swap predicts the swap and doesn't write; get_populated_ticks", () => {
    const setup = () => {
      const k = koindx(3000, 60);
      k.initialize(R(0));
      k.mint("wallet", -6000, 6000, 10n ** 14n);
      k.mint("other", -1200, -600, 10n ** 13n);
      k.mint("other", 600, 1200, 10n ** 13n);
      k.mint("wallet", 120, 180, 10n ** 13n);
      return k;
    };
    const ticks = [-6000, -1200, -600, 120, 180, 600, 1200, 6000];
    const k = setup();
    const before = S(k.state(ticks, [["wallet", -6000, 6000]]));
    for (const [z, amt, lim] of [
      [true, 10n ** 10n, undefined],
      [false, 10n ** 10n, undefined],
      [true, -(10n ** 9n), undefined],
      [false, -(10n ** 9n), undefined],
      [true, MaxUint64, R(-3000)],
      [false, MaxUint64, R(3000)],
      [true, MaxUint64, MIN + 1n],
      [false, MaxUint64, MAX - 1n],
      [true, 10n ** 6n, R(-600)], // ends exactly on a tick
      [false, 10n ** 6n, R(600)],
      [true, 1n, undefined],
      [false, 1n, undefined],
      [true, MaxUint64, undefined], // AMOUNT_OVERFLOW
      [false, MaxUint64, undefined],
      [true, -(10n ** 20n), undefined], // exact output more than available
    ]) {
      const quote = k.quote(z, amt, lim);
      const real = setup();
      const swap = real.swap(z, amt, lim);
      expect(quote.ok).toEqual(swap.ok);
      if (!swap.ok) continue;
      const [t0, t1] = swap.transfers;
      const sum = (list) => list.reduce((a, b) => a + b, 0n);
      const slot0 = real.pool.slot0();
      expect({ in: quote.value.amountIn, out: quote.value.amountOut, price: quote.value.sqrtPriceX96After, tick: quote.value.tickAfter }).toEqual({
        in: sum(z ? t0 : t1),
        out: sum(z ? t1 : t0),
        price: slot0.sqrtPriceX96,
        tick: slot0.tick,
      });
    }
    expect(S(k.state(ticks, [["wallet", -6000, 6000]]))).toEqual(before);

    const populated = (start, limit, descending) => k.pool.read("get_populated_ticks", { start, limit, descending }).ticks;
    expect(populated(MIN_TICK - 1, 100, false).map((t) => t.tick)).toEqual(ticks);
    expect(populated(MAX_TICK + 1, 100, true).map((t) => t.tick)).toEqual([...ticks].reverse());
    expect(populated(-6000, 100, false).map((t) => t.tick)).toEqual(ticks.slice(1)); // start excluded
    expect(populated(MIN_TICK - 1, 3, false).length).toEqual(3);
    for (const t of populated(MIN_TICK - 1, 100, false)) {
      const full = k.pool.ticks(t.tick);
      expect([BigInt(t.liquidityNet), BigInt(t.liquidityGross)]).toEqual([full.liquidityNet, full.liquidityGross]);
    }
  });
});
