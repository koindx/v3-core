import { System, Protobuf, Storage, chain, authority } from "@koinos/sdk-as";
import { pool } from "./proto/pool";
import { Spaces } from "./Spaces";
import { PoolState, PoolConfig, StateStorage } from "./State";
import { Ticks, TickInfo } from "./libraries/Tick";
import { TickBitmap } from "./libraries/TickBitmap";
import { Positions, PositionInfo } from "./libraries/Position";
import { Observations } from "./libraries/Oracle";
import { U256 } from "../../../libraries/U256";
import { I256 } from "../../../libraries/I256";
import { Keys } from "../../../utils/Keys";
import { TickMath } from "../../../libraries/TickMath";
import { SqrtPriceMath } from "../../../libraries/SqrtPriceMath";
import { SwapMath } from "../../../libraries/SwapMath";
import { LiquidityMath } from "../../../libraries/LiquidityMath";
import { FixedPoint128 } from "../../../libraries/FixedPoint";
import { Contract, TokenHelper } from "../../../utils/Contract";
import { ADDRESS_LENGTH } from "../../../utils/Tokens";
import { SafeCast } from "../../../libraries/SafeCast";

// entry points called by the pool
const MINT_CALLBACK_ENTRY: u32 = 0x7c878d25; // koindx_v3_mint_callback
const SWAP_CALLBACK_ENTRY: u32 = 0x38e03f68; // koindx_v3_swap_callback
const FLASH_CALLBACK_ENTRY: u32 = 0xcd7ce544; // koindx_v3_flash_callback
const FACTORY_OWNER_ENTRY: u32 = 0x4c102969; // factory.owner

const MAX_TICK_SPACING: i32 = 16384;
const MAX_POPULATED_TICKS: u32 = 500;

class ModifyPositionResult {
  constructor(
    /** the position with the given owner and tick range (updated in memory, not saved) */
    public position: PositionInfo,
    /** the amount of token0 owed to the pool (mint) or owed to the position (burn) */
    public amount0: U256,
    /** the amount of token1 owed to the pool (mint) or owed to the position (burn) */
    public amount1: U256
  ) {}
}

/** the top level state of the swap, the results of which are recorded in storage at the end */
class SwapResult {
  /** the amount of the input token paid to the pool (token0 if zeroForOne) */
  amountIn: u64 = 0;
  /** the amount of the output token sent by the pool (token1 if zeroForOne) */
  amountOut: u64 = 0;
  sqrtPriceX96: U256 = U256.zero();
  tick: i32 = 0;
  liquidity: U256 = U256.zero();
  feeGrowthGlobalX128: U256 = U256.zero();
  protocolFee: U256 = U256.zero();
  initializedTicksCrossed: u32 = 0;
}

/**
 * KoinDX v3 Pool: port of UniswapV3Pool.
 *
 * A pool is a contract uploaded to its own address (like the KoinDX v2 core). The factory
 * validates the bytecode and calls `configure` with the immutable parameters of the pool.
 */
export class Pool {
  contractId: Uint8Array;
  storage: StateStorage;
  tickStore: Ticks;
  tickBitmap: TickBitmap;
  positionStore: Positions;
  observationStore: Observations;
  private _config: PoolConfig | null = null;

  constructor() {
    this.contractId = System.getContractId();
    this.storage = new StateStorage(this.contractId);
    this.tickStore = new Ticks(this.contractId);
    this.tickBitmap = new TickBitmap(this.contractId);
    this.positionStore = new Positions(this.contractId);
    this.observationStore = new Observations(this.contractId);
  }

  /**
   * The contract is deployed overriding its own authority (call contract, transaction
   * application and upload contract): nobody can act on behalf of it or upgrade its code.
   */
  authorize(args: authority.authorize_arguments): authority.authorize_result {
    return new authority.authorize_result(false);
  }

  // ---------------------------------------------------------------------------
  // read methods
  // ---------------------------------------------------------------------------

  get_immutables(args: pool.get_immutables_arguments): pool.get_immutables_result {
    const config = this.config();
    return new pool.get_immutables_result(
      config.factory,
      config.isConfigured() ? PoolConfig.tokenAddress(config.token0) : new Uint8Array(0),
      config.isConfigured() ? PoolConfig.tokenAddress(config.token1) : new Uint8Array(0),
      config.fee,
      config.tickSpacing,
      config.maxLiquidityPerTick.toString(),
      config.token0,
      config.token1
    );
  }

  slot0(args: pool.slot0_arguments): pool.slot0_result {
    const state = this.storage.loadState();
    return new pool.slot0_result(
      state.sqrtPriceX96.toString(),
      state.tick,
      state.observationIndex,
      state.observationCardinality,
      state.observationCardinalityNext,
      state.feeProtocol,
      state.unlocked
    );
  }

  liquidity(args: pool.liquidity_arguments): pool.str {
    return new pool.str(this.storage.loadState().liquidity.toString());
  }

  fee_growth_global(args: pool.fee_growth_global_arguments): pool.fee_growth_global_result {
    const state = this.storage.loadState();
    return new pool.fee_growth_global_result(
      state.feeGrowthGlobal0X128.toString(),
      state.feeGrowthGlobal1X128.toString()
    );
  }

  protocol_fees(args: pool.protocol_fees_arguments): pool.protocol_fees_result {
    const state = this.storage.loadState();
    return new pool.protocol_fees_result(state.protocolFees0.toString(), state.protocolFees1.toString());
  }

  ticks(args: pool.ticks_arguments): pool.ticks_result {
    const info = this.tickStore.get(args.tick);
    return new pool.ticks_result(
      info.liquidityGross.toString(),
      info.liquidityNet.toString(),
      info.feeGrowthOutside0X128.toString(),
      info.feeGrowthOutside1X128.toString(),
      info.tickCumulativeOutside,
      info.secondsPerLiquidityOutsideX128.toString(),
      info.secondsOutside,
      info.initialized
    );
  }

