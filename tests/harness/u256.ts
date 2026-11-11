// U256 test exports (shared by v3-core and v3-periphery, see scripts/check-shared.js): every
// operation takes and returns decimal strings, bytes are hex strings (big endian).
import { System } from "@koinos/sdk-as";
import { U256 } from "../../libraries/U256";

function u(s: string): U256 {
  return U256.fromString(s);
}

function hexDigit(c: i32): u8 {
  if (c >= 48 && c <= 57) return <u8>(c - 48);
  if (c >= 97 && c <= 102) return <u8>(c - 87);
  System.require(c >= 65 && c <= 70, "invalid hex");
  return <u8>(c - 55);
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = (hexDigit(hex.charCodeAt(2 * i)) << 4) | hexDigit(hex.charCodeAt(2 * i + 1));
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    hex += (b < 16 ? "0" : "") + b.toString(16);
  }
  return hex;
}

// arithmetic (checked by default, explicit wrapping variants)
export function u256Add(a: string, b: string): string { return U256.add(u(a), u(b)).toString(); }
export function u256Sub(a: string, b: string): string { return U256.sub(u(a), u(b)).toString(); }
export function u256Mul(a: string, b: string): string { return U256.mul(u(a), u(b)).toString(); }
export function u256WrappingAdd(a: string, b: string): string { return U256.wrappingAdd(u(a), u(b)).toString(); }
export function u256WrappingSub(a: string, b: string): string { return U256.wrappingSub(u(a), u(b)).toString(); }
export function u256WrappingMul(a: string, b: string): string { return U256.wrappingMul(u(a), u(b)).toString(); }
export function u256Div(a: string, b: string): string { return U256.div(u(a), u(b)).toString(); }
export function u256Mod(a: string, b: string): string { return U256.mod(u(a), u(b)).toString(); }
export function u256DivRoundingUp(a: string, b: string): string { return U256.divRoundingUp(u(a), u(b)).toString(); }
export function u256MulDiv(a: string, b: string, d: string): string { return U256.mulDiv(u(a), u(b), u(d)).toString(); }
export function u256MulDivRoundingUp(a: string, b: string, d: string): string { return U256.mulDivRoundingUp(u(a), u(b), u(d)).toString(); }

// bitwise operations and shifts
export function u256And(a: string, b: string): string { return U256.and(u(a), u(b)).toString(); }
export function u256Or(a: string, b: string): string { return U256.or(u(a), u(b)).toString(); }
export function u256Xor(a: string, b: string): string { return U256.xor(u(a), u(b)).toString(); }
export function u256Not(a: string): string { return U256.not(u(a)).toString(); }
export function u256Shl(a: string, n: i32): string { return U256.shl(u(a), n).toString(); }
export function u256WrappingShl(a: string, n: i32): string { return U256.wrappingShl(u(a), n).toString(); }
export function u256Shr(a: string, n: i32): string { return U256.shr(u(a), n).toString(); }
export function u256Sar(a: string, n: i32): string { return U256.sar(u(a), n).toString(); }
export function u256Truncate(a: string, bits: i32): string { return U256.truncate(u(a), bits).toString(); }

// comparison and bits
export function u256Cmp(a: string, b: string): i32 { return U256.cmp(u(a), u(b)); }
export function u256Eq(a: string, b: string): bool { return U256.eq(u(a), u(b)); }
export function u256Lt(a: string, b: string): bool { return U256.lt(u(a), u(b)); }
export function u256Lte(a: string, b: string): bool { return U256.lte(u(a), u(b)); }
export function u256Gt(a: string, b: string): bool { return U256.gt(u(a), u(b)); }
export function u256Gte(a: string, b: string): bool { return U256.gte(u(a), u(b)); }
export function u256IsZero(a: string): bool { return u(a).isZero(); }
export function u256BitLength(a: string): i32 { return u(a).bitLength(); }
export function u256Msb(a: string): i32 { return u(a).mostSignificantBit(); }
export function u256Lsb(a: string): i32 { return u(a).leastSignificantBit(); }
export function u256TestBit(a: string, index: i32): bool { return u(a).testBit(index); }

// conversions
export function u256Parse(a: string): string { return u(a).toString(); }
export function u256ToU64(a: string): string { return u(a).toU64().toString(); }
export function u256ToBytesHex(a: string): string { return toHex(u(a).toBytes()); }
export function u256FromBytesHex(hex: string): string { return U256.fromBytes(fromHex(hex)).toString(); }
export function u256BytesRoundTrip(a: string): string { return U256.fromBytes(u(a).toBytes()).toString(); }
export function u256BytesLength(a: string): i32 { return u(a).toBytes().length; }
