// Port of Uniswap v3-core test/UniswapV3Pool.spec.ts, run against the compiled pool in the Koinos
// VM emulator. The expected values are the ones of Uniswap.
//
// Koinos differences:
// - revert reasons have the "KOINDX: " prefix and some are more descriptive (LOK → LOCKED,
//   R → SQRT_PRICE_OUT_OF_RANGE, LO → LIQUIDITY_OVERFLOW, LS → LIQUIDITY_SUB, NP → NO_POSITION…)
// - token amounts are u64 (Koinos tokens): the collect requests use MaxUint64 instead of
//   MaxUint128, and the tests that move more than 2^64 tokens are adapted (see each test)
// - the zero address doesn't exist: the flash donations use `other` as recipient (with 0 amounts
//   nothing is transferred to it)
// - pool.connect(other).f() is f(..., other): `other` signs the transaction
// - Koinos can't catch a reverted call: each reentrancy attempt is a separate transaction
// - TickMathTest/SwapMathTest are the compiled math libraries (tests/build/harness.wasm)
const { poolFixture, createPoolFunctions, TEST_POOL_START_TIME, transfers, testEvents } = require("./shared/fixtures");
const { expectRevert } = require("./shared/contracts");
const tc = require("./shared/test-contracts");
const { entryPoint } = require("../vm/koinos-vm");
const harness = require("../harness");
const { UniswapEVM } = require("./evm/uniswap-evm");
const {
  expandTo18Decimals,
  FeeAmount,
  getMaxTick,
  getMinTick,
  encodePriceSqrt,
  TICK_SPACINGS,
  getMaxLiquidityPerTick,
  MaxUint128,
  MaxUint256,
  MaxUint64,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
} = require("./shared/utilities");

