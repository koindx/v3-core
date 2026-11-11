// Port of Uniswap v3-core test/TickMath.spec.ts (libraries/TickMath.ts compiled in
// tests/build/harness.wasm). The "result" tests compare with the values recorded by Uniswap
// (test/__snapshots__/TickMath.spec.ts.snap). Not applicable: the gas cost tests.
const { call, callString } = require("../../harness");
const { encodePriceSqrt, MIN_SQRT_RATIO, MAX_SQRT_RATIO } = require("../shared/utilities");

const MIN_TICK = -887272;
const MAX_TICK = 887272;

const tickMath = {
  getSqrtRatioAtTick: (tick) => BigInt(callString("getSqrtRatioAtTick", tick)),
  getTickAtSqrtRatio: (ratio) => call("getTickAtSqrtRatio", BigInt(ratio).toString()),
};

// Uniswap snapshot: getSqrtRatioAtTick(tick)
const SQRT_RATIO_SNAPSHOT = {
  "-50": "79030349367926598376800521322",
  "-100": "78833030112140176575862854579",
  "-250": "78244023372248365697264290337",
  "-500": "77272108795590369356373805297",
  "-1000": "75364347830767020784054125655",
  "-2500": "69919044979842180277688105136",
  "-3000": "68192822843687888778582228483",
  "-4000": "64867181785621769311890333195",
  "-5000": "61703726247759831737814779831",
  "-50000": "6504256538020985011912221507",
  "-150000": "43836292794701720435367485",
  "-250000": "295440463448801648376846",
  "-500000": "1101692437043807371",
  "-738203": "7409801140451",
  50: "79426470787362580746886972461",
  100: "79625275426524748796330556128",
  250: "80224679980005306637834519095",
  500: "81233731461783161732293370115",
  1000: "83290069058676223003182343270",
  2500: "89776708723587163891445672585",
  3000: "92049301871182272007977902845",
  4000: "96768528593268422080558758223",
  5000: "101729702841318637793976746270",
  50000: "965075977353221155028623082916",
  150000: "143194173941309278083010301478497",
  250000: "21246587762933397357449903968194344",
  500000: "5697689776495288729098254600827762987878",
  738203: "847134979253254120489401328389043031315994541",
};

// Uniswap snapshot: getTickAtSqrtRatio(ratio)
const TICK_SNAPSHOT = {
  "4295128739": -887272,
  "79228162514264337593543": -276325,
  "79228162514264337593543950": -138163,
  "9903520314283042199192993792": -41591,
  "28011385487393069959365969113": -20796,
  "56022770974786139918731938227": -6932,
  "79228162514264337593543950336": 0,
  "112045541949572279837463876454": 6931,
  "224091083899144559674927752909": 20795,
  "633825300114114700748351602688": 41590,
  "79228162514264337593543950336000": 138162,
  "79228162514264337593543950336000000": 276324,
  "1461446703485210103287273052203988822378723970341": 887271,
};

