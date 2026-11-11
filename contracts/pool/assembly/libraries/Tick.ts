import { System, Storage } from "@koinos/sdk-as";
import { pool } from "../proto/pool";
import { Spaces } from "../Spaces";
import { U256 } from "../../../../libraries/U256";
import { I256 } from "../../../../libraries/I256";
import { Keys } from "../../../../utils/Keys";
import { TickMath } from "../../../../libraries/TickMath";
import { LiquidityMath } from "../../../../libraries/LiquidityMath";

const UINT160_BITS = 160;

/** info stored for each initialized individual tick */
export class TickInfo {
  /** the total position liquidity that references this tick */
  liquidityGross: U256 = U256.zero();
  /** amount of net liquidity added (subtracted) when tick is crossed from left to right (right to left) */
  liquidityNet: I256 = I256.zero();
  /** fee growth per unit of liquidity on the _other_ side of this tick (relative to the current tick) */
  feeGrowthOutside0X128: U256 = U256.zero();
  feeGrowthOutside1X128: U256 = U256.zero();
  /** the cumulative tick value on the other side of the tick (int56 in Uniswap) */
  tickCumulativeOutside: i64 = 0;
  /** the seconds per unit of liquidity on the _other_ side of this tick (uint160) */
  secondsPerLiquidityOutsideX128: U256 = U256.zero();
  /** the seconds spent on the other side of the tick (relative to the current tick) */
  secondsOutside: u32 = 0;
  /** true iff the tick is initialized, i.e. the value is exactly equivalent to the expression liquidityGross != 0 */
  initialized: bool = false;

  static fromRecord(record: pool.tick_record | null): TickInfo {
    const info = new TickInfo();
    if (record) {
      info.liquidityGross = U256.fromBytes(record.liquidity_gross);
      info.liquidityNet = I256.fromBytes(record.liquidity_net);
      info.feeGrowthOutside0X128 = U256.fromBytes(record.fee_growth_outside0_x128);
      info.feeGrowthOutside1X128 = U256.fromBytes(record.fee_growth_outside1_x128);
      info.tickCumulativeOutside = record.tick_cumulative_outside;
      info.secondsPerLiquidityOutsideX128 = U256.fromBytes(record.seconds_per_liquidity_outside_x128);
      info.secondsOutside = record.seconds_outside;
      info.initialized = record.initialized;
    }
    return info;
  }

  toRecord(): pool.tick_record {
    return new pool.tick_record(
      this.liquidityGross.toBytes(),
      this.liquidityNet.toBytes(),
      this.feeGrowthOutside0X128.toBytes(),
      this.feeGrowthOutside1X128.toBytes(),
      this.tickCumulativeOutside,
      this.secondsPerLiquidityOutsideX128.toBytes(),
      this.secondsOutside,
      this.initialized
    );
  }
}

export class FeeGrowthInside {
  constructor(public feeGrowthInside0X128: U256, public feeGrowthInside1X128: U256) {}
}

/**
 * Port of Uniswap v3 Tick library.
 *
 * Contains functions for managing tick processes and relevant calculations
 */
export class Ticks {
  map: Storage.Map<Uint8Array, pool.tick_record>;

  constructor(contractId: Uint8Array) {
    this.map = new Storage.Map(
      contractId,
      Spaces.TICKS_SPACE_ID,
      pool.tick_record.decode,
      pool.tick_record.encode,
      null
    );
  }

  get(tick: i32): TickInfo {
    return TickInfo.fromRecord(this.map.get(Keys.int32(tick)));
  }

  put(tick: i32, info: TickInfo): void {
    this.map.put(Keys.int32(tick), info.toRecord());
  }

  /** Clears tick data */
  clear(tick: i32): void {
    this.map.remove(Keys.int32(tick));
  }

  /**
   * Derives max liquidity per tick from given tick spacing.
   * Executed within the pool constructor (here: when the pool is configured by the factory)
   */
  static tickSpacingToMaxLiquidityPerTick(tickSpacing: i32): U256 {
    const minTick = (TickMath.MIN_TICK / tickSpacing) * tickSpacing;
    const maxTick = (TickMath.MAX_TICK / tickSpacing) * tickSpacing;
    const numTicks = <u32>((maxTick - minTick) / tickSpacing) + 1;
    return U256.div(U256.maxBits(128), U256.fromU32(numTicks));
  }