describe("UniswapV3Pool", () => {
  let fixture, vm, wallet, other;
  let token0, token1;
  let factory;
  let pool;
  let swapTarget;

  let swapToLowerPrice, swapToHigherPrice, swapExact0For1, swapExact1For0;
  let tickSpacing, minTick, maxTick;
  let mint, flash;

  function createPool(_feeAmount, _tickSpacing) {
    const p = fixture.createPool(_feeAmount, _tickSpacing);
    ({ swapToLowerPrice, swapToHigherPrice, swapExact0For1, swapExact1For0, mint, flash } = createPoolFunctions({
      fixture,
      token0,
      token1,
      swapTarget,
      pool: p,
    }));
    minTick = getMinTick(_tickSpacing);
    maxTick = getMaxTick(_tickSpacing);
    tickSpacing = _tickSpacing;
    return p;
  }

  beforeEach(() => {
    fixture = poolFixture();
    ({ vm, wallet, other, token0, token1, factory } = fixture);
    swapTarget = fixture.swapTargetCallee;
    // default to the 30 bips pool
    pool = createPool(FeeAmount.MEDIUM, TICK_SPACINGS[FeeAmount.MEDIUM]);
  });

  const balance = (token, account) => token.balanceOf(typeof account === "string" ? account : account.address);
  const poolEvents = (res, name) => pool.events(res.events, name).map((e) => e.args);

  function checkObservationEquals(observation, expected) {
    expect({
      initialized: observation.initialized,
      blockTimestamp: observation.blockTimestamp,
      tickCumulative: observation.tickCumulative.toString(),
      secondsPerLiquidityCumulativeX128: observation.secondsPerLiquidityCumulativeX128.toString(),
    }).toEqual({
      initialized: expected.initialized,
      blockTimestamp: expected.blockTimestamp,
      tickCumulative: expected.tickCumulative.toString(),
      secondsPerLiquidityCumulativeX128: expected.secondsPerLiquidityCumulativeX128.toString(),
    });
  }

  it("constructor initializes immutables", () => {
    const immutables = pool.immutables();
    expect(immutables.factory).toEqual(factory.address);
    expect(immutables.token0).toEqual(token0.address);
    expect(immutables.token1).toEqual(token1.address);
    expect(BigInt(immutables.maxLiquidityPerTick)).toEqual(getMaxLiquidityPerTick(tickSpacing));
  });

  describe("#initialize", () => {
    it("fails if already initialized", () => {
      pool.initialize(encodePriceSqrt(1, 1));
      expectRevert(() => pool.initialize(encodePriceSqrt(1, 1)), "KOINDX: ALREADY_INITIALIZED");
    });
    it("fails if starting price is too low", () => {
      expectRevert(() => pool.initialize(1n), "KOINDX: SQRT_PRICE_OUT_OF_RANGE");
      expectRevert(() => pool.initialize(MIN_SQRT_RATIO - 1n), "KOINDX: SQRT_PRICE_OUT_OF_RANGE");
    });
    it("fails if starting price is too high", () => {
      expectRevert(() => pool.initialize(MAX_SQRT_RATIO), "KOINDX: SQRT_PRICE_OUT_OF_RANGE");
      expectRevert(() => pool.initialize((1n << 160n) - 1n), "KOINDX: SQRT_PRICE_OUT_OF_RANGE");
    });
    it("can be initialized at MIN_SQRT_RATIO", () => {
      pool.initialize(MIN_SQRT_RATIO);
      expect(pool.slot0().tick).toEqual(getMinTick(1));
    });
    it("can be initialized at MAX_SQRT_RATIO - 1", () => {
      pool.initialize(MAX_SQRT_RATIO - 1n);
      expect(pool.slot0().tick).toEqual(getMaxTick(1) - 1);
    });
    it("sets initial variables", () => {
      const price = encodePriceSqrt(1, 2);
      pool.initialize(price);

      const { sqrtPriceX96, observationIndex } = pool.slot0();
      expect(sqrtPriceX96).toEqual(price);
      expect(observationIndex).toEqual(0);
      expect(pool.slot0().tick).toEqual(-6932);
    });
    it("initializes the first observations slot", () => {
      pool.initialize(encodePriceSqrt(1, 1));
      checkObservationEquals(pool.observations(0), {
        secondsPerLiquidityCumulativeX128: 0,
        initialized: true,
        blockTimestamp: TEST_POOL_START_TIME,
        tickCumulative: 0,
      });
    });
    it("emits a Initialized event with the input tick", () => {
      const sqrtPriceX96 = encodePriceSqrt(1, 2);
      expect(poolEvents(pool.initialize(sqrtPriceX96), "pool.initialize_event")).toEqual([{ sqrtPriceX96: sqrtPriceX96.toString(), tick: -6932 }]);
    });
  });

  describe("#increaseObservationCardinalityNext", () => {
    it("can only be called after initialize", () => {
      expectRevert(() => pool.increaseObservationCardinalityNext(2), "KOINDX: LOCKED");
    });
    it("emits an event including both old and new", () => {
      pool.initialize(encodePriceSqrt(1, 1));
      expect(poolEvents(pool.increaseObservationCardinalityNext(2), "pool.increase_observation_cardinality_next_event")).toEqual([
        { observationCardinalityNextOld: 1, observationCardinalityNextNew: 2 },
      ]);
    });
    it("does not emit an event for no op call", () => {
      pool.initialize(encodePriceSqrt(1, 1));
      pool.increaseObservationCardinalityNext(3);
      expect(poolEvents(pool.increaseObservationCardinalityNext(2), "pool.increase_observation_cardinality_next_event")).toEqual([]);
    });
    it("does not change cardinality next if less than current", () => {
      pool.initialize(encodePriceSqrt(1, 1));
      pool.increaseObservationCardinalityNext(3);
      pool.increaseObservationCardinalityNext(2);
      expect(pool.slot0().observationCardinalityNext).toEqual(3);
    });
    it("increases cardinality and cardinality next first time", () => {
      pool.initialize(encodePriceSqrt(1, 1));
      pool.increaseObservationCardinalityNext(2);
      const { observationCardinality, observationCardinalityNext } = pool.slot0();
      expect(observationCardinality).toEqual(1);
      expect(observationCardinalityNext).toEqual(2);
    });
  });

  describe("#mint", () => {
    it("fails if not initialized", () => {
      expectRevert(() => mint(wallet, -tickSpacing, tickSpacing, 1), "KOINDX: LOCKED");
    });
    describe("after initialization", () => {
      beforeEach(() => {
        pool.initialize(encodePriceSqrt(1, 10));
        mint(wallet, minTick, maxTick, 3161);
      });

      describe("failure cases", () => {
        it("fails if tickLower greater than tickUpper", () => {
          expectRevert(() => mint(wallet, 1, 0, 1), "KOINDX: TLU");
        });
        it("fails if tickLower less than min tick", () => {
          expectRevert(() => mint(wallet, -887273, 0, 1), "KOINDX: TLM");
        });
        it("fails if tickUpper greater than max tick", () => {
          expectRevert(() => mint(wallet, 0, 887273, 1), "KOINDX: TUM");
        });
        it("fails if amount exceeds the max", () => {
          const maxLiquidityGross = BigInt(pool.immutables().maxLiquidityPerTick);
          expectRevert(() => mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross + 1n), "KOINDX: LIQUIDITY_OVERFLOW");
          // Koinos: the tokens needed for the max liquidity of this range don't fit in a u64
          expectRevert(() => mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross), "KOINDX: AMOUNT_OVERFLOW");
          // Koinos: the max liquidity in a range whose amounts fit in a u64
          expectRevert(() => mint(wallet, maxTick - tickSpacing * 2, maxTick - tickSpacing, maxLiquidityGross + 1n), "KOINDX: LIQUIDITY_OVERFLOW");
          mint(wallet, maxTick - tickSpacing * 2, maxTick - tickSpacing, maxLiquidityGross);
        });
        it("fails if total amount at tick exceeds the max", () => {
          mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, 1000);

          const maxLiquidityGross = BigInt(pool.immutables().maxLiquidityPerTick);
          expectRevert(() => mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross - 1000n + 1n), "KOINDX: LIQUIDITY_OVERFLOW");
          expectRevert(() => mint(wallet, minTick + tickSpacing * 2, maxTick - tickSpacing, maxLiquidityGross - 1000n + 1n), "KOINDX: LIQUIDITY_OVERFLOW");
          expectRevert(() => mint(wallet, minTick + tickSpacing, maxTick - tickSpacing * 2, maxLiquidityGross - 1000n + 1n), "KOINDX: LIQUIDITY_OVERFLOW");
          // Koinos: the tokens needed don't fit in a u64
          expectRevert(() => mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross - 1000n), "KOINDX: AMOUNT_OVERFLOW");

          // Koinos: the same checks in a range whose amounts fit in a u64
          const lower = maxTick - tickSpacing * 4;
          const upper = maxTick - tickSpacing * 2;
          mint(wallet, lower, upper, 1000);
          expectRevert(() => mint(wallet, lower, upper, maxLiquidityGross - 1000n + 1n), "KOINDX: LIQUIDITY_OVERFLOW");
          expectRevert(() => mint(wallet, lower + tickSpacing, upper, maxLiquidityGross - 1000n + 1n), "KOINDX: LIQUIDITY_OVERFLOW");
          expectRevert(() => mint(wallet, lower, upper - tickSpacing, maxLiquidityGross - 1000n + 1n), "KOINDX: LIQUIDITY_OVERFLOW");
          mint(wallet, lower, upper, maxLiquidityGross - 1000n);
        });
        it("fails if amount is 0", () => {
          expectRevert(() => mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, 0), "KOINDX: ZERO_LIQUIDITY");
        });
      });

      describe("success cases", () => {
        it("initial balances", () => {
          expect(balance(token0, pool.address)).toEqual(9996n);
          expect(balance(token1, pool.address)).toEqual(1000n);
        });

        it("initial tick", () => {
          expect(pool.slot0().tick).toEqual(-23028);
        });

        describe("above current price", () => {
          it("transfers token0 only", () => {
            const { events } = mint(wallet, -22980, 0, 10000);
            expect(transfers(events, token0)).toEqual([{ from: wallet.address, to: pool.address, value: 21549n }]);
            expect(transfers(events, token1)).toEqual([]);
            expect(balance(token0, pool.address)).toEqual(9996n + 21549n);
            expect(balance(token1, pool.address)).toEqual(1000n);
          });

          it("max tick with max leverage", () => {
            mint(wallet, maxTick - tickSpacing, maxTick, 1n << 102n);
            expect(balance(token0, pool.address)).toEqual(9996n + 828011525n);
            expect(balance(token1, pool.address)).toEqual(1000n);
          });

          it("works for max tick", () => {
            const { events } = mint(wallet, -22980, maxTick, 10000);
            expect(transfers(events, token0)).toEqual([{ from: wallet.address, to: pool.address, value: 31549n }]);
            expect(balance(token0, pool.address)).toEqual(9996n + 31549n);
            expect(balance(token1, pool.address)).toEqual(1000n);
          });

          it("removing works", () => {
            mint(wallet, -240, 0, 10000);
            pool.burn(-240, 0, 10000);
            const { amount0, amount1 } = pool.collectStatic(wallet, -240, 0, MaxUint64, MaxUint64);
            expect(amount0).toEqual(120n);
            expect(amount1).toEqual(0n);
          });

          it("adds liquidity to liquidityGross", () => {
            mint(wallet, -240, 0, 100);
            expect(pool.ticks(-240).liquidityGross).toEqual(100n);
            expect(pool.ticks(0).liquidityGross).toEqual(100n);
            expect(pool.ticks(tickSpacing).liquidityGross).toEqual(0n);
            expect(pool.ticks(tickSpacing * 2).liquidityGross).toEqual(0n);
            mint(wallet, -240, tickSpacing, 150);
            expect(pool.ticks(-240).liquidityGross).toEqual(250n);
            expect(pool.ticks(0).liquidityGross).toEqual(100n);
            expect(pool.ticks(tickSpacing).liquidityGross).toEqual(150n);
            expect(pool.ticks(tickSpacing * 2).liquidityGross).toEqual(0n);
            mint(wallet, 0, tickSpacing * 2, 60);
            expect(pool.ticks(-240).liquidityGross).toEqual(250n);
            expect(pool.ticks(0).liquidityGross).toEqual(160n);
            expect(pool.ticks(tickSpacing).liquidityGross).toEqual(150n);
            expect(pool.ticks(tickSpacing * 2).liquidityGross).toEqual(60n);
          });

          it("removes liquidity from liquidityGross", () => {
            mint(wallet, -240, 0, 100);
            mint(wallet, -240, 0, 40);
            pool.burn(-240, 0, 90);
            expect(pool.ticks(-240).liquidityGross).toEqual(50n);
            expect(pool.ticks(0).liquidityGross).toEqual(50n);
          });

          it("clears tick lower if last position is removed", () => {
            mint(wallet, -240, 0, 100);
            pool.burn(-240, 0, 100);
            const { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128 } = pool.ticks(-240);
            expect(liquidityGross).toEqual(0n);
            expect(feeGrowthOutside0X128).toEqual(0n);
            expect(feeGrowthOutside1X128).toEqual(0n);
          });

          it("clears tick upper if last position is removed", () => {
            mint(wallet, -240, 0, 100);
            pool.burn(-240, 0, 100);
            const { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128 } = pool.ticks(0);
            expect(liquidityGross).toEqual(0n);
            expect(feeGrowthOutside0X128).toEqual(0n);
            expect(feeGrowthOutside1X128).toEqual(0n);
          });
          it("only clears the tick that is not used at all", () => {
            mint(wallet, -240, 0, 100);
            mint(wallet, -tickSpacing, 0, 250);
            pool.burn(-240, 0, 100);

            let { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128 } = pool.ticks(-240);
            expect(liquidityGross).toEqual(0n);
            expect(feeGrowthOutside0X128).toEqual(0n);
            expect(feeGrowthOutside1X128).toEqual(0n);
            ({ liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128 } = pool.ticks(-tickSpacing));
            expect(liquidityGross).toEqual(250n);
            expect(feeGrowthOutside0X128).toEqual(0n);
            expect(feeGrowthOutside1X128).toEqual(0n);
          });

          it("does not write an observation", () => {
            checkObservationEquals(pool.observations(0), {
              tickCumulative: 0,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0,
            });
            pool.advanceTime(1);
            mint(wallet, -240, 0, 100);
            checkObservationEquals(pool.observations(0), {
              tickCumulative: 0,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0,
            });
          });
        });

        describe("including current price", () => {
          it("price within range: transfers current price of both tokens", () => {
            const { events } = mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, 100);
            expect(transfers(events, token0)).toEqual([{ from: wallet.address, to: pool.address, value: 317n }]);
            expect(transfers(events, token1)).toEqual([{ from: wallet.address, to: pool.address, value: 32n }]);
            expect(balance(token0, pool.address)).toEqual(9996n + 317n);
            expect(balance(token1, pool.address)).toEqual(1000n + 32n);
          });

          it("initializes lower tick", () => {
            mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, 100);
            expect(pool.ticks(minTick + tickSpacing).liquidityGross).toEqual(100n);
          });

          it("initializes upper tick", () => {
            mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, 100);
            expect(pool.ticks(maxTick - tickSpacing).liquidityGross).toEqual(100n);
          });

          it("works for min/max tick", () => {
            const { events } = mint(wallet, minTick, maxTick, 10000);
            expect(transfers(events, token0)).toEqual([{ from: wallet.address, to: pool.address, value: 31623n }]);
            expect(transfers(events, token1)).toEqual([{ from: wallet.address, to: pool.address, value: 3163n }]);
            expect(balance(token0, pool.address)).toEqual(9996n + 31623n);
            expect(balance(token1, pool.address)).toEqual(1000n + 3163n);
          });

          it("removing works", () => {
            mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, 100);
            pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 100);
            const { amount0, amount1 } = pool.collectStatic(wallet, minTick + tickSpacing, maxTick - tickSpacing, MaxUint64, MaxUint64);
            expect(amount0).toEqual(316n);
            expect(amount1).toEqual(31n);
          });

          it("writes an observation", () => {
            checkObservationEquals(pool.observations(0), {
              tickCumulative: 0,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0,
            });
            pool.advanceTime(1);
            mint(wallet, minTick, maxTick, 100);
            checkObservationEquals(pool.observations(0), {
              tickCumulative: -23028,
              blockTimestamp: TEST_POOL_START_TIME + 1,
              initialized: true,
              secondsPerLiquidityCumulativeX128: "107650226801941937191829992860413859",
            });
          });
        });

        describe("below current price", () => {
          it("transfers token1 only", () => {
            const { events } = mint(wallet, -46080, -23040, 10000);
            expect(transfers(events, token1)).toEqual([{ from: wallet.address, to: pool.address, value: 2162n }]);
            expect(transfers(events, token0)).toEqual([]);
            expect(balance(token0, pool.address)).toEqual(9996n);
            expect(balance(token1, pool.address)).toEqual(1000n + 2162n);
          });

          it("min tick with max leverage", () => {
            mint(wallet, minTick, minTick + tickSpacing, 1n << 102n);
            expect(balance(token0, pool.address)).toEqual(9996n);
            expect(balance(token1, pool.address)).toEqual(1000n + 828011520n);
          });

          it("works for min tick", () => {
            const { events } = mint(wallet, minTick, -23040, 10000);
            expect(transfers(events, token1)).toEqual([{ from: wallet.address, to: pool.address, value: 3161n }]);
            expect(balance(token0, pool.address)).toEqual(9996n);
            expect(balance(token1, pool.address)).toEqual(1000n + 3161n);
          });

          it("removing works", () => {
            mint(wallet, -46080, -46020, 10000);
            pool.burn(-46080, -46020, 10000);
            const { amount0, amount1 } = pool.collectStatic(wallet, -46080, -46020, MaxUint64, MaxUint64);
            expect(amount0).toEqual(0n);
            expect(amount1).toEqual(3n);
          });

          it("does not write an observation", () => {
            checkObservationEquals(pool.observations(0), {
              tickCumulative: 0,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0,
            });
            pool.advanceTime(1);
            mint(wallet, -46080, -23040, 100);
            checkObservationEquals(pool.observations(0), {
              tickCumulative: 0,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0,
            });
          });
        });
      });

      it("protocol fees accumulate as expected during swap", () => {
        pool.setFeeProtocol(6, 6);

        mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1));
        swapExact0For1(expandTo18Decimals(1) / 10n, wallet);
        swapExact1For0(expandTo18Decimals(1) / 100n, wallet);

        const { token0: token0ProtocolFees, token1: token1ProtocolFees } = pool.protocolFees();
        expect(token0ProtocolFees).toEqual(50000000000000n);
        expect(token1ProtocolFees).toEqual(5000000000000n);
      });

      it("positions are protected before protocol fee is turned on", () => {
        mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1));
        swapExact0For1(expandTo18Decimals(1) / 10n, wallet);
        swapExact1For0(expandTo18Decimals(1) / 100n, wallet);

        let { token0: token0ProtocolFees, token1: token1ProtocolFees } = pool.protocolFees();
        expect(token0ProtocolFees).toEqual(0n);
        expect(token1ProtocolFees).toEqual(0n);

        pool.setFeeProtocol(6, 6);
        ({ token0: token0ProtocolFees, token1: token1ProtocolFees } = pool.protocolFees());
        expect(token0ProtocolFees).toEqual(0n);
        expect(token1ProtocolFees).toEqual(0n);
      });

      it("poke is not allowed on uninitialized position", () => {
        mint(other, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1));
        swapExact0For1(expandTo18Decimals(1) / 10n, wallet);
        swapExact1For0(expandTo18Decimals(1) / 100n, wallet);

        expectRevert(() => pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 0), "KOINDX: NO_POSITION");

        mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, 1);
        let { liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed1, tokensOwed0 } = pool.positions(
          wallet,
          minTick + tickSpacing,
          maxTick - tickSpacing
        );
        expect(liquidity).toEqual(1n);
        expect(feeGrowthInside0LastX128).toEqual(102084710076281216349243831104605583n);
        expect(feeGrowthInside1LastX128).toEqual(10208471007628121634924383110460558n);
        expect(tokensOwed0).toEqual(0n);
        expect(tokensOwed1).toEqual(0n);

        pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 1);
        ({ liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed1, tokensOwed0 } = pool.positions(
          wallet,
          minTick + tickSpacing,
          maxTick - tickSpacing
        ));
        expect(liquidity).toEqual(0n);
        expect(feeGrowthInside0LastX128).toEqual(102084710076281216349243831104605583n);
        expect(feeGrowthInside1LastX128).toEqual(10208471007628121634924383110460558n);
        expect(tokensOwed0).toEqual(3n);
        expect(tokensOwed1).toEqual(0n);
      });
    });
  });

  // the combined amount of liquidity that the pool is initialized with (including the 1 minimum liquidity that is burned)
  const initializeLiquidityAmount = expandTo18Decimals(2);
  function initializeAtZeroTick(p) {
    p.initialize(encodePriceSqrt(1, 1));
    const spacing = p.immutables().tickSpacing;
    const [min, max] = [getMinTick(spacing), getMaxTick(spacing)];
    mint(wallet, min, max, initializeLiquidityAmount);
  }

  describe("#burn", () => {
    beforeEach(() => initializeAtZeroTick(pool));

    function checkTickIsClear(tick) {
      const { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128, liquidityNet } = pool.ticks(tick);
      expect(liquidityGross).toEqual(0n);
      expect(feeGrowthOutside0X128).toEqual(0n);
      expect(feeGrowthOutside1X128).toEqual(0n);
      expect(liquidityNet).toEqual(0n);
    }

    function checkTickIsNotClear(tick) {
      const { liquidityGross } = pool.ticks(tick);
      expect(liquidityGross).not.toEqual(0n);
    }

    it("does not clear the position fee growth snapshot if no more liquidity", () => {
      // some activity that would make the ticks non-zero
      pool.advanceTime(10);
      mint(other, minTick, maxTick, expandTo18Decimals(1));
      swapExact0For1(expandTo18Decimals(1), wallet);
      swapExact1For0(expandTo18Decimals(1), wallet);
      pool.burn(minTick, maxTick, expandTo18Decimals(1), other);
      const { liquidity, tokensOwed0, tokensOwed1, feeGrowthInside0LastX128, feeGrowthInside1LastX128 } = pool.positions(other, minTick, maxTick);
      expect(liquidity).toEqual(0n);
      expect(tokensOwed0).not.toEqual(0n);
      expect(tokensOwed1).not.toEqual(0n);
      expect(feeGrowthInside0LastX128).toEqual(340282366920938463463374607431768211n);
      expect(feeGrowthInside1LastX128).toEqual(340282366920938576890830247744589365n);
    });

    it("clears the tick if its the last position using it", () => {
      const tickLower = minTick + tickSpacing;
      const tickUpper = maxTick - tickSpacing;
      // some activity that would make the ticks non-zero
      pool.advanceTime(10);
      mint(wallet, tickLower, tickUpper, 1);
      swapExact0For1(expandTo18Decimals(1), wallet);
      pool.burn(tickLower, tickUpper, 1);
      checkTickIsClear(tickLower);
      checkTickIsClear(tickUpper);
    });

    it("clears only the lower tick if upper is still used", () => {
      const tickLower = minTick + tickSpacing;
      const tickUpper = maxTick - tickSpacing;
      // some activity that would make the ticks non-zero
      pool.advanceTime(10);
      mint(wallet, tickLower, tickUpper, 1);
      mint(wallet, tickLower + tickSpacing, tickUpper, 1);
      swapExact0For1(expandTo18Decimals(1), wallet);
      pool.burn(tickLower, tickUpper, 1);
      checkTickIsClear(tickLower);
      checkTickIsNotClear(tickUpper);
    });

    it("clears only the upper tick if lower is still used", () => {
      const tickLower = minTick + tickSpacing;
      const tickUpper = maxTick - tickSpacing;
      // some activity that would make the ticks non-zero
      pool.advanceTime(10);
      mint(wallet, tickLower, tickUpper, 1);
      mint(wallet, tickLower, tickUpper - tickSpacing, 1);
      swapExact0For1(expandTo18Decimals(1), wallet);
      pool.burn(tickLower, tickUpper, 1);
      checkTickIsNotClear(tickLower);
      checkTickIsClear(tickUpper);
    });
  });

  describe("#observe", () => {
    beforeEach(() => initializeAtZeroTick(pool));

    // zero tick
    it("current tick accumulator increases by tick over time", () => {
      let {
        tickCumulatives: [tickCumulative],
      } = pool.observe([0]);
      expect(tickCumulative).toEqual(0n);
      pool.advanceTime(10);
      ({
        tickCumulatives: [tickCumulative],
      } = pool.observe([0]));
      expect(tickCumulative).toEqual(0n);
    });

    it("current tick accumulator after single swap", () => {
      // moves to tick -1
      swapExact0For1(1000, wallet);
      pool.advanceTime(4);
      const {
        tickCumulatives: [tickCumulative],
      } = pool.observe([0]);
      expect(tickCumulative).toEqual(-4n);
    });

    it("current tick accumulator after two swaps", () => {
      swapExact0For1(expandTo18Decimals(1) / 2n, wallet);
      expect(pool.slot0().tick).toEqual(-4452);
      pool.advanceTime(4);
      swapExact1For0(expandTo18Decimals(1) / 4n, wallet);
      expect(pool.slot0().tick).toEqual(-1558);
      pool.advanceTime(6);
      const {
        tickCumulatives: [tickCumulative],
      } = pool.observe([0]);
      // -4452*4 + -1558*6
      expect(tickCumulative).toEqual(-27156n);
    });
  });

  describe("miscellaneous mint tests", () => {
    beforeEach(() => {
      pool = createPool(FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW]);
      initializeAtZeroTick(pool);
    });

    it("mint to the right of the current price", () => {
      const liquidityDelta = 1000;
      const lowerTick = tickSpacing;
      const upperTick = tickSpacing * 2;

      const liquidityBefore = pool.liquidity();

      const b0 = balance(token0, pool.address);
      const b1 = balance(token1, pool.address);

      mint(wallet, lowerTick, upperTick, liquidityDelta);

      const liquidityAfter = pool.liquidity();
      expect(liquidityAfter >= liquidityBefore).toBe(true);

      expect(balance(token0, pool.address) - b0).toEqual(1n);
      expect(balance(token1, pool.address) - b1).toEqual(0n);
    });

    it("mint to the left of the current price", () => {
      const liquidityDelta = 1000;
      const lowerTick = -tickSpacing * 2;
      const upperTick = -tickSpacing;

      const liquidityBefore = pool.liquidity();

      const b0 = balance(token0, pool.address);
      const b1 = balance(token1, pool.address);

      mint(wallet, lowerTick, upperTick, liquidityDelta);

      const liquidityAfter = pool.liquidity();
      expect(liquidityAfter >= liquidityBefore).toBe(true);

      expect(balance(token0, pool.address) - b0).toEqual(0n);
      expect(balance(token1, pool.address) - b1).toEqual(1n);
    });

    it("mint within the current price", () => {
      const liquidityDelta = 1000;
      const lowerTick = -tickSpacing;
      const upperTick = tickSpacing;

      const liquidityBefore = pool.liquidity();

      const b0 = balance(token0, pool.address);
      const b1 = balance(token1, pool.address);

      mint(wallet, lowerTick, upperTick, liquidityDelta);

      const liquidityAfter = pool.liquidity();
      expect(liquidityAfter >= liquidityBefore).toBe(true);

      expect(balance(token0, pool.address) - b0).toEqual(1n);
      expect(balance(token1, pool.address) - b1).toEqual(1n);
    });

    it("cannot remove more than the entire position", () => {
      const lowerTick = -tickSpacing;
      const upperTick = tickSpacing;
      mint(wallet, lowerTick, upperTick, expandTo18Decimals(1000));
      expectRevert(() => pool.burn(lowerTick, upperTick, expandTo18Decimals(1001)), "KOINDX: LIQUIDITY_SUB");
    });

    it("collect fees within the current price after swap", () => {
      const liquidityDelta = expandTo18Decimals(100);
      const lowerTick = -tickSpacing * 100;
      const upperTick = tickSpacing * 100;

      mint(wallet, lowerTick, upperTick, liquidityDelta);

      const liquidityBefore = pool.liquidity();

      const amount0In = expandTo18Decimals(1);
      swapExact0For1(amount0In, wallet);

      const liquidityAfter = pool.liquidity();
      expect(liquidityAfter >= liquidityBefore).toBe(true); // k increases

      const token0BalanceBeforePool = balance(token0, pool.address);
      const token1BalanceBeforePool = balance(token1, pool.address);
      const token0BalanceBeforeWallet = balance(token0, wallet);
      const token1BalanceBeforeWallet = balance(token1, wallet);

      pool.burn(lowerTick, upperTick, 0);
      pool.collect(wallet, lowerTick, upperTick, MaxUint64, MaxUint64);

      pool.burn(lowerTick, upperTick, 0);
      const { amount0: fees0, amount1: fees1 } = pool.collectStatic(wallet, lowerTick, upperTick, MaxUint64, MaxUint64);
      expect(fees0).toEqual(0n);
      expect(fees1).toEqual(0n);

      const token0BalanceAfterWallet = balance(token0, wallet);
      const token1BalanceAfterWallet = balance(token1, wallet);
      const token0BalanceAfterPool = balance(token0, pool.address);
      const token1BalanceAfterPool = balance(token1, pool.address);

      expect(token0BalanceAfterWallet > token0BalanceBeforeWallet).toBe(true);
      expect(token1BalanceAfterWallet).toEqual(token1BalanceBeforeWallet);

      expect(token0BalanceAfterPool < token0BalanceBeforePool).toBe(true);
      expect(token1BalanceAfterPool).toEqual(token1BalanceBeforePool);
    });
  });

  describe("post-initialize at medium fee", () => {
    describe("k (implicit)", () => {
      it("returns 0 before initialization", () => {
        expect(pool.liquidity()).toEqual(0n);
      });
      describe("post initialized", () => {
        beforeEach(() => initializeAtZeroTick(pool));

        it("returns initial liquidity", () => {
          expect(pool.liquidity()).toEqual(expandTo18Decimals(2));
        });
        it("returns in supply in range", () => {
          mint(wallet, -tickSpacing, tickSpacing, expandTo18Decimals(3));
          expect(pool.liquidity()).toEqual(expandTo18Decimals(5));
        });
        it("excludes supply at tick above current tick", () => {
          mint(wallet, tickSpacing, tickSpacing * 2, expandTo18Decimals(3));
          expect(pool.liquidity()).toEqual(expandTo18Decimals(2));
        });
        it("excludes supply at tick below current tick", () => {
          mint(wallet, -tickSpacing * 2, -tickSpacing, expandTo18Decimals(3));
          expect(pool.liquidity()).toEqual(expandTo18Decimals(2));
        });
        it("updates correctly when exiting range", () => {
          const kBefore = pool.liquidity();
          expect(kBefore).toEqual(expandTo18Decimals(2));

          // add liquidity at and above current tick
          const liquidityDelta = expandTo18Decimals(1);
          const lowerTick = 0;
          const upperTick = tickSpacing;
          mint(wallet, lowerTick, upperTick, liquidityDelta);

          // ensure virtual supply has increased appropriately
          const kAfter = pool.liquidity();
          expect(kAfter).toEqual(expandTo18Decimals(3));

          // swap toward the left (just enough for the tick transition function to trigger)
          swapExact0For1(1, wallet);
          const { tick } = pool.slot0();
          expect(tick).toEqual(-1);

          const kAfterSwap = pool.liquidity();
          expect(kAfterSwap).toEqual(expandTo18Decimals(2));
        });
        it("updates correctly when entering range", () => {
          const kBefore = pool.liquidity();
          expect(kBefore).toEqual(expandTo18Decimals(2));

          // add liquidity below the current tick
          const liquidityDelta = expandTo18Decimals(1);
          const lowerTick = -tickSpacing;
          const upperTick = 0;
          mint(wallet, lowerTick, upperTick, liquidityDelta);

          // ensure virtual supply hasn't changed
          const kAfter = pool.liquidity();
          expect(kAfter).toEqual(kBefore);

          // swap toward the left (just enough for the tick transition function to trigger)
          swapExact0For1(1, wallet);
          const { tick } = pool.slot0();
          expect(tick).toEqual(-1);

          const kAfterSwap = pool.liquidity();
          expect(kAfterSwap).toEqual(expandTo18Decimals(3));
        });
      });
    });
  });

  describe("limit orders", () => {
    beforeEach(() => initializeAtZeroTick(pool));

    const burnEvent = (owner, tickLower, tickUpper, amount, amount0, amount1) => ({
      owner: owner.address,
      tickLower,
      tickUpper,
      amount: amount.toString(),
      amount0: amount0.toString(),
      amount1: amount1.toString(),
    });

    function limitSelling0For1(fees1) {
      let res = mint(wallet, 0, 120, expandTo18Decimals(1));
      expect(transfers(res.events, token0)).toEqual([{ from: wallet.address, to: pool.address, value: 5981737760509663n }]);
      // somebody takes the limit order
      swapExact1For0(expandTo18Decimals(2), other);
      res = pool.burn(0, 120, expandTo18Decimals(1));
      expect(poolEvents(res, "pool.burn_event")).toEqual([burnEvent(wallet, 0, 120, expandTo18Decimals(1), 0, "6017734268818165")]);
      expect(transfers(res.events, token0)).toEqual([]);
      expect(transfers(res.events, token1)).toEqual([]);
      res = pool.collect(wallet, 0, 120, MaxUint64, MaxUint64);
      expect(transfers(res.events, token1)).toEqual([{ from: pool.address, to: wallet.address, value: 6017734268818165n + fees1 }]);
      expect(transfers(res.events, token0)).toEqual([]);
      expect(pool.slot0().tick >= 120).toBe(true);
    }

    function limitSelling1For0(fees0) {
      let res = mint(wallet, -120, 0, expandTo18Decimals(1));
      expect(transfers(res.events, token1)).toEqual([{ from: wallet.address, to: pool.address, value: 5981737760509663n }]);
      // somebody takes the limit order
      swapExact0For1(expandTo18Decimals(2), other);
      res = pool.burn(-120, 0, expandTo18Decimals(1));
      expect(poolEvents(res, "pool.burn_event")).toEqual([burnEvent(wallet, -120, 0, expandTo18Decimals(1), "6017734268818165", 0)]);
      expect(transfers(res.events, token0)).toEqual([]);
      expect(transfers(res.events, token1)).toEqual([]);
      res = pool.collect(wallet, -120, 0, MaxUint64, MaxUint64);
      expect(transfers(res.events, token0)).toEqual([{ from: pool.address, to: wallet.address, value: 6017734268818165n + fees0 }]);
      expect(pool.slot0().tick < -120).toBe(true);
    }

    it("limit selling 0 for 1 at tick 0 thru 1", () => {
      limitSelling0For1(18107525382602n); // roughly 0.3% despite other liquidity
    });
    it("limit selling 1 for 0 at tick 0 thru -1", () => {
      limitSelling1For0(18107525382602n); // roughly 0.3% despite other liquidity
    });

    describe("fee is on", () => {
      beforeEach(() => pool.setFeeProtocol(6, 6));
      it("limit selling 0 for 1 at tick 0 thru 1", () => {
        limitSelling0For1(15089604485501n); // roughly 0.25% despite other liquidity
      });
      it("limit selling 1 for 0 at tick 0 thru -1", () => {
        limitSelling1For0(15089604485501n); // roughly 0.25% despite other liquidity
      });
    });
  });

  describe("#collect", () => {
    beforeEach(() => {
      pool = createPool(FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW]);
      pool.initialize(encodePriceSqrt(1, 1));
    });

    it("works with multiple LPs", () => {
      mint(wallet, minTick, maxTick, expandTo18Decimals(1));
      mint(wallet, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(2));

      swapExact0For1(expandTo18Decimals(1), wallet);

      // poke positions
      pool.burn(minTick, maxTick, 0);
      pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 0);

      const { tokensOwed0: tokensOwed0Position0 } = pool.positions(wallet, minTick, maxTick);
      const { tokensOwed0: tokensOwed0Position1 } = pool.positions(wallet, minTick + tickSpacing, maxTick - tickSpacing);

      expect(tokensOwed0Position0).toEqual(166666666666667n);
      expect(tokensOwed0Position1).toEqual(333333333333334n);
    });

    describe("works across large increases", () => {
      beforeEach(() => {
        mint(wallet, minTick, maxTick, expandTo18Decimals(1));
      });

      // type(uint128).max * 2**128 / 1e18
      // https://www.wolframalpha.com/input/?i=%282**128+-+1%29+*+2**128+%2F+1e18
      const magicNumber = 115792089237316195423570985008687907852929702298719625575994n;

      it("works just before the cap binds", () => {
        pool.setFeeGrowthGlobal0X128(magicNumber);
        pool.burn(minTick, maxTick, 0);

        const { tokensOwed0, tokensOwed1 } = pool.positions(wallet, minTick, maxTick);

        expect(tokensOwed0).toEqual(MaxUint128 - 1n);
        expect(tokensOwed1).toEqual(0n);
      });

      it("works just after the cap binds", () => {
        pool.setFeeGrowthGlobal0X128(magicNumber + 1n);
        pool.burn(minTick, maxTick, 0);

        const { tokensOwed0, tokensOwed1 } = pool.positions(wallet, minTick, maxTick);

        expect(tokensOwed0).toEqual(MaxUint128);
        expect(tokensOwed1).toEqual(0n);
      });

      it("works well after the cap binds", () => {
        pool.setFeeGrowthGlobal0X128(MaxUint256);
        pool.burn(minTick, maxTick, 0);

        const { tokensOwed0, tokensOwed1 } = pool.positions(wallet, minTick, maxTick);

        expect(tokensOwed0).toEqual(MaxUint128);
        expect(tokensOwed1).toEqual(0n);
      });
    });

    describe("works across overflow boundaries", () => {
      beforeEach(() => {
        pool.setFeeGrowthGlobal0X128(MaxUint256);
        pool.setFeeGrowthGlobal1X128(MaxUint256);
        mint(wallet, minTick, maxTick, expandTo18Decimals(10));
      });

      it("token0", () => {
        swapExact0For1(expandTo18Decimals(1), wallet);
        pool.burn(minTick, maxTick, 0);
        const { amount0, amount1 } = pool.collectStatic(wallet, minTick, maxTick, MaxUint64, MaxUint64);
        expect(amount0).toEqual(499999999999999n);
        expect(amount1).toEqual(0n);
      });
      it("token1", () => {
        swapExact1For0(expandTo18Decimals(1), wallet);
        pool.burn(minTick, maxTick, 0);
        const { amount0, amount1 } = pool.collectStatic(wallet, minTick, maxTick, MaxUint64, MaxUint64);
        expect(amount0).toEqual(0n);
        expect(amount1).toEqual(499999999999999n);
      });
      it("token0 and token1", () => {
        swapExact0For1(expandTo18Decimals(1), wallet);
        swapExact1For0(expandTo18Decimals(1), wallet);
        pool.burn(minTick, maxTick, 0);
        const { amount0, amount1 } = pool.collectStatic(wallet, minTick, maxTick, MaxUint64, MaxUint64);
        expect(amount0).toEqual(499999999999999n);
        expect(amount1).toEqual(500000000000000n);
      });
    });
  });

  // Uniswap: 1000e18 of liquidity in the full range, i.e. 1000e18 of each token: more than the
  // supply of a Koinos token (u64), and the rounding of the fees depends on the liquidity. The
  // tests run twice:
  // - with the liquidity of Uniswap on the Uniswap reference (the published bytecode in an EVM,
  //   tests/uniswap/evm) with the expected values of Uniswap: the reference is Uniswap
  // - with 10e18 of liquidity on KoinDX and on the Uniswap reference: every result of KoinDX must
  //   be equal to the result of Uniswap
  for (const { title, liquidityAmount, koindx } of [
    { title: "Uniswap reference, liquidity of Uniswap", liquidityAmount: expandTo18Decimals(1000), koindx: false },
    { title: "KoinDX = Uniswap reference, liquidity of 10e18", liquidityAmount: expandTo18Decimals(10), koindx: true },
  ]) {
    describe(`#feeProtocol (${title})`, () => {
      let uni, upool;

      beforeEach(async () => {
        uni = await UniswapEVM.create();
        upool = await uni.createPool(FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW]);
        await upool.initialize(encodePriceSqrt(1, 1));
        if (koindx) pool = createPool(FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW]);
        else [minTick, maxTick] = [getMinTick(TICK_SPACINGS[FeeAmount.LOW]), getMaxTick(TICK_SPACINGS[FeeAmount.LOW])];
        await both(
          () => {
            pool.initialize(encodePriceSqrt(1, 1));
            mint(wallet, minTick, maxTick, liquidityAmount);
          },
          () => upool.mint(uni.wallet, minTick, maxTick, liquidityAmount)
        );
      });

      /** runs a step on KoinDX and on the Uniswap reference: the results must be equal */
      async function both(onKoinDX, onUniswap) {
        const expected = await onUniswap();
        if (!koindx) return expected;
        const result = onKoinDX();
        if (result !== undefined) expect(result).toEqual(expected);
        return result;
      }
      /** the expected values of Uniswap (for its liquidity) */
      const expectUniswap = (value, expected) => {
        if (!koindx) expect(value).toEqual(expected);
      };
      const values = (list) => list.map((t) => t.value);

      const slot0 = () => both(() => pool.slot0().feeProtocol, async () => (await upool.slot0()).feeProtocol);
      const setFeeProtocol = (feeProtocol0, feeProtocol1) =>
        both(
          () => void pool.setFeeProtocol(feeProtocol0, feeProtocol1),
          async () => void (await upool.setFeeProtocol(feeProtocol0, feeProtocol1))
        );
      const protocolFees = () => both(() => pool.protocolFees(), () => upool.protocolFees());
      const collectProtocol = () =>
        both(
          () => {
            const { events } = pool.collectProtocol(other, MaxUint64, MaxUint64);
            return [values(transfers(events, token0)), values(transfers(events, token1))];
          },
          async () => {
            const { events } = await upool.collectProtocol(uni.other, MaxUint128, MaxUint128);
            return [values(uni.transfers(events, uni.token0)), values(uni.transfers(events, uni.token1))];
          }
        );
      const collect = () =>
        both(
          () => {
            const { events } = pool.collect(wallet, minTick, maxTick, MaxUint64, MaxUint64);
            return [values(transfers(events, token0)), values(transfers(events, token1))];
          },
          async () => {
            const { events } = await upool.collect(uni.wallet, minTick, maxTick, MaxUint128, MaxUint128);
            return [values(uni.transfers(events, uni.token0)), values(uni.transfers(events, uni.token1))];
          }
        );
      const poke = () =>
        both(
          () => void pool.burn(minTick, maxTick, 0),
          async () => void (await upool.burn(minTick, maxTick, 0))
        );

      it("is initially set to 0", async () => {
        expect(await slot0()).toEqual(0);
      });

      it("can be changed by the owner", async () => {
        await setFeeProtocol(6, 6);
        expect(await slot0()).toEqual(102);
      });

      it("cannot be changed out of bounds", async () => {
        await expect(upool.setFeeProtocol(3, 3)).rejects.toThrow();
        await expect(upool.setFeeProtocol(11, 11)).rejects.toThrow();
        if (koindx) {
          expectRevert(() => pool.setFeeProtocol(3, 3), "KOINDX: INVALID_FEE_PROTOCOL");
          expectRevert(() => pool.setFeeProtocol(11, 11), "KOINDX: INVALID_FEE_PROTOCOL");
        }
      });

      it("cannot be changed by addresses that are not owner", async () => {
        await expect(upool.setFeeProtocol(6, 6, uni.other)).rejects.toThrow();
        if (koindx) expectRevert(() => pool.setFeeProtocol(6, 6, other), "KOINDX: FORBIDDEN");
      });

      async function swapAndGetFeesOwed({ amount, zeroForOne, poke }) {
        const { amount0: fees0, amount1: fees1 } = await both(
          () => {
            if (zeroForOne) swapExact0For1(amount, wallet);
            else swapExact1For0(amount, wallet);
            if (poke) pool.burn(minTick, maxTick, 0);
            return pool.collectStatic(wallet, minTick, maxTick, MaxUint64, MaxUint64);
          },
          async () => {
            if (zeroForOne) await upool.swapExact0For1(amount, uni.wallet);
            else await upool.swapExact1For0(amount, uni.wallet);
            if (poke) await upool.burn(minTick, maxTick, 0);
            return upool.collectStatic(uni.wallet, minTick, maxTick, MaxUint128, MaxUint128);
          }
        );

        expect(fees0 >= 0n).toBe(true);
        expect(fees1 >= 0n).toBe(true);

        return { token0Fees: fees0, token1Fees: fees1 };
      }

      it("position owner gets full fees when protocol fee is off", async () => {
        const { token0Fees, token1Fees } = await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: true, poke: true });

        // 6 bips * 1e18
        expectUniswap(token0Fees, 499999999999999n);
        expect(token1Fees).toEqual(0n);
      });

      it("swap fees accumulate as expected (0 for 1)", async () => {
        let token0Fees, token1Fees;
        ({ token0Fees, token1Fees } = await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: true, poke: true }));
        expectUniswap(token0Fees, 499999999999999n);
        expect(token1Fees).toEqual(0n);
        ({ token0Fees, token1Fees } = await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: true, poke: true }));
        expectUniswap(token0Fees, 999999999999998n);
        expect(token1Fees).toEqual(0n);
        ({ token0Fees, token1Fees } = await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: true, poke: true }));
        expectUniswap(token0Fees, 1499999999999997n);
        expect(token1Fees).toEqual(0n);
      });

      it("swap fees accumulate as expected (1 for 0)", async () => {
        let token0Fees, token1Fees;
        ({ token0Fees, token1Fees } = await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: false, poke: true }));
        expect(token0Fees).toEqual(0n);
        expectUniswap(token1Fees, 499999999999999n);
        ({ token0Fees, token1Fees } = await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: false, poke: true }));
        expect(token0Fees).toEqual(0n);
        expectUniswap(token1Fees, 999999999999998n);
        ({ token0Fees, token1Fees } = await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: false, poke: true }));
        expect(token0Fees).toEqual(0n);
        expectUniswap(token1Fees, 1499999999999997n);
      });

      it("position owner gets partial fees when protocol fee is on", async () => {
        await setFeeProtocol(6, 6);

        const { token0Fees, token1Fees } = await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: true, poke: true });

        expectUniswap(token0Fees, 416666666666666n);
        expect(token1Fees).toEqual(0n);
      });

      describe("#collectProtocol", () => {
        it("returns 0 if no fees", async () => {
          await setFeeProtocol(6, 6);
          const { amount0, amount1 } = await both(
            () => pool.collectProtocolStatic(wallet, MaxUint64, MaxUint64),
            () => upool.collectProtocolStatic(uni.wallet, MaxUint128, MaxUint128)
          );
          expect(amount0).toEqual(0n);
          expect(amount1).toEqual(0n);
        });

        it("can collect fees", async () => {
          await setFeeProtocol(6, 6);

          await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: true, poke: true });

          const [transfers0] = await collectProtocol();
          expectUniswap(transfers0, [83333333333332n]);
        });

        it("fees collected can differ between token0 and token1", async () => {
          await setFeeProtocol(8, 5);

          await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: true, poke: false });
          await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: false, poke: false });

          const [transfers0, transfers1] = await collectProtocol();
          // more token0 fees because it's 1/5th the swap fees
          expectUniswap(transfers0, [62499999999999n]);
          // less token1 fees because it's 1/8th the swap fees
          expectUniswap(transfers1, [99999999999998n]);
        });
      });

      it("fees collected by lp after two swaps should be double one swap", async () => {
        await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: true, poke: true });
        const { token0Fees, token1Fees } = await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: true, poke: true });

        // 6 bips * 2e18
        expectUniswap(token0Fees, 999999999999998n);
        expect(token1Fees).toEqual(0n);
      });

      it("fees collected after two swaps with fee turned on in middle are fees from last swap (not confiscatory)", async () => {
        await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: true, poke: false });

        await setFeeProtocol(6, 6);

        const { token0Fees, token1Fees } = await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: true, poke: true });

        expectUniswap(token0Fees, 916666666666666n);
        expect(token1Fees).toEqual(0n);
      });

      it("fees collected by lp after two swaps with intermediate withdrawal", async () => {
        await setFeeProtocol(6, 6);

        const { token0Fees, token1Fees } = await swapAndGetFeesOwed({ amount: expandTo18Decimals(1), zeroForOne: true, poke: true });

        expectUniswap(token0Fees, 416666666666666n);
        expect(token1Fees).toEqual(0n);

        // collect the fees
        await collect();

        const { token0Fees: token0FeesNext, token1Fees: token1FeesNext } = await swapAndGetFeesOwed({
          amount: expandTo18Decimals(1),
          zeroForOne: true,
          poke: false,
        });

        expect(token0FeesNext).toEqual(0n);
        expect(token1FeesNext).toEqual(0n);

        let { token0: token0ProtocolFees, token1: token1ProtocolFees } = await protocolFees();
        expectUniswap(token0ProtocolFees, 166666666666666n);
        expect(token1ProtocolFees).toEqual(0n);

        await poke(); // poke to update fees
        const [transfers0] = await collect();
        expectUniswap(transfers0, [416666666666666n]);
        ({ token0: token0ProtocolFees, token1: token1ProtocolFees } = await protocolFees());
        expectUniswap(token0ProtocolFees, 166666666666666n);
        expect(token1ProtocolFees).toEqual(0n);
      });
    });
  }

  describe("#tickSpacing", () => {
    describe("tickSpacing = 12", () => {
      beforeEach(() => {
        pool = createPool(FeeAmount.MEDIUM, 12);
      });
      describe("post initialize", () => {
        beforeEach(() => {
          pool.initialize(encodePriceSqrt(1, 1));
        });
        it("mint can only be called for multiples of 12", () => {
          expectRevert(() => mint(wallet, -6, 0, 1), "KOINDX: TICK_NOT_SPACED");
          expectRevert(() => mint(wallet, 0, 6, 1), "KOINDX: TICK_NOT_SPACED");
        });
        it("mint can be called with multiples of 12", () => {
          mint(wallet, 12, 24, 1);
          mint(wallet, -144, -120, 1);
        });
        it("swapping across gaps works in 1 for 0 direction", () => {
          const liquidityAmount = expandTo18Decimals(1) / 4n;
          mint(wallet, 120000, 121200, liquidityAmount);
          swapExact1For0(expandTo18Decimals(1), wallet);
          const res = pool.burn(120000, 121200, liquidityAmount);
          expect(poolEvents(res, "pool.burn_event")).toEqual([
            {
              owner: wallet.address,
              tickLower: 120000,
              tickUpper: 121200,
              amount: liquidityAmount.toString(),
              amount0: "30027458295511",
              amount1: "996999999999999999",
            },
          ]);
          expect(transfers(res.events, token0)).toEqual([]);
          expect(transfers(res.events, token1)).toEqual([]);
          expect(pool.slot0().tick).toEqual(120196);
        });
        it("swapping across gaps works in 0 for 1 direction", () => {
          const liquidityAmount = expandTo18Decimals(1) / 4n;
          mint(wallet, -121200, -120000, liquidityAmount);
          swapExact0For1(expandTo18Decimals(1), wallet);
          const res = pool.burn(-121200, -120000, liquidityAmount);
          expect(poolEvents(res, "pool.burn_event")).toEqual([
            {
              owner: wallet.address,
              tickLower: -121200,
              tickUpper: -120000,
              amount: liquidityAmount.toString(),
              amount0: "996999999999999999",
              amount1: "30027458295511",
            },
          ]);
          expect(transfers(res.events, token0)).toEqual([]);
          expect(transfers(res.events, token1)).toEqual([]);
          expect(pool.slot0().tick).toEqual(-120197);
        });
      });
    });
  });

  // https://github.com/Uniswap/uniswap-v3-core/issues/214
  it("tick transition cannot run twice if zero for one swap ends at fractional price just below tick", () => {
    pool = createPool(FeeAmount.MEDIUM, 1);
    const p0 = BigInt(harness.callString("getSqrtRatioAtTick", -24081)) + 1n;
    // initialize at a price of ~0.3 token1/token0
    // meaning if you swap in 2 token0, you should end up getting 0 token1
    pool.initialize(p0);
    expect(pool.liquidity()).toEqual(0n); // current pool liquidity is 1
    expect(pool.slot0().tick).toEqual(-24081); // pool tick is -24081

    // add a bunch of liquidity around current price
    const liquidity = expandTo18Decimals(1000);
    mint(wallet, -24082, -24080, liquidity);
    expect(pool.liquidity()).toEqual(liquidity); // current pool liquidity is now liquidity + 1

    mint(wallet, -24082, -24081, liquidity);
    expect(pool.liquidity()).toEqual(liquidity); // current pool liquidity is still liquidity + 1

    // check the math works out to moving the price down 1, sending no amount out, and having some amount remaining
    {
      const [sqrtQ, amountIn, amountOut, feeAmount] = harness
        .callString("computeSwapStep", p0.toString(), (p0 - 1n).toString(), liquidity.toString(), "3", FeeAmount.MEDIUM)
        .split(",")
        .map(BigInt);
      expect(sqrtQ).toEqual(p0 - 1n); // price moves
      expect(feeAmount).toEqual(1n); // fee amount is 1
      expect(amountIn).toEqual(1n); // amount in is 1
      expect(amountOut).toEqual(0n); // zero amount out
    }

    // swap 2 amount in, should get 0 amount out
    const { events } = swapExact0For1(3, wallet);
    expect(transfers(events, token0)).toEqual([{ from: wallet.address, to: pool.address, value: 3n }]);
    expect(transfers(events, token1)).toEqual([]);

    const { tick, sqrtPriceX96 } = pool.slot0();

    expect(tick).toEqual(-24082); // pool is at the next tick
    expect(sqrtPriceX96).toEqual(p0 - 1n); // pool price is still on the p0 boundary
    expect(pool.liquidity()).toEqual(liquidity * 2n); // pool has run tick transition and liquidity changed
  });

  describe("#flash", () => {
    it("fails if not initialized", () => {
      expectRevert(() => flash(100, 200, other), "KOINDX: LOCKED");
      expectRevert(() => flash(100, 0, other), "KOINDX: LOCKED");
      expectRevert(() => flash(0, 200, other), "KOINDX: LOCKED");
    });
    it("fails if no liquidity", () => {
      pool.initialize(encodePriceSqrt(1, 1));
      expectRevert(() => flash(100, 200, other), "KOINDX: L");
      expectRevert(() => flash(100, 0, other), "KOINDX: L");
      expectRevert(() => flash(0, 200, other), "KOINDX: L");
    });
    describe("after liquidity added", () => {
      let balance0;
      let balance1;
      beforeEach(() => {
        initializeAtZeroTick(pool);
        [balance0, balance1] = [balance(token0, pool.address), balance(token1, pool.address)];
      });

      const flashEvent = (amount0, amount1, paid0, paid1) => ({
        sender: swapTarget.address,
        recipient: other.address,
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        paid0: paid0.toString(),
        paid1: paid1.toString(),
      });

      describe("fee off", () => {
        it("emits an event", () => {
          expect(poolEvents(flash(1001, 2001, other), "pool.flash_event")).toEqual([flashEvent(1001, 2001, 4, 7)]);
        });

        it("transfers the amount0 to the recipient", () => {
          const { events } = flash(100, 200, other);
          expect(transfers(events, token0)[0]).toEqual({ from: pool.address, to: other.address, value: 100n });
        });
        it("transfers the amount1 to the recipient", () => {
          const { events } = flash(100, 200, other);
          expect(transfers(events, token1)[0]).toEqual({ from: pool.address, to: other.address, value: 200n });
        });
        it("can flash only token0", () => {
          const { events } = flash(101, 0, other);
          expect(transfers(events, token0)[0]).toEqual({ from: pool.address, to: other.address, value: 101n });
          expect(transfers(events, token1)).toEqual([]);
        });
        it("can flash only token1", () => {
          const { events } = flash(0, 102, other);
          expect(transfers(events, token1)[0]).toEqual({ from: pool.address, to: other.address, value: 102n });
          expect(transfers(events, token0)).toEqual([]);
        });
        it("can flash entire token balance", () => {
          const { events } = flash(balance0, balance1, other);
          expect(transfers(events, token0)[0]).toEqual({ from: pool.address, to: other.address, value: balance0 });
          expect(transfers(events, token1)[0]).toEqual({ from: pool.address, to: other.address, value: balance1 });
        });
        it("no-op if both amounts are 0", () => {
          const { events } = flash(0, 0, other);
          expect(transfers(events, token0)).toEqual([]);
          expect(transfers(events, token1)).toEqual([]);
        });
        it("fails if flash amount is greater than token balance", () => {
          expectRevert(() => flash(balance0 + 1n, balance1, other), "insufficient balance");
          expectRevert(() => flash(balance0, balance1 + 1n, other), "insufficient balance");
        });
        it("calls the flash callback on the sender with correct fee amounts", () => {
          const { events } = flash(1001, 2002, other);
          expect(testEvents(events, "FlashCallback")).toEqual([{ fee0: "4", fee1: "7" }]);
        });
        it("increases the fee growth by the expected amount", () => {
          flash(1001, 2002, other);
          expect(pool.feeGrowthGlobal0X128()).toEqual((4n << 128n) / expandTo18Decimals(2));
          expect(pool.feeGrowthGlobal1X128()).toEqual((7n << 128n) / expandTo18Decimals(2));
        });
        it("fails if original balance not returned in either token", () => {
          expectRevert(() => flash(1000, 0, other, 999, 0), "KOINDX: F0");
          expectRevert(() => flash(0, 1000, other, 0, 999), "KOINDX: F1");
        });
        it("fails if underpays either token", () => {
          expectRevert(() => flash(1000, 0, other, 1002, 0), "KOINDX: F0");
          expectRevert(() => flash(0, 1000, other, 0, 1002), "KOINDX: F1");
        });
        it("allows donating token0", () => {
          const { events } = flash(0, 0, other, 567, 0);
          expect(transfers(events, token0)).toEqual([{ from: wallet.address, to: pool.address, value: 567n }]);
          expect(transfers(events, token1)).toEqual([]);
          expect(pool.feeGrowthGlobal0X128()).toEqual((567n << 128n) / expandTo18Decimals(2));
        });
        it("allows donating token1", () => {
          const { events } = flash(0, 0, other, 0, 678);
          expect(transfers(events, token1)).toEqual([{ from: wallet.address, to: pool.address, value: 678n }]);
          expect(transfers(events, token0)).toEqual([]);
          expect(pool.feeGrowthGlobal1X128()).toEqual((678n << 128n) / expandTo18Decimals(2));
        });
        it("allows donating token0 and token1 together", () => {
          const { events } = flash(0, 0, other, 789, 1234);
          expect(transfers(events, token0)).toEqual([{ from: wallet.address, to: pool.address, value: 789n }]);
          expect(transfers(events, token1)).toEqual([{ from: wallet.address, to: pool.address, value: 1234n }]);

          expect(pool.feeGrowthGlobal0X128()).toEqual((789n << 128n) / expandTo18Decimals(2));
          expect(pool.feeGrowthGlobal1X128()).toEqual((1234n << 128n) / expandTo18Decimals(2));
        });
      });

      describe("fee on", () => {
        beforeEach(() => {
          pool.setFeeProtocol(6, 6);
        });

        it("emits an event", () => {
          expect(poolEvents(flash(1001, 2001, other), "pool.flash_event")).toEqual([flashEvent(1001, 2001, 4, 7)]);
        });

        it("increases the fee growth by the expected amount", () => {
          flash(2002, 4004, other);

          const { token0: token0ProtocolFees, token1: token1ProtocolFees } = pool.protocolFees();
          expect(token0ProtocolFees).toEqual(1n);
          expect(token1ProtocolFees).toEqual(2n);

          expect(pool.feeGrowthGlobal0X128()).toEqual((6n << 128n) / expandTo18Decimals(2));
          expect(pool.feeGrowthGlobal1X128()).toEqual((11n << 128n) / expandTo18Decimals(2));
        });
        it("allows donating token0", () => {
          const { events } = flash(0, 0, other, 567, 0);
          expect(transfers(events, token0)).toEqual([{ from: wallet.address, to: pool.address, value: 567n }]);
          expect(transfers(events, token1)).toEqual([]);

          expect(pool.protocolFees().token0).toEqual(94n);
          expect(pool.feeGrowthGlobal0X128()).toEqual((473n << 128n) / expandTo18Decimals(2));
        });
        it("allows donating token1", () => {
          const { events } = flash(0, 0, other, 0, 678);
          expect(transfers(events, token1)).toEqual([{ from: wallet.address, to: pool.address, value: 678n }]);
          expect(transfers(events, token0)).toEqual([]);

          expect(pool.protocolFees().token1).toEqual(113n);
          expect(pool.feeGrowthGlobal1X128()).toEqual((565n << 128n) / expandTo18Decimals(2));
        });
        it("allows donating token0 and token1 together", () => {
          const { events } = flash(0, 0, other, 789, 1234);
          expect(transfers(events, token0)).toEqual([{ from: wallet.address, to: pool.address, value: 789n }]);
          expect(transfers(events, token1)).toEqual([{ from: wallet.address, to: pool.address, value: 1234n }]);

          const { token0: token0ProtocolFees, token1: token1ProtocolFees } = pool.protocolFees();
          expect(token0ProtocolFees).toEqual(131n);
          expect(token1ProtocolFees).toEqual(205n);

          expect(pool.feeGrowthGlobal0X128()).toEqual((658n << 128n) / expandTo18Decimals(2));
          expect(pool.feeGrowthGlobal1X128()).toEqual((1029n << 128n) / expandTo18Decimals(2));
        });
      });
    });
  });

  describe("#increaseObservationCardinalityNext", () => {
    it("cannot be called before initialization", () => {
      expectRevert(() => pool.increaseObservationCardinalityNext(2), "KOINDX: LOCKED");
    });
    describe("after initialization", () => {
      beforeEach(() => pool.initialize(encodePriceSqrt(1, 1)));
      it("oracle starting state after initialization", () => {
        const { observationCardinality, observationIndex, observationCardinalityNext } = pool.slot0();
        expect(observationCardinality).toEqual(1);
        expect(observationIndex).toEqual(0);
        expect(observationCardinalityNext).toEqual(1);
        const { secondsPerLiquidityCumulativeX128, tickCumulative, initialized, blockTimestamp } = pool.observations(0);
        expect(secondsPerLiquidityCumulativeX128).toEqual(0n);
        expect(tickCumulative).toEqual(0n);
        expect(initialized).toEqual(true);
        expect(blockTimestamp).toEqual(TEST_POOL_START_TIME);
      });
      it("increases observation cardinality next", () => {
        pool.increaseObservationCardinalityNext(2);
        const { observationCardinality, observationIndex, observationCardinalityNext } = pool.slot0();
        expect(observationCardinality).toEqual(1);
        expect(observationIndex).toEqual(0);
        expect(observationCardinalityNext).toEqual(2);
      });
      it("is no op if target is already exceeded", () => {
        pool.increaseObservationCardinalityNext(5);
        pool.increaseObservationCardinalityNext(3);
        const { observationCardinality, observationIndex, observationCardinalityNext } = pool.slot0();
        expect(observationCardinality).toEqual(1);
        expect(observationIndex).toEqual(0);
        expect(observationCardinalityNext).toEqual(5);
      });
    });
  });

  describe("#setFeeProtocol", () => {
    beforeEach(() => {
      pool.initialize(encodePriceSqrt(1, 1));
    });

    const setFeeProtocolEvents = (res) => poolEvents(res, "pool.set_fee_protocol_event");

    it("can only be called by factory owner", () => {
      expectRevert(() => pool.setFeeProtocol(5, 5, other), "KOINDX: FORBIDDEN");
    });
    it("fails if fee is lt 4 or gt 10", () => {
      expectRevert(() => pool.setFeeProtocol(3, 3), "KOINDX: INVALID_FEE_PROTOCOL");
      expectRevert(() => pool.setFeeProtocol(6, 3), "KOINDX: INVALID_FEE_PROTOCOL");
      expectRevert(() => pool.setFeeProtocol(3, 6), "KOINDX: INVALID_FEE_PROTOCOL");
      expectRevert(() => pool.setFeeProtocol(11, 11), "KOINDX: INVALID_FEE_PROTOCOL");
      expectRevert(() => pool.setFeeProtocol(6, 11), "KOINDX: INVALID_FEE_PROTOCOL");
      expectRevert(() => pool.setFeeProtocol(11, 6), "KOINDX: INVALID_FEE_PROTOCOL");
    });
    it("succeeds for fee of 4", () => {
      pool.setFeeProtocol(4, 4);
    });
    it("succeeds for fee of 10", () => {
      pool.setFeeProtocol(10, 10);
    });
    it("sets protocol fee", () => {
      pool.setFeeProtocol(7, 7);
      expect(pool.slot0().feeProtocol).toEqual(119);
    });
    it("can change protocol fee", () => {
      pool.setFeeProtocol(7, 7);
      pool.setFeeProtocol(5, 8);
      expect(pool.slot0().feeProtocol).toEqual(133);
    });
    it("can turn off protocol fee", () => {
      pool.setFeeProtocol(4, 4);
      pool.setFeeProtocol(0, 0);
      expect(pool.slot0().feeProtocol).toEqual(0);
    });
    it("emits an event when turned on", () => {
      expect(setFeeProtocolEvents(pool.setFeeProtocol(7, 7))).toEqual([{ feeProtocol0Old: 0, feeProtocol1Old: 0, feeProtocol0New: 7, feeProtocol1New: 7 }]);
    });
    it("emits an event when turned off", () => {
      pool.setFeeProtocol(7, 5);
      expect(setFeeProtocolEvents(pool.setFeeProtocol(0, 0))).toEqual([{ feeProtocol0Old: 7, feeProtocol1Old: 5, feeProtocol0New: 0, feeProtocol1New: 0 }]);
    });
    it("emits an event when changed", () => {
      pool.setFeeProtocol(4, 10);
      expect(setFeeProtocolEvents(pool.setFeeProtocol(6, 8))).toEqual([{ feeProtocol0Old: 4, feeProtocol1Old: 10, feeProtocol0New: 6, feeProtocol1New: 8 }]);
    });
    it("emits an event when unchanged", () => {
      pool.setFeeProtocol(5, 9);
      expect(setFeeProtocolEvents(pool.setFeeProtocol(5, 9))).toEqual([{ feeProtocol0Old: 5, feeProtocol1Old: 9, feeProtocol0New: 5, feeProtocol1New: 9 }]);
    });
  });

  describe("#lock", () => {
    beforeEach(() => {
      pool.initialize(encodePriceSqrt(1, 1));
      mint(wallet, minTick, maxTick, expandTo18Decimals(1));
    });

    // Uniswap: TestUniswapV3ReentrantCallee calls each function from the swap callback and checks
    // that it reverts with LOK. Koinos can't catch a reverted call: one transaction per function
    for (const method of ["swap", "mint", "burn", "flash", "collect", "collect_protocol"]) {
      it(`cannot reenter from swap callback: ${method}`, () => {
        const { address } = vm.account("TestUniswapV3ReentrantCallee");
        vm.deployNative(address, tc.reentrantContract({ codec: pool.codec }));
        expectRevert(
          () =>
            vm.transaction({
              signers: [wallet.address],
              operations: [{ call: { contractId: address, entryPoint: entryPoint("swapToReenter"), args: tc.json({ pool: pool.address, method }) } }],
            }),
          "KOINDX: LOCKED"
        );
      });
    }
  });

  describe("#snapshotCumulativesInside", () => {
    const tickLower = -TICK_SPACINGS[FeeAmount.MEDIUM];
    const tickUpper = TICK_SPACINGS[FeeAmount.MEDIUM];
    const tickSpacing = TICK_SPACINGS[FeeAmount.MEDIUM];
    beforeEach(() => {
      pool.initialize(encodePriceSqrt(1, 1));
      mint(wallet, tickLower, tickUpper, 10);
    });
    it("throws if ticks are in reverse order", () => {
      expectRevert(() => pool.snapshotCumulativesInside(tickUpper, tickLower), "KOINDX: TLU");
    });
    it("throws if ticks are the same", () => {
      expectRevert(() => pool.snapshotCumulativesInside(tickUpper, tickUpper), "KOINDX: TLU");
    });
    it("throws if tick lower is too low", () => {
      expectRevert(() => pool.snapshotCumulativesInside(getMinTick(tickSpacing) - 1, tickUpper));
    });
    it("throws if tick upper is too high", () => {
      expectRevert(() => pool.snapshotCumulativesInside(tickLower, getMaxTick(tickSpacing) + 1));
    });
    it("throws if tick lower is not initialized", () => {
      expectRevert(() => pool.snapshotCumulativesInside(tickLower - tickSpacing, tickUpper), "KOINDX: TICK_NOT_INITIALIZED");
    });
    it("throws if tick upper is not initialized", () => {
      expectRevert(() => pool.snapshotCumulativesInside(tickLower, tickUpper + tickSpacing), "KOINDX: TICK_NOT_INITIALIZED");
    });
    it("is zero immediately after initialize", () => {
      const { secondsPerLiquidityInsideX128, tickCumulativeInside, secondsInside } = pool.snapshotCumulativesInside(tickLower, tickUpper);
      expect(secondsPerLiquidityInsideX128).toEqual(0n);
      expect(tickCumulativeInside).toEqual(0n);
      expect(secondsInside).toEqual(0);
    });
    it("increases by expected amount when time elapses in the range", () => {
      pool.advanceTime(5);
      const { secondsPerLiquidityInsideX128, tickCumulativeInside, secondsInside } = pool.snapshotCumulativesInside(tickLower, tickUpper);
      expect(secondsPerLiquidityInsideX128).toEqual((5n << 128n) / 10n);
      expect(tickCumulativeInside).toEqual(0n);
      expect(secondsInside).toEqual(5);
    });
    it("does not account for time increase above range", () => {
      pool.advanceTime(5);
      swapToHigherPrice(encodePriceSqrt(2, 1), wallet);
      pool.advanceTime(7);
      const { secondsPerLiquidityInsideX128, tickCumulativeInside, secondsInside } = pool.snapshotCumulativesInside(tickLower, tickUpper);
      expect(secondsPerLiquidityInsideX128).toEqual((5n << 128n) / 10n);
      expect(tickCumulativeInside).toEqual(0n);
      expect(secondsInside).toEqual(5);
    });
    it("does not account for time increase below range", () => {
      pool.advanceTime(5);
      swapToLowerPrice(encodePriceSqrt(1, 2), wallet);
      pool.advanceTime(7);
      const { secondsPerLiquidityInsideX128, tickCumulativeInside, secondsInside } = pool.snapshotCumulativesInside(tickLower, tickUpper);
      expect(secondsPerLiquidityInsideX128).toEqual((5n << 128n) / 10n);
      // tick is 0 for 5 seconds, then not in range
      expect(tickCumulativeInside).toEqual(0n);
      expect(secondsInside).toEqual(5);
    });
    it("time increase below range is not counted", () => {
      swapToLowerPrice(encodePriceSqrt(1, 2), wallet);
      pool.advanceTime(5);
      swapToHigherPrice(encodePriceSqrt(1, 1), wallet);
      pool.advanceTime(7);
      const { secondsPerLiquidityInsideX128, tickCumulativeInside, secondsInside } = pool.snapshotCumulativesInside(tickLower, tickUpper);
      expect(secondsPerLiquidityInsideX128).toEqual((7n << 128n) / 10n);
      // tick is not in range then tick is 0 for 7 seconds
      expect(tickCumulativeInside).toEqual(0n);
      expect(secondsInside).toEqual(7);
    });
    it("time increase above range is not counted", () => {
      swapToHigherPrice(encodePriceSqrt(2, 1), wallet);
      pool.advanceTime(5);
      swapToLowerPrice(encodePriceSqrt(1, 1), wallet);
      pool.advanceTime(7);
      const { secondsPerLiquidityInsideX128, tickCumulativeInside, secondsInside } = pool.snapshotCumulativesInside(tickLower, tickUpper);
      expect(secondsPerLiquidityInsideX128).toEqual((7n << 128n) / 10n);
      expect(pool.slot0().tick).toEqual(-1); // justify the -7 tick cumulative inside value
      expect(tickCumulativeInside).toEqual(-7n);
      expect(secondsInside).toEqual(7);
    });
    it("positions minted after time spent", () => {
      pool.advanceTime(5);
      mint(wallet, tickUpper, getMaxTick(tickSpacing), 15);
      swapToHigherPrice(encodePriceSqrt(2, 1), wallet);
      pool.advanceTime(8);
      const { secondsPerLiquidityInsideX128, tickCumulativeInside, secondsInside } = pool.snapshotCumulativesInside(tickUpper, getMaxTick(tickSpacing));
      expect(secondsPerLiquidityInsideX128).toEqual((8n << 128n) / 15n);
      // the tick of 2/1 is 6931
      // 8 seconds * 6931 = 55448
      expect(tickCumulativeInside).toEqual(55448n);
      expect(secondsInside).toEqual(8);
    });
    it("overlapping liquidity is aggregated", () => {
      mint(wallet, tickLower, getMaxTick(tickSpacing), 15);
      pool.advanceTime(5);
      swapToHigherPrice(encodePriceSqrt(2, 1), wallet);
      pool.advanceTime(8);
      const { secondsPerLiquidityInsideX128, tickCumulativeInside, secondsInside } = pool.snapshotCumulativesInside(tickLower, tickUpper);
      expect(secondsPerLiquidityInsideX128).toEqual((5n << 128n) / 25n);
      expect(tickCumulativeInside).toEqual(0n);
      expect(secondsInside).toEqual(5);
    });
    it("relative behavior of snapshots", () => {
      pool.advanceTime(5);
      mint(wallet, getMinTick(tickSpacing), tickLower, 15);
      const {
        secondsPerLiquidityInsideX128: secondsPerLiquidityInsideX128Start,
        tickCumulativeInside: tickCumulativeInsideStart,
        secondsInside: secondsInsideStart,
      } = pool.snapshotCumulativesInside(getMinTick(tickSpacing), tickLower);
      pool.advanceTime(8);
      // 13 seconds in starting range, then 3 seconds in newly minted range
      swapToLowerPrice(encodePriceSqrt(1, 2), wallet);
      pool.advanceTime(3);
      const { secondsPerLiquidityInsideX128, tickCumulativeInside, secondsInside } = pool.snapshotCumulativesInside(getMinTick(tickSpacing), tickLower);
      const expectedDiffSecondsPerLiquidity = (3n << 128n) / 15n;
      // the secondsPerLiquidity accumulators are uint160 and wrap around
      expect((secondsPerLiquidityInsideX128 - secondsPerLiquidityInsideX128Start + (1n << 160n)) % (1n << 160n)).toEqual(expectedDiffSecondsPerLiquidity);
      expect(secondsPerLiquidityInsideX128).not.toEqual(expectedDiffSecondsPerLiquidity);
      // the tick is the one corresponding to the price of 1/2, or log base 1.0001 of 0.5
      // this is -6932, and 3 seconds have passed, so the cumulative computed from the diff equals 6932 * 3
      expect(tickCumulativeInside - tickCumulativeInsideStart).toEqual(-20796n);
      expect(secondsInside - secondsInsideStart).toEqual(3);
      expect(secondsInside).not.toEqual(3);
    });
  });

  // Koinos: Uniswap donates type(uint128).max of fees with flash, more than a u64 token supply.
  // The fee growth reached by these donations is set directly with setFeeGrowthGlobal0X128 /
  // setFeeGrowthGlobal1X128 (MockTimeUniswapV3Pool test functions), the remaining donations are
  // real flashes. The pool doesn't hold the uint128 fees, so the fees owed are read from the
  // positions instead of collect when they are above the pool balance.
  describe("fees overflow scenarios", () => {
    it("up to max uint 128", () => {
      pool.initialize(encodePriceSqrt(1, 1));
      mint(wallet, minTick, maxTick, 1);
      // flash(0, 0, wallet, MaxUint128, MaxUint128) with a liquidity of 1
      pool.setFeeGrowthGlobal0X128(MaxUint128 << 128n);
      pool.setFeeGrowthGlobal1X128(MaxUint128 << 128n);

      const [feeGrowthGlobal0X128, feeGrowthGlobal1X128] = [pool.feeGrowthGlobal0X128(), pool.feeGrowthGlobal1X128()];
      // all 1s in first 128 bits
      expect(feeGrowthGlobal0X128).toEqual(MaxUint128 << 128n);
      expect(feeGrowthGlobal1X128).toEqual(MaxUint128 << 128n);
      pool.burn(minTick, maxTick, 0);
      const { tokensOwed0, tokensOwed1 } = pool.positions(wallet, minTick, maxTick);
      expect(tokensOwed0).toEqual(MaxUint128);
      expect(tokensOwed1).toEqual(MaxUint128);
    });

    it("overflow max uint 128", () => {
      pool.initialize(encodePriceSqrt(1, 1));
      mint(wallet, minTick, maxTick, 1);
      // flash(0, 0, wallet, MaxUint128, MaxUint128)
      pool.setFeeGrowthGlobal0X128(MaxUint128 << 128n);
      pool.setFeeGrowthGlobal1X128(MaxUint128 << 128n);
      flash(0, 0, wallet, 1, 1);

      const [feeGrowthGlobal0X128, feeGrowthGlobal1X128] = [pool.feeGrowthGlobal0X128(), pool.feeGrowthGlobal1X128()];
      // all 1s in first 128 bits
      expect(feeGrowthGlobal0X128).toEqual(0n);
      expect(feeGrowthGlobal1X128).toEqual(0n);
      pool.burn(minTick, maxTick, 0);
      const { amount0, amount1 } = pool.collectStatic(wallet, minTick, maxTick, MaxUint64, MaxUint64);
      // fees burned
      expect(amount0).toEqual(0n);
      expect(amount1).toEqual(0n);
    });

    it("overflow max uint 128 after poke burns fees owed to 0", () => {
      pool.initialize(encodePriceSqrt(1, 1));
      mint(wallet, minTick, maxTick, 1);
      // flash(0, 0, wallet, MaxUint128, MaxUint128)
      pool.setFeeGrowthGlobal0X128(MaxUint128 << 128n);
      pool.setFeeGrowthGlobal1X128(MaxUint128 << 128n);
      pool.burn(minTick, maxTick, 0);
      flash(0, 0, wallet, 1, 1);
      pool.burn(minTick, maxTick, 0);

      const { amount0, amount1 } = pool.collectStatic(wallet, minTick, maxTick, MaxUint64, MaxUint64);
      // fees burned
      expect(amount0).toEqual(0n);
      expect(amount1).toEqual(0n);
    });

    it("two positions at the same snapshot", () => {
      pool.initialize(encodePriceSqrt(1, 1));
      mint(wallet, minTick, maxTick, 1);
      mint(other, minTick, maxTick, 1);
      // flash(0, 0, wallet, MaxUint128, 0) twice with a liquidity of 2
      pool.setFeeGrowthGlobal0X128(2n * ((MaxUint128 << 128n) / 2n));
      const feeGrowthGlobal0X128 = pool.feeGrowthGlobal0X128();
      expect(feeGrowthGlobal0X128).toEqual(MaxUint128 << 128n);
      flash(0, 0, wallet, 2, 0);
      pool.burn(minTick, maxTick, 0);
      pool.burn(minTick, maxTick, 0, other);
      let { amount0 } = pool.collectStatic(wallet, minTick, maxTick, MaxUint64, MaxUint64);
      expect(amount0).toEqual(0n); // amount0 of wallet
      ({ amount0 } = pool.collectStatic(other, minTick, maxTick, MaxUint64, MaxUint64, other));
      expect(amount0).toEqual(0n); // amount0 of other
    });

    it("two positions 1 wei of fees apart overflows exactly once", () => {
      pool.initialize(encodePriceSqrt(1, 1));
      mint(wallet, minTick, maxTick, 1);
      flash(0, 0, wallet, 1, 0);
      mint(other, minTick, maxTick, 1);
      // flash(0, 0, wallet, MaxUint128, 0) twice with a liquidity of 2
      pool.setFeeGrowthGlobal0X128((pool.feeGrowthGlobal0X128() + 2n * ((MaxUint128 << 128n) / 2n)) % (1n << 256n));
      const feeGrowthGlobal0X128 = pool.feeGrowthGlobal0X128();
      expect(feeGrowthGlobal0X128).toEqual(0n);
      flash(0, 0, wallet, 2, 0);
      pool.burn(minTick, maxTick, 0);
      pool.burn(minTick, maxTick, 0, other);
      let { amount0 } = pool.collectStatic(wallet, minTick, maxTick, MaxUint64, MaxUint64);
      expect(amount0).toEqual(1n); // amount0 of wallet
      ({ amount0 } = pool.collectStatic(other, minTick, maxTick, MaxUint64, MaxUint64, other));
      expect(amount0).toEqual(0n); // amount0 of other
    });
  });

  describe("swap underpayment tests", () => {
    let underpay;
    beforeEach(() => {
      const { address } = vm.account("TestUniswapV3SwapPay");
      vm.deployNative(address, tc.swapPayContract({ codec: pool.codec }));
      fixture.approve(address);
      underpay = (recipient, zeroForOne, sqrtPriceX96, amountSpecified, pay0, pay1) =>
        vm.transaction({
          signers: [wallet.address],
          operations: [
            {
              call: {
                contractId: address,
                entryPoint: entryPoint("swap"),
                args: tc.json({ pool: pool.address, recipient: recipient.address, zeroForOne, sqrtPriceX96, amountSpecified: amountSpecified.toString(), pay0, pay1, payer: wallet.address }),
              },
            },
          ],
        });
      pool.initialize(encodePriceSqrt(1, 1));
      mint(wallet, minTick, maxTick, expandTo18Decimals(1));
    });

    it("underpay zero for one and exact in", () => {
      expectRevert(() => underpay(wallet, true, MIN_SQRT_RATIO + 1n, 1000, 1, 0), "KOINDX: IIA");
    });
    it("pay in the wrong token zero for one and exact in", () => {
      expectRevert(() => underpay(wallet, true, MIN_SQRT_RATIO + 1n, 1000, 0, 2000), "KOINDX: IIA");
    });
    it("overpay zero for one and exact in", () => {
      underpay(wallet, true, MIN_SQRT_RATIO + 1n, 1000, 2000, 0);
    });
    it("underpay zero for one and exact out", () => {
      expectRevert(() => underpay(wallet, true, MIN_SQRT_RATIO + 1n, -1000, 1, 0), "KOINDX: IIA");
    });
    it("pay in the wrong token zero for one and exact out", () => {
      expectRevert(() => underpay(wallet, true, MIN_SQRT_RATIO + 1n, -1000, 0, 2000), "KOINDX: IIA");
    });
    it("overpay zero for one and exact out", () => {
      underpay(wallet, true, MIN_SQRT_RATIO + 1n, -1000, 2000, 0);
    });
    it("underpay one for zero and exact in", () => {
      expectRevert(() => underpay(wallet, false, MAX_SQRT_RATIO - 1n, 1000, 0, 1), "KOINDX: IIA");
    });
    it("pay in the wrong token one for zero and exact in", () => {
      expectRevert(() => underpay(wallet, false, MAX_SQRT_RATIO - 1n, 1000, 2000, 0), "KOINDX: IIA");
    });
    it("overpay one for zero and exact in", () => {
      underpay(wallet, false, MAX_SQRT_RATIO - 1n, 1000, 0, 2000);
    });
    it("underpay one for zero and exact out", () => {
      expectRevert(() => underpay(wallet, false, MAX_SQRT_RATIO - 1n, -1000, 0, 1), "KOINDX: IIA");
    });
    it("pay in the wrong token one for zero and exact out", () => {
      expectRevert(() => underpay(wallet, false, MAX_SQRT_RATIO - 1n, -1000, 2000, 0), "KOINDX: IIA");
    });
    it("overpay one for zero and exact out", () => {
      underpay(wallet, false, MAX_SQRT_RATIO - 1n, -1000, 0, 2000);
    });
  });
});