describe("TickMath", () => {
  describe("#getSqrtRatioAtTick", () => {
    it("throws for too low", () => {
      expect(() => tickMath.getSqrtRatioAtTick(MIN_TICK - 1)).toThrow("KOINDX: TICK_OUT_OF_RANGE");
    });

    it("throws for too high", () => {
      expect(() => tickMath.getSqrtRatioAtTick(MAX_TICK + 1)).toThrow("KOINDX: TICK_OUT_OF_RANGE");
    });

    it("min tick", () => {
      expect(tickMath.getSqrtRatioAtTick(MIN_TICK)).toEqual(4295128739n);
    });

    it("min tick +1", () => {
      expect(tickMath.getSqrtRatioAtTick(MIN_TICK + 1)).toEqual(4295343490n);
    });

    it("max tick - 1", () => {
      expect(tickMath.getSqrtRatioAtTick(MAX_TICK - 1)).toEqual(1461373636630004318706518188784493106690254656249n);
    });

    it("min tick ratio is less than js implementation", () => {
      expect(tickMath.getSqrtRatioAtTick(MIN_TICK) < encodePriceSqrt(1, 2n ** 127n)).toBe(true);
    });

    it("max tick ratio is greater than js implementation", () => {
      expect(tickMath.getSqrtRatioAtTick(MAX_TICK) > encodePriceSqrt(2n ** 127n, 1)).toBe(true);
    });

    it("max tick", () => {
      expect(tickMath.getSqrtRatioAtTick(MAX_TICK)).toEqual(1461446703485210103287273052203988822378723970342n);
    });

    for (const absTick of [50, 100, 250, 500, 1_000, 2_500, 3_000, 4_000, 5_000, 50_000, 150_000, 250_000, 500_000, 738_203]) {
      for (const tick of [-absTick, absTick]) {
        describe(`tick ${tick}`, () => {
          it("is at most off by 1/100th of a bips", () => {
            // Uniswap: decimal.js; a double is precise enough for this tolerance
            const jsResult = Math.sqrt(Math.pow(1.0001, tick)) * 2 ** 96;
            const result = Number(tickMath.getSqrtRatioAtTick(tick));
            expect(Math.abs(result - jsResult) / jsResult).toBeLessThan(0.000001);
          });
          it("result", () => {
            expect(tickMath.getSqrtRatioAtTick(tick).toString()).toEqual(SQRT_RATIO_SNAPSHOT[tick]);
          });
        });
      }
    }
  });

  describe("#MIN_SQRT_RATIO", () => {
    it("equals #getSqrtRatioAtTick(MIN_TICK)", () => {
      expect(tickMath.getSqrtRatioAtTick(MIN_TICK)).toEqual(MIN_SQRT_RATIO);
    });
  });

  describe("#MAX_SQRT_RATIO", () => {
    it("equals #getSqrtRatioAtTick(MAX_TICK)", () => {
      expect(tickMath.getSqrtRatioAtTick(MAX_TICK)).toEqual(MAX_SQRT_RATIO);
    });
  });

  describe("#getTickAtSqrtRatio", () => {
    it("throws for too low", () => {
      expect(() => tickMath.getTickAtSqrtRatio(MIN_SQRT_RATIO - 1n)).toThrow("KOINDX: SQRT_PRICE_OUT_OF_RANGE");
    });

    it("throws for too high", () => {
      expect(() => tickMath.getTickAtSqrtRatio(MAX_SQRT_RATIO)).toThrow("KOINDX: SQRT_PRICE_OUT_OF_RANGE");
    });

    it("ratio of min tick", () => {
      expect(tickMath.getTickAtSqrtRatio(MIN_SQRT_RATIO)).toEqual(MIN_TICK);
    });
    it("ratio of min tick + 1", () => {
      expect(tickMath.getTickAtSqrtRatio("4295343490")).toEqual(MIN_TICK + 1);
    });
    it("ratio of max tick - 1", () => {
      expect(tickMath.getTickAtSqrtRatio("1461373636630004318706518188784493106690254656249")).toEqual(MAX_TICK - 1);
    });
    it("ratio closest to max tick", () => {
      expect(tickMath.getTickAtSqrtRatio(MAX_SQRT_RATIO - 1n)).toEqual(MAX_TICK - 1);
    });

    for (const ratio of [
      MIN_SQRT_RATIO,
      encodePriceSqrt(10n ** 12n, 1),
      encodePriceSqrt(10n ** 6n, 1),
      encodePriceSqrt(1, 64),
      encodePriceSqrt(1, 8),
      encodePriceSqrt(1, 2),
      encodePriceSqrt(1, 1),
      encodePriceSqrt(2, 1),
      encodePriceSqrt(8, 1),
      encodePriceSqrt(64, 1),
      encodePriceSqrt(1, 10n ** 6n),
      encodePriceSqrt(1, 10n ** 12n),
      MAX_SQRT_RATIO - 1n,
    ]) {
      describe(`ratio ${ratio}`, () => {
        it("is at most off by 1", () => {
          // Uniswap: decimal.js; a double is precise enough for this tolerance
          const price = (Number(ratio) / 2 ** 96) ** 2;
          const jsResult = Math.floor(Math.log(price) / Math.log(1.0001));
          const result = tickMath.getTickAtSqrtRatio(ratio);
          expect(Math.abs(result - jsResult)).toBeLessThanOrEqual(1);
        });
        it("ratio is between the tick and tick+1", () => {
          const tick = tickMath.getTickAtSqrtRatio(ratio);
          const ratioOfTick = tickMath.getSqrtRatioAtTick(tick);
          const ratioOfTickPlusOne = tickMath.getSqrtRatioAtTick(tick + 1);
          expect(ratio >= ratioOfTick).toBe(true);
          expect(ratio < ratioOfTickPlusOne).toBe(true);
        });
        it("result", () => {
          // the snapshot of Uniswap is keyed by the ratio: it also checks encodePriceSqrt
          expect(tickMath.getTickAtSqrtRatio(ratio)).toEqual(TICK_SNAPSHOT[ratio.toString()]);
        });
      });
    }
  });
});
