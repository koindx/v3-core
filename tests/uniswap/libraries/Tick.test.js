// Port of Uniswap v3-core test/Tick.spec.ts. TickTest: the Tick library compiled in
// tests/harness/pool-libraries.ts, run in the Koinos VM emulator with the storage of a contract.
const { KoinosVM } = require("../../vm/koinos-vm");
const { PoolLibraries } = require("../shared/pool-libraries");
const { expectRevert } = require("../shared/contracts");
const { FeeAmount, getMaxLiquidityPerTick, TICK_SPACINGS, MaxUint128, MaxUint256 } = require("../shared/utilities");

/** the Uniswap TickTest contract */
class TickTest {
  constructor() {
    this.lib = new PoolLibraries(new KoinosVM(), "TickTest");
  }

  tickSpacingToMaxLiquidityPerTick(tickSpacing) {
    return BigInt(this.lib.callString("tickSpacingToMaxLiquidityPerTick", tickSpacing));
  }

  setTick(tick, info) {
    this.lib.callVoid(
      "tickSet",
      tick,
      BigInt(info.liquidityGross),
      BigInt(info.liquidityNet),
      BigInt(info.feeGrowthOutside0X128),
      BigInt(info.feeGrowthOutside1X128),
      BigInt(info.tickCumulativeOutside),
      BigInt(info.secondsPerLiquidityOutsideX128),
      info.secondsOutside,
      info.initialized
    );
  }

  ticks(tick) {
    const [liquidityGross, liquidityNet, feeGrowthOutside0X128, feeGrowthOutside1X128, tickCumulativeOutside, secondsPerLiquidityOutsideX128, secondsOutside, initialized] = this.lib
      .callString("tickGet", tick)
      .split(",");
    return {
      liquidityGross: BigInt(liquidityGross),
      liquidityNet: BigInt(liquidityNet),
      feeGrowthOutside0X128: BigInt(feeGrowthOutside0X128),
      feeGrowthOutside1X128: BigInt(feeGrowthOutside1X128),
      tickCumulativeOutside: BigInt(tickCumulativeOutside),
      secondsPerLiquidityOutsideX128: BigInt(secondsPerLiquidityOutsideX128),
      secondsOutside: Number(secondsOutside),
      initialized: initialized === "true",
    };
  }

  getFeeGrowthInside(tickLower, tickUpper, tickCurrent, feeGrowthGlobal0X128, feeGrowthGlobal1X128) {
    const [feeGrowthInside0X128, feeGrowthInside1X128] = this.lib
      .callString("tickGetFeeGrowthInside", tickLower, tickUpper, tickCurrent, BigInt(feeGrowthGlobal0X128), BigInt(feeGrowthGlobal1X128))
      .split(",")
      .map(BigInt);
    return { feeGrowthInside0X128, feeGrowthInside1X128 };
  }

  _updateArgs(tick, tickCurrent, liquidityDelta, feeGrowthGlobal0X128, feeGrowthGlobal1X128, secondsPerLiquidityCumulativeX128, tickCumulative, time, upper, maxLiquidity) {
    return [
      "tickUpdate",
      tick,
      tickCurrent,
      BigInt(liquidityDelta),
      BigInt(feeGrowthGlobal0X128),
      BigInt(feeGrowthGlobal1X128),
      BigInt(secondsPerLiquidityCumulativeX128),
      BigInt(tickCumulative),
      time,
      upper,
      BigInt(maxLiquidity),
    ];
  }

  update(...args) {
    return this.lib.call(...this._updateArgs(...args)).res === 1;
  }

  get callStatic() {
    return { update: (...args) => this.lib.callStatic(...this._updateArgs(...args)).res === 1 };
  }

  clear(tick) {
    this.lib.callVoid("tickClear", tick);
  }

  cross(tick, feeGrowthGlobal0X128, feeGrowthGlobal1X128, secondsPerLiquidityCumulativeX128, tickCumulative, time) {
    return BigInt(
      this.lib.callString("tickCross", tick, BigInt(feeGrowthGlobal0X128), BigInt(feeGrowthGlobal1X128), BigInt(secondsPerLiquidityCumulativeX128), BigInt(tickCumulative), time)
    );
  }
}

const tickInfo = (fields) => ({
  liquidityGross: 0,
  liquidityNet: 0,
  feeGrowthOutside0X128: 0,
  feeGrowthOutside1X128: 0,
  secondsPerLiquidityOutsideX128: 0,
  tickCumulativeOutside: 0,
  secondsOutside: 0,
  initialized: true,
  ...fields,
});

