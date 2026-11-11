# Uniswap v3-core tests on KoinDX

Every test file of [Uniswap v3-core](https://github.com/Uniswap/v3-core/tree/main/test) is ported
to `tests/uniswap` and runs against the compiled KoinDX contracts (the same wasm that is
deployed), with the expected values of Uniswap.

## How the tests run

| Tool | What it is |
|---|---|
| Koinos VM emulator (`tests/vm`) | runs the compiled contracts in Node.js with the system call semantics of koinos-chain (reverts unwind the transaction, `get_caller`, authority overrides, object spaces, read only calls), a controllable block time (Uniswap's `MockTimeUniswapV3Pool`) and direct state access (`setFeeGrowthGlobal0X128`...) |
| test contracts (`tests/uniswap/shared/test-contracts.js`) | ports of `TestUniswapV3Callee`, `TestUniswapV3Router`, `TestUniswapV3SwapPay`, `TestUniswapV3ReentrantCallee`, `UniswapV3PoolSwapTest`, `MockTimeUniswapV3PoolDeployer` |
| math harness (`tests/harness/index.ts`) | the math libraries compiled to wasm (`TickMathTest`, `SqrtPriceMathTest`, `SwapMathTest`, `FullMathTest`, `BitMathTest`, `LiquidityMathTest`) |
| pool libraries module (`tests/harness/pool-libraries.ts`) | `Tick`, `TickBitmap` and `Oracle` compiled to wasm and run in the emulator with the storage of a contract (`TickTest`, `TickBitmapTest`, `OracleTest`) |
| Uniswap reference (`tests/uniswap/evm`) | the Uniswap v3 factory and pool bytecode published in `@uniswap/v3-core` (the contracts deployed on Ethereum) run in an EVM (`@ethereumjs/evm`), with small Solidity helpers compiled with solc 0.7.6 |
| Uniswap snapshots (`tests/uniswap/fixtures`) | the results recorded by Uniswap (`UniswapV3Pool.swaps.spec.ts.snap`, `UniswapV3Pool.arbitrage.spec.ts.snap`), copied from the Uniswap repository (GPL-2.0-or-later) |

## Coverage

| Uniswap test | KoinDX test | Tests | Notes |
|---|---|---|---|
| `UniswapV3Factory.spec.ts` | `UniswapV3Factory.test.js` | 24 | fee 100 is enabled by default (the tests that enable a fee tier use 200); the ownership is transferred in two steps (`set_owner` + `accept_owner`); the test addresses are KCS-4 tokens (`create_pool` asks the tokens for the allowances of the pool, Uniswap's `createPool` doesn't call them); plus a test of the canonical token identifiers |
| `UniswapV3Pool.spec.ts` | `UniswapV3Pool.test.js` | 185 | see the adaptations below |
| `UniswapV3Pool.swaps.spec.ts` | `UniswapV3Pool.swaps.test.js` | 166 | 158 swaps equal to the Uniswap snapshot; 2 swaps that would leave more than 2^64 - 1 tokens in the pool and 5 pools that need more than 2^64 tokens revert with `AMOUNT_OVERFLOW` |
| `UniswapV3Pool.arbitrage.spec.ts` | `UniswapV3Pool.arbitrage.test.js` | 48 | the 48 cases reproduced on the Uniswap reference against the snapshot, and with the amounts / 10 on KoinDX and the reference (equal results); the mint of the max liquidity per tick of the sandwich tests (~10^30 tokens) reverts with `AMOUNT_OVERFLOW` |
| `UniswapV3Router.spec.ts` | `UniswapV3Router.test.js` | 2 | |
| `Tick.spec.ts` | `libraries/Tick.test.js` | 26 | |
| `TickBitmap.spec.ts` | `libraries/TickBitmap.test.js` | 26 | |
| `Oracle.spec.ts` | `libraries/Oracle.test.js` | 68 | includes the "full oracle" tests (65535 observations) that Uniswap skips |
| `TickMath.spec.ts` | `libraries/TickMath.test.js` | 111 | results equal to the Uniswap snapshot |
| `SqrtPriceMath.spec.ts` | `libraries/SqrtPriceMath.test.js` | 33 | |
| `SwapMath.spec.ts` | `libraries/SwapMath.test.js` | 9 | |
| `FullMath.spec.ts` | `libraries/FullMath.test.js` | 19 | includes the random input fuzzer that Uniswap skips |
| `BitMath.spec.ts` | `libraries/BitMath.test.js` | 10 | |
| `LiquidityMath.spec.ts` | `libraries/LiquidityMath.test.js` | 6 | |
| `UniswapV3Pool.gas.spec.ts` | — | — | not applicable: EVM gas costs |
| `NoDelegateCall.spec.ts` | — | — | not applicable: Koinos has no `delegatecall` |
| — | `differential/Pool.fuzz.test.js` | 4 | random sequences of operations on KoinDX and on the Uniswap reference, compared after every operation (see below) |
| — | `differential/U64Swaps.test.js` | 4 | swaps of more than 2^63 - 1 units (up to 2^64 - 1) on KoinDX and on the Uniswap reference |
| — | `differential/PoolEdges.test.js` | 20 | the edge cases the random fuzzer rarely reaches (MIN/MAX ticks and prices, swaps ending on ticks, maxLiquidityPerTick, oracle wrap-around, 32-bit time wrap, fee growth wrapping, quote_swap), on KoinDX and on the Uniswap reference |
| — | `koinos-security.test.js` | 21 | attacks specific to Koinos (keys of the pools, authority of `owner`, code that runs during an authority check or a token call, factory ownership with smart wallets, pool creation including the previous code and the allowances of the pool address, malformed addresses), see [SECURITY.md](../SECURITY.md) |

The gas cost tests of every file are not applicable (EVM gas); the bytecode size tests neither.

## Adaptations

- Revert reasons have the `KOINDX: ` prefix and some are more descriptive: `LOK` → `LOCKED`,
  `R` → `SQRT_PRICE_OUT_OF_RANGE`, `T` → `TICK_OUT_OF_RANGE`, `LO` → `LIQUIDITY_OVERFLOW`,
  `LS` → `LIQUIDITY_SUB`, `LA` → `LIQUIDITY_ADD`, `NP` → `NO_POSITION`, `OLD` →
  `OBSERVATION_TOO_OLD`, `I` → `OBSERVATIONS_NOT_INITIALIZED`. The requires without a reason of
  Uniswap have one (`TICK_NOT_SPACED`, `ZERO_LIQUIDITY`, `FORBIDDEN`, `INVALID_FEE_PROTOCOL`,
  `TICK_NOT_INITIALIZED`).
- Token amounts are `u64` (Koinos tokens): the collect requests use `2^64 - 1` instead of
  `2^128 - 1`, and the scenarios that need more than 2^64 tokens are adapted:
  - the fees overflow scenarios (donations of `2^128 - 1` tokens) set the fee growth reached by
    the donations with `setFeeGrowthGlobal0X128` / `setFeeGrowthGlobal1X128` (the test functions
    of `MockTimeUniswapV3Pool`); the fees owed (up to `2^128 - 1`) are read from the positions
  - "#feeProtocol" (1000e18 of liquidity): the tests run on the Uniswap reference with the
    Uniswap liquidity and values, and on KoinDX and the reference with 10e18 (equal results)
  - the mint of the max liquidity of the full range must revert with `AMOUNT_OVERFLOW`, the
    max liquidity is checked in a range near the max tick where the amounts fit
- The swap API uses `u64` amounts like the Koinos tokens (direction, exact input or output, amount
  specified, amounts in and out): the test contracts convert Uniswap's signed `amountSpecified`
  and deltas; the swaps to a price use `2^64 - 1` instead of `2^255 - 1`.
  `differential/U64Swaps.test.js` swaps more than 2^63 - 1 units (up to 2^64 - 1) on KoinDX and
  on the Uniswap reference: equal results.
- The test tokens follow the Koinos token standard (KCS-4, the KOIN contract: `tests/vm/token.js`):
  a contract can only move the tokens of an account up to its allowance. Like the Uniswap tests,
  the accounts approve the test contracts that pay the pools (`MaxUint64` instead of
  `MaxUint256`); the fuzzer approves again before each operation since KCS-4 decrements every
  allowance (Uniswap's `MaxUint256` is never used up).
- There is no zero address: the flash donations use another account as recipient (with amounts of
  0 nothing is transferred to it).
- Koinos can't catch a reverted call: the reentrancy test runs one transaction per function, each
  must revert with `LOCKED`.

## Differences found and fixed

The ported tests and the Uniswap reference found these differences, now aligned with Uniswap:

- `collect_protocol` keeps 1 unit of each protocol fee in the pool when everything is requested
  (Uniswap: "ensure that the slot is not cleared, for gas savings").
- `Oracle.grow` writes placeholder observations (`blockTimestamp = 1`, not initialized) in the new
  slots: the account that grows the oracle pays the storage, not the swaps.
- The fees owed to a position are truncated to `uint128` and `tokensOwed` / protocol fees wrap at
  2^128, instead of reverting (see `OVERFLOW.md`).

## Differential fuzzing

`tests/uniswap/differential/Pool.fuzz.test.js` runs random sequences of mints, burns, collects,
swaps (exact input / output, price limits), flash loans and donations, protocol fees, oracle growth,
observations and time on KoinDX and on the Uniswap reference. After every operation both must agree
on the outcome (success, or failure with the same reason), the transferred amounts and the whole
state: `slot0`, liquidity, fee growth, protocol fees, pool and account balances, every used tick,
every position, the observations, `observe` and `snapshotCumulativesInside`.

```sh
POOL_FUZZ_RUNS=150 POOL_FUZZ_OPS=100 POOL_FUZZ_SEED=100 POOL_FUZZ_STATS=1 npx jest --rootDir tests uniswap/differential
```

The swap amounts go up to 2^64 - 1. There is no expected difference: an amount of more than
2^64 - 1 units can't be paid on both implementations (`AMOUNT_OVERFLOW` on KoinDX, the token
balance on Uniswap).

The reference runs without the Ethereum block gas limit: with little liquidity, a swap can walk
through thousands of empty words of the tick bitmap (up to ~7000 with a tick spacing of 1), which
costs more than 30M gas on Uniswap. Both implementations give the same result when the swap runs to
the end. The command above (seeds 100 to 249, 15000 operations) passes; with the 30M gas limit,
5 of its sequences stop on such a swap that Uniswap can't execute on Ethereum. On Koinos such a swap
is limited by the compute bandwidth of the transaction instead.