  /** Retrieves fee growth data */
  getFeeGrowthInside(
    tickLower: i32,
    tickUpper: i32,
    tickCurrent: i32,
    feeGrowthGlobal0X128: U256,
    feeGrowthGlobal1X128: U256
  ): FeeGrowthInside {
    const lower = this.get(tickLower);
    const upper = this.get(tickUpper);

    // fee growth values are relative: the subtractions wrap around (mod 2^256) on purpose,
    // only the differences between two snapshots are meaningful
    // calculate fee growth below
    let feeGrowthBelow0X128: U256;
    let feeGrowthBelow1X128: U256;
    if (tickCurrent >= tickLower) {
      feeGrowthBelow0X128 = lower.feeGrowthOutside0X128;
      feeGrowthBelow1X128 = lower.feeGrowthOutside1X128;
    } else {
      feeGrowthBelow0X128 = U256.wrappingSub(feeGrowthGlobal0X128, lower.feeGrowthOutside0X128);
      feeGrowthBelow1X128 = U256.wrappingSub(feeGrowthGlobal1X128, lower.feeGrowthOutside1X128);
    }

    // calculate fee growth above
    let feeGrowthAbove0X128: U256;
    let feeGrowthAbove1X128: U256;
    if (tickCurrent < tickUpper) {
      feeGrowthAbove0X128 = upper.feeGrowthOutside0X128;
      feeGrowthAbove1X128 = upper.feeGrowthOutside1X128;
    } else {
      feeGrowthAbove0X128 = U256.wrappingSub(feeGrowthGlobal0X128, upper.feeGrowthOutside0X128);
      feeGrowthAbove1X128 = U256.wrappingSub(feeGrowthGlobal1X128, upper.feeGrowthOutside1X128);
    }

    return new FeeGrowthInside(
      U256.wrappingSub(U256.wrappingSub(feeGrowthGlobal0X128, feeGrowthBelow0X128), feeGrowthAbove0X128),
      U256.wrappingSub(U256.wrappingSub(feeGrowthGlobal1X128, feeGrowthBelow1X128), feeGrowthAbove1X128)
    );
  }

  /**
   * Updates a tick and returns true if the tick was flipped from initialized to uninitialized, or vice versa
   */
  update(
    tick: i32,
    tickCurrent: i32,
    liquidityDelta: I256,
    feeGrowthGlobal0X128: U256,
    feeGrowthGlobal1X128: U256,
    secondsPerLiquidityCumulativeX128: U256,
    tickCumulative: i64,
    time: u32,
    upper: bool,
    maxLiquidity: U256
  ): bool {
    const info = this.get(tick);

    const liquidityGrossBefore = info.liquidityGross;
    const liquidityGrossAfter = LiquidityMath.addDelta(liquidityGrossBefore, liquidityDelta);

    System.require(U256.lte(liquidityGrossAfter, maxLiquidity), "KOINDX: LIQUIDITY_OVERFLOW");

    const flipped = liquidityGrossAfter.isZero() != liquidityGrossBefore.isZero();

    if (liquidityGrossBefore.isZero()) {
      // by convention, we assume that all growth before a tick was initialized happened _below_ the tick
      if (tick <= tickCurrent) {
        info.feeGrowthOutside0X128 = feeGrowthGlobal0X128;
        info.feeGrowthOutside1X128 = feeGrowthGlobal1X128;
        info.secondsPerLiquidityOutsideX128 = secondsPerLiquidityCumulativeX128;
        info.tickCumulativeOutside = tickCumulative;
        info.secondsOutside = time;
      }
      info.initialized = true;
    }

    info.liquidityGross = liquidityGrossAfter;

    // when the lower (upper) tick is crossed left to right (right to left), liquidity must be added (removed)
    info.liquidityNet = upper
      ? I256.sub(info.liquidityNet, liquidityDelta).checkInt128()
      : I256.add(info.liquidityNet, liquidityDelta).checkInt128();

    this.put(tick, info);
    return flipped;
  }

  /**
   * Transitions to next tick as needed by price movement
   * @returns the amount of liquidity added (subtracted) when tick is crossed from left to right (right to left)
   */
  cross(
    tick: i32,
    feeGrowthGlobal0X128: U256,
    feeGrowthGlobal1X128: U256,
    secondsPerLiquidityCumulativeX128: U256,
    tickCumulative: i64,
    time: u32
  ): I256 {
    const info = this.get(tick);
    info.feeGrowthOutside0X128 = U256.wrappingSub(feeGrowthGlobal0X128, info.feeGrowthOutside0X128);
    info.feeGrowthOutside1X128 = U256.wrappingSub(feeGrowthGlobal1X128, info.feeGrowthOutside1X128);
    info.secondsPerLiquidityOutsideX128 = U256.truncate(
      U256.wrappingSub(secondsPerLiquidityCumulativeX128, info.secondsPerLiquidityOutsideX128),
      UINT160_BITS
    );
    info.tickCumulativeOutside = tickCumulative - info.tickCumulativeOutside;
    info.secondsOutside = time - info.secondsOutside;
    this.put(tick, info);
    return info.liquidityNet;
  }
}
