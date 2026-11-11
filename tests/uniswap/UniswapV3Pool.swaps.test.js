// Port of Uniswap v3-core test/UniswapV3Pool.swaps.spec.ts: the swaps of each pool test case
// against the expected results recorded by Uniswap (fixtures/UniswapV3Pool.swaps.spec.ts.snap.txt,
// copied from the Uniswap v3-core repository, GPL-2.0-or-later).
//
// Koinos differences:
// - token amounts are u64: the pools whose positions need more than 2^64 tokens can't be created
//   (the mint reverts with AMOUNT_OVERFLOW), their swaps are not applicable
// - the swaps to a price use the max u64 amount (Uniswap: max int256), a swap that would leave
//   more than 2^64 - 1 tokens in the pool can't be paid
// - revert reasons: "revert SPL" → "KOINDX: SPL"
const { poolFixture, createPoolFunctions, transfers } = require("./shared/fixtures");
const { expectRevert } = require("./shared/contracts");
const { toPrecision5, formatTokenAmount, formatPrice } = require("./shared/format");
const { loadUniswapSnapshot } = require("./shared/snapshot");
const { encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxLiquidityPerTick, getMaxTick, getMinTick, MAX_SQRT_RATIO, MIN_SQRT_RATIO, MaxUint64, TICK_SPACINGS } = require("./shared/utilities");



function swapCaseToDescription(testCase) {
  const priceClause = testCase.sqrtPriceLimit ? ` to price ${formatPrice(testCase.sqrtPriceLimit)}` : "";
  if ("exactOut" in testCase) {
    if (testCase.exactOut) {
      if (testCase.zeroForOne) return `swap token0 for exactly ${formatTokenAmount(testCase.amount1)} token1${priceClause}`;
      return `swap token1 for exactly ${formatTokenAmount(testCase.amount0)} token0${priceClause}`;
    }
    if (testCase.zeroForOne) return `swap exactly ${formatTokenAmount(testCase.amount0)} token0 for token1${priceClause}`;
    return `swap exactly ${formatTokenAmount(testCase.amount1)} token1 for token0${priceClause}`;
  }
  return testCase.zeroForOne ? `swap token0 for token1${priceClause}` : `swap token1 for token0${priceClause}`;
}

function executeSwap(testCase, poolFunctions, recipient) {
  if ("exactOut" in testCase) {
    if (testCase.exactOut) {
      if (testCase.zeroForOne) return poolFunctions.swap0ForExact1(testCase.amount1, recipient, testCase.sqrtPriceLimit);
      return poolFunctions.swap1ForExact0(testCase.amount0, recipient, testCase.sqrtPriceLimit);
    }
    if (testCase.zeroForOne) return poolFunctions.swapExact0For1(testCase.amount0, recipient, testCase.sqrtPriceLimit);
    return poolFunctions.swapExact1For0(testCase.amount1, recipient, testCase.sqrtPriceLimit);
  }
  if (testCase.zeroForOne) return poolFunctions.swapToLowerPrice(testCase.sqrtPriceLimit, recipient);
  return poolFunctions.swapToHigherPrice(testCase.sqrtPriceLimit, recipient);
}

const DEFAULT_POOL_SWAP_TESTS = [
  // swap large amounts in/out
  { zeroForOne: true, exactOut: false, amount0: expandTo18Decimals(1) },
  { zeroForOne: false, exactOut: false, amount1: expandTo18Decimals(1) },
  { zeroForOne: true, exactOut: true, amount1: expandTo18Decimals(1) },
  { zeroForOne: false, exactOut: true, amount0: expandTo18Decimals(1) },
  // swap large amounts in/out with a price limit
  { zeroForOne: true, exactOut: false, amount0: expandTo18Decimals(1), sqrtPriceLimit: encodePriceSqrt(50, 100) },
  { zeroForOne: false, exactOut: false, amount1: expandTo18Decimals(1), sqrtPriceLimit: encodePriceSqrt(200, 100) },
  { zeroForOne: true, exactOut: true, amount1: expandTo18Decimals(1), sqrtPriceLimit: encodePriceSqrt(50, 100) },
  { zeroForOne: false, exactOut: true, amount0: expandTo18Decimals(1), sqrtPriceLimit: encodePriceSqrt(200, 100) },
  // swap small amounts in/out
  { zeroForOne: true, exactOut: false, amount0: 1000n },
  { zeroForOne: false, exactOut: false, amount1: 1000n },
  { zeroForOne: true, exactOut: true, amount1: 1000n },
  { zeroForOne: false, exactOut: true, amount0: 1000n },
  // swap arbitrary input to price
  { sqrtPriceLimit: encodePriceSqrt(5, 2), zeroForOne: false },
  { sqrtPriceLimit: encodePriceSqrt(2, 5), zeroForOne: true },
  { sqrtPriceLimit: encodePriceSqrt(5, 2), zeroForOne: true },
  { sqrtPriceLimit: encodePriceSqrt(2, 5), zeroForOne: false },
];

