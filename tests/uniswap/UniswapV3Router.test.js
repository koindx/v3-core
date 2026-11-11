// Port of Uniswap v3-core test/UniswapV3Router.spec.ts: a multi-hop swap through 2 pools with
// the test router (TestUniswapV3Router, tests/uniswap/shared/test-contracts.js)
const { poolFixture, createPoolFunctions, createMultiPoolFunctions, transfers } = require("./shared/fixtures");
const { FeeAmount, TICK_SPACINGS, encodePriceSqrt, getMinTick, getMaxTick, expandTo18Decimals } = require("./shared/utilities");

const feeAmount = FeeAmount.MEDIUM;
const tickSpacing = TICK_SPACINGS[feeAmount];

describe("UniswapV3Pool", () => {
  let fixture, wallet, token0, token1, token2, factory;
  let pool0, pool1, pool0Functions, pool1Functions;
  let minTick, maxTick;
  let swapTargetCallee, swapTargetRouter;

  beforeEach(() => {
    fixture = poolFixture();
    ({ wallet, token0, token1, token2, factory } = fixture);
    ({ swapTargetCallee, swapTargetRouter } = fixture);

    const createPoolWrapped = (amount, spacing, firstToken, secondToken) => {
      const pool = fixture.createPool(amount, spacing, firstToken, secondToken);
      const poolFunctions = createPoolFunctions({ fixture, swapTarget: swapTargetCallee, token0: firstToken, token1: secondToken, pool });
      minTick = getMinTick(spacing);
      maxTick = getMaxTick(spacing);
      return [pool, poolFunctions];
    };

    // default to the 30 bips pool
    [pool0, pool0Functions] = createPoolWrapped(feeAmount, tickSpacing, token0, token1);
    [pool1, pool1Functions] = createPoolWrapped(feeAmount, tickSpacing, token1, token2);
  });

  it("constructor initializes immutables", () => {
    const immutables0 = pool0.immutables();
    const immutables1 = pool1.immutables();
    expect(immutables0.factory).toEqual(factory.address);
    expect(immutables0.token0).toEqual(token0.address);
    expect(immutables0.token1).toEqual(token1.address);
    expect(immutables1.factory).toEqual(factory.address);
    expect(immutables1.token0).toEqual(token1.address);
    expect(immutables1.token1).toEqual(token2.address);
  });

  describe("multi-swaps", () => {
    let inputToken;
    let outputToken;

    beforeEach(() => {
      inputToken = token0;
      outputToken = token2;

      pool0.initialize(encodePriceSqrt(1, 1));
      pool1.initialize(encodePriceSqrt(1, 1));

      pool0Functions.mint(wallet, minTick, maxTick, expandTo18Decimals(1));
      pool1Functions.mint(wallet, minTick, maxTick, expandTo18Decimals(1));
    });

    it("multi-swap", () => {
      const token0OfPoolOutput = pool1.immutables().token0;
      const ForExact0 = outputToken.address === token0OfPoolOutput;

      const { swapForExact0Multi, swapForExact1Multi } = createMultiPoolFunctions({
        fixture,
        swapTarget: swapTargetRouter,
        poolInput: pool0,
        poolOutput: pool1,
      });

      const method = ForExact0 ? swapForExact0Multi : swapForExact1Multi;

      const { events } = method(100, wallet);
      expect(transfers(events, outputToken)).toEqual([{ from: pool1.address, to: wallet.address, value: 100n }]);
      expect(transfers(events, token1)).toEqual([{ from: pool0.address, to: pool1.address, value: 102n }]);
      expect(transfers(events, inputToken)).toEqual([{ from: wallet.address, to: pool0.address, value: 104n }]);
    });
  });
});
