import { System, Base58 } from "@koinos/sdk-as";

/** Koinos addresses are 25 bytes: version (1) + ripemd160 (20) + checksum (4) */
export const ADDRESS_LENGTH = 25;

/**
 * Tokens are identified by strings, like in the KoinDX v2 periphery:
 * - system tokens are referenced by their name service name ("koin", "vhp"), so pools keep
 *   working if the system contract address is upgraded
 * - any other token is referenced by its base58 address
 */
export namespace Tokens {
  export const NAME_SERVICE_TOKENS: string[] = ["koin", "vhp"];

  export function isNameService(token: string): bool {
    return NAME_SERVICE_TOKENS.includes(token);
  }

  /** resolves the address of a token identifier */
  export function address(token: string): Uint8Array {
    if (isNameService(token)) {
      return System.getContractAddress(token);
    }
    const decoded = Base58.decode(token);
    // the base58 decoder of the SDK is lenient (it skips spaces and extra leading "1", and stops at
    // the first invalid character): only the canonical encoding of an address is accepted, so a
    // token has a single identifier and there is a single pool per pair of tokens and fee
    System.require(decoded.length == ADDRESS_LENGTH && Base58.encode(decoded) == token, "KOINDX: INVALID_TOKEN");
    return decoded;
  }

  /** Uniswap sorts tokens by address, KoinDX sorts the token identifiers (token0 < token1) */
  export function sort(tokenA: string, tokenB: string): string[] {
    return tokenA < tokenB ? [tokenA, tokenB] : [tokenB, tokenA];
  }
}
