// Port of Uniswap v3-core test/UniswapV3Pool.arbitrage.spec.ts.
//
// The scenarios use passive liquidities up to 100e18 tokens, more than a u64 token supply (max
// ~1.84e19). Each test runs twice:
// - the scenario of Uniswap on the Uniswap reference (the published bytecode in an EVM,
//   tests/uniswap/evm), compared with the results recorded by Uniswap
//   (fixtures/UniswapV3Pool.arbitrage.spec.ts.snap.txt): the reference is Uniswap
// - the same scenario with the amounts (passive liquidity and swapped amount) divided by 10 on
//   KoinDX and on the Uniswap reference: every result of KoinDX must be equal to Uniswap's
// The sandwich tests mint the max liquidity per tick in one tick spacing (~1.09e30 tokens): on
// KoinDX the frontrun is compared, then the mint must revert with AMOUNT_OVERFLOW.
const { entryPoint } = require("../vm/koinos-vm");
const { call, callString } = require("../harness");
const { UniswapEVM } = require("./evm/uniswap-evm");
const { poolFixture, createPoolFunctions } = require("./shared/fixtures");
const { expectRevert } = require("./shared/contracts");
const tc = require("./shared/test-contracts");
const { formatPrice, formatTokenAmount } = require("./shared/format");
const { loadUniswapSnapshot } = require("./shared/snapshot");
const { encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxLiquidityPerTick, getMaxTick, getMinTick, isqrt, MAX_SQRT_RATIO, MIN_SQRT_RATIO, MaxUint64, MaxUint128, MaxUint256, TICK_SPACINGS } = require("./shared/utilities");

const SNAPSHOT = loadUniswapSnapshot("UniswapV3Pool.arbitrage.spec.ts.snap.txt");

/**
 * Uniswap: new Decimal(sqrtRatio^2 * (1e6 + bipsHundredths) / 1e6).sqrt().floor(), decimal.js
 * rounds the square root to 20 significant digits (half up)
 */
function applySqrtRatioBipsHundredthsDelta(sqrtRatio, bipsHundredths) {
  const x = (sqrtRatio * sqrtRatio * BigInt(1e6 + bipsHundredths)) / 1000000n;
  const shift = isqrt(x).toString().length - 20; // the square root is rounded at 10^shift
  if (shift >= 0) {
    const unit = 10n ** BigInt(shift);
    const f = isqrt(x / (unit * unit));
    return (4n * x >= ((2n * f + 1n) * unit) ** 2n ? f + 1n : f) * unit;
  }
  const scale = 10n ** BigInt(-shift);
  const f = isqrt(x * scale * scale);
  return (4n * x * scale * scale >= (2n * f + 1n) ** 2n ? f + 1n : f) / scale;
}

const getTickAtSqrtRatio = (ratio) => call("getTickAtSqrtRatio", ratio.toString());
const getSqrtRatioAtTick = (tick) => BigInt(callString("getSqrtRatioAtTick", tick));

const feeAmount = FeeAmount.MEDIUM;
const tickSpacing = TICK_SPACINGS[feeAmount];
const minTick = getMinTick(tickSpacing);
const maxTick = getMaxTick(tickSpacing);
const startingPrice = encodePriceSqrt(1, 1);

