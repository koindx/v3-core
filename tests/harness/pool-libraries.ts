// Test module of the pool libraries that use the contract storage (Tick, TickBitmap, Oracle):
// the equivalent of the Uniswap test contracts TickTest, TickBitmapTest and OracleTest. It runs in
// the Koinos VM emulator (KoinosVM.callModule), in the context (storage) of a test contract.
// Big numbers and int64 values are passed as strings, lists as comma separated strings.
import { System } from "@koinos/sdk-as";
import { U256 } from "../../libraries/U256";
import { I256 } from "../../libraries/I256";
import { Ticks, TickInfo } from "../../contracts/pool/assembly/libraries/Tick";
import { TickBitmap } from "../../contracts/pool/assembly/libraries/TickBitmap";
import { Observations, Observation } from "../../contracts/pool/assembly/libraries/Oracle";

function u(s: string): U256 {
  return U256.fromString(s);
}

function parseI64(s: string): i64 {
  return I64.parseInt(s, 10);
}

function contractId(): Uint8Array {
  return System.getContractId();
}

// TickTest ---------------------------------------------------------------------

export function tickSpacingToMaxLiquidityPerTick(tickSpacing: i32): string {
  return Ticks.tickSpacingToMaxLiquidityPerTick(tickSpacing).toString();
}

export function tickSet(
  tick: i32,
  liquidityGross: string,
  liquidityNet: string,
  feeGrowthOutside0X128: string,
  feeGrowthOutside1X128: string,
  tickCumulativeOutside: string,
  secondsPerLiquidityOutsideX128: string,
  secondsOutside: u32,
  initialized: bool
): void {
  const info = new TickInfo();
  info.liquidityGross = u(liquidityGross);
  info.liquidityNet = I256.fromString(liquidityNet);
  info.feeGrowthOutside0X128 = u(feeGrowthOutside0X128);
  info.feeGrowthOutside1X128 = u(feeGrowthOutside1X128);
  info.tickCumulativeOutside = parseI64(tickCumulativeOutside);
  info.secondsPerLiquidityOutsideX128 = u(secondsPerLiquidityOutsideX128);
  info.secondsOutside = secondsOutside;
  info.initialized = initialized;
  new Ticks(contractId()).put(tick, info);
}

/** liquidityGross,liquidityNet,feeGrowthOutside0X128,feeGrowthOutside1X128,tickCumulativeOutside,secondsPerLiquidityOutsideX128,secondsOutside,initialized */
export function tickGet(tick: i32): string {
  const info = new Ticks(contractId()).get(tick);
  return [
    info.liquidityGross.toString(),
    info.liquidityNet.toString(),
    info.feeGrowthOutside0X128.toString(),
    info.feeGrowthOutside1X128.toString(),
    info.tickCumulativeOutside.toString(),
    info.secondsPerLiquidityOutsideX128.toString(),
    info.secondsOutside.toString(),
    info.initialized ? "true" : "false",
  ].join(",");
}

export function tickGetFeeGrowthInside(
  tickLower: i32,
  tickUpper: i32,
  tickCurrent: i32,
  feeGrowthGlobal0X128: string,
  feeGrowthGlobal1X128: string
): string {
  const res = new Ticks(contractId()).getFeeGrowthInside(tickLower, tickUpper, tickCurrent, u(feeGrowthGlobal0X128), u(feeGrowthGlobal1X128));
  return res.feeGrowthInside0X128.toString() + "," + res.feeGrowthInside1X128.toString();
}

export function tickUpdate(
  tick: i32,
  tickCurrent: i32,
  liquidityDelta: string,
  feeGrowthGlobal0X128: string,
  feeGrowthGlobal1X128: string,
  secondsPerLiquidityCumulativeX128: string,
  tickCumulative: string,
  time: u32,
  upper: bool,
  maxLiquidity: string
): bool {
  return new Ticks(contractId()).update(
    tick,
    tickCurrent,
    I256.fromString(liquidityDelta),
    u(feeGrowthGlobal0X128),
    u(feeGrowthGlobal1X128),
    u(secondsPerLiquidityCumulativeX128),
    parseI64(tickCumulative),
    time,
    upper,
    u(maxLiquidity)
  );
}

export function tickClear(tick: i32): void {
  new Ticks(contractId()).clear(tick);
}

