export namespace Spaces {
  // immutables set by the factory (Uniswap: constructor parameters)
  export const CONFIG_SPACE_ID = 0;
  // slot0 + fee growth + protocol fees + liquidity
  export const STATE_SPACE_ID = 1;
  // tick (4 bytes, sign flipped big endian) => tick_record
  export const TICKS_SPACE_ID = 2;
  // word position (2 bytes, sign flipped big endian) => bitmap_record
  export const TICK_BITMAP_SPACE_ID = 3;
  // owner (25 bytes) + tick lower (4 bytes) + tick upper (4 bytes) => position_record
  export const POSITIONS_SPACE_ID = 4;
  // index (2 bytes big endian) => observation_record
  export const OBSERVATIONS_SPACE_ID = 5;
}
