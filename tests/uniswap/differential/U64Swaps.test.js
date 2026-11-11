// Swaps of any u64 amount, like the Koinos tokens (KCS-4 `value` is a uint64): a single swap can
// move more than 2^63 - 1 units of a token (the limit of an int64 swap API) up to 2^64 - 1. Each
// swap runs on KoinDX and on the Uniswap reference (the published bytecode in an EVM) with the same
// pool, and the transferred amounts and the pool state must be equal.
const { UniswapEVM } = require("../evm/uniswap-evm");
const { poolFixture, createPoolFunctions, transfers } = require("../shared/fixtures");
const { encodePriceSqrt, FeeAmount, TICK_SPACINGS, getMinTick, getMaxTick, MaxUint64 } = require("../shared/utilities");

const FEE = FeeAmount.MEDIUM;
const SPACING = TICK_SPACINGS[FEE];
// ~5e18 of each token in the full range: the wallet keeps ~1.3e19 of each token to swap
const LIQUIDITY = 5n * 10n ** 18n;
const INT64_MAX = (1n << 63n) - 1n;

const values = (list) => list.map((t) => t.value);

describe("swaps of u64 amounts (more than 2^63 - 1 units)", () => {
  let koindx, uniswap;

  beforeEach(async () => {
    const fixture = poolFixture();
    const pool = fixture.createPool(FEE, SPACING);
    const fns = createPoolFunctions({ fixture, swapTarget: fixture.swapTargetCallee, token0: fixture.token0, token1: fixture.token1, pool });
    pool.initialize(encodePriceSqrt(1, 1));
    fns.mint(fixture.wallet, getMinTick(SPACING), getMaxTick(SPACING), LIQUIDITY);
    koindx = { fixture, pool, fns, recipient: fixture.other };

    const uni = await UniswapEVM.create({ tokenSupply: MaxUint64 });
    const evmPool = await uni.createPool(FEE, SPACING);
    await evmPool.initialize(encodePriceSqrt(1, 1));
    await evmPool.mint(uni.wallet, getMinTick(SPACING), getMaxTick(SPACING), LIQUIDITY);
    uniswap = { uni, pool: evmPool, recipient: uni.other };
  });

  /** runs a swap function (Uniswap's createPoolFunctions names) on both implementations */
  async function swapBoth(method, ...args) {
    const { events } = koindx.fns[method](...args, koindx.recipient);
    const { events: evmEvents } = await uniswap.pool[method](...args, uniswap.recipient);
    const { token0, token1 } = koindx.fixture;
    const result = { amounts: [values(transfers(events, token0)), values(transfers(events, token1))] };
    const expected = { amounts: [values(uniswap.uni.transfers(evmEvents, uniswap.uni.token0)), values(uniswap.uni.transfers(evmEvents, uniswap.uni.token1))] };
    expect(result).toEqual(expected);

    const slot0 = koindx.pool.slot0();
    const evmSlot0 = await uniswap.pool.slot0();
    expect([slot0.sqrtPriceX96, slot0.tick, koindx.pool.liquidity(), koindx.pool.feeGrowthGlobal0X128(), koindx.pool.feeGrowthGlobal1X128()]).toEqual([
      evmSlot0.sqrtPriceX96,
      evmSlot0.tick,
      await uniswap.pool.liquidity(),
      await uniswap.pool.feeGrowthGlobal0X128(),
      await uniswap.pool.feeGrowthGlobal1X128(),
    ]);
    return result.amounts;
  }

  it("exact input of more than 2^63 - 1 units", async () => {
    const amountIn = INT64_MAX + 10n ** 15n;
    const [paid, received] = await swapBoth("swapExact0For1", amountIn);
    expect(paid).toEqual([amountIn]);
    expect(received[0] > 0n).toBe(true);
  });

  it("exact output that needs more than 2^63 - 1 units of input", async () => {
    const [received, paid] = await swapBoth("swap1ForExact0", 34n * 10n ** 17n);
    expect(received).toEqual([34n * 10n ** 17n]);
    expect(paid[0] > INT64_MAX).toBe(true);
  });

  it("swap to a price with the max u64 amount (Uniswap: max int256)", async () => {
    const price = encodePriceSqrt(1, 10);
    const { events } = koindx.fns.swapToLowerPrice(price, koindx.recipient);
    const { events: evmEvents } = await uniswap.pool.swapToLowerPrice(price, uniswap.recipient);
    const paid = values(transfers(events, koindx.fixture.token0));
    expect(paid).toEqual(values(uniswap.uni.transfers(evmEvents, uniswap.uni.token0)));
    expect(values(transfers(events, koindx.fixture.token1))).toEqual(values(uniswap.uni.transfers(evmEvents, uniswap.uni.token1)));
    expect(paid[0] > INT64_MAX).toBe(true);
    expect(koindx.pool.slot0().sqrtPriceX96).toEqual(price);
    expect((await uniswap.pool.slot0()).sqrtPriceX96).toEqual(price);
  });

  it("an amount that can't be paid reverts on both", async () => {
    // the wallet has ~1.3e19 of token0 left. KCS-4 checks the allowance before the balance: the
    // allowance of the test callee (used by the mint) is set to the max again
    koindx.fixture.approve(koindx.fixture.swapTargetCallee);
    expect(() => koindx.fns.swapExact0For1(MaxUint64, koindx.recipient)).toThrow("account 'from' has insufficient balance");
    await expect(uniswap.pool.swapExact0For1(MaxUint64, uniswap.recipient)).rejects.toThrow("insufficient balance");
  });
});
