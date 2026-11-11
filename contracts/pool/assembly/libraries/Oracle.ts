import { System, Storage } from "@koinos/sdk-as";
import { pool } from "../proto/pool";
import { Spaces } from "../Spaces";
import { U256 } from "../../../../libraries/U256";
import { Keys } from "../../../../utils/Keys";

const UINT160_BITS = 160;
const MAX_CARDINALITY: u32 = 65535;

export class Observation {
  /** the block timestamp of the observation (seconds, truncated to 32 bits) */
  blockTimestamp: u32 = 0;
  /** the tick accumulator, i.e. tick * time elapsed since the pool was first initialized (int56 in Uniswap) */
  tickCumulative: i64 = 0;
  /** the seconds per liquidity, i.e. seconds elapsed / max(1, liquidity) since the pool was first initialized (uint160) */
  secondsPerLiquidityCumulativeX128: U256 = U256.zero();
  /** whether or not the observation is initialized */
  initialized: bool = false;

  static fromRecord(record: pool.observation_record | null): Observation {
    const obs = new Observation();
    if (record) {
      obs.blockTimestamp = record.block_timestamp;
      obs.tickCumulative = record.tick_cumulative;
      obs.secondsPerLiquidityCumulativeX128 = U256.fromBytes(record.seconds_per_liquidity_cumulative_x128);
      obs.initialized = record.initialized;
    }
    return obs;
  }

  toRecord(): pool.observation_record {
    return new pool.observation_record(
      this.blockTimestamp,
      this.tickCumulative,
      this.secondsPerLiquidityCumulativeX128.toBytes(),
      this.initialized
    );
  }
}

export class IndexAndCardinality {
  constructor(public index: u32, public cardinality: u32) {}
}

export class CumulativeValues {
  constructor(public tickCumulative: i64, public secondsPerLiquidityCumulativeX128: U256) {}
}

class SurroundingObservations {
  constructor(public beforeOrAt: Observation, public atOrAfter: Observation) {}
}

/**
 * Transforms a previous observation into a new observation, given the passage of time and the current tick and liquidity values
 */
function transform(last: Observation, blockTimestamp: u32, tick: i32, liquidity: U256): Observation {
  const delta: u32 = blockTimestamp - last.blockTimestamp;
  const obs = new Observation();
  obs.blockTimestamp = blockTimestamp;
  obs.tickCumulative = last.tickCumulative + <i64>tick * <i64>delta;
  // uint160 accumulator: wraps around (mod 2^160) on purpose, only differences are meaningful
  obs.secondsPerLiquidityCumulativeX128 = U256.truncate(
    U256.wrappingAdd(
      last.secondsPerLiquidityCumulativeX128,
      U256.div(U256.shl(U256.fromU32(delta), 128), liquidity.isZero() ? U256.one() : liquidity)
    ),
    UINT160_BITS
  );
  obs.initialized = true;
  return obs;
}

/**
 * comparator for 32-bit timestamps
 * safe for 0 or 1 overflows, a and b _must_ be chronologically before or equal to time
 */
function lte(time: u32, a: u32, b: u32): bool {
  // if there hasn't been overflow, no need to adjust
  if (a <= time && b <= time) return a <= b;

  const aAdjusted: u64 = a > time ? <u64>a : <u64>a + 0x100000000;
  const bAdjusted: u64 = b > time ? <u64>b : <u64>b + 0x100000000;

  return aAdjusted <= bAdjusted;
}

/**
 * Port of Uniswap v3 Oracle.
 *
 * Provides price and liquidity data useful for a wide variety of system designs. Instances of
 * stored oracle data, "observations", are collected in the oracle array.
 *
 * Like Uniswap, `grow` pre-fills the new slots (so the swaps don't pay for creating them); an
 * absent observation reads like an uninitialized one.
 */
export class Observations {
  map: Storage.Map<Uint8Array, pool.observation_record>;

  constructor(contractId: Uint8Array) {
    this.map = new Storage.Map(
      contractId,
      Spaces.OBSERVATIONS_SPACE_ID,
      pool.observation_record.decode,
      pool.observation_record.encode,
      null
    );
  }

  get(index: u32): Observation {
    return Observation.fromRecord(this.map.get(Keys.uint16(index)));
  }