  tick_bitmap(args: pool.tick_bitmap_arguments): pool.str {
    // Uniswap: int16 word positions
    System.require(args.word_position >= i16.MIN_VALUE && args.word_position <= i16.MAX_VALUE, "KOINDX: INVALID_WORD_POSITION");
    return new pool.str(this.tickBitmap.getWord(args.word_position).toString());
  }

  positions(args: pool.positions_arguments): pool.positions_result {
    const position = this.positionStore.get(args.owner, args.tick_lower, args.tick_upper);
    return new pool.positions_result(
      position.liquidity.toString(),
      position.feeGrowthInside0LastX128.toString(),
      position.feeGrowthInside1LastX128.toString(),
      position.tokensOwed0.toString(),
      position.tokensOwed1.toString()
    );
  }

  observations(args: pool.observations_arguments): pool.observations_result {
    // Uniswap: an array of 65535 observations
    System.require(args.index < 65535, "KOINDX: INVALID_INDEX");
    const obs = this.observationStore.get(args.index);
    return new pool.observations_result(
      obs.blockTimestamp,
      obs.tickCumulative,
      obs.secondsPerLiquidityCumulativeX128.toString(),
      obs.initialized
    );
  }

  observe(args: pool.observe_arguments): pool.observe_result {
    const state = this.storage.loadState();
    const values = this.observationStore.observe(
      this.blockTimestamp(),
      args.seconds_agos,
      state.tick,
      state.observationIndex,
      state.liquidity,
      state.observationCardinality
    );
    const tickCumulatives = new Array<i64>(values.length);
    const secondsPerLiquidity = new Array<string>(values.length);
    for (let i = 0; i < values.length; i++) {
      tickCumulatives[i] = values[i].tickCumulative;
      secondsPerLiquidity[i] = values[i].secondsPerLiquidityCumulativeX128.toString();
    }
    return new pool.observe_result(tickCumulatives, secondsPerLiquidity);
  }

  snapshot_cumulatives_inside(args: pool.snapshot_cumulatives_inside_arguments): pool.snapshot_cumulatives_inside_result {
    const tickLower = args.tick_lower;
    const tickUpper = args.tick_upper;
    this.checkTicks(tickLower, tickUpper);

    const lower = this.tickStore.get(tickLower);
    System.require(lower.initialized, "KOINDX: TICK_NOT_INITIALIZED");
    const upper = this.tickStore.get(tickUpper);
    System.require(upper.initialized, "KOINDX: TICK_NOT_INITIALIZED");

    const state = this.storage.loadState();

    if (state.tick < tickLower) {
      return new pool.snapshot_cumulatives_inside_result(
        lower.tickCumulativeOutside - upper.tickCumulativeOutside,
        uint160Sub(lower.secondsPerLiquidityOutsideX128, upper.secondsPerLiquidityOutsideX128).toString(),
        lower.secondsOutside - upper.secondsOutside
      );
    } else if (state.tick < tickUpper) {
      const time = this.blockTimestamp();
      const cumulatives = this.observationStore.observeSingle(
        time,
        0,
        state.tick,
        state.observationIndex,
        state.liquidity,
        state.observationCardinality
      );
      return new pool.snapshot_cumulatives_inside_result(
        cumulatives.tickCumulative - lower.tickCumulativeOutside - upper.tickCumulativeOutside,
        uint160Sub(
          uint160Sub(cumulatives.secondsPerLiquidityCumulativeX128, lower.secondsPerLiquidityOutsideX128),
          upper.secondsPerLiquidityOutsideX128
        ).toString(),
        time - lower.secondsOutside - upper.secondsOutside
      );
    }
    return new pool.snapshot_cumulatives_inside_result(
      upper.tickCumulativeOutside - lower.tickCumulativeOutside,
      uint160Sub(upper.secondsPerLiquidityOutsideX128, lower.secondsPerLiquidityOutsideX128).toString(),
      upper.secondsOutside - lower.secondsOutside
    );
  }

  get_populated_ticks(args: pool.get_populated_ticks_arguments): pool.get_populated_ticks_result {
    let limit: u32 = args.limit == 0 ? 100 : args.limit;
    if (limit > MAX_POPULATED_TICKS) limit = MAX_POPULATED_TICKS;
    const objects = this.tickStore.map.getMany(
      Keys.int32(args.start),
      <i32>limit,
      args.descending ? Storage.Direction.Descending : Storage.Direction.Ascending
    );
    const result = new pool.get_populated_ticks_result();
    for (let i = 0; i < objects.length; i++) {
      const info = TickInfo.fromRecord(objects[i].value);
      result.ticks.push(new pool.populated_tick(
        Keys.toInt32(objects[i].key!),
        info.liquidityNet.toString(),
        info.liquidityGross.toString()
      ));
    }
    return result;
  }

  quote_swap(args: pool.quote_swap_arguments): pool.quote_swap_result {
    const state = this.storage.loadState();
    System.require(!state.sqrtPriceX96.isZero(), "KOINDX: NOT_INITIALIZED");
    const res = this.computeSwap(
      state,
      args.zero_for_one,
      args.exact_input,
      args.amount_specified,
      U256.fromString(args.sqrt_price_limit_x96),
      true
    );
    return new pool.quote_swap_result(
      res.amountIn,
      res.amountOut,
      res.sqrtPriceX96.toString(),
      res.tick,
      res.initializedTicksCrossed
    );
  }

  // ---------------------------------------------------------------------------
  // write methods
  // ---------------------------------------------------------------------------