describe("Tick", () => {
  let tickTest;

  beforeEach(() => {
    tickTest = new TickTest();
  });

  describe("#tickSpacingToMaxLiquidityPerTick", () => {
    it("returns the correct value for low fee", () => {
      const maxLiquidityPerTick = tickTest.tickSpacingToMaxLiquidityPerTick(TICK_SPACINGS[FeeAmount.LOW]);
      expect(maxLiquidityPerTick).toEqual(1917569901783203986719870431555990n); // 110.8 bits
      expect(maxLiquidityPerTick).toEqual(getMaxLiquidityPerTick(TICK_SPACINGS[FeeAmount.LOW]));
    });
    it("returns the correct value for medium fee", () => {
      const maxLiquidityPerTick = tickTest.tickSpacingToMaxLiquidityPerTick(TICK_SPACINGS[FeeAmount.MEDIUM]);
      expect(maxLiquidityPerTick).toEqual(11505743598341114571880798222544994n); // 113.1 bits
      expect(maxLiquidityPerTick).toEqual(getMaxLiquidityPerTick(TICK_SPACINGS[FeeAmount.MEDIUM]));
    });
    it("returns the correct value for high fee", () => {
      const maxLiquidityPerTick = tickTest.tickSpacingToMaxLiquidityPerTick(TICK_SPACINGS[FeeAmount.HIGH]);
      expect(maxLiquidityPerTick).toEqual(38350317471085141830651933667504588n); // 114.7 bits
      expect(maxLiquidityPerTick).toEqual(getMaxLiquidityPerTick(TICK_SPACINGS[FeeAmount.HIGH]));
    });
    it("returns the correct value for entire range", () => {
      const maxLiquidityPerTick = tickTest.tickSpacingToMaxLiquidityPerTick(887272);
      expect(maxLiquidityPerTick).toEqual(MaxUint128 / 3n); // 126 bits
      expect(maxLiquidityPerTick).toEqual(getMaxLiquidityPerTick(887272));
    });
    it("returns the correct value for 2302", () => {
      const maxLiquidityPerTick = tickTest.tickSpacingToMaxLiquidityPerTick(2302);
      expect(maxLiquidityPerTick).toEqual(441351967472034323558203122479595605n); // 118 bits
      expect(maxLiquidityPerTick).toEqual(getMaxLiquidityPerTick(2302));
    });
  });

  describe("#getFeeGrowthInside", () => {
    it("returns all for two uninitialized ticks if tick is inside", () => {
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = tickTest.getFeeGrowthInside(-2, 2, 0, 15, 15);
      expect(feeGrowthInside0X128).toEqual(15n);
      expect(feeGrowthInside1X128).toEqual(15n);
    });
    it("returns 0 for two uninitialized ticks if tick is above", () => {
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = tickTest.getFeeGrowthInside(-2, 2, 4, 15, 15);
      expect(feeGrowthInside0X128).toEqual(0n);
      expect(feeGrowthInside1X128).toEqual(0n);
    });
    it("returns 0 for two uninitialized ticks if tick is below", () => {
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = tickTest.getFeeGrowthInside(-2, 2, -4, 15, 15);
      expect(feeGrowthInside0X128).toEqual(0n);
      expect(feeGrowthInside1X128).toEqual(0n);
    });

    it("subtracts upper tick if below", () => {
      tickTest.setTick(2, tickInfo({ feeGrowthOutside0X128: 2, feeGrowthOutside1X128: 3 }));
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = tickTest.getFeeGrowthInside(-2, 2, 0, 15, 15);
      expect(feeGrowthInside0X128).toEqual(13n);
      expect(feeGrowthInside1X128).toEqual(12n);
    });

    it("subtracts lower tick if above", () => {
      tickTest.setTick(-2, tickInfo({ feeGrowthOutside0X128: 2, feeGrowthOutside1X128: 3 }));
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = tickTest.getFeeGrowthInside(-2, 2, 0, 15, 15);
      expect(feeGrowthInside0X128).toEqual(13n);
      expect(feeGrowthInside1X128).toEqual(12n);
    });

    it("subtracts upper and lower tick if inside", () => {
      tickTest.setTick(-2, tickInfo({ feeGrowthOutside0X128: 2, feeGrowthOutside1X128: 3 }));
      tickTest.setTick(2, tickInfo({ feeGrowthOutside0X128: 4, feeGrowthOutside1X128: 1 }));
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = tickTest.getFeeGrowthInside(-2, 2, 0, 15, 15);
      expect(feeGrowthInside0X128).toEqual(9n);
      expect(feeGrowthInside1X128).toEqual(11n);
    });

    it("works correctly with overflow on inside tick", () => {
      tickTest.setTick(-2, tickInfo({ feeGrowthOutside0X128: MaxUint256 - 3n, feeGrowthOutside1X128: MaxUint256 - 2n }));
      tickTest.setTick(2, tickInfo({ feeGrowthOutside0X128: 3, feeGrowthOutside1X128: 5 }));
      const { feeGrowthInside0X128, feeGrowthInside1X128 } = tickTest.getFeeGrowthInside(-2, 2, 0, 15, 15);
      expect(feeGrowthInside0X128).toEqual(16n);
      expect(feeGrowthInside1X128).toEqual(13n);
    });
  });

  describe("#update", () => {
    it("flips from zero to nonzero", () => {
      expect(tickTest.callStatic.update(0, 0, 1, 0, 0, 0, 0, 0, false, 3)).toEqual(true);
    });
    it("does not flip from nonzero to greater nonzero", () => {
      tickTest.update(0, 0, 1, 0, 0, 0, 0, 0, false, 3);
      expect(tickTest.callStatic.update(0, 0, 1, 0, 0, 0, 0, 0, false, 3)).toEqual(false);
    });
    it("flips from nonzero to zero", () => {
      tickTest.update(0, 0, 1, 0, 0, 0, 0, 0, false, 3);
      expect(tickTest.callStatic.update(0, 0, -1, 0, 0, 0, 0, 0, false, 3)).toEqual(true);
    });
    it("does not flip from nonzero to lesser nonzero", () => {
      tickTest.update(0, 0, 2, 0, 0, 0, 0, 0, false, 3);
      expect(tickTest.callStatic.update(0, 0, -1, 0, 0, 0, 0, 0, false, 3)).toEqual(false);
    });
    it("does not flip from nonzero to lesser nonzero (2)", () => {
      tickTest.update(0, 0, 2, 0, 0, 0, 0, 0, false, 3);
      expect(tickTest.callStatic.update(0, 0, -1, 0, 0, 0, 0, 0, false, 3)).toEqual(false);
    });
    it("reverts if total liquidity gross is greater than max", () => {
      tickTest.update(0, 0, 2, 0, 0, 0, 0, 0, false, 3);
      tickTest.update(0, 0, 1, 0, 0, 0, 0, 0, true, 3);
      expectRevert(() => tickTest.update(0, 0, 1, 0, 0, 0, 0, 0, false, 3), "KOINDX: LIQUIDITY_OVERFLOW");
    });
    it("nets the liquidity based on upper flag", () => {
      tickTest.update(0, 0, 2, 0, 0, 0, 0, 0, false, 10);
      tickTest.update(0, 0, 1, 0, 0, 0, 0, 0, true, 10);
      tickTest.update(0, 0, 3, 0, 0, 0, 0, 0, true, 10);
      tickTest.update(0, 0, 1, 0, 0, 0, 0, 0, false, 10);
      const { liquidityGross, liquidityNet } = tickTest.ticks(0);
      expect(liquidityGross).toEqual(BigInt(2 + 1 + 3 + 1));
      expect(liquidityNet).toEqual(BigInt(2 - 1 - 3 + 1));
    });
    it("reverts on overflow liquidity gross", () => {
      tickTest.update(0, 0, MaxUint128 / 2n - 1n, 0, 0, 0, 0, 0, false, MaxUint128);
      expectRevert(() => tickTest.update(0, 0, MaxUint128 / 2n - 1n, 0, 0, 0, 0, 0, false, MaxUint128), "KOINDX: INT128_OVERFLOW");
    });
    it("assumes all growth happens below ticks lte current tick", () => {
      tickTest.update(1, 1, 1, 1, 2, 3, 4, 5, false, MaxUint128);
      const { feeGrowthOutside0X128, feeGrowthOutside1X128, secondsOutside, secondsPerLiquidityOutsideX128, tickCumulativeOutside, initialized } = tickTest.ticks(1);
      expect(feeGrowthOutside0X128).toEqual(1n);
      expect(feeGrowthOutside1X128).toEqual(2n);
      expect(secondsPerLiquidityOutsideX128).toEqual(3n);
      expect(tickCumulativeOutside).toEqual(4n);
      expect(secondsOutside).toEqual(5);
      expect(initialized).toEqual(true);
    });
    it("does not set any growth fields if tick is already initialized", () => {
      tickTest.update(1, 1, 1, 1, 2, 3, 4, 5, false, MaxUint128);
      tickTest.update(1, 1, 1, 6, 7, 8, 9, 10, false, MaxUint128);
      const { feeGrowthOutside0X128, feeGrowthOutside1X128, secondsOutside, secondsPerLiquidityOutsideX128, tickCumulativeOutside, initialized } = tickTest.ticks(1);
      expect(feeGrowthOutside0X128).toEqual(1n);
      expect(feeGrowthOutside1X128).toEqual(2n);
      expect(secondsPerLiquidityOutsideX128).toEqual(3n);
      expect(tickCumulativeOutside).toEqual(4n);
      expect(secondsOutside).toEqual(5);
      expect(initialized).toEqual(true);
    });
    it("does not set any growth fields for ticks gt current tick", () => {
      tickTest.update(2, 1, 1, 1, 2, 3, 4, 5, false, MaxUint128);
      const { feeGrowthOutside0X128, feeGrowthOutside1X128, secondsOutside, secondsPerLiquidityOutsideX128, tickCumulativeOutside, initialized } = tickTest.ticks(2);
      expect(feeGrowthOutside0X128).toEqual(0n);
      expect(feeGrowthOutside1X128).toEqual(0n);
      expect(secondsPerLiquidityOutsideX128).toEqual(0n);
      expect(tickCumulativeOutside).toEqual(0n);
      expect(secondsOutside).toEqual(0);
      expect(initialized).toEqual(true);
    });
  });

  describe("#clear", () => {
    it("deletes all the data in the tick", () => {
      tickTest.setTick(
        2,
        tickInfo({
          feeGrowthOutside0X128: 1,
          feeGrowthOutside1X128: 2,
          liquidityGross: 3,
          liquidityNet: 4,
          secondsPerLiquidityOutsideX128: 5,
          tickCumulativeOutside: 6,
          secondsOutside: 7,
        })
      );
      tickTest.clear(2);
      const t = tickTest.ticks(2);
      expect(t.feeGrowthOutside0X128).toEqual(0n);
      expect(t.feeGrowthOutside1X128).toEqual(0n);
      expect(t.secondsOutside).toEqual(0);
      expect(t.secondsPerLiquidityOutsideX128).toEqual(0n);
      expect(t.tickCumulativeOutside).toEqual(0n);
      expect(t.liquidityGross).toEqual(0n);
      expect(t.liquidityNet).toEqual(0n);
      expect(t.initialized).toEqual(false);
    });
  });

  describe("#cross", () => {
    const info = tickInfo({
      feeGrowthOutside0X128: 1,
      feeGrowthOutside1X128: 2,
      liquidityGross: 3,
      liquidityNet: 4,
      secondsPerLiquidityOutsideX128: 5,
      tickCumulativeOutside: 6,
      secondsOutside: 7,
    });

    it("flips the growth variables", () => {
      tickTest.setTick(2, info);
      expect(tickTest.cross(2, 7, 9, 8, 15, 10)).toEqual(4n);
      const { feeGrowthOutside0X128, feeGrowthOutside1X128, secondsOutside, tickCumulativeOutside, secondsPerLiquidityOutsideX128 } = tickTest.ticks(2);
      expect(feeGrowthOutside0X128).toEqual(6n);
      expect(feeGrowthOutside1X128).toEqual(7n);
      expect(secondsPerLiquidityOutsideX128).toEqual(3n);
      expect(tickCumulativeOutside).toEqual(9n);
      expect(secondsOutside).toEqual(3);
    });
    it("two flips are no op", () => {
      tickTest.setTick(2, info);
      tickTest.cross(2, 7, 9, 8, 15, 10);
      tickTest.cross(2, 7, 9, 8, 15, 10);
      const { feeGrowthOutside0X128, feeGrowthOutside1X128, secondsOutside, tickCumulativeOutside, secondsPerLiquidityOutsideX128 } = tickTest.ticks(2);
      expect(feeGrowthOutside0X128).toEqual(1n);
      expect(feeGrowthOutside1X128).toEqual(2n);
      expect(secondsPerLiquidityOutsideX128).toEqual(5n);
      expect(tickCumulativeOutside).toEqual(6n);
      expect(secondsOutside).toEqual(7);
    });
  });
});
