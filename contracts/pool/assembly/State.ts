import { System, Storage } from "@koinos/sdk-as";
import { pool } from "./proto/pool";
import { Spaces } from "./Spaces";
import { U256 } from "../../../libraries/U256";

/** Uniswap's Slot0 + fee growth globals + protocol fees + liquidity */
export class PoolState {
  /** the current price (Q64.96) */
  sqrtPriceX96: U256 = U256.zero();
  /** the current tick */
  tick: i32 = 0;
  /** the most-recently updated index of the observations array */
  observationIndex: u32 = 0;
  /** the current maximum number of observations that are being stored */
  observationCardinality: u32 = 0;
  /** the next maximum number of observations to store, triggered in observations.write */
  observationCardinalityNext: u32 = 0;
  /** the current protocol fee as a percentage of the swap fee taken on withdrawal, represented as an integer denominator (1/x)% */
  feeProtocol: u32 = 0;
  /** whether the pool is locked */
  unlocked: bool = false;
  /** fee growth per unit of liquidity (Q128.128) */
  feeGrowthGlobal0X128: U256 = U256.zero();
  feeGrowthGlobal1X128: U256 = U256.zero();
  /** accumulated protocol fees in token0/token1 units (uint128) */
  protocolFees0: U256 = U256.zero();
  protocolFees1: U256 = U256.zero();
  /** the currently in range liquidity available to the pool */
  liquidity: U256 = U256.zero();

  static fromRecord(record: pool.state_record): PoolState {
    const s = new PoolState();
    s.sqrtPriceX96 = U256.fromBytes(record.sqrt_price_x96);
    s.tick = record.tick;
    s.observationIndex = record.observation_index;
    s.observationCardinality = record.observation_cardinality;
    s.observationCardinalityNext = record.observation_cardinality_next;
    s.feeProtocol = record.fee_protocol;
    s.unlocked = record.unlocked;
    s.feeGrowthGlobal0X128 = U256.fromBytes(record.fee_growth_global0_x128);
    s.feeGrowthGlobal1X128 = U256.fromBytes(record.fee_growth_global1_x128);
    s.protocolFees0 = U256.fromBytes(record.protocol_fees_token0);
    s.protocolFees1 = U256.fromBytes(record.protocol_fees_token1);
    s.liquidity = U256.fromBytes(record.liquidity);
    return s;
  }

  toRecord(): pool.state_record {
    return new pool.state_record(
      this.sqrtPriceX96.toBytes(),
      this.tick,
      this.observationIndex,
      this.observationCardinality,
      this.observationCardinalityNext,
      this.feeProtocol,
      this.unlocked,
      this.feeGrowthGlobal0X128.toBytes(),
      this.feeGrowthGlobal1X128.toBytes(),
      this.protocolFees0.toBytes(),
      this.protocolFees1.toBytes(),
      this.liquidity.toBytes()
    );
  }
}

/** Uniswap's pool immutables (factory, token0, token1, fee, tickSpacing, maxLiquidityPerTick) */
export class PoolConfig {
  factory: Uint8Array = new Uint8Array(0);
  token0: pool.token_object = new pool.token_object();
  token1: pool.token_object = new pool.token_object();
  fee: u32 = 0;
  tickSpacing: i32 = 0;
  maxLiquidityPerTick: U256 = U256.zero();

  isConfigured(): bool {
    return this.factory.length > 0;
  }

  static fromRecord(record: pool.config_record): PoolConfig {
    const c = new PoolConfig();
    c.factory = record.factory;
    if (record.token0) c.token0 = record.token0!;
    if (record.token1) c.token1 = record.token1!;
    c.fee = record.fee;
    c.tickSpacing = record.tick_spacing;
    c.maxLiquidityPerTick = U256.fromBytes(record.max_liquidity_per_tick);
    return c;
  }

  toRecord(): pool.config_record {
    return new pool.config_record(
      this.factory,
      this.token0,
      this.token1,
      this.fee,
      this.tickSpacing,
      this.maxLiquidityPerTick.toBytes()
    );
  }

  /** resolves the address of a token (system tokens like koin are resolved through the name service) */
  static tokenAddress(tokenObject: pool.token_object): Uint8Array {
    if (tokenObject.is_nameservice) {
      return System.getContractAddress(tokenObject.nameservice);
    }
    return tokenObject.token_address;
  }
}

export class StateStorage {
  config: Storage.Obj<pool.config_record>;
  state: Storage.Obj<pool.state_record>;

  constructor(contractId: Uint8Array) {
    this.config = new Storage.Obj(
      contractId,
      Spaces.CONFIG_SPACE_ID,
      pool.config_record.decode,
      pool.config_record.encode,
      () => new pool.config_record()
    );
    this.state = new Storage.Obj(
      contractId,
      Spaces.STATE_SPACE_ID,
      pool.state_record.decode,
      pool.state_record.encode,
      () => new pool.state_record()
    );
  }

  loadConfig(): PoolConfig {
    return PoolConfig.fromRecord(this.config.get()!);
  }

  saveConfig(config: PoolConfig): void {
    this.config.put(config.toRecord());
  }

  loadState(): PoolState {
    return PoolState.fromRecord(this.state.get()!);
  }

  saveState(state: PoolState): void {
    this.state.put(state.toRecord());
  }
}