/** KoinDX in the Koinos VM emulator */
function koindxPool(feeProtocol, passiveLiquidity) {
  const fixture = poolFixture();
  const { wallet } = fixture;
  const arbitrageur = fixture.other;
  const pool = fixture.createPool(feeAmount, tickSpacing);
  const fns = createPoolFunctions({ fixture, swapTarget: fixture.swapTargetCallee, token0: fixture.token0, token1: fixture.token1, pool });
  // UniswapV3PoolSwapTest
  const tester = fixture.vm.account("UniswapV3PoolSwapTest").address;
  fixture.vm.deployNative(tester, tc.poolSwapTestContract({ codec: pool.codec }));
  fixture.approve(tester);

  pool.initialize(startingPrice);
  if (feeProtocol != 0) pool.setFeeProtocol(feeProtocol, feeProtocol);
  fns.mint(wallet, minTick, maxTick, passiveLiquidity);

  return {
    name: "KoinDX",
    maxAmount: MaxUint64,
    simulateSwap(zeroForOne, amountSpecified, sqrtPriceLimitX96) {
      const { events } = fixture.vm.transaction({
        signers: [wallet.address],
        dryRun: true,
        operations: [
          {
            call: {
              contractId: tester,
              entryPoint: entryPoint("getSwapResult"),
              args: tc.json({ pool: pool.address, zeroForOne, amountSpecified: amountSpecified.toString(), sqrtPriceLimitX96, payer: wallet.address }),
            },
          },
        ],
      });
      const r = tc.parse(events.find((e) => e.name === "SwapResult").data);
      return { amount0Delta: BigInt(r.amount0Delta), amount1Delta: BigInt(r.amount1Delta), nextSqrtRatio: BigInt(r.nextSqrtRatio) };
    },
    swapExact0For1: (amount, to) => fns.swapExact0For1(amount, to === "arbitrageur" ? arbitrageur : wallet),
    swapExact1For0: (amount, to) => fns.swapExact1For0(amount, to === "arbitrageur" ? arbitrageur : wallet),
    swapToLowerPrice: (price, to) => fns.swapToLowerPrice(price, to === "arbitrageur" ? arbitrageur : wallet),
    swapToHigherPrice: (price, to) => fns.swapToHigherPrice(price, to === "arbitrageur" ? arbitrageur : wallet),
    mint(tickLower, tickUpper, liquidity) {
      const { events } = fns.mint(wallet, tickLower, tickUpper, liquidity);
      const { amount0, amount1 } = pool.events(events, "pool.mint_event")[0].args;
      return { amount0: BigInt(amount0), amount1: BigInt(amount1) };
    },
    burnStatic(tickLower, tickUpper, amount) {
      const r = pool.callStatic(wallet, "burn", { tickLower, tickUpper, amount: amount.toString(), owner: wallet.address });
      return { amount0: BigInt(r.amount0), amount1: BigInt(r.amount1) };
    },
    burn: (tickLower, tickUpper, amount) => pool.burn(tickLower, tickUpper, amount),
    collectStatic: (tickLower, tickUpper) => pool.collectStatic(arbitrageur, tickLower, tickUpper, MaxUint64, MaxUint64),
    sqrtPriceX96: () => pool.slot0().sqrtPriceX96,
    tick: () => pool.slot0().tick,
  };
}

/** the Uniswap reference */
async function uniswapPool(feeProtocol, passiveLiquidity) {
  const uni = await UniswapEVM.create();
  const pool = await uni.createPool(feeAmount, tickSpacing);
  const arbitrageur = uni.other;
  await pool.initialize(startingPrice);
  if (feeProtocol != 0) await pool.setFeeProtocol(feeProtocol, feeProtocol);
  await pool.mint(uni.wallet, minTick, maxTick, passiveLiquidity);
  const to = (who) => (who === "arbitrageur" ? arbitrageur : uni.wallet);
  return {
    name: "Uniswap",
    maxAmount: MaxUint256 / 2n,
    /** UniswapV3PoolSwapTest.getSwapResult: the swap and the next price, without the state changes */
    async simulateSwap(zeroForOne, amountSpecified, sqrtPriceLimitX96) {
      const sm = uni.evm.stateManager;
      await sm.checkpoint();
      try {
        const { result } = await pool.swap(zeroForOne, amountSpecified, uni.wallet, sqrtPriceLimitX96);
        return { amount0Delta: BigInt(result.amount0.toString()), amount1Delta: BigInt(result.amount1.toString()), nextSqrtRatio: (await pool.slot0()).sqrtPriceX96 };
      } finally {
        await sm.revert();
      }
    },
    swapExact0For1: (amount, who) => pool.swapExact0For1(amount, to(who)),
    swapExact1For0: (amount, who) => pool.swapExact1For0(amount, to(who)),
    swapToLowerPrice: (price, who) => pool.swapToLowerPrice(price, to(who)),
    swapToHigherPrice: (price, who) => pool.swapToHigherPrice(price, to(who)),
    async mint(tickLower, tickUpper, liquidity) {
      const { events } = await pool.mint(uni.wallet, tickLower, tickUpper, liquidity);
      const { amount0, amount1 } = events.find((e) => e.name === "Mint").args;
      return { amount0, amount1 };
    },
    async burnStatic(tickLower, tickUpper, amount) {
      const r = await pool.contract.callStatic("burn", [tickLower, tickUpper, amount]);
      return { amount0: BigInt(r.amount0.toString()), amount1: BigInt(r.amount1.toString()) };
    },
    burn: (tickLower, tickUpper, amount) => pool.burn(tickLower, tickUpper, amount),
    collectStatic: (tickLower, tickUpper) => pool.collectStatic(arbitrageur, tickLower, tickUpper, MaxUint128, MaxUint128),
    sqrtPriceX96: async () => (await pool.slot0()).sqrtPriceX96,
    tick: async () => (await pool.slot0()).tick,
  };
}