  put(index: u32, obs: Observation): void {
    this.map.put(Keys.uint16(index), obs.toRecord());
  }

  /** Initialize the oracle array by writing the first slot. Called once for the lifecycle of the observations array */
  initialize(time: u32): IndexAndCardinality {
    const obs = new Observation();
    obs.blockTimestamp = time;
    obs.initialized = true;
    this.put(0, obs);
    return new IndexAndCardinality(1, 1);
  }

  /**
   * Writes an oracle observation to the array. Writable at most once per block.
   * Index represents the most recently written element. cardinality and index must be tracked externally.
   * If the index is at the end of the allowable array length (according to cardinality), and the next cardinality
   * is greater than the current one, cardinality may be increased. This restriction is created to preserve ordering.
   */
  write(
    index: u32,
    blockTimestamp: u32,
    tick: i32,
    liquidity: U256,
    cardinality: u32,
    cardinalityNext: u32
  ): IndexAndCardinality {
    const last = this.get(index);

    // early return if we've already written an observation this block
    if (last.blockTimestamp == blockTimestamp) return new IndexAndCardinality(index, cardinality);

    let cardinalityUpdated: u32;
    // if the conditions are right, we can bump the cardinality
    if (cardinalityNext > cardinality && index == cardinality - 1) {
      cardinalityUpdated = cardinalityNext;
    } else {
      cardinalityUpdated = cardinality;
    }

    const indexUpdated = (index + 1) % cardinalityUpdated;
    this.put(indexUpdated, transform(last, blockTimestamp, tick, liquidity));
    return new IndexAndCardinality(indexUpdated, cardinalityUpdated);
  }

  /** Prepares the oracle array to store up to `next` observations */
  grow(current: u32, next: u32): u32 {
    System.require(current > 0, "KOINDX: OBSERVATIONS_NOT_INITIALIZED");
    // no-op if the passed next value isn't greater than the current next value
    if (next <= current) return current;
    System.require(next <= MAX_CARDINALITY, "KOINDX: CARDINALITY_TOO_HIGH");
    // store in each slot to prevent creating new objects in swaps (the caller of the growth pays
    // the storage, like in Uniswap). This data will not be used because initialized is still false
    const placeholder = new Observation();
    placeholder.blockTimestamp = 1;
    const record = placeholder.toRecord();
    for (let i = current; i < next; i++) this.map.put(Keys.uint16(i), record);
    return next;
  }

  /**
   * Fetches the observations beforeOrAt and atOrAfter a target, i.e. where [beforeOrAt, atOrAfter] is satisfied.
   * The result may be the same observation, or adjacent observations.
   */
  private binarySearch(time: u32, target: u32, index: u32, cardinality: u32): SurroundingObservations {
    let l: i64 = <i64>((index + 1) % cardinality); // oldest observation
    let r: i64 = l + <i64>cardinality - 1; // newest observation
    let i: i64;
    let beforeOrAt = new Observation();
    let atOrAfter = new Observation();
    while (true) {
      i = (l + r) / 2;

      beforeOrAt = this.get(<u32>(i % <i64>cardinality));

      // we've landed on an uninitialized tick, keep searching higher (more recently)
      if (!beforeOrAt.initialized) {
        l = i + 1;
        continue;
      }

      atOrAfter = this.get(<u32>((i + 1) % <i64>cardinality));

      const targetAtOrAfter = lte(time, beforeOrAt.blockTimestamp, target);

      // check if we've found the answer!
      if (targetAtOrAfter && lte(time, target, atOrAfter.blockTimestamp)) break;

      if (!targetAtOrAfter) r = i - 1;
      else l = i + 1;

      System.require(l <= r + 1, "KOINDX: OBSERVATION_NOT_FOUND");
    }
    return new SurroundingObservations(beforeOrAt, atOrAfter);
  }