  configure(args: pool.configure_arguments): pool.empty_object {
    // the factory creates the pool, so it is the caller of this method
    const caller = System.getCaller().caller;
    System.require(caller.length > 0, "KOINDX: FORBIDDEN");
    // a pool must be uploaded to a fresh address (also prevents configuring it twice)
    System.require(this.spacesAreEmpty(), "KOINDX: ERROR_IN_VERIFICATION_OF_SPACES");
    System.require(args.token0 !== null && args.token1 !== null, "KOINDX: INVALID_TOKENS");
    System.require(args.fee < 1000000, "KOINDX: INVALID_FEE");
    System.require(args.tick_spacing > 0 && args.tick_spacing < MAX_TICK_SPACING, "KOINDX: INVALID_TICK_SPACING");

    const config = new PoolConfig();
    config.factory = caller;
    config.token0 = args.token0!;
    config.token1 = args.token1!;
    config.fee = args.fee;
    config.tickSpacing = args.tick_spacing;
    config.maxLiquidityPerTick = Ticks.tickSpacingToMaxLiquidityPerTick(args.tick_spacing);
    this.storage.saveConfig(config);
    this._config = config;

    System.event(
      "pool.configure_event",
      Protobuf.encode(
        new pool.configure_event(
          caller,
          PoolConfig.tokenAddress(config.token0),
          PoolConfig.tokenAddress(config.token1),
          config.fee,
          config.tickSpacing
        ),
        pool.configure_event.encode
      ),
      [this.contractId]
    );
    return new pool.empty_object();
  }

  /** not locked because it initializes unlocked */
  initialize(args: pool.initialize_arguments): pool.empty_object {
    System.require(this.config().isConfigured(), "KOINDX: NOT_CONFIGURED");
    const state = this.storage.loadState();
    System.require(state.sqrtPriceX96.isZero(), "KOINDX: ALREADY_INITIALIZED");

    const sqrtPriceX96 = U256.fromString(args.sqrt_price_x96);
    const tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);

    const oracle = this.observationStore.initialize(this.blockTimestamp());

    state.sqrtPriceX96 = sqrtPriceX96;
    state.tick = tick;
    // Uniswap: (cardinality, cardinalityNext) = observations.initialize(...), both 1
    state.observationIndex = 0;
    state.observationCardinality = oracle.cardinality;
    state.observationCardinalityNext = oracle.cardinality;
    state.feeProtocol = 0;
    state.unlocked = true;
    this.storage.saveState(state);