// the scenarios of the Uniswap tests, on an implementation; they return the raw values

async function simulateSwap(impl, zeroForOne, amountSpecified, sqrtPriceLimitX96) {
  const res = await impl.simulateSwap(zeroForOne, amountSpecified, sqrtPriceLimitX96 ?? (zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n));
  const executionPrice = zeroForOne ? encodePriceSqrt(res.amount1Delta, -res.amount0Delta) : encodePriceSqrt(-res.amount1Delta, res.amount0Delta);
  return { ...res, executionPrice };
}

async function notSandwiched(impl, { zeroForOne, inputAmount }) {
  const { executionPrice, amount1Delta, amount0Delta } = await simulateSwap(impl, zeroForOne, inputAmount);
  zeroForOne ? await impl.swapExact0For1(inputAmount, "wallet") : await impl.swapExact1For0(inputAmount, "wallet");
  return { executionPrice, amount0Delta, amount1Delta, priceAfter: await impl.sqrtPriceX96() };
}

const formatNotSandwiched = (r) => ({
  executionPrice: formatPrice(r.executionPrice),
  amount0Delta: formatTokenAmount(r.amount0Delta),
  amount1Delta: formatTokenAmount(r.amount1Delta),
  priceAfter: formatPrice(r.priceAfter),
});

