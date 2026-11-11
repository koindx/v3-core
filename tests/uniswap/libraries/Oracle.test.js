// Port of Uniswap v3-core test/Oracle.spec.ts. OracleTest: the Oracle library compiled in
// tests/harness/pool-libraries.ts, run in the Koinos VM emulator (the observations are stored in
// the storage of a contract, the other state variables of OracleTest are kept here).
// The "full oracle" tests (skipped by Uniswap because they are slow) are run here.
// Not applicable: the gas cost tests.
const { KoinosVM } = require("../../vm/koinos-vm");
const { PoolLibraries } = require("../shared/pool-libraries");
const { expectRevert } = require("../shared/contracts");
const { TEST_POOL_START_TIME } = require("../shared/fixtures");
const { MaxUint128 } = require("../shared/utilities");

const U32 = 2 ** 32;

/** the Uniswap OracleTest contract */
class OracleTest {
  constructor() {
    this.lib = new PoolLibraries(new KoinosVM(), "OracleTest");
    this.time = 0;
    this.tick = 0;
    this.liquidity = 0n;
    this.index = 0;
    this.cardinality = 0;
    this.cardinalityNext = 0;
  }

  initialize({ time, tick, liquidity }) {
    if (this.cardinality !== 0) throw new Error("already initialized");
    this.time = time;
    this.tick = tick;
    this.liquidity = BigInt(liquidity);
    [this.cardinality, this.cardinalityNext] = this.lib.callString("oracleInitialize", time).split(",").map(Number);
  }

  advanceTime(by) {
    this.time = (this.time + by) % U32;
  }

  // write an observation, then change tick and liquidity
  update({ advanceTimeBy, tick, liquidity }) {
    this.advanceTime(advanceTimeBy);
    [this.index, this.cardinality] = this.lib
      .callString("oracleWrite", this.index, this.time, this.tick, this.liquidity, this.cardinality, this.cardinalityNext)
      .split(",")
      .map(Number);
    this.tick = tick;
    this.liquidity = BigInt(liquidity);
  }

  batchUpdate(params) {
    const res = this.lib
      .callString(
        "oracleBatchUpdate",
        this.index,
        this.time,
        this.tick,
        this.liquidity,
        this.cardinality,
        this.cardinalityNext,
        params.map((p) => p.advanceTimeBy).join(","),
        params.map((p) => p.tick).join(","),
        params.map((p) => p.liquidity).join(",")
      )
      .split(",");
    [this.index, this.cardinality, this.time, this.tick] = res.slice(0, 4).map(Number);
    this.liquidity = BigInt(res[4]);
  }

  grow(cardinalityNext) {
    this.cardinalityNext = this.lib.call("oracleGrow", this.cardinalityNext, cardinalityNext).res >>> 0;
  }

  observe(secondsAgos) {
    const res = this.lib.callString("oracleObserve", this.time, secondsAgos.join(","), this.tick, this.index, this.liquidity, this.cardinality);
    const values = res.length ? res.split(";").map((v) => v.split(",").map(BigInt)) : [];
    return { tickCumulatives: values.map((v) => v[0]), secondsPerLiquidityCumulativeX128s: values.map((v) => v[1]) };
  }

  observations(index) {
    const [blockTimestamp, tickCumulative, secondsPerLiquidityCumulativeX128, initialized] = this.lib.callString("oracleGet", index).split(",");
    return {
      blockTimestamp: Number(blockTimestamp),
      tickCumulative: BigInt(tickCumulative),
      secondsPerLiquidityCumulativeX128: BigInt(secondsPerLiquidityCumulativeX128),
      initialized: initialized === "true",
    };
  }
}

function checkObservationEquals({ tickCumulative, blockTimestamp, initialized, secondsPerLiquidityCumulativeX128 }, expected) {
  expect({
    initialized,
    blockTimestamp,
    tickCumulative: tickCumulative.toString(),
    secondsPerLiquidityCumulativeX128: secondsPerLiquidityCumulativeX128.toString(),
  }).toEqual({
    ...expected,
    tickCumulative: expected.tickCumulative.toString(),
    secondsPerLiquidityCumulativeX128: expected.secondsPerLiquidityCumulativeX128.toString(),
  });
}