  /**
   * Fetches the observations beforeOrAt and atOrAfter a given target, i.e. where [beforeOrAt, atOrAfter] is satisfied
   * Assumes there is at least 1 initialized observation.
   */
  private getSurroundingObservations(
    time: u32,
    target: u32,
    tick: i32,
    index: u32,
    liquidity: U256,
    cardinality: u32
  ): SurroundingObservations {
    // optimistically set before to the newest observation
    let beforeOrAt = this.get(index);

    // if the target is chronologically at or after the newest observation, we can early return
    if (lte(time, beforeOrAt.blockTimestamp, target)) {
      if (beforeOrAt.blockTimestamp == target) {
        // if newest observation equals target, we're in the same block, so we can ignore atOrAfter
        return new SurroundingObservations(beforeOrAt, new Observation());
      } else {
        // otherwise, we need to transform
        return new SurroundingObservations(beforeOrAt, transform(beforeOrAt, target, tick, liquidity));
      }
    }

    // now, set before to the oldest observation
    beforeOrAt = this.get((index + 1) % cardinality);
    if (!beforeOrAt.initialized) beforeOrAt = this.get(0);

    // ensure that the target is chronologically at or after the oldest observation
    System.require(lte(time, beforeOrAt.blockTimestamp, target), "KOINDX: OBSERVATION_TOO_OLD");

    // if we've reached this point, we have to binary search
    return this.binarySearch(time, target, index, cardinality);
  }

  /**
   * Returns the accumulator values as of each time seconds ago from the given time in the array of `secondsAgos`.
   * Reverts if `secondsAgo` > oldest observation
   */
  observeSingle(
    time: u32,
    secondsAgo: u32,
    tick: i32,
    index: u32,
    liquidity: U256,
    cardinality: u32
  ): CumulativeValues {
    if (secondsAgo == 0) {
      let last = this.get(index);
      if (last.blockTimestamp != time) last = transform(last, time, tick, liquidity);
      return new CumulativeValues(last.tickCumulative, last.secondsPerLiquidityCumulativeX128);
    }

    const target: u32 = time - secondsAgo;

    const surrounding = this.getSurroundingObservations(time, target, tick, index, liquidity, cardinality);
    const beforeOrAt = surrounding.beforeOrAt;
    const atOrAfter = surrounding.atOrAfter;

    if (target == beforeOrAt.blockTimestamp) {
      // we're at the left boundary
      return new CumulativeValues(beforeOrAt.tickCumulative, beforeOrAt.secondsPerLiquidityCumulativeX128);
    } else if (target == atOrAfter.blockTimestamp) {
      // we're at the right boundary
      return new CumulativeValues(atOrAfter.tickCumulative, atOrAfter.secondsPerLiquidityCumulativeX128);
    } else {
      // we're in the middle
      const observationTimeDelta: u32 = atOrAfter.blockTimestamp - beforeOrAt.blockTimestamp;
      const targetDelta: u32 = target - beforeOrAt.blockTimestamp;
      const tickCumulative = beforeOrAt.tickCumulative +
        ((atOrAfter.tickCumulative - beforeOrAt.tickCumulative) / <i64>observationTimeDelta) * <i64>targetDelta;
      const secondsPerLiquidityDelta = U256.truncate(
        U256.wrappingSub(atOrAfter.secondsPerLiquidityCumulativeX128, beforeOrAt.secondsPerLiquidityCumulativeX128),
        UINT160_BITS
      );
      const secondsPerLiquidity = U256.truncate(
        U256.wrappingAdd(
          beforeOrAt.secondsPerLiquidityCumulativeX128,
          U256.truncate(
            U256.div(U256.mul(secondsPerLiquidityDelta, U256.fromU32(targetDelta)), U256.fromU32(observationTimeDelta)),
            UINT160_BITS
          )
        ),
        UINT160_BITS
      );
      return new CumulativeValues(tickCumulative, secondsPerLiquidity);
    }
  }

  /**
   * Returns the accumulator values as of each time seconds ago from the given time in the array of `secondsAgos`
   */
  observe(
    time: u32,
    secondsAgos: u32[],
    tick: i32,
    index: u32,
    liquidity: U256,
    cardinality: u32
  ): CumulativeValues[] {
    System.require(cardinality > 0, "KOINDX: OBSERVATIONS_NOT_INITIALIZED");
    const result = new Array<CumulativeValues>(secondsAgos.length);
    for (let i = 0; i < secondsAgos.length; i++) {
      result[i] = this.observeSingle(time, secondsAgos[i], tick, index, liquidity, cardinality);
    }
    return result;
  }
}