const fullRange = (tickSpacing, liquidity) => [{ tickLower: getMinTick(tickSpacing), tickUpper: getMaxTick(tickSpacing), liquidity }];
const M = TICK_SPACINGS[FeeAmount.MEDIUM];

const TEST_POOLS = [
  {
    description: "low fee, 1:1 price, 2e18 max range liquidity",
    feeAmount: FeeAmount.LOW,
    tickSpacing: TICK_SPACINGS[FeeAmount.LOW],
    startingPrice: encodePriceSqrt(1, 1),
    positions: fullRange(TICK_SPACINGS[FeeAmount.LOW], expandTo18Decimals(2)),
  },
  {
    description: "medium fee, 1:1 price, 2e18 max range liquidity",
    feeAmount: FeeAmount.MEDIUM,
    tickSpacing: M,
    startingPrice: encodePriceSqrt(1, 1),
    positions: fullRange(M, expandTo18Decimals(2)),
  },
  {
    description: "high fee, 1:1 price, 2e18 max range liquidity",
    feeAmount: FeeAmount.HIGH,
    tickSpacing: TICK_SPACINGS[FeeAmount.HIGH],
    startingPrice: encodePriceSqrt(1, 1),
    positions: fullRange(TICK_SPACINGS[FeeAmount.HIGH], expandTo18Decimals(2)),
  },
  {
    description: "medium fee, 10:1 price, 2e18 max range liquidity",
    feeAmount: FeeAmount.MEDIUM,
    tickSpacing: M,
    startingPrice: encodePriceSqrt(10, 1),
    positions: fullRange(M, expandTo18Decimals(2)),
  },
  {
    description: "medium fee, 1:10 price, 2e18 max range liquidity",
    feeAmount: FeeAmount.MEDIUM,
    tickSpacing: M,
    startingPrice: encodePriceSqrt(1, 10),
    positions: fullRange(M, expandTo18Decimals(2)),
  },
  {
    description: "medium fee, 1:1 price, 0 liquidity, all liquidity around current price",
    feeAmount: FeeAmount.MEDIUM,
    tickSpacing: M,
    startingPrice: encodePriceSqrt(1, 1),
    positions: [
      { tickLower: getMinTick(M), tickUpper: -M, liquidity: expandTo18Decimals(2) },
      { tickLower: M, tickUpper: getMaxTick(M), liquidity: expandTo18Decimals(2) },
    ],
  },
  {
    description: "medium fee, 1:1 price, additional liquidity around current price",
    feeAmount: FeeAmount.MEDIUM,
    tickSpacing: M,
    startingPrice: encodePriceSqrt(1, 1),
    positions: [
      { tickLower: getMinTick(M), tickUpper: getMaxTick(M), liquidity: expandTo18Decimals(2) },
      { tickLower: getMinTick(M), tickUpper: -M, liquidity: expandTo18Decimals(2) },
      { tickLower: M, tickUpper: getMaxTick(M), liquidity: expandTo18Decimals(2) },
    ],
  },
  {
    description: "low fee, large liquidity around current price (stable swap)",
    feeAmount: FeeAmount.LOW,
    tickSpacing: TICK_SPACINGS[FeeAmount.LOW],
    startingPrice: encodePriceSqrt(1, 1),
    positions: [{ tickLower: -TICK_SPACINGS[FeeAmount.LOW], tickUpper: TICK_SPACINGS[FeeAmount.LOW], liquidity: expandTo18Decimals(2) }],
  },
  {
    description: "medium fee, token0 liquidity only",
    feeAmount: FeeAmount.MEDIUM,
    tickSpacing: M,
    startingPrice: encodePriceSqrt(1, 1),
    positions: [{ tickLower: 0, tickUpper: 2000 * M, liquidity: expandTo18Decimals(2) }],
  },
  {
    description: "medium fee, token1 liquidity only",
    feeAmount: FeeAmount.MEDIUM,
    tickSpacing: M,
    startingPrice: encodePriceSqrt(1, 1),
    positions: [{ tickLower: -2000 * M, tickUpper: 0, liquidity: expandTo18Decimals(2) }],
  },
  {
    description: "close to max price",
    feeAmount: FeeAmount.MEDIUM,
    tickSpacing: M,
    startingPrice: encodePriceSqrt(1n << 127n, 1),
    positions: fullRange(M, expandTo18Decimals(2)),
    u64: false,
  },
  {
    description: "close to min price",
    feeAmount: FeeAmount.MEDIUM,
    tickSpacing: M,
    startingPrice: encodePriceSqrt(1, 1n << 127n),
    positions: fullRange(M, expandTo18Decimals(2)),
    u64: false,
  },
  {
    description: "max full range liquidity at 1:1 price with default fee",
    feeAmount: FeeAmount.MEDIUM,
    tickSpacing: M,
    startingPrice: encodePriceSqrt(1, 1),
    positions: fullRange(M, getMaxLiquidityPerTick(M)),
    u64: false,
  },
  {
    description: "initialized at the max ratio",
    feeAmount: FeeAmount.MEDIUM,
    tickSpacing: M,
    startingPrice: MAX_SQRT_RATIO - 1n,
    positions: fullRange(M, expandTo18Decimals(2)),
    u64: false,
  },
  {
    description: "initialized at the min ratio",
    feeAmount: FeeAmount.MEDIUM,
    tickSpacing: M,
    startingPrice: MIN_SQRT_RATIO,
    positions: fullRange(M, expandTo18Decimals(2)),
    u64: false,
  },
];

