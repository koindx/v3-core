// JavaScript ports of the Uniswap v3-core test contracts (contracts/test/*.sol) for the Koinos VM
// emulator. Their own entry points take JSON arguments (they are only called by the tests), the
// pool callbacks use the pool ABI.
//
// Koinos has no msg.sender for accounts: the account that pays (Uniswap: msg.sender of the test
// contract) is passed explicitly as `payer` and must sign the transaction, the test token then
// lets the test contract transfer its tokens (Uniswap: approve + transferFrom).
//
// The test contracts keep the signed amounts of Uniswap (amountSpecified, amount0Delta,
// amount1Delta) and convert them from / to the swap API of the pool (direction, exact input and
// u64 amounts in and out).
const { koinos } = require("@koinos/proto-js");
const { utils } = require("koilib");
const { entryPoint, addressBytes } = require("../../vm/koinos-vm");
const { TOKEN_ENTRIES } = require("../../vm/token");
const { MaxUint64, MIN_SQRT_RATIO, MAX_SQRT_RATIO } = require("./utilities");

const T = koinos.contracts.token;
const json = (obj) => Buffer.from(JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
const parse = (bytes) => JSON.parse(Buffer.from(bytes).toString());
const dataBytes = (obj) => json(obj);
const dataOf = (base64url) => parse(utils.decodeBase64url(base64url));

const CALLBACKS = {
  mint: entryPoint("koindx_v3_mint_callback"),
  swap: entryPoint("koindx_v3_swap_callback"),
  flash: entryPoint("koindx_v3_flash_callback"),
};

/** Uniswap's signed amountSpecified (positive: exact input) → swap arguments of the pool */
function swapArguments({ amountSpecified, ...args }) {
  const amount = BigInt(amountSpecified);
  return { ...args, exactInput: amount > 0n, amountSpecified: (amount < 0n ? -amount : amount).toString() };
}

/** amounts in and out of the pool → Uniswap's signed deltas of the pool balances */
function signedDeltas(zeroForOne, amountIn, amountOut) {
  const [paid, sent] = [BigInt(amountIn), -BigInt(amountOut)];
  return zeroForOne ? [paid, sent] : [sent, paid];
}

/** koindx_v3_swap_callback arguments → Uniswap's uniswapV3SwapCallback arguments */
function decodeSwapCallback(pool, args) {
  const { zeroForOne, amountIn, amountOut, data } = pool.codec.decode("pool.swap_callback_args", args);
  const [amount0Delta, amount1Delta] = signedDeltas(zeroForOne, amountIn, amountOut).map((v) => v.toString());
  return { amount0Delta, amount1Delta, data };
}

/** helpers shared by the test contracts */
function poolApi(ctx, pool) {
  const codec = pool.codec;
  const call = (address, method, args) => {
    const m = codec.method(method);
    const res = ctx.call(address, m.entry_point, m.argument ? codec.encode(m.argument, args) : new Uint8Array(0));
    return m.return ? codec.decode(m.return, res) : {};
  };
  return {
    call,
    immutables: (address) => call(address, "get_immutables", {}),
    /** swap with Uniswap's signed amountSpecified, returns Uniswap's signed amount0 / amount1 */
    swap: (address, args) => {
      const { amountIn, amountOut } = call(address, "swap", swapArguments(args));
      const [amount0, amount1] = signedDeltas(args.zeroForOne, amountIn, amountOut).map((v) => v.toString());
      return { amount0, amount1 };
    },
    pay: (token, from, to, value) =>
      ctx.call(token, TOKEN_ENTRIES.transfer, T.transfer_arguments.encode({ from: addressBytes(from), to: addressBytes(to), value: value.toString() }).finish()),
  };
}

const b58 = (bytes) => utils.encodeBase58(Uint8Array.from(bytes));

/** TestUniswapV3Callee.sol */
function calleeContract(pool) {
  const E = (name) => entryPoint(name);
  return (ctx, entry, args) => {
    const api = poolApi(ctx, pool);
    const swap = (a, zeroForOne, amountSpecified, sqrtPriceLimitX96) =>
      api.swap(a.pool, { recipient: a.recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96: sqrtPriceLimitX96.toString(), data: dataBytes({ payer: a.payer }) });
    switch (entry) {
      case E("swapExact0For1"): {
        const a = parse(args);
        swap(a, true, BigInt(a.amount), a.sqrtPriceLimitX96);
        return;
      }
      case E("swap0ForExact1"): {
        const a = parse(args);
        swap(a, true, -BigInt(a.amount), a.sqrtPriceLimitX96);
        return;
      }
      case E("swapExact1For0"): {
        const a = parse(args);
        swap(a, false, BigInt(a.amount), a.sqrtPriceLimitX96);
        return;
      }
      case E("swap1ForExact0"): {
        const a = parse(args);
        swap(a, false, -BigInt(a.amount), a.sqrtPriceLimitX96);
        return;
      }
      case E("swapToLowerSqrtPrice"): {
        const a = parse(args);
        swap(a, true, MaxUint64, a.sqrtPriceX96);
        return;
      }
      case E("swapToHigherSqrtPrice"): {
        const a = parse(args);
        swap(a, false, MaxUint64, a.sqrtPriceX96);
        return;
      }
      case E("mint"): {
        const a = parse(args);
        api.call(a.pool, "mint", { recipient: a.recipient, tickLower: a.tickLower, tickUpper: a.tickUpper, amount: a.amount.toString(), data: dataBytes({ payer: a.payer }) });
        return;
      }
      case E("flash"): {
        const a = parse(args);
        api.call(a.pool, "flash", { recipient: a.recipient, amount0: a.amount0, amount1: a.amount1, data: dataBytes({ payer: a.payer, pay0: a.pay0, pay1: a.pay1 }) });
        return;
      }
      case CALLBACKS.swap: {
        const { amount0Delta, amount1Delta, data } = decodeSwapCallback(pool, args);
        const { payer } = dataOf(data);
        ctx.event("SwapCallback", json({ amount0Delta, amount1Delta }));
        const poolAddress = b58(ctx.caller.caller);
        const { token0, token1 } = api.immutables(poolAddress);
        if (BigInt(amount0Delta) > 0n) api.pay(token0, payer, poolAddress, amount0Delta);
        else if (BigInt(amount1Delta) > 0n) api.pay(token1, payer, poolAddress, amount1Delta);
        else ctx.require(BigInt(amount0Delta) === 0n && BigInt(amount1Delta) === 0n, "assert");
        return;
      }
      case CALLBACKS.mint: {
        const { amount0Owed, amount1Owed, data } = pool.codec.decode("pool.mint_callback_args", args);
        const { payer } = dataOf(data);
        ctx.event("MintCallback", json({ amount0Owed, amount1Owed }));
        const poolAddress = b58(ctx.caller.caller);
        const { token0, token1 } = api.immutables(poolAddress);
        if (BigInt(amount0Owed) > 0n) api.pay(token0, payer, poolAddress, amount0Owed);
        if (BigInt(amount1Owed) > 0n) api.pay(token1, payer, poolAddress, amount1Owed);
        return;
      }
      case CALLBACKS.flash: {
        const { fee0, fee1, data } = pool.codec.decode("pool.flash_callback_args", args);
        ctx.event("FlashCallback", json({ fee0, fee1 }));
        const { payer, pay0, pay1 } = dataOf(data);
        const poolAddress = b58(ctx.caller.caller);
        const { token0, token1 } = api.immutables(poolAddress);
        if (BigInt(pay0) > 0n) api.pay(token0, payer, poolAddress, pay0);
        if (BigInt(pay1) > 0n) api.pay(token1, payer, poolAddress, pay1);
        return;
      }
      default:
        ctx.revert("unknown entry point");
    }
  };
}

/** TestUniswapV3Router.sol */
function routerContract(pool) {
  const E = (name) => entryPoint(name);
  return (ctx, entry, args) => {
    const api = poolApi(ctx, pool);
    switch (entry) {
      case E("swapForExact0Multi"): {
        const a = parse(args);
        api.swap(a.poolOutput, { recipient: a.recipient, zeroForOne: false, amountSpecified: -BigInt(a.amount0Out), sqrtPriceLimitX96: (MAX_SQRT_RATIO - 1n).toString(), data: dataBytes({ pools: [a.poolInput], payer: a.payer }) });
        return;
      }
      case E("swapForExact1Multi"): {
        const a = parse(args);
        api.swap(a.poolOutput, { recipient: a.recipient, zeroForOne: true, amountSpecified: -BigInt(a.amount1Out), sqrtPriceLimitX96: (MIN_SQRT_RATIO + 1n).toString(), data: dataBytes({ pools: [a.poolInput], payer: a.payer }) });
        return;
      }
      case CALLBACKS.swap: {
        const { amount0Delta, amount1Delta, data } = decodeSwapCallback(pool, args);
        ctx.event("SwapCallback", json({ amount0Delta, amount1Delta }));
        const { pools, payer } = dataOf(data);
        const poolAddress = b58(ctx.caller.caller);
        const { token0, token1 } = api.immutables(poolAddress);
        if (pools.length === 1) {
          // get the address and amount of the token that we need to pay
          const tokenToBePaid = BigInt(amount0Delta) > 0n ? token0 : token1;
          const amountToBePaid = BigInt(amount0Delta) > 0n ? BigInt(amount0Delta) : BigInt(amount1Delta);
          const zeroForOne = tokenToBePaid === api.immutables(pools[0]).token1;
          api.swap(pools[0], {
            recipient: poolAddress,
            zeroForOne,
            amountSpecified: -amountToBePaid,
            sqrtPriceLimitX96: (zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n).toString(),
            data: dataBytes({ pools: [], payer }),
          });
        } else if (BigInt(amount0Delta) > 0n) {
          api.pay(token0, payer, poolAddress, amount0Delta);
        } else {
          api.pay(token1, payer, poolAddress, amount1Delta);
        }
        return;
      }
      default:
        ctx.revert("unknown entry point");
    }
  };
}

/** TestUniswapV3SwapPay.sol */
function swapPayContract(pool) {
  return (ctx, entry, args) => {
    const api = poolApi(ctx, pool);
    switch (entry) {
      case entryPoint("swap"): {
        const a = parse(args);
        api.swap(a.pool, { recipient: a.recipient, zeroForOne: a.zeroForOne, amountSpecified: a.amountSpecified, sqrtPriceLimitX96: a.sqrtPriceX96.toString(), data: dataBytes({ payer: a.payer, pay0: a.pay0, pay1: a.pay1 }) });
        return;
      }
      case CALLBACKS.swap: {
        const { data } = decodeSwapCallback(pool, args);
        const { payer, pay0, pay1 } = dataOf(data);
        const poolAddress = b58(ctx.caller.caller);
        const { token0, token1 } = api.immutables(poolAddress);
        if (BigInt(pay0) > 0n) api.pay(token0, payer, poolAddress, pay0);
        else if (BigInt(pay1) > 0n) api.pay(token1, payer, poolAddress, pay1);
        return;
      }
      default:
        ctx.revert("unknown entry point");
    }
  };
}

/**
 * TestUniswapV3ReentrantCallee.sol: Koinos can't catch a reverted call (the whole transaction
 * reverts), so each reentrancy attempt is a separate transaction that must revert with LOCKED
 */
function reentrantContract(pool) {
  return (ctx, entry, args) => {
    const api = poolApi(ctx, pool);
    switch (entry) {
      case entryPoint("swapToReenter"): {
        const a = parse(args);
        api.swap(a.pool, { recipient: ctx.contractId, zeroForOne: false, amountSpecified: "1", sqrtPriceLimitX96: (MAX_SQRT_RATIO - 1n).toString(), data: dataBytes({ method: a.method }) });
        return;
      }
      case CALLBACKS.swap: {
        const { data } = decodeSwapCallback(pool, args);
        const { method } = dataOf(data);
        const poolAddress = b58(ctx.caller.caller);
        const me = ctx.contractId;
        const reenter = {
          swap: () => api.call(poolAddress, "swap", { recipient: me, zeroForOne: false, exactInput: true, amountSpecified: "1", sqrtPriceLimitX96: "0", data: new Uint8Array(0) }),
          mint: () => api.call(poolAddress, "mint", { recipient: me, tickLower: 0, tickUpper: 0, amount: "0", data: new Uint8Array(0) }),
          collect: () => api.call(poolAddress, "collect", { recipient: me, tickLower: 0, tickUpper: 0, amount0Requested: "0", amount1Requested: "0" }),
          burn: () => api.call(poolAddress, "burn", { tickLower: 0, tickUpper: 0, amount: "0" }),
          flash: () => api.call(poolAddress, "flash", { recipient: me, amount0: "0", amount1: "0", data: new Uint8Array(0) }),
          collect_protocol: () => api.call(poolAddress, "collect_protocol", { recipient: me, amount0Requested: "0", amount1Requested: "0" }),
        };
        reenter[method]();
        ctx.revert("Unable to reenter");
        return;
      }
      default:
        ctx.revert("unknown entry point");
    }
  };
}

/** UniswapV3PoolSwapTest.sol */
function poolSwapTestContract(pool) {
  return (ctx, entry, args) => {
    const api = poolApi(ctx, pool);
    switch (entry) {
      case entryPoint("getSwapResult"): {
        const a = parse(args);
        const res = api.swap(a.pool, { recipient: ctx.contractId, zeroForOne: a.zeroForOne, amountSpecified: a.amountSpecified, sqrtPriceLimitX96: a.sqrtPriceLimitX96.toString(), data: dataBytes({ payer: a.payer }) });
        const slot0 = api.call(a.pool, "slot0", {});
        ctx.event("SwapResult", json({ amount0Delta: res.amount0, amount1Delta: res.amount1, nextSqrtRatio: slot0.sqrtPriceX96 }));
        return;
      }
      case CALLBACKS.swap: {
        const { amount0Delta, amount1Delta, data } = decodeSwapCallback(pool, args);
        const { payer } = dataOf(data);
        const poolAddress = b58(ctx.caller.caller);
        const { token0, token1 } = api.immutables(poolAddress);
        if (BigInt(amount0Delta) > 0n) api.pay(token0, payer, poolAddress, amount0Delta);
        else if (BigInt(amount1Delta) > 0n) api.pay(token1, payer, poolAddress, amount1Delta);
        return;
      }
      default:
        ctx.revert("unknown entry point");
    }
  };
}

/**
 * MockTimeUniswapV3PoolDeployer.sol: configures a pool with any fee and tick spacing (the factory
 * only accepts the enabled fee tiers). The pool calls `owner` on its factory (this contract) for
 * the protocol fee functions: forwarded to the real factory.
 */
function deployerContract(pool, factoryAddress) {
  return (ctx, entry, args) => {
    const api = poolApi(ctx, pool);
    switch (entry) {
      case entryPoint("deploy"): {
        const a = parse(args);
        api.call(a.pool, "configure", { token0: { tokenAddress: a.token0 }, token1: { tokenAddress: a.token1 }, fee: a.fee, tickSpacing: a.tickSpacing });
        return;
      }
      case entryPoint("owner"):
        return ctx.call(factoryAddress, entryPoint("owner"), new Uint8Array(0));
      default:
        ctx.revert("unknown entry point");
    }
  };
}

module.exports = {
  json,
  parse,
  CALLBACKS,
  swapArguments,
  signedDeltas,
  calleeContract,
  routerContract,
  swapPayContract,
  reentrantContract,
  poolSwapTestContract,
  deployerContract,
};
