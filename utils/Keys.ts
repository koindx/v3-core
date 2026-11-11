/**
 * Helpers to build storage keys.
 *
 * Signed integers are stored with the sign bit flipped and in big endian, so the lexicographic
 * order of the keys in the Koinos state database matches the numeric order (this allows
 * iterating initialized ticks in order).
 */
export namespace Keys {
  export function int32(value: i32): Uint8Array {
    const v = <u32>value ^ 0x80000000;
    const key = new Uint8Array(4);
    key[0] = <u8>(v >> 24);
    key[1] = <u8>(v >> 16);
    key[2] = <u8>(v >> 8);
    key[3] = <u8>v;
    return key;
  }

  export function toInt32(key: Uint8Array): i32 {
    const v = (<u32>key[0] << 24) | (<u32>key[1] << 16) | (<u32>key[2] << 8) | <u32>key[3];
    return <i32>(v ^ 0x80000000);
  }

  export function int16(value: i32): Uint8Array {
    const v = (<u32>value & 0xFFFF) ^ 0x8000;
    const key = new Uint8Array(2);
    key[0] = <u8>(v >> 8);
    key[1] = <u8>v;
    return key;
  }

  export function uint16(value: u32): Uint8Array {
    const key = new Uint8Array(2);
    key[0] = <u8>(value >> 8);
    key[1] = <u8>value;
    return key;
  }

  /** owner + tick lower + tick upper (Uniswap: keccak256(abi.encodePacked(owner, tickLower, tickUpper))) */
  export function position(owner: Uint8Array, tickLower: i32, tickUpper: i32): Uint8Array {
    const key = new Uint8Array(owner.length + 8);
    key.set(owner, 0);
    key.set(int32(tickLower), owner.length);
    key.set(int32(tickUpper), owner.length + 4);
    return key;
  }

  export function uint64(value: u64): Uint8Array {
    const key = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      key[7 - i] = <u8>(value >> (<u64>(i * 8)));
    }
    return key;
  }

  export function toUint64(key: Uint8Array): u64 {
    let v: u64 = 0;
    for (let i = 0; i < key.length; i++) {
      v = (v << 8) | <u64>key[i];
    }
    return v;
  }
}