export function tickCross(
  tick: i32,
  feeGrowthGlobal0X128: string,
  feeGrowthGlobal1X128: string,
  secondsPerLiquidityCumulativeX128: string,
  tickCumulative: string,
  time: u32
): string {
  return new Ticks(contractId())
    .cross(tick, u(feeGrowthGlobal0X128), u(feeGrowthGlobal1X128), u(secondsPerLiquidityCumulativeX128), parseI64(tickCumulative), time)
    .toString();
}

// TickBitmapTest (tick spacing of 1) -------------------------------------------

export function bitmapFlipTick(tick: i32): void {
  new TickBitmap(contractId()).flipTick(tick, 1);
}

/** next,initialized */
export function bitmapNextInitializedTickWithinOneWord(tick: i32, lte: bool): string {
  const res = new TickBitmap(contractId()).nextInitializedTickWithinOneWord(tick, 1, lte);
  return res.next.toString() + "," + (res.initialized ? "true" : "false");
}

export function bitmapIsInitialized(tick: i32): bool {
  const res = new TickBitmap(contractId()).nextInitializedTickWithinOneWord(tick, 1, true);
  return res.next == tick ? res.initialized : false;
}

// OracleTest (the state of OracleTest is kept by the caller) -------------------

/** index,cardinality */
export function oracleInitialize(time: u32): string {
  const res = new Observations(contractId()).initialize(time);
  return res.index.toString() + "," + res.cardinality.toString();
}

/** index,cardinality */
export function oracleWrite(index: u32, blockTimestamp: u32, tick: i32, liquidity: string, cardinality: u32, cardinalityNext: u32): string {
  const res = new Observations(contractId()).write(index, blockTimestamp, tick, u(liquidity), cardinality, cardinalityNext);
  return res.index.toString() + "," + res.cardinality.toString();
}

export function oracleGrow(current: u32, next: u32): u32 {
  return new Observations(contractId()).grow(current, next);
}

/** tickCumulative,secondsPerLiquidityCumulativeX128 for each secondsAgo, separated by ";" */
export function oracleObserve(time: u32, secondsAgos: string, tick: i32, index: u32, liquidity: string, cardinality: u32): string {
  const parts = secondsAgos.length > 0 ? secondsAgos.split(",") : new Array<string>(0);
  const values = new Array<u32>(parts.length);
  for (let i = 0; i < parts.length; i++) values[i] = <u32>I64.parseInt(parts[i], 10);
  const res = new Observations(contractId()).observe(time, values, tick, index, u(liquidity), cardinality);
  const out = new Array<string>(res.length);
  for (let i = 0; i < res.length; i++) {
    out[i] = res[i].tickCumulative.toString() + "," + res[i].secondsPerLiquidityCumulativeX128.toString();
  }
  return out.join(";");
}

/** blockTimestamp,tickCumulative,secondsPerLiquidityCumulativeX128,initialized */
export function oracleGet(index: u32): string {
  const obs: Observation = new Observations(contractId()).get(index);
  return [
    obs.blockTimestamp.toString(),
    obs.tickCumulative.toString(),
    obs.secondsPerLiquidityCumulativeX128.toString(),
    obs.initialized ? "true" : "false",
  ].join(",");
}

/**
 * OracleTest.batchUpdate: writes an observation for each update, then changes the tick and the
 * liquidity. Returns index,cardinality,time,tick,liquidity
 */
export function oracleBatchUpdate(
  index: u32,
  time: u32,
  tick: i32,
  liquidity: string,
  cardinality: u32,
  cardinalityNext: u32,
  advanceTimeBys: string,
  ticks: string,
  liquidities: string
): string {
  const observations = new Observations(contractId());
  const advances = advanceTimeBys.split(",");
  const newTicks = ticks.split(",");
  const newLiquidities = liquidities.split(",");
  let _index = index;
  let _cardinality = cardinality;
  let _time = time;
  let _tick = tick;
  let _liquidity = u(liquidity);
  for (let i = 0; i < advances.length; i++) {
    _time += <u32>I64.parseInt(advances[i], 10);
    const res = observations.write(_index, _time, _tick, _liquidity, _cardinality, cardinalityNext);
    _index = res.index;
    _cardinality = res.cardinality;
    _tick = <i32>I64.parseInt(newTicks[i], 10);
    _liquidity = u(newLiquidities[i]);
  }
  return [_index.toString(), _cardinality.toString(), _time.toString(), _tick.toString(), _liquidity.toString()].join(",");
}