/** the sandwich, until the mint of the max liquidity when `untilMint` (KoinDX can't mint it) */
async function sandwiched(impl, { zeroForOne, inputAmount, valueToken1 }, untilMint = false) {
  const { executionPrice } = await simulateSwap(impl, zeroForOne, inputAmount);

  const firstTickAboveMarginalPrice = zeroForOne
    ? Math.ceil(getTickAtSqrtRatio(applySqrtRatioBipsHundredthsDelta(executionPrice, feeAmount)) / tickSpacing) * tickSpacing
    : Math.floor(getTickAtSqrtRatio(applySqrtRatioBipsHundredthsDelta(executionPrice, -feeAmount)) / tickSpacing) * tickSpacing;
  const tickAfterFirstTickAboveMarginPrice = zeroForOne ? firstTickAboveMarginalPrice - tickSpacing : firstTickAboveMarginalPrice + tickSpacing;

  const priceSwapStart = getSqrtRatioAtTick(firstTickAboveMarginalPrice);

  let arbBalance0 = 0n;
  let arbBalance1 = 0n;

  // first frontrun to the first tick before the execution price
  const { amount0Delta: frontrunDelta0, amount1Delta: frontrunDelta1, executionPrice: frontrunExecutionPrice } = await simulateSwap(
    impl,
    zeroForOne,
    impl.maxAmount,
    priceSwapStart
  );
  arbBalance0 -= frontrunDelta0;
  arbBalance1 -= frontrunDelta1;
  zeroForOne ? await impl.swapToLowerPrice(priceSwapStart, "arbitrageur") : await impl.swapToHigherPrice(priceSwapStart, "arbitrageur");

  const profitToken1AfterFrontRun = valueToken1(arbBalance0, arbBalance1);

  const tickLower = zeroForOne ? tickAfterFirstTickAboveMarginPrice : firstTickAboveMarginalPrice;
  const tickUpper = zeroForOne ? firstTickAboveMarginalPrice : tickAfterFirstTickAboveMarginPrice;
  const frontrun = { executionPrice: frontrunExecutionPrice, delta0: frontrunDelta0, delta1: frontrunDelta1, profitToken1AfterFrontRun, tickLower, tickUpper, tick: await impl.tick() };
  if (untilMint) return frontrun;

  // deposit max liquidity at the tick
  const { amount0: amount0Mint, amount1: amount1Mint } = await impl.mint(tickLower, tickUpper, getMaxLiquidityPerTick(tickSpacing));
  arbBalance0 -= amount0Mint;
  arbBalance1 -= amount1Mint;

  // execute the user's swap
  const { executionPrice: executionPriceAfterFrontrun } = await simulateSwap(impl, zeroForOne, inputAmount);
  zeroForOne ? await impl.swapExact0For1(inputAmount, "wallet") : await impl.swapExact1For0(inputAmount, "wallet");

  // burn the arb's liquidity
  const { amount0: amount0Burn, amount1: amount1Burn } = await impl.burnStatic(tickLower, tickUpper, getMaxLiquidityPerTick(tickSpacing));
  await impl.burn(tickLower, tickUpper, getMaxLiquidityPerTick(tickSpacing));
  arbBalance0 += amount0Burn;
  arbBalance1 += amount1Burn;

  // add the fees as well
  const { amount0: amount0CollectAndBurn, amount1: amount1CollectAndBurn } = await impl.collectStatic(tickLower, tickUpper);
  const [amount0Collect, amount1Collect] = [amount0CollectAndBurn - amount0Burn, amount1CollectAndBurn - amount1Burn];
  arbBalance0 += amount0Collect;
  arbBalance1 += amount1Collect;

  const profitToken1AfterSandwich = valueToken1(arbBalance0, arbBalance1);

  // backrun the swap to true price, i.e. swap to the marginal price = true price
  const priceToSwapTo = zeroForOne
    ? applySqrtRatioBipsHundredthsDelta(valueToken1.truePrice, -feeAmount)
    : applySqrtRatioBipsHundredthsDelta(valueToken1.truePrice, feeAmount);
  const { amount0Delta: backrunDelta0, amount1Delta: backrunDelta1, executionPrice: backrunExecutionPrice } = await simulateSwap(impl, !zeroForOne, impl.maxAmount, priceToSwapTo);
  await impl.swapToHigherPrice(priceToSwapTo, "wallet");
  arbBalance0 -= backrunDelta0;
  arbBalance1 -= backrunDelta1;

  return {
    sandwichedPrice: formatPrice(executionPriceAfterFrontrun),
    arbBalanceDelta0: formatTokenAmount(arbBalance0),
    arbBalanceDelta1: formatTokenAmount(arbBalance1),
    profit: {
      final: formatTokenAmount(valueToken1(arbBalance0, arbBalance1)),
      afterFrontrun: formatTokenAmount(profitToken1AfterFrontRun),
      afterSandwich: formatTokenAmount(profitToken1AfterSandwich),
    },
    backrun: { executionPrice: formatPrice(backrunExecutionPrice), delta0: formatTokenAmount(backrunDelta0), delta1: formatTokenAmount(backrunDelta1) },
    frontrun: { executionPrice: formatPrice(frontrunExecutionPrice), delta0: formatTokenAmount(frontrunDelta0), delta1: formatTokenAmount(frontrunDelta1) },
    collect: { amount0: formatTokenAmount(amount0Collect), amount1: formatTokenAmount(amount1Collect) },
    burn: { amount0: formatTokenAmount(amount0Burn), amount1: formatTokenAmount(amount1Burn) },
    mint: { amount0: formatTokenAmount(amount0Mint), amount1: formatTokenAmount(amount1Mint) },
    finalPrice: formatPrice(await impl.sqrtPriceX96()),
  };
}

async function backrunOnly(impl, { zeroForOne, inputAmount, valueToken1 }) {
  let arbBalance0 = 0n;
  let arbBalance1 = 0n;

  zeroForOne ? await impl.swapExact0For1(inputAmount, "wallet") : await impl.swapExact1For0(inputAmount, "wallet");

  // swap to the marginal price = true price
  const priceToSwapTo = zeroForOne
    ? applySqrtRatioBipsHundredthsDelta(valueToken1.truePrice, -feeAmount)
    : applySqrtRatioBipsHundredthsDelta(valueToken1.truePrice, feeAmount);
  const { amount0Delta: backrunDelta0, amount1Delta: backrunDelta1, executionPrice: backrunExecutionPrice } = await simulateSwap(impl, !zeroForOne, impl.maxAmount, priceToSwapTo);
  zeroForOne ? await impl.swapToHigherPrice(priceToSwapTo, "wallet") : await impl.swapToLowerPrice(priceToSwapTo, "wallet");
  arbBalance0 -= backrunDelta0;
  arbBalance1 -= backrunDelta1;

  return {
    arbBalance0,
    arbBalance1,
    final: valueToken1(arbBalance0, arbBalance1),
    backrunExecutionPrice,
    backrunDelta0,
    backrunDelta1,
    finalPrice: await impl.sqrtPriceX96(),
  };
}