    System.event(
      "pool.initialize_event",
      Protobuf.encode(new pool.initialize_event(sqrtPriceX96.toString(), tick), pool.initialize_event.encode),
      [this.contractId]
    );
    return new pool.empty_object();
  }

  mint(args: pool.mint_arguments): pool.mint_result {
    const state = this.lockedState();
    const sender = this.callerContract();
    System.require(args.recipient.length == ADDRESS_LENGTH, "KOINDX: INVALID_RECIPIENT");
    const amount = U256.fromString(args.amount);
    System.require(!amount.isZero(), "KOINDX: ZERO_LIQUIDITY");

    const res = this.modifyPosition(
      state,
      args.recipient,
      args.tick_lower,
      args.tick_upper,
      new I256(false, amount).checkInt128()
    );
    this.positionStore.put(res.position);

    const amount0 = SafeCast.toU64(res.amount0);
    const amount1 = SafeCast.toU64(res.amount1);

    // lock the pool during the callback
    state.unlocked = false;
    this.storage.saveState(state);

    let balance0Before: u64 = 0;
    let balance1Before: u64 = 0;
    if (amount0 > 0) balance0Before = this.balance0();
    if (amount1 > 0) balance1Before = this.balance1();
    Contract.call(
      sender,
      MINT_CALLBACK_ENTRY,
      Protobuf.encode(new pool.mint_callback_args(amount0, amount1, args.data), pool.mint_callback_args.encode),
      "KOINDX: MINT_CALLBACK_FAILED"
    );
    if (amount0 > 0) System.require(addU64(balance0Before, amount0) <= this.balance0(), "KOINDX: M0");
    if (amount1 > 0) System.require(addU64(balance1Before, amount1) <= this.balance1(), "KOINDX: M1");

    System.event(
      "pool.mint_event",
      Protobuf.encode(
        new pool.mint_event(sender, args.recipient, args.tick_lower, args.tick_upper, amount.toString(), amount0, amount1),
        pool.mint_event.encode
      ),
      [args.recipient, sender]
    );

    state.unlocked = true;
    this.storage.saveState(state);
    return new pool.mint_result(amount0, amount1);
  }

  collect(args: pool.collect_arguments): pool.collect_result {
    const owner = Contract.getSender(args.owner);
    const state = this.lockedState();
    System.require(args.recipient.length == ADDRESS_LENGTH, "KOINDX: INVALID_RECIPIENT");

    // we don't need to checkTicks here, because invalid positions will never have non-zero tokensOwed{0,1}
    const position = this.positionStore.get(owner, args.tick_lower, args.tick_upper);

    const amount0 = minU64(args.amount0_requested, position.tokensOwed0);
    const amount1 = minU64(args.amount1_requested, position.tokensOwed1);

    if (amount0 > 0 || amount1 > 0) {
      position.tokensOwed0 = U256.sub(position.tokensOwed0, U256.fromU64(amount0));
      position.tokensOwed1 = U256.sub(position.tokensOwed1, U256.fromU64(amount1));
      this.positionStore.put(position);

      state.unlocked = false;
      this.storage.saveState(state);
      const config = this.config();
      if (amount0 > 0) this.transferOut(config.token0, args.recipient, amount0);
      if (amount1 > 0) this.transferOut(config.token1, args.recipient, amount1);
      state.unlocked = true;
      this.storage.saveState(state);
    }

    System.event(
      "pool.collect_event",
      Protobuf.encode(
        new pool.collect_event(owner, args.recipient, args.tick_lower, args.tick_upper, amount0, amount1),
        pool.collect_event.encode
      ),
      [args.recipient, owner]
    );
    return new pool.collect_result(amount0, amount1);
  }

  burn(args: pool.burn_arguments): pool.burn_result {
    const owner = Contract.getSender(args.owner);
    const state = this.lockedState();
    const amount = args.amount.length > 0 ? U256.fromString(args.amount) : U256.zero();

    const res = this.modifyPosition(
      state,
      owner,
      args.tick_lower,
      args.tick_upper,
      new I256(true, amount).checkInt128()
    );

    const amount0 = SafeCast.toU64(res.amount0);
    const amount1 = SafeCast.toU64(res.amount1);

    const position = res.position;
    if (amount0 > 0 || amount1 > 0) {
      position.tokensOwed0 = addUint128Wrapping(position.tokensOwed0, U256.fromU64(amount0));
      position.tokensOwed1 = addUint128Wrapping(position.tokensOwed1, U256.fromU64(amount1));
    }
    this.positionStore.put(position);
    this.storage.saveState(state);

    System.event(
      "pool.burn_event",
      Protobuf.encode(
        new pool.burn_event(owner, args.tick_lower, args.tick_upper, amount.toString(), amount0, amount1),
        pool.burn_event.encode
      ),
      [owner]
    );
    return new pool.burn_result(amount0, amount1);
  }

  swap(args: pool.swap_arguments): pool.swap_result {
    const state = this.lockedState();
    const sender = this.callerContract();
    System.require(args.recipient.length == ADDRESS_LENGTH, "KOINDX: INVALID_RECIPIENT");

    const zeroForOne = args.zero_for_one;
    const res = this.computeSwap(
      state,
      zeroForOne,
      args.exact_input,
      args.amount_specified,
      U256.fromString(args.sqrt_price_limit_x96),
      false
    );

    // update tick and write an oracle entry if the tick change
    if (res.tick != state.tick) {
      const oracle = this.observationStore.write(
        state.observationIndex,
        this.blockTimestamp(),
        state.tick,
        state.liquidity,
        state.observationCardinality,
        state.observationCardinalityNext
      );
      state.observationIndex = oracle.index;
      state.observationCardinality = oracle.cardinality;
      state.tick = res.tick;
    }
    state.sqrtPriceX96 = res.sqrtPriceX96;

    // update liquidity if it changed
    state.liquidity = res.liquidity;

    // update fee growth global and, if necessary, protocol fees
    if (zeroForOne) {
      state.feeGrowthGlobal0X128 = res.feeGrowthGlobalX128;
      if (!res.protocolFee.isZero()) {
        state.protocolFees0 = addUint128Wrapping(state.protocolFees0, res.protocolFee);
      }
    } else {
      state.feeGrowthGlobal1X128 = res.feeGrowthGlobalX128;
      if (!res.protocolFee.isZero()) {
        state.protocolFees1 = addUint128Wrapping(state.protocolFees1, res.protocolFee);
      }
    }

    // keep the pool locked during the transfers and the callback
    state.unlocked = false;
    this.storage.saveState(state);

    const config = this.config();
    const callbackArgs = Protobuf.encode(
      new pool.swap_callback_args(zeroForOne, res.amountIn, res.amountOut, args.data),
      pool.swap_callback_args.encode
    );

    // do the transfers and collect payment
    if (zeroForOne) {
      if (res.amountOut > 0) {
        this.transferOut(config.token1, args.recipient, res.amountOut);
      }
      const balance0Before = this.balance0();
      Contract.call(sender, SWAP_CALLBACK_ENTRY, callbackArgs, "KOINDX: SWAP_CALLBACK_FAILED");
      System.require(addU64(balance0Before, res.amountIn) <= this.balance0(), "KOINDX: IIA");
    } else {
      if (res.amountOut > 0) {
        this.transferOut(config.token0, args.recipient, res.amountOut);
      }
      const balance1Before = this.balance1();
      Contract.call(sender, SWAP_CALLBACK_ENTRY, callbackArgs, "KOINDX: SWAP_CALLBACK_FAILED");
      System.require(addU64(balance1Before, res.amountIn) <= this.balance1(), "KOINDX: IIA");
    }

    System.event(
      "pool.swap_event",
      Protobuf.encode(
        new pool.swap_event(
          sender,
          args.recipient,
          zeroForOne,
          res.amountIn,
          res.amountOut,
          res.sqrtPriceX96.toString(),
          res.liquidity.toString(),
          res.tick
        ),
        pool.swap_event.encode
      ),
      [args.recipient, sender]
    );

    state.unlocked = true;
    this.storage.saveState(state);
    return new pool.swap_result(res.amountIn, res.amountOut);
  }

  flash(args: pool.flash_arguments): pool.empty_object {
    const state = this.lockedState();
    const sender = this.callerContract();
    System.require(args.recipient.length == ADDRESS_LENGTH, "KOINDX: INVALID_RECIPIENT");
    const liquidity = state.liquidity;
    System.require(!liquidity.isZero(), "KOINDX: L");

    const config = this.config();
    const fee = U256.fromU32(config.fee);
    const million = U256.fromU64(1000000);
    const fee0 = U256.mulDivRoundingUp(U256.fromU64(args.amount0), fee, million).toU64();
    const fee1 = U256.mulDivRoundingUp(U256.fromU64(args.amount1), fee, million).toU64();

    state.unlocked = false;
    this.storage.saveState(state);

    const balance0Before = this.balance0();
    const balance1Before = this.balance1();

    if (args.amount0 > 0) TokenHelper.transfer(PoolConfig.tokenAddress(config.token0), this.contractId, args.recipient, args.amount0);
    if (args.amount1 > 0) TokenHelper.transfer(PoolConfig.tokenAddress(config.token1), this.contractId, args.recipient, args.amount1);

    Contract.call(
      sender,
      FLASH_CALLBACK_ENTRY,
      Protobuf.encode(new pool.flash_callback_args(fee0, fee1, args.data), pool.flash_callback_args.encode),
      "KOINDX: FLASH_CALLBACK_FAILED"
    );

    const balance0After = this.balance0();
    const balance1After = this.balance1();

    System.require(addU64(balance0Before, fee0) <= balance0After, "KOINDX: F0");
    System.require(addU64(balance1Before, fee1) <= balance1After, "KOINDX: F1");

    // sub is safe because we know balanceAfter is gt balanceBefore by at least fee
    const paid0 = balance0After - balance0Before;
    const paid1 = balance1After - balance1Before;

    if (paid0 > 0) {
      const feeProtocol0 = state.feeProtocol % 16;
      const fees0: u64 = feeProtocol0 == 0 ? 0 : paid0 / <u64>feeProtocol0;
      if (fees0 > 0) state.protocolFees0 = addUint128Wrapping(state.protocolFees0, U256.fromU64(fees0));
      // fee growth accumulator: wraps around (mod 2^256) on purpose
      state.feeGrowthGlobal0X128 = U256.wrappingAdd(
        state.feeGrowthGlobal0X128,
        U256.mulDiv(U256.fromU64(paid0 - fees0), FixedPoint128.Q128, liquidity)
      );
    }
    if (paid1 > 0) {
      const feeProtocol1 = state.feeProtocol >> 4;
      const fees1: u64 = feeProtocol1 == 0 ? 0 : paid1 / <u64>feeProtocol1;
      if (fees1 > 0) state.protocolFees1 = addUint128Wrapping(state.protocolFees1, U256.fromU64(fees1));
      state.feeGrowthGlobal1X128 = U256.wrappingAdd(
        state.feeGrowthGlobal1X128,
        U256.mulDiv(U256.fromU64(paid1 - fees1), FixedPoint128.Q128, liquidity)
      );
    }

    System.event(
      "pool.flash_event",
      Protobuf.encode(
        new pool.flash_event(sender, args.recipient, args.amount0, args.amount1, paid0, paid1),
        pool.flash_event.encode
      ),
      [args.recipient, sender]
    );

    state.unlocked = true;
    this.storage.saveState(state);
    return new pool.empty_object();
  }

  increase_observation_cardinality_next(args: pool.increase_observation_cardinality_next_arguments): pool.empty_object {
    const state = this.lockedState();
    const observationCardinalityNextOld = state.observationCardinalityNext; // for the event
    const observationCardinalityNextNew = this.observationStore.grow(
      observationCardinalityNextOld,
      args.observation_cardinality_next
    );
    if (observationCardinalityNextOld != observationCardinalityNextNew) {
      state.observationCardinalityNext = observationCardinalityNextNew;
      this.storage.saveState(state);
      System.event(
        "pool.increase_observation_cardinality_next_event",
        Protobuf.encode(
          new pool.increase_observation_cardinality_next_event(observationCardinalityNextOld, observationCardinalityNextNew),
          pool.increase_observation_cardinality_next_event.encode
        ),
        [this.contractId]
      );
    }
    return new pool.empty_object();
  }

  set_fee_protocol(args: pool.set_fee_protocol_arguments): pool.empty_object {
    // Uniswap: lock, then onlyFactoryOwner (the authority check of the owner can run code)
    const state = this.lockedState();
    state.unlocked = false;
    this.storage.saveState(state);
    this.requireFactoryOwner();
    const feeProtocol0 = args.fee_protocol0;
    const feeProtocol1 = args.fee_protocol1;
    System.require(
      (feeProtocol0 == 0 || (feeProtocol0 >= 4 && feeProtocol0 <= 10)) &&
        (feeProtocol1 == 0 || (feeProtocol1 >= 4 && feeProtocol1 <= 10)),
      "KOINDX: INVALID_FEE_PROTOCOL"
    );
    const feeProtocolOld = state.feeProtocol;
    state.feeProtocol = feeProtocol0 + (feeProtocol1 << 4);
    state.unlocked = true;
    this.storage.saveState(state);

    System.event(
      "pool.set_fee_protocol_event",
      Protobuf.encode(
        new pool.set_fee_protocol_event(feeProtocolOld % 16, feeProtocolOld >> 4, feeProtocol0, feeProtocol1),
        pool.set_fee_protocol_event.encode
      ),
      [this.contractId]
    );
    return new pool.empty_object();
  }

  collect_protocol(args: pool.collect_protocol_arguments): pool.collect_protocol_result {
    // Uniswap: lock, then onlyFactoryOwner (the authority check of the owner can run code)
    const state = this.lockedState();
    state.unlocked = false;
    this.storage.saveState(state);
    this.requireFactoryOwner();
    const sender = System.getCaller().caller;
    System.require(args.recipient.length == ADDRESS_LENGTH, "KOINDX: INVALID_RECIPIENT");

    let amount0 = minU64(args.amount0_requested, state.protocolFees0);
    let amount1 = minU64(args.amount1_requested, state.protocolFees1);
    // like Uniswap, 1 unit of the protocol fees stays in the pool when everything is requested
    // (Uniswap: ensure that the slot is not cleared, for gas savings): the same amounts as Uniswap
    if (amount0 > 0 && U256.eq(U256.fromU64(amount0), state.protocolFees0)) amount0--;
    if (amount1 > 0 && U256.eq(U256.fromU64(amount1), state.protocolFees1)) amount1--;

    if (amount0 > 0 || amount1 > 0) {
      state.protocolFees0 = U256.sub(state.protocolFees0, U256.fromU64(amount0));
      state.protocolFees1 = U256.sub(state.protocolFees1, U256.fromU64(amount1));
      this.storage.saveState(state);
      const config = this.config();
      if (amount0 > 0) this.transferOut(config.token0, args.recipient, amount0);
      if (amount1 > 0) this.transferOut(config.token1, args.recipient, amount1);
    }
    state.unlocked = true;
    this.storage.saveState(state);

    System.event(
      "pool.collect_protocol_event",
      Protobuf.encode(
        new pool.collect_protocol_event(sender, args.recipient, amount0, amount1),
        pool.collect_protocol_event.encode
      ),
      [args.recipient]
    );
    return new pool.collect_protocol_result(amount0, amount1);
  }

  // ---------------------------------------------------------------------------
  // internal
  // ---------------------------------------------------------------------------

  private config(): PoolConfig {
    if (!this._config) this._config = this.storage.loadConfig();
    return this._config!;
  }

  /**
   * Mutually exclusive reentrancy protection into the pool to/from a method. This method also prevents entrance
   * to a function before the pool is initialized (Uniswap's `lock` modifier).
   *
   * On Koinos any call to another contract can run arbitrary code that calls the pool back: an
   * authority check runs the `authorize` of a smart wallet, and every call is writable (there is
   * no `staticcall`, a token `balance_of` can call the pool). So `unlocked = false` is saved
   * before any call to another contract, or the state is loaded after it (the authority check of
   * `owner` in burn / collect): otherwise a pool operation made during that call would be
   * overwritten by the stale state
   */
  private lockedState(): PoolState {
    const state = this.storage.loadState();
    System.require(state.unlocked, "KOINDX: LOCKED");
    return state;
  }

  /** the account that receives the callbacks must be a contract */
  private callerContract(): Uint8Array {
    const caller = System.getCaller().caller;
    System.require(caller.length > 0, "KOINDX: CALLER_MUST_BE_A_CONTRACT");
    return caller;
  }

  /** Prevents calling a function from anyone except the owner of the factory */
  private requireFactoryOwner(): void {
    const res = Contract.call(
      this.config().factory,
      FACTORY_OWNER_ENTRY,
      new Uint8Array(0),
      "KOINDX: FACTORY_OWNER_FAILED"
    );
    const owner = Protobuf.decode<pool.address>(res, pool.address.decode).value;
    Contract.requireAuthority(owner);
  }

  /** Returns the block timestamp in seconds truncated to 32 bits, i.e. mod 2**32 */
  private blockTimestamp(): u32 {
    const field = System.getBlockField("header.timestamp");
    System.require(field != null, "KOINDX: BLOCK_TIMESTAMP_NOT_FOUND");
    return <u32>(field!.uint64_value / 1000);
  }

  /**
   * TransferHelper.safeTransfer: sends `value` of a token from the pool to `to`. A Koinos token
   * reverts when a transfer fails, but a token can also return without moving the tokens (the
   * `transfer_result { value: false }` of the first KCS-1 tokens is encoded as empty bytes, like
   * the result of a successful KCS-4 transfer): the balance of the pool must decrease by `value`,
   * otherwise the transaction reverts (Uniswap: TF), the recipient must not lose its tokens
   */
  private transferOut(token: pool.token_object, to: Uint8Array, value: u64): void {
    const tokenAddress = PoolConfig.tokenAddress(token);
    const before = TokenHelper.balanceOf(tokenAddress, this.contractId);
    TokenHelper.transfer(tokenAddress, this.contractId, to, value);
    const after = TokenHelper.balanceOf(tokenAddress, this.contractId);
    System.require(before >= value && after <= before - value, "KOINDX: TRANSFER_FAILED");
  }

  private balance0(): u64 {
    return TokenHelper.balanceOf(PoolConfig.tokenAddress(this.config().token0), this.contractId);
  }

  private balance1(): u64 {
    return TokenHelper.balanceOf(PoolConfig.tokenAddress(this.config().token1), this.contractId);
  }

  /** Common checks for valid tick inputs */
  private checkTicks(tickLower: i32, tickUpper: i32): void {
    System.require(tickLower < tickUpper, "KOINDX: TLU");
    System.require(tickLower >= TickMath.MIN_TICK, "KOINDX: TLM");
    System.require(tickUpper <= TickMath.MAX_TICK, "KOINDX: TUM");
  }

  /** checks that no object exists in the storage spaces used by the pool */
  private spacesAreEmpty(): bool {
    const empty = new Uint8Array(0);
    for (let spaceId: u32 = <u32>Spaces.CONFIG_SPACE_ID; spaceId <= <u32>Spaces.OBSERVATIONS_SPACE_ID; spaceId++) {
      const space = new chain.object_space(false, this.contractId, spaceId);
      if (System.getBytes(space, empty) !== null) return false;
      if (System.getNextBytes(space, empty) !== null) return false;
    }
    return true;
  }

  /**
   * Effect some changes to a position
   * @returns the position and the amounts of token0/token1 owed to the pool (liquidity added)
   * or owed to the position (liquidity removed)
   */
  private modifyPosition(
    state: PoolState,
    owner: Uint8Array,
    tickLower: i32,
    tickUpper: i32,
    liquidityDelta: I256
  ): ModifyPositionResult {
    this.checkTicks(tickLower, tickUpper);

    const tick = state.tick;
    const position = this.updatePosition(state, owner, tickLower, tickUpper, liquidityDelta, tick);

    let amount0 = U256.zero();
    let amount1 = U256.zero();

    if (!liquidityDelta.isZero()) {
      if (tick < tickLower) {
        // current tick is below the passed range; liquidity can only become in range by crossing from left to
        // right, when we'll need _more_ token0 (it's becoming more valuable) so user must provide it
        amount0 = SqrtPriceMath.getAmount0DeltaSigned(
          TickMath.getSqrtRatioAtTick(tickLower),
          TickMath.getSqrtRatioAtTick(tickUpper),
          liquidityDelta
        ).abs;
      } else if (tick < tickUpper) {
        // current tick is inside the passed range
        const liquidityBefore = state.liquidity;

        // write an oracle entry
        const oracle = this.observationStore.write(
          state.observationIndex,
          this.blockTimestamp(),
          tick,
          liquidityBefore,
          state.observationCardinality,
          state.observationCardinalityNext
        );
        state.observationIndex = oracle.index;
        state.observationCardinality = oracle.cardinality;

        amount0 = SqrtPriceMath.getAmount0DeltaSigned(
          state.sqrtPriceX96,
          TickMath.getSqrtRatioAtTick(tickUpper),
          liquidityDelta
        ).abs;
        amount1 = SqrtPriceMath.getAmount1DeltaSigned(
          TickMath.getSqrtRatioAtTick(tickLower),
          state.sqrtPriceX96,
          liquidityDelta
        ).abs;

        state.liquidity = LiquidityMath.addDelta(liquidityBefore, liquidityDelta);
      } else {
        // current tick is above the passed range; liquidity can only become in range by crossing from right to
        // left, when we'll need _more_ token1 (it's becoming more valuable) so user must provide it
        amount1 = SqrtPriceMath.getAmount1DeltaSigned(
          TickMath.getSqrtRatioAtTick(tickLower),
          TickMath.getSqrtRatioAtTick(tickUpper),
          liquidityDelta
        ).abs;
      }
    }

    return new ModifyPositionResult(position, amount0, amount1);
  }

  /** Gets and updates a position with the given liquidity delta */
  private updatePosition(
    state: PoolState,
    owner: Uint8Array,
    tickLower: i32,
    tickUpper: i32,
    liquidityDelta: I256,
    tick: i32
  ): PositionInfo {
    const position = this.positionStore.get(owner, tickLower, tickUpper);
    const config = this.config();

    const feeGrowthGlobal0X128 = state.feeGrowthGlobal0X128;
    const feeGrowthGlobal1X128 = state.feeGrowthGlobal1X128;

    // if we need to update the ticks, do it
    let flippedLower = false;
    let flippedUpper = false;
    if (!liquidityDelta.isZero()) {
      const time = this.blockTimestamp();
      const cumulatives = this.observationStore.observeSingle(
        time,
        0,
        state.tick,
        state.observationIndex,
        state.liquidity,
        state.observationCardinality
      );

      flippedLower = this.tickStore.update(
        tickLower,
        tick,
        liquidityDelta,
        feeGrowthGlobal0X128,
        feeGrowthGlobal1X128,
        cumulatives.secondsPerLiquidityCumulativeX128,
        cumulatives.tickCumulative,
        time,
        false,
        config.maxLiquidityPerTick
      );
      flippedUpper = this.tickStore.update(
        tickUpper,
        tick,
        liquidityDelta,
        feeGrowthGlobal0X128,
        feeGrowthGlobal1X128,
        cumulatives.secondsPerLiquidityCumulativeX128,
        cumulatives.tickCumulative,
        time,
        true,
        config.maxLiquidityPerTick
      );

      if (flippedLower) this.tickBitmap.flipTick(tickLower, config.tickSpacing);
      if (flippedUpper) this.tickBitmap.flipTick(tickUpper, config.tickSpacing);
    }

    const feeGrowthInside = this.tickStore.getFeeGrowthInside(
      tickLower,
      tickUpper,
      tick,
      feeGrowthGlobal0X128,
      feeGrowthGlobal1X128
    );

    position.update(liquidityDelta, feeGrowthInside.feeGrowthInside0X128, feeGrowthInside.feeGrowthInside1X128);

    // clear any tick data that is no longer needed
    if (liquidityDelta.isNegative()) {
      if (flippedLower) this.tickStore.clear(tickLower);
      if (flippedUpper) this.tickStore.clear(tickUpper);
    }
    return position;
  }

  /**
   * The swap loop of UniswapV3Pool.swap. When `simulate` is true no tick is written, so it can
   * be used from read-only calls (quoter).
   *
   * Uniswap's signed `amountSpecified` is `exactInput` (positive) and its absolute value
   * `amountSpecified`, a token amount (u64).
   */
  private computeSwap(
    slot0Start: PoolState,
    zeroForOne: bool,
    exactInput: bool,
    amountSpecified: u64,
    sqrtPriceLimitX96: U256,
    simulate: bool
  ): SwapResult {
    System.require(amountSpecified != 0, "KOINDX: AS");
    System.require(
      zeroForOne
        ? U256.lt(sqrtPriceLimitX96, slot0Start.sqrtPriceX96) && U256.gt(sqrtPriceLimitX96, TickMath.MIN_SQRT_RATIO)
        : U256.gt(sqrtPriceLimitX96, slot0Start.sqrtPriceX96) && U256.lt(sqrtPriceLimitX96, TickMath.MAX_SQRT_RATIO),
      "KOINDX: SPL"
    );

    const config = this.config();

    // cache
    const liquidityStart = slot0Start.liquidity;
    const blockTimestamp = this.blockTimestamp();
    const feeProtocol = zeroForOne ? slot0Start.feeProtocol % 16 : slot0Start.feeProtocol >> 4;
    let tickCumulative: i64 = 0;
    let secondsPerLiquidityCumulativeX128 = U256.zero();
    let computedLatestObservation = false;

    const amountSpecifiedAbs = U256.fromU64(amountSpecified);

    // state: amounts are kept as absolute values, their sign is given by `exactInput`
    let amountSpecifiedRemaining = amountSpecifiedAbs;
    // exact input: total output (negative), exact output: total input (positive)
    let amountCalculated = U256.zero();
    let sqrtPriceX96 = slot0Start.sqrtPriceX96;
    let tick = slot0Start.tick;
    let feeGrowthGlobalX128 = zeroForOne ? slot0Start.feeGrowthGlobal0X128 : slot0Start.feeGrowthGlobal1X128;
    let protocolFee = U256.zero();
    let liquidity = liquidityStart;
    let initializedTicksCrossed: u32 = 0;

    // continue swapping as long as we haven't used the entire input/output and haven't reached the price limit
    while (!amountSpecifiedRemaining.isZero() && U256.neq(sqrtPriceX96, sqrtPriceLimitX96)) {
      const sqrtPriceStartX96 = sqrtPriceX96;

      const nextTick = this.tickBitmap.nextInitializedTickWithinOneWord(tick, config.tickSpacing, zeroForOne);
      let tickNext = nextTick.next;

      // ensure that we do not overshoot the min/max tick, as the tick bitmap is not aware of these bounds
      if (tickNext < TickMath.MIN_TICK) {
        tickNext = TickMath.MIN_TICK;
      } else if (tickNext > TickMath.MAX_TICK) {
        tickNext = TickMath.MAX_TICK;
      }

      // get the price for the next tick
      const sqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(tickNext);

      // compute values to swap to the target tick, price limit, or point where input/output amount is exhausted
      const useLimit = zeroForOne
        ? U256.lt(sqrtPriceNextX96, sqrtPriceLimitX96)
        : U256.gt(sqrtPriceNextX96, sqrtPriceLimitX96);
      const step = SwapMath.computeSwapStep(
        sqrtPriceX96,
        useLimit ? sqrtPriceLimitX96 : sqrtPriceNextX96,
        liquidity,
        amountSpecifiedRemaining,
        exactInput,
        config.fee
      );
      sqrtPriceX96 = step.sqrtRatioNextX96;

      if (exactInput) {
        amountSpecifiedRemaining = U256.sub(amountSpecifiedRemaining, U256.add(step.amountIn, step.feeAmount));
        amountCalculated = U256.add(amountCalculated, step.amountOut);
      } else {
        amountSpecifiedRemaining = U256.sub(amountSpecifiedRemaining, step.amountOut);
        amountCalculated = U256.add(amountCalculated, U256.add(step.amountIn, step.feeAmount));
      }

      // if the protocol fee is on, calculate how much is owed, decrement feeAmount, and increment protocolFee
      let feeAmount = step.feeAmount;
      if (feeProtocol > 0) {
        const delta = U256.div(feeAmount, U256.fromU32(feeProtocol));
        feeAmount = U256.sub(feeAmount, delta);
        protocolFee = addUint128Wrapping(protocolFee, delta);
      }

      // update global fee tracker (wraps around mod 2^256 on purpose)
      if (!liquidity.isZero()) {
        feeGrowthGlobalX128 = U256.wrappingAdd(feeGrowthGlobalX128, U256.mulDiv(feeAmount, FixedPoint128.Q128, liquidity));
      }

      // shift tick if we reached the next price
      if (U256.eq(sqrtPriceX96, sqrtPriceNextX96)) {
        // if the tick is initialized, run the tick transition
        if (nextTick.initialized) {
          // check for the placeholder value, which we replace with the actual value the first time the swap
          // crosses an initialized tick
          if (!computedLatestObservation) {
            const cumulatives = this.observationStore.observeSingle(
              blockTimestamp,
              0,
              slot0Start.tick,
              slot0Start.observationIndex,
              liquidityStart,
              slot0Start.observationCardinality
            );
            tickCumulative = cumulatives.tickCumulative;
            secondsPerLiquidityCumulativeX128 = cumulatives.secondsPerLiquidityCumulativeX128;
            computedLatestObservation = true;
          }
          let liquidityNet: I256;
          if (simulate) {
            liquidityNet = this.tickStore.get(tickNext).liquidityNet;
          } else {
            liquidityNet = this.tickStore.cross(
              tickNext,
              zeroForOne ? feeGrowthGlobalX128 : slot0Start.feeGrowthGlobal0X128,
              zeroForOne ? slot0Start.feeGrowthGlobal1X128 : feeGrowthGlobalX128,
              secondsPerLiquidityCumulativeX128,
              tickCumulative,
              blockTimestamp
            );
          }
          // if we're moving leftward, we interpret liquidityNet as the opposite sign
          // safe because liquidityNet cannot be type(int128).min
          if (zeroForOne) liquidityNet = I256.negate(liquidityNet);

          liquidity = LiquidityMath.addDelta(liquidity, liquidityNet);
          initializedTicksCrossed++;
        }

        tick = zeroForOne ? tickNext - 1 : tickNext;
      } else if (U256.neq(sqrtPriceX96, sqrtPriceStartX96)) {
        // recompute unless we're on a lower tick boundary (i.e. already transitioned ticks), and haven't moved
        tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
      }
    }

    // amountSpecified - amountSpecifiedRemaining (at most amountSpecified, a u64)
    const specifiedUsed = U256.sub(amountSpecifiedAbs, amountSpecifiedRemaining).toU64();
    // exact input: the amount out, exact output: the amount in. More than 2^64 - 1 units of a
    // token can't be paid or held by the pool (Uniswap fails on the token transfer)
    const calculated = SafeCast.toU64(amountCalculated);

    const res = new SwapResult();
    if (exactInput) {
      res.amountIn = specifiedUsed;
      res.amountOut = calculated;
    } else {
      res.amountIn = calculated;
      res.amountOut = specifiedUsed;
    }
    res.sqrtPriceX96 = sqrtPriceX96;
    res.tick = tick;
    res.liquidity = liquidity;
    res.feeGrowthGlobalX128 = feeGrowthGlobalX128;
    res.protocolFee = protocolFee;
    res.initializedTicksCrossed = initializedTicksCrossed;
    return res;
  }
}

/**
 * uint128 += uint128 of Uniswap (Solidity 0.7, unchecked): wraps around mod 2^128. Used for the
 * tokens owed to positions and the protocol fees, exactly like Uniswap, so a swap or a burn can
 * never revert because of these accumulators (they are bounded by the token supply anyway)
 */
function addUint128Wrapping(a: U256, b: U256): U256 {
  return U256.truncate(U256.wrappingAdd(a, b), 128);
}

function addU64(a: u64, b: u64): u64 {
  const c = a + b;
  System.require(c >= a, "KOINDX: AMOUNT_OVERFLOW");
  return c;
}

/** min(requested, owed) where owed may be bigger than 64 bits */
function minU64(requested: u64, owed: U256): u64 {
  if (owed.fitsBits(64) && owed.w0 < requested) return owed.w0;
  return requested;
}

/** a - b in uint160 arithmetic (wraps around) */
function uint160Sub(a: U256, b: U256): U256 {
  return U256.truncate(U256.wrappingSub(a, b), 160);
}