describe("Oracle", () => {
  const oracleFixture = () => new OracleTest();

  const initializedOracleFixture = () => {
    const oracle = oracleFixture();
    oracle.initialize({ time: 0, tick: 0, liquidity: 0 });
    return oracle;
  };

  describe("#initialize", () => {
    let oracle;
    beforeEach(() => {
      oracle = oracleFixture();
    });
    it("index is 0", () => {
      oracle.initialize({ liquidity: 1, tick: 1, time: 1 });
      expect(oracle.index).toEqual(0);
    });
    it("cardinality is 1", () => {
      oracle.initialize({ liquidity: 1, tick: 1, time: 1 });
      expect(oracle.cardinality).toEqual(1);
    });
    it("cardinality next is 1", () => {
      oracle.initialize({ liquidity: 1, tick: 1, time: 1 });
      expect(oracle.cardinalityNext).toEqual(1);
    });
    it("sets first slot timestamp only", () => {
      oracle.initialize({ liquidity: 1, tick: 1, time: 1 });
      checkObservationEquals(oracle.observations(0), {
        initialized: true,
        blockTimestamp: 1,
        tickCumulative: 0,
        secondsPerLiquidityCumulativeX128: 0,
      });
    });
  });

  describe("#grow", () => {
    let oracle;
    beforeEach(() => {
      oracle = initializedOracleFixture();
    });

    it("increases the cardinality next for the first call", () => {
      oracle.grow(5);
      expect(oracle.index).toEqual(0);
      expect(oracle.cardinality).toEqual(1);
      expect(oracle.cardinalityNext).toEqual(5);
    });

    it("does not touch the first slot", () => {
      oracle.grow(5);
      checkObservationEquals(oracle.observations(0), {
        secondsPerLiquidityCumulativeX128: 0,
        tickCumulative: 0,
        blockTimestamp: 0,
        initialized: true,
      });
    });

    it("is no op if oracle is already gte that size", () => {
      oracle.grow(5);
      oracle.grow(3);
      expect(oracle.index).toEqual(0);
      expect(oracle.cardinality).toEqual(1);
      expect(oracle.cardinalityNext).toEqual(5);
    });

    it("adds data to all the slots", () => {
      oracle.grow(5);
      for (let i = 1; i < 5; i++) {
        checkObservationEquals(oracle.observations(i), {
          secondsPerLiquidityCumulativeX128: 0,
          tickCumulative: 0,
          blockTimestamp: 1,
          initialized: false,
        });
      }
    });

    it("grow after wrap", () => {
      oracle.grow(2);
      oracle.update({ advanceTimeBy: 2, liquidity: 1, tick: 1 }); // index is now 1
      oracle.update({ advanceTimeBy: 2, liquidity: 1, tick: 1 }); // index is now 0 again
      expect(oracle.index).toEqual(0);
      oracle.grow(3);
      expect(oracle.index).toEqual(0);
      expect(oracle.cardinality).toEqual(2);
      expect(oracle.cardinalityNext).toEqual(3);
    });
  });

  describe("#write", () => {
    let oracle;

    beforeEach(() => {
      oracle = initializedOracleFixture();
    });

    it("single element array gets overwritten", () => {
      oracle.update({ advanceTimeBy: 1, tick: 2, liquidity: 5 });
      expect(oracle.index).toEqual(0);
      checkObservationEquals(oracle.observations(0), {
        initialized: true,
        secondsPerLiquidityCumulativeX128: "340282366920938463463374607431768211456",
        tickCumulative: 0,
        blockTimestamp: 1,
      });
      oracle.update({ advanceTimeBy: 5, tick: -1, liquidity: 8 });
      expect(oracle.index).toEqual(0);
      checkObservationEquals(oracle.observations(0), {
        initialized: true,
        secondsPerLiquidityCumulativeX128: "680564733841876926926749214863536422912",
        tickCumulative: 10,
        blockTimestamp: 6,
      });
      oracle.update({ advanceTimeBy: 3, tick: 2, liquidity: 3 });
      expect(oracle.index).toEqual(0);
      checkObservationEquals(oracle.observations(0), {
        initialized: true,
        secondsPerLiquidityCumulativeX128: "808170621437228850725514692650449502208",
        tickCumulative: 7,
        blockTimestamp: 9,
      });
    });

    it("does nothing if time has not changed", () => {
      oracle.grow(2);
      oracle.update({ advanceTimeBy: 1, tick: 3, liquidity: 2 });
      expect(oracle.index).toEqual(1);
      oracle.update({ advanceTimeBy: 0, tick: -5, liquidity: 9 });
      expect(oracle.index).toEqual(1);
    });

    it("writes an index if time has changed", () => {
      oracle.grow(3);
      oracle.update({ advanceTimeBy: 6, tick: 3, liquidity: 2 });
      expect(oracle.index).toEqual(1);
      oracle.update({ advanceTimeBy: 4, tick: -5, liquidity: 9 });

      expect(oracle.index).toEqual(2);
      checkObservationEquals(oracle.observations(1), {
        tickCumulative: 0,
        secondsPerLiquidityCumulativeX128: "2041694201525630780780247644590609268736",
        initialized: true,
        blockTimestamp: 6,
      });
    });

    it("grows cardinality when writing past", () => {
      oracle.grow(2);
      oracle.grow(4);
      expect(oracle.cardinality).toEqual(1);
      oracle.update({ advanceTimeBy: 3, tick: 5, liquidity: 6 });
      expect(oracle.cardinality).toEqual(4);
      oracle.update({ advanceTimeBy: 4, tick: 6, liquidity: 4 });
      expect(oracle.cardinality).toEqual(4);
      expect(oracle.index).toEqual(2);
      checkObservationEquals(oracle.observations(2), {
        secondsPerLiquidityCumulativeX128: "1247702012043441032699040227249816775338",
        tickCumulative: 20,
        initialized: true,
        blockTimestamp: 7,
      });
    });

    it("wraps around", () => {
      oracle.grow(3);
      oracle.update({ advanceTimeBy: 3, tick: 1, liquidity: 2 });
      oracle.update({ advanceTimeBy: 4, tick: 2, liquidity: 3 });
      oracle.update({ advanceTimeBy: 5, tick: 3, liquidity: 4 });

      expect(oracle.index).toEqual(0);

      checkObservationEquals(oracle.observations(0), {
        secondsPerLiquidityCumulativeX128: "2268549112806256423089164049545121409706",
        tickCumulative: 14,
        initialized: true,
        blockTimestamp: 12,
      });
    });

    it("accumulates liquidity", () => {
      oracle.grow(4);

      oracle.update({ advanceTimeBy: 3, tick: 3, liquidity: 2 });
      oracle.update({ advanceTimeBy: 4, tick: -7, liquidity: 6 });
      oracle.update({ advanceTimeBy: 5, tick: -2, liquidity: 4 });

      expect(oracle.index).toEqual(3);

      checkObservationEquals(oracle.observations(1), {
        initialized: true,
        tickCumulative: 0,
        secondsPerLiquidityCumulativeX128: "1020847100762815390390123822295304634368",
        blockTimestamp: 3,
      });
      checkObservationEquals(oracle.observations(2), {
        initialized: true,
        tickCumulative: 12,
        secondsPerLiquidityCumulativeX128: "1701411834604692317316873037158841057280",
        blockTimestamp: 7,
      });
      checkObservationEquals(oracle.observations(3), {
        initialized: true,
        tickCumulative: -23,
        secondsPerLiquidityCumulativeX128: "1984980473705474370203018543351981233493",
        blockTimestamp: 12,
      });
      checkObservationEquals(oracle.observations(4), {
        initialized: false,
        tickCumulative: 0,
        secondsPerLiquidityCumulativeX128: 0,
        blockTimestamp: 0,
      });
    });
  });

  describe("#observe", () => {
    describe("before initialization", () => {
      let oracle;
      beforeEach(() => {
        oracle = oracleFixture();
      });

      const observeSingle = (secondsAgo) => {
        const {
          tickCumulatives: [tickCumulative],
          secondsPerLiquidityCumulativeX128s: [secondsPerLiquidityCumulativeX128],
        } = oracle.observe([secondsAgo]);
        return { secondsPerLiquidityCumulativeX128, tickCumulative };
      };

      it("fails before initialize", () => {
        expectRevert(() => observeSingle(0), "KOINDX: OBSERVATIONS_NOT_INITIALIZED");
      });

      it("fails if an older observation does not exist", () => {
        oracle.initialize({ liquidity: 4, tick: 2, time: 5 });
        expectRevert(() => observeSingle(1), "KOINDX: OBSERVATION_TOO_OLD");
      });

      it("does not fail across overflow boundary", () => {
        oracle.initialize({ liquidity: 4, tick: 2, time: 2 ** 32 - 1 });
        oracle.advanceTime(2);
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(1);
        expect(tickCumulative).toEqual(2n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(85070591730234615865843651857942052864n);
      });

      it("interpolates correctly at max liquidity", () => {
        oracle.initialize({ liquidity: MaxUint128, tick: 0, time: 0 });
        oracle.grow(2);
        oracle.update({ advanceTimeBy: 13, tick: 0, liquidity: 0 });
        let { secondsPerLiquidityCumulativeX128 } = observeSingle(0);
        expect(secondsPerLiquidityCumulativeX128).toEqual(13n);
        ({ secondsPerLiquidityCumulativeX128 } = observeSingle(6));
        expect(secondsPerLiquidityCumulativeX128).toEqual(7n);
        ({ secondsPerLiquidityCumulativeX128 } = observeSingle(12));
        expect(secondsPerLiquidityCumulativeX128).toEqual(1n);
        ({ secondsPerLiquidityCumulativeX128 } = observeSingle(13));
        expect(secondsPerLiquidityCumulativeX128).toEqual(0n);
      });

      it("interpolates correctly at min liquidity", () => {
        oracle.initialize({ liquidity: 0, tick: 0, time: 0 });
        oracle.grow(2);
        oracle.update({ advanceTimeBy: 13, tick: 0, liquidity: MaxUint128 });
        let { secondsPerLiquidityCumulativeX128 } = observeSingle(0);
        expect(secondsPerLiquidityCumulativeX128).toEqual(13n << 128n);
        ({ secondsPerLiquidityCumulativeX128 } = observeSingle(6));
        expect(secondsPerLiquidityCumulativeX128).toEqual(7n << 128n);
        ({ secondsPerLiquidityCumulativeX128 } = observeSingle(12));
        expect(secondsPerLiquidityCumulativeX128).toEqual(1n << 128n);
        ({ secondsPerLiquidityCumulativeX128 } = observeSingle(13));
        expect(secondsPerLiquidityCumulativeX128).toEqual(0n);
      });

      it("interpolates the same as 0 liquidity for 1 liquidity", () => {
        oracle.initialize({ liquidity: 1, tick: 0, time: 0 });
        oracle.grow(2);
        oracle.update({ advanceTimeBy: 13, tick: 0, liquidity: MaxUint128 });
        let { secondsPerLiquidityCumulativeX128 } = observeSingle(0);
        expect(secondsPerLiquidityCumulativeX128).toEqual(13n << 128n);
        ({ secondsPerLiquidityCumulativeX128 } = observeSingle(6));
        expect(secondsPerLiquidityCumulativeX128).toEqual(7n << 128n);
        ({ secondsPerLiquidityCumulativeX128 } = observeSingle(12));
        expect(secondsPerLiquidityCumulativeX128).toEqual(1n << 128n);
        ({ secondsPerLiquidityCumulativeX128 } = observeSingle(13));
        expect(secondsPerLiquidityCumulativeX128).toEqual(0n);
      });

      it("interpolates correctly across uint32 seconds boundaries", () => {
        // setup
        oracle.initialize({ liquidity: 0, tick: 0, time: 0 });
        oracle.grow(2);
        oracle.update({ advanceTimeBy: 2 ** 32 - 6, tick: 0, liquidity: 0 });
        let { secondsPerLiquidityCumulativeX128 } = observeSingle(0);
        expect(secondsPerLiquidityCumulativeX128).toEqual(BigInt(2 ** 32 - 6) << 128n);
        oracle.update({ advanceTimeBy: 13, tick: 0, liquidity: 0 });
        ({ secondsPerLiquidityCumulativeX128 } = observeSingle(0));
        expect(secondsPerLiquidityCumulativeX128).toEqual(7n << 128n);

        // interpolation checks
        ({ secondsPerLiquidityCumulativeX128 } = observeSingle(3));
        expect(secondsPerLiquidityCumulativeX128).toEqual(4n << 128n);
        ({ secondsPerLiquidityCumulativeX128 } = observeSingle(8));
        expect(secondsPerLiquidityCumulativeX128).toEqual(BigInt(2 ** 32 - 1) << 128n);
      });

      it("single observation at current time", () => {
        oracle.initialize({ liquidity: 4, tick: 2, time: 5 });
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(0);
        expect(tickCumulative).toEqual(0n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(0n);
      });

      it("single observation in past but not earlier than secondsAgo", () => {
        oracle.initialize({ liquidity: 4, tick: 2, time: 5 });
        oracle.advanceTime(3);
        expectRevert(() => observeSingle(4), "KOINDX: OBSERVATION_TOO_OLD");
      });

      it("single observation in past at exactly seconds ago", () => {
        oracle.initialize({ liquidity: 4, tick: 2, time: 5 });
        oracle.advanceTime(3);
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(3);
        expect(tickCumulative).toEqual(0n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(0n);
      });

      it("single observation in past counterfactual in past", () => {
        oracle.initialize({ liquidity: 4, tick: 2, time: 5 });
        oracle.advanceTime(3);
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(1);
        expect(tickCumulative).toEqual(4n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(170141183460469231731687303715884105728n);
      });

      it("single observation in past counterfactual now", () => {
        oracle.initialize({ liquidity: 4, tick: 2, time: 5 });
        oracle.advanceTime(3);
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(0);
        expect(tickCumulative).toEqual(6n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(255211775190703847597530955573826158592n);
      });

      it("two observations in chronological order 0 seconds ago exact", () => {
        oracle.initialize({ liquidity: 5, tick: -5, time: 5 });
        oracle.grow(2);
        oracle.update({ advanceTimeBy: 4, tick: 1, liquidity: 2 });
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(0);
        expect(tickCumulative).toEqual(-20n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(272225893536750770770699685945414569164n);
      });

      it("two observations in chronological order 0 seconds ago counterfactual", () => {
        oracle.initialize({ liquidity: 5, tick: -5, time: 5 });
        oracle.grow(2);
        oracle.update({ advanceTimeBy: 4, tick: 1, liquidity: 2 });
        oracle.advanceTime(7);
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(0);
        expect(tickCumulative).toEqual(-13n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(1463214177760035392892510811956603309260n);
      });

      it("two observations in chronological order seconds ago is exactly on first observation", () => {
        oracle.initialize({ liquidity: 5, tick: -5, time: 5 });
        oracle.grow(2);
        oracle.update({ advanceTimeBy: 4, tick: 1, liquidity: 2 });
        oracle.advanceTime(7);
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(11);
        expect(tickCumulative).toEqual(0n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(0n);
      });

      it("two observations in chronological order seconds ago is between first and second", () => {
        oracle.initialize({ liquidity: 5, tick: -5, time: 5 });
        oracle.grow(2);
        oracle.update({ advanceTimeBy: 4, tick: 1, liquidity: 2 });
        oracle.advanceTime(7);
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(9);
        expect(tickCumulative).toEqual(-10n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(136112946768375385385349842972707284582n);
      });

      it("two observations in reverse order 0 seconds ago exact", () => {
        oracle.initialize({ liquidity: 5, tick: -5, time: 5 });
        oracle.grow(2);
        oracle.update({ advanceTimeBy: 4, tick: 1, liquidity: 2 });
        oracle.update({ advanceTimeBy: 3, tick: -5, liquidity: 4 });
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(0);
        expect(tickCumulative).toEqual(-17n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(782649443918158465965761597093066886348n);
      });

      it("two observations in reverse order 0 seconds ago counterfactual", () => {
        oracle.initialize({ liquidity: 5, tick: -5, time: 5 });
        oracle.grow(2);
        oracle.update({ advanceTimeBy: 4, tick: 1, liquidity: 2 });
        oracle.update({ advanceTimeBy: 3, tick: -5, liquidity: 4 });
        oracle.advanceTime(7);
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(0);
        expect(tickCumulative).toEqual(-52n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(1378143586029800777026667160098661256396n);
      });

      it("two observations in reverse order seconds ago is exactly on first observation", () => {
        oracle.initialize({ liquidity: 5, tick: -5, time: 5 });
        oracle.grow(2);
        oracle.update({ advanceTimeBy: 4, tick: 1, liquidity: 2 });
        oracle.update({ advanceTimeBy: 3, tick: -5, liquidity: 4 });
        oracle.advanceTime(7);
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(10);
        expect(tickCumulative).toEqual(-20n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(272225893536750770770699685945414569164n);
      });

      it("two observations in reverse order seconds ago is between first and second", () => {
        oracle.initialize({ liquidity: 5, tick: -5, time: 5 });
        oracle.grow(2);
        oracle.update({ advanceTimeBy: 4, tick: 1, liquidity: 2 });
        oracle.update({ advanceTimeBy: 3, tick: -5, liquidity: 4 });
        oracle.advanceTime(7);
        const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(9);
        expect(tickCumulative).toEqual(-19n);
        expect(secondsPerLiquidityCumulativeX128).toEqual(442367076997220002502386989661298674892n);
      });

      it("can fetch multiple observations", () => {
        oracle.initialize({ time: 5, tick: 2, liquidity: 2n ** 15n });
        oracle.grow(4);
        oracle.update({ advanceTimeBy: 13, tick: 6, liquidity: 2n ** 12n });
        oracle.advanceTime(5);

        const { tickCumulatives, secondsPerLiquidityCumulativeX128s } = oracle.observe([0, 3, 8, 13, 15, 18]);
        expect(tickCumulatives).toEqual([56n, 38n, 20n, 10n, 6n, 0n]);
        expect(secondsPerLiquidityCumulativeX128s).toEqual([
          550383467004691728624232610897330176n,
          301153217795020002454768787094765568n,
          103845937170696552570609926584401920n,
          51922968585348276285304963292200960n,
          31153781151208965771182977975320576n,
          0n,
        ]);
      });
    });

    for (const startingTime of [5, 2 ** 32 - 5]) {
      describe(`initialized with 5 observations with starting time of ${startingTime}`, () => {
        const oracleFixture5Observations = () => {
          const oracle = oracleFixture();
          oracle.initialize({ liquidity: 5, tick: -5, time: startingTime });
          oracle.grow(5);
          oracle.update({ advanceTimeBy: 3, tick: 1, liquidity: 2 });
          oracle.update({ advanceTimeBy: 2, tick: -6, liquidity: 4 });
          oracle.update({ advanceTimeBy: 4, tick: -2, liquidity: 4 });
          oracle.update({ advanceTimeBy: 1, tick: -2, liquidity: 9 });
          oracle.update({ advanceTimeBy: 3, tick: 4, liquidity: 2 });
          oracle.update({ advanceTimeBy: 6, tick: 6, liquidity: 7 });
          return oracle;
        };
        let oracle;
        beforeEach(() => {
          oracle = oracleFixture5Observations();
        });

        const observeSingle = (secondsAgo) => {
          const {
            tickCumulatives: [tickCumulative],
            secondsPerLiquidityCumulativeX128s: [secondsPerLiquidityCumulativeX128],
          } = oracle.observe([secondsAgo]);
          return { secondsPerLiquidityCumulativeX128, tickCumulative };
        };

        it("index, cardinality, cardinality next", () => {
          expect(oracle.index).toEqual(1);
          expect(oracle.cardinality).toEqual(5);
          expect(oracle.cardinalityNext).toEqual(5);
        });
        it("latest observation same time as latest", () => {
          const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(0);
          expect(tickCumulative).toEqual(-21n);
          expect(secondsPerLiquidityCumulativeX128).toEqual(2104079302127802832415199655953100107502n);
        });
        it("latest observation 5 seconds after latest", () => {
          oracle.advanceTime(5);
          const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(5);
          expect(tickCumulative).toEqual(-21n);
          expect(secondsPerLiquidityCumulativeX128).toEqual(2104079302127802832415199655953100107502n);
        });
        it("current observation 5 seconds after latest", () => {
          oracle.advanceTime(5);
          const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(0);
          expect(tickCumulative).toEqual(9n);
          expect(secondsPerLiquidityCumulativeX128).toEqual(2347138135642758877746181518404363115684n);
        });
        it("between latest observation and just before latest observation at same time as latest", () => {
          const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(3);
          expect(tickCumulative).toEqual(-33n);
          expect(secondsPerLiquidityCumulativeX128).toEqual(1593655751746395137220137744805447790318n);
        });
        it("between latest observation and just before latest observation after the latest observation", () => {
          oracle.advanceTime(5);
          const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(8);
          expect(tickCumulative).toEqual(-33n);
          expect(secondsPerLiquidityCumulativeX128).toEqual(1593655751746395137220137744805447790318n);
        });
        it("older than oldest reverts", () => {
          expectRevert(() => observeSingle(15), "KOINDX: OBSERVATION_TOO_OLD");
          oracle.advanceTime(5);
          expectRevert(() => observeSingle(20), "KOINDX: OBSERVATION_TOO_OLD");
        });
        it("oldest observation", () => {
          const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(14);
          expect(tickCumulative).toEqual(-13n);
          expect(secondsPerLiquidityCumulativeX128).toEqual(544451787073501541541399371890829138329n);
        });
        it("oldest observation after some time", () => {
          oracle.advanceTime(6);
          const { tickCumulative, secondsPerLiquidityCumulativeX128 } = observeSingle(20);
          expect(tickCumulative).toEqual(-13n);
          expect(secondsPerLiquidityCumulativeX128).toEqual(544451787073501541541399371890829138329n);
        });

        it("fetch many values", () => {
          oracle.advanceTime(6);
          const { tickCumulatives, secondsPerLiquidityCumulativeX128s } = oracle.observe([20, 17, 13, 10, 5, 1, 0]);
          // Uniswap snapshot (test/__snapshots__/Oracle.spec.ts.snap)
          expect({
            tickCumulatives: tickCumulatives.map(Number),
            secondsPerLiquidityCumulativeX128s: secondsPerLiquidityCumulativeX128s.map((lc) => lc.toString()),
          }).toEqual({
            secondsPerLiquidityCumulativeX128s: [
              "544451787073501541541399371890829138329",
              "799663562264205389138930327464655296921",
              "1045423049484883168306923099498710116305",
              "1423514568285925905488450441089563684590",
              "2152691068830794041481396028443352709138",
              "2347138135642758877746181518404363115684",
              "2395749902345750086812377890894615717321",
            ],
            tickCumulatives: [-13, -31, -43, -37, -15, 9, 15],
          });
        });
      });
    }
  });

  describe("full oracle", () => {
    let full;
    let oracle;

    const BATCH_SIZE = 300;

    const STARTING_TIME = TEST_POOL_START_TIME;

    beforeAll(() => {
      full = oracleFixture();
      full.initialize({ liquidity: 0, tick: 0, time: STARTING_TIME });
      let cardinalityNext = full.cardinalityNext;
      while (cardinalityNext < 65535) {
        const growTo = Math.min(65535, cardinalityNext + BATCH_SIZE);
        full.grow(growTo);
        cardinalityNext = growTo;
      }

      for (let i = 0; i < 65535; i += BATCH_SIZE) {
        const batch = Array(BATCH_SIZE)
          .fill(null)
          .map((_, j) => ({ advanceTimeBy: 13, tick: -i - j, liquidity: i + j }));
        full.batchUpdate(batch);
      }
    }, 600000);

    // the observations are only read: the tests share the oracle, with their own time
    beforeEach(() => {
      oracle = Object.assign(Object.create(OracleTest.prototype), full);
    });

    it("has max cardinality next", () => {
      expect(oracle.cardinalityNext).toEqual(65535);
    });

    it("has max cardinality", () => {
      expect(oracle.cardinality).toEqual(65535);
    });

    it("index wrapped around", () => {
      expect(oracle.index).toEqual(165);
    });

    function checkObserve(secondsAgo, expected) {
      const { tickCumulatives, secondsPerLiquidityCumulativeX128s } = oracle.observe([secondsAgo]);
      expect({
        tickCumulative: tickCumulatives[0].toString(),
        secondsPerLiquidityCumulativeX128: secondsPerLiquidityCumulativeX128s[0].toString(),
      }).toEqual(expected);
    }

    it("can observe into the ordered portion with exact seconds ago", () => {
      checkObserve(100 * 13, { secondsPerLiquidityCumulativeX128: "60465049086512033878831623038233202591033", tickCumulative: "-27970560813" });
    });

    it("can observe into the ordered portion with unexact seconds ago", () => {
      checkObserve(100 * 13 + 5, { secondsPerLiquidityCumulativeX128: "60465023149565257990964350912969670793706", tickCumulative: "-27970232823" });
    });

    it("can observe at exactly the latest observation", () => {
      checkObserve(0, { secondsPerLiquidityCumulativeX128: "60471787506468701386237800669810720099776", tickCumulative: "-28055903863" });
    });

    it("can observe at exactly the latest observation after some time passes", () => {
      oracle.advanceTime(5);
      checkObserve(5, { secondsPerLiquidityCumulativeX128: "60471787506468701386237800669810720099776", tickCumulative: "-28055903863" });
    });

    it("can observe after the latest observation counterfactual", () => {
      oracle.advanceTime(5);
      checkObserve(3, { secondsPerLiquidityCumulativeX128: "60471797865298117996489508104462919730461", tickCumulative: "-28056035261" });
    });

    it("can observe into the unordered portion of array at exact seconds ago of observation", () => {
      checkObserve(200 * 13, { secondsPerLiquidityCumulativeX128: "60458300386499273141628780395875293027404", tickCumulative: "-27885347763" });
    });

    it("can observe into the unordered portion of array at seconds ago between observations", () => {
      checkObserve(200 * 13 + 5, { secondsPerLiquidityCumulativeX128: "60458274409952896081377821330361274907140", tickCumulative: "-27885020273" });
    });

    it("can observe the oldest observation 13*65534 seconds ago", () => {
      checkObserve(13 * 65534, { secondsPerLiquidityCumulativeX128: "33974356747348039873972993881117400879779", tickCumulative: "-175890" });
    });

    it("can observe the oldest observation 13*65534 + 5 seconds ago if time has elapsed", () => {
      oracle.advanceTime(5);
      checkObserve(13 * 65534 + 5, { secondsPerLiquidityCumulativeX128: "33974356747348039873972993881117400879779", tickCumulative: "-175890" });
    });
  });
});