const formatBackrunOnly = (r) => ({
  arbBalanceDelta0: formatTokenAmount(r.arbBalance0),
  arbBalanceDelta1: formatTokenAmount(r.arbBalance1),
  profit: { final: formatTokenAmount(r.final) },
  backrun: { executionPrice: formatPrice(r.backrunExecutionPrice), delta0: formatTokenAmount(r.backrunDelta0), delta1: formatTokenAmount(r.backrunDelta1) },
  finalPrice: formatPrice(r.finalPrice),
});

describe("UniswapV3Pool arbitrage tests", () => {
  for (const feeProtocol of [0, 6]) {
    describe(`protocol fee = ${feeProtocol};`, () => {
      for (const passiveLiquidity of [expandTo18Decimals(1) / 100n, expandTo18Decimals(1), expandTo18Decimals(10), expandTo18Decimals(100)]) {
        describe(`passive liquidity of ${formatTokenAmount(passiveLiquidity)}`, () => {
          for (const { zeroForOne, assumedTruePriceAfterSwap, inputAmount, description } of [
            {
              description: "exact input of 10e18 token0 with starting price of 1.0 and true price of 0.98",
              zeroForOne: true,
              inputAmount: expandTo18Decimals(10),
              assumedTruePriceAfterSwap: encodePriceSqrt(98, 100),
            },
            {
              description: "exact input of 10e18 token0 with starting price of 1.0 and true price of 1.01",
              zeroForOne: true,
              inputAmount: expandTo18Decimals(10),
              assumedTruePriceAfterSwap: encodePriceSqrt(101, 100),
            },
          ]) {
            describe(description, () => {
              const snapshotName = (test) =>
                `UniswapV3Pool arbitrage tests protocol fee = ${feeProtocol}; passive liquidity of ${formatTokenAmount(passiveLiquidity)} ${description} ${test} 1`;
              const valueToken1 = (arbBalance0, arbBalance1) => (assumedTruePriceAfterSwap * assumedTruePriceAfterSwap * arbBalance0) / (1n << 192n) + arbBalance1;
              valueToken1.truePrice = assumedTruePriceAfterSwap;
              const scenario = { zeroForOne, inputAmount, valueToken1 };
              // KoinDX: the amounts divided by 10
              const scaled = { zeroForOne, inputAmount: inputAmount / 10n, valueToken1 };

              it("not sandwiched", async () => {
                const uniswap = await notSandwiched(await uniswapPool(feeProtocol, passiveLiquidity), scenario);
                expect(formatNotSandwiched(uniswap)).toEqual(SNAPSHOT[snapshotName("not sandwiched")]);

                const expected = await notSandwiched(await uniswapPool(feeProtocol, passiveLiquidity / 10n), scaled);
                expect(await notSandwiched(koindxPool(feeProtocol, passiveLiquidity / 10n), scaled)).toEqual(expected);
              });

              it("sandwiched with swap to execution price then mint max liquidity/target/burn max liquidity", async () => {
                const name = snapshotName("sandwiched with swap to execution price then mint max liquidity/target/burn max liquidity");
                expect(await sandwiched(await uniswapPool(feeProtocol, passiveLiquidity), scenario)).toEqual(SNAPSHOT[name]);

                // KoinDX: the frontrun, then the mint of the max liquidity overflows the token amounts
                const expected = await sandwiched(await uniswapPool(feeProtocol, passiveLiquidity / 10n), scaled, true);
                const koindx = koindxPool(feeProtocol, passiveLiquidity / 10n);
                expect(await sandwiched(koindx, scaled, true)).toEqual(expected);
                expectRevert(() => koindx.mint(expected.tickLower, expected.tickUpper, getMaxLiquidityPerTick(tickSpacing)), "KOINDX: AMOUNT_OVERFLOW");
              });

              it("backrun to true price after swap only", async () => {
                const uniswap = await backrunOnly(await uniswapPool(feeProtocol, passiveLiquidity), scenario);
                expect(formatBackrunOnly(uniswap)).toEqual(SNAPSHOT[snapshotName("backrun to true price after swap only")]);

                const expected = await backrunOnly(await uniswapPool(feeProtocol, passiveLiquidity / 10n), scaled);
                expect(await backrunOnly(koindxPool(feeProtocol, passiveLiquidity / 10n), scaled)).toEqual(expected);
              });
            });
          }
        });
      }
    });
  }
});
