import { System, Storage } from "@koinos/sdk-as";
import { pool } from "../proto/pool";
import { Spaces } from "../Spaces";
import { U256 } from "../../../../libraries/U256";
import { Keys } from "../../../../utils/Keys";

export class NextInitializedTick {
  constructor(public next: i32, public initialized: bool) {}
}

/**
 * Port of Uniswap v3 TickBitmap.
 *
 * Stores a packed mapping of tick index to its initialized state. The mapping uses int16 for
 * keys since ticks are represented as int24 and there are 256 (2^8) values per word.
 * Empty words are removed from the storage.
 */
export class TickBitmap {
  map: Storage.Map<Uint8Array, pool.bitmap_record>;

  constructor(contractId: Uint8Array) {
    this.map = new Storage.Map(
      contractId,
      Spaces.TICK_BITMAP_SPACE_ID,
      pool.bitmap_record.decode,
      pool.bitmap_record.encode,
      null
    );
  }

  getWord(wordPos: i32): U256 {
    const record = this.map.get(Keys.int16(wordPos));
    if (!record) return U256.zero();
    return U256.fromBytes(record.value);
  }

  putWord(wordPos: i32, word: U256): void {
    if (word.isZero()) {
      this.map.remove(Keys.int16(wordPos));
    } else {
      this.map.put(Keys.int16(wordPos), new pool.bitmap_record(word.toBytes()));
    }
  }

  /** Computes the position in the mapping where the initialized bit for a tick lives */
  @inline
  static wordPosition(tick: i32): i32 {
    return tick >> 8;
  }

  @inline
  static bitPosition(tick: i32): i32 {
    return tick & 0xFF;
  }

  /** Flips the initialized state for a given tick from false to true, or vice versa */
  flipTick(tick: i32, tickSpacing: i32): void {
    System.require(tick % tickSpacing == 0, "KOINDX: TICK_NOT_SPACED"); // ensure that the tick is spaced
    const compressed = tick / tickSpacing;
    const wordPos = TickBitmap.wordPosition(compressed);
    const bitPos = TickBitmap.bitPosition(compressed);
    const mask = U256.pow2(bitPos);
    this.putWord(wordPos, U256.xor(this.getWord(wordPos), mask));
  }

  /**
   * Returns the next initialized tick contained in the same word (or adjacent word) as the tick
   * that is either to the left (less than or equal to) or right (greater than) of the given tick
   */
  nextInitializedTickWithinOneWord(tick: i32, tickSpacing: i32, lte: bool): NextInitializedTick {
    let compressed = tick / tickSpacing;
    if (tick < 0 && tick % tickSpacing != 0) compressed--; // round towards negative infinity

    if (lte) {
      const wordPos = TickBitmap.wordPosition(compressed);
      const bitPos = TickBitmap.bitPosition(compressed);
      // all the 1s at or to the right of the current bitPos
      const mask = U256.maxBits(bitPos + 1);
      const masked = U256.and(this.getWord(wordPos), mask);

      // if there are no initialized ticks to the right of or at the current tick, return rightmost in the word
      const initialized = !masked.isZero();
      // overflow/underflow is possible, but prevented externally by limiting both tickSpacing and tick
      const next = initialized
        ? (compressed - (bitPos - masked.mostSignificantBit())) * tickSpacing
        : (compressed - bitPos) * tickSpacing;
      return new NextInitializedTick(next, initialized);
    } else {
      // start from the word of the next tick, since the current tick state doesn't matter
      const wordPos = TickBitmap.wordPosition(compressed + 1);
      const bitPos = TickBitmap.bitPosition(compressed + 1);
      // all the 1s at or to the left of the bitPos
      const mask = U256.not(U256.maxBits(bitPos));
      const masked = U256.and(this.getWord(wordPos), mask);

      // if there are no initialized ticks to the left of the current tick, return leftmost in the word
      const initialized = !masked.isZero();
      // overflow/underflow is possible, but prevented externally by limiting both tickSpacing and tick
      const next = initialized
        ? (compressed + 1 + (masked.leastSignificantBit() - bitPos)) * tickSpacing
        : (compressed + 1 + (255 - bitPos)) * tickSpacing;
      return new NextInitializedTick(next, initialized);
    }
  }
}