const SNAPSHOT = loadUniswapSnapshot("UniswapV3Pool.swaps.spec.ts.snap.txt");

describe("UniswapV3Pool swap tests", () => {
  it("the snapshot of Uniswap has a result for every test", () => {
    const names = [];
    for (const poolCase of TEST_POOLS) {
      for (const testCase of poolCase.swapTests || DEFAULT_POOL_SWAP_TESTS) {
        names.push(`UniswapV3Pool swap tests ${poolCase.description} ${swapCaseToDescription(testCase)} 1`);
      }
    }
    expect(names.filter((name) => !SNAPSHOT[name])).toEqual([]);
    expect(names.length).toEqual(Object.keys(SNAPSHOT).length);
  });

  for (const poolCase of TEST_POOLS) {
    describe(poolCase.description, () => {
      let fixture, wallet, token0, token1, pool, poolFunctions, poolBalance0, poolBalance1, swapTarget;
      let SWAP_RECIPIENT_ADDRESS, POSITION_PROCEEDS_OUTPUT_ADDRESS;

      function setup() {
        fixture = poolFixture();
        ({ wallet, token0, token1 } = fixture);
        swapTarget = fixture.swapTargetCallee;
        SWAP_RECIPIENT_ADDRESS = fixture.vm.account("swap recipient").address;
        POSITION_PROCEEDS_OUTPUT_ADDRESS = fixture.vm.account("position proceeds output").address;
        pool = fixture.createPool(poolCase.feeAmount, poolCase.tickSpacing);
        poolFunctions = createPoolFunctions({ fixture, swapTarget, token0, token1, pool });
        pool.initialize(poolCase.startingPrice);
      }

      if (poolCase.u64 === false) {
        // Koinos: the positions of this pool need more than 2^64 tokens
        it("can't be created: the positions need more tokens than a u64", () => {
          setup();
          const overflows = poolCase.positions.map(({ tickLower, tickUpper, liquidity }) => {
            try {
              poolFunctions.mint(wallet, tickLower, tickUpper, liquidity);
              return false;
            } catch (e) {
              expect(e.message).toEqual("KOINDX: AMOUNT_OVERFLOW");
              return true;
            }
          });
          expect(overflows).toContain(true);
        });
        return;
      }

      beforeEach(() => {
        setup();
        // mint all positions
        for (const position of poolCase.positions) {
          poolFunctions.mint(wallet, position.tickLower, position.tickUpper, position.liquidity);
        }
        [poolBalance0, poolBalance1] = [token0.balanceOf(pool.address), token1.balanceOf(pool.address)];
      });

      afterEach(() => {
        // check can burn positions
        for (const { liquidity, tickUpper, tickLower } of poolCase.positions) {
          pool.burn(tickLower, tickUpper, liquidity);
          pool.collect(POSITION_PROCEEDS_OUTPUT_ADDRESS, tickLower, tickUpper, MaxUint64, MaxUint64);
        }
      });

      for (const testCase of poolCase.swapTests || DEFAULT_POOL_SWAP_TESTS) {
        const name = swapCaseToDescription(testCase);
        it(name, () => {
          const expected = SNAPSHOT[`UniswapV3Pool swap tests ${poolCase.description} ${name} 1`];
          const slot0 = pool.slot0();

          if (expected.swapError) {
            const reason = expected.swapError.replace("VM Exception while processing transaction: revert ", "KOINDX: ");
            expectRevert(() => executeSwap(testCase, poolFunctions, SWAP_RECIPIENT_ADDRESS), reason);
            expect({
              swapError: expected.swapError,
              poolBalance0: poolBalance0.toString(),
              poolBalance1: poolBalance1.toString(),
              poolPriceBefore: formatPrice(slot0.sqrtPriceX96),
              tickBefore: slot0.tick,
            }).toEqual(expected);
            return;
          }

          // Koinos: a swap that would leave more than 2^64 - 1 tokens in the pool can't be paid
          const exceedsU64 = ["0", "1"].some((i) => BigInt(expected[`amount${i}Before`]) + BigInt(expected[`amount${i}Delta`]) > MaxUint64);
          if (exceedsU64) {
            expectRevert(() => executeSwap(testCase, poolFunctions, SWAP_RECIPIENT_ADDRESS), "KOINDX: AMOUNT_OVERFLOW");
            expect({ amount0Before: poolBalance0.toString(), amount1Before: poolBalance1.toString(), tickBefore: slot0.tick }).toEqual({
              amount0Before: expected.amount0Before,
              amount1Before: expected.amount1Before,
              tickBefore: expected.tickBefore,
            });
            return;
          }

          const { events } = executeSwap(testCase, poolFunctions, SWAP_RECIPIENT_ADDRESS);
          const [poolBalance0After, poolBalance1After, slot0After, liquidityAfter, feeGrowthGlobal0X128, feeGrowthGlobal1X128] = [
            token0.balanceOf(pool.address),
            token1.balanceOf(pool.address),
            pool.slot0(),
            pool.liquidity(),
            pool.feeGrowthGlobal0X128(),
            pool.feeGrowthGlobal1X128(),
          ];
          const poolBalance0Delta = poolBalance0After - poolBalance0;
          const poolBalance1Delta = poolBalance1After - poolBalance1;

          // check all the events were emitted corresponding to balance changes
          const transfer = (delta) =>
            delta === 0n ? [] : delta < 0n ? [{ from: pool.address, to: SWAP_RECIPIENT_ADDRESS, value: -delta }] : [{ from: wallet.address, to: pool.address, value: delta }];
          expect(transfers(events, token0)).toEqual(transfer(poolBalance0Delta));
          expect(transfers(events, token1)).toEqual(transfer(poolBalance1Delta));

          // check that the swap event was emitted too (Uniswap's amount0 / amount1 are the pool
          // balance deltas: the input amount is paid to the pool, the output amount is sent by it)
          const [amountIn, amountOut] = testCase.zeroForOne ? [poolBalance0Delta, -poolBalance1Delta] : [poolBalance1Delta, -poolBalance0Delta];
          expect(pool.events(events, "pool.swap_event").map((e) => e.args)).toEqual([
            {
              sender: swapTarget.address,
              recipient: SWAP_RECIPIENT_ADDRESS,
              zeroForOne: testCase.zeroForOne,
              amountIn: amountIn.toString(),
              amountOut: amountOut.toString(),
              sqrtPriceX96: slot0After.sqrtPriceX96.toString(),
              liquidity: liquidityAfter.toString(),
              tick: slot0After.tick,
            },
          ]);

          expect({
            amount0Before: poolBalance0.toString(),
            amount1Before: poolBalance1.toString(),
            amount0Delta: poolBalance0Delta.toString(),
            amount1Delta: poolBalance1Delta.toString(),
            feeGrowthGlobal0X128Delta: feeGrowthGlobal0X128.toString(),
            feeGrowthGlobal1X128Delta: feeGrowthGlobal1X128.toString(),
            tickBefore: slot0.tick,
            poolPriceBefore: formatPrice(slot0.sqrtPriceX96),
            tickAfter: slot0After.tick,
            poolPriceAfter: formatPrice(slot0After.sqrtPriceX96),
            executionPrice: toPrecision5(-poolBalance1Delta, poolBalance0Delta),
          }).toEqual(expected);
        });
      }
    });
  }
});

