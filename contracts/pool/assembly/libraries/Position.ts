import { System, Storage } from "@koinos/sdk-as";
import { pool } from "../proto/pool";
import { Spaces } from "../Spaces";
import { U256 } from "../../../../libraries/U256";
import { I256 } from "../../../../libraries/I256";
import { Keys } from "../../../../utils/Keys";
import { FixedPoint128 } from "../../../../libraries/FixedPoint";
import { LiquidityMath } from "../../../../libraries/LiquidityMath";

/** info stored for each user's position */
export class PositionInfo {
  /** the amount of liquidity owned by this position */
  liquidity: U256 = U256.zero();
  /** fee growth per unit of liquidity as of the last update to liquidity or fees owed */
  feeGrowthInside0LastX128: U256 = U256.zero();
  feeGrowthInside1LastX128: U256 = U256.zero();
  /** the fees owed to the position owner in token0/token1 (uint128) */
  tokensOwed0: U256 = U256.zero();
  tokensOwed1: U256 = U256.zero();

  constructor(public key: Uint8Array) {}

  static fromRecord(key: Uint8Array, record: pool.position_record | null): PositionInfo {
    const info = new PositionInfo(key);
    if (record) {
      info.liquidity = U256.fromBytes(record.liquidity);
      info.feeGrowthInside0LastX128 = U256.fromBytes(record.fee_growth_inside0_last_x128);
      info.feeGrowthInside1LastX128 = U256.fromBytes(record.fee_growth_inside1_last_x128);
      info.tokensOwed0 = U256.fromBytes(record.tokens_owed0);
      info.tokensOwed1 = U256.fromBytes(record.tokens_owed1);
    }
    return info;
  }

  toRecord(): pool.position_record {
    return new pool.position_record(
      this.liquidity.toBytes(),
      this.feeGrowthInside0LastX128.toBytes(),
      this.feeGrowthInside1LastX128.toBytes(),
      this.tokensOwed0.toBytes(),
      this.tokensOwed1.toBytes()
    );
  }

  isEmpty(): bool {
    return this.liquidity.isZero() &&
      this.feeGrowthInside0LastX128.isZero() &&
      this.feeGrowthInside1LastX128.isZero() &&
      this.tokensOwed0.isZero() &&
      this.tokensOwed1.isZero();
  }

  /**
   * Credits accumulated fees to a user's position
   * @param liquidityDelta the change in pool liquidity as a result of the position update
   * @param feeGrowthInside0X128 the all-time fee growth in token0, per unit of liquidity, inside the position's tick boundaries
   * @param feeGrowthInside1X128 the all-time fee growth in token1, per unit of liquidity, inside the position's tick boundaries
   */
  update(liquidityDelta: I256, feeGrowthInside0X128: U256, feeGrowthInside1X128: U256): void {
    let liquidityNext: U256;
    if (liquidityDelta.isZero()) {
      System.require(!this.liquidity.isZero(), "KOINDX: NO_POSITION"); // disallow pokes for 0 liquidity positions
      liquidityNext = this.liquidity;
    } else {
      liquidityNext = LiquidityMath.addDelta(this.liquidity, liquidityDelta);
    }

    // calculate accumulated fees. overflow in the subtraction of fee growth is expected (modular
    // arithmetic) and, like Uniswap, the result is truncated to uint128: a position can always be
    // poked and burned (the fees are bounded by the tokens actually paid to the pool)
    const tokensOwed0 = U256.truncate(
      U256.mulDiv(U256.wrappingSub(feeGrowthInside0X128, this.feeGrowthInside0LastX128), this.liquidity, FixedPoint128.Q128),
      128
    );
    const tokensOwed1 = U256.truncate(
      U256.mulDiv(U256.wrappingSub(feeGrowthInside1X128, this.feeGrowthInside1LastX128), this.liquidity, FixedPoint128.Q128),
      128
    );

    // update the position
    if (!liquidityDelta.isZero()) this.liquidity = liquidityNext;
    this.feeGrowthInside0LastX128 = feeGrowthInside0X128;
    this.feeGrowthInside1LastX128 = feeGrowthInside1X128;
    if (!tokensOwed0.isZero() || !tokensOwed1.isZero()) {
      // overflow is acceptable, have to withdraw before you hit type(uint128).max fees (Uniswap)
      this.tokensOwed0 = U256.truncate(U256.wrappingAdd(this.tokensOwed0, tokensOwed0), 128);
      this.tokensOwed1 = U256.truncate(U256.wrappingAdd(this.tokensOwed1, tokensOwed1), 128);
    }
  }
}

/**
 * Port of Uniswap v3 Position library.
 *
 * Positions represent an owner address' liquidity between a lower and upper tick boundary.
 * The key is the concatenation of owner + tick lower + tick upper (instead of a keccak256 hash)
 */
export class Positions {
  map: Storage.Map<Uint8Array, pool.position_record>;

  constructor(contractId: Uint8Array) {
    this.map = new Storage.Map(
      contractId,
      Spaces.POSITIONS_SPACE_ID,
      pool.position_record.decode,
      pool.position_record.encode,
      null
    );
  }

  /** Returns the Info struct of a position, given an owner and position boundaries */
  get(owner: Uint8Array, tickLower: i32, tickUpper: i32): PositionInfo {
    const key = Keys.position(owner, tickLower, tickUpper);
    return PositionInfo.fromRecord(key, this.map.get(key));
  }

  put(position: PositionInfo): void {
    if (position.isEmpty()) {
      this.map.remove(position.key);
    } else {
      this.map.put(position.key, position.toRecord());
    }
  }
}
