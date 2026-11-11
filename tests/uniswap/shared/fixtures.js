// Port of Uniswap v3-core test/shared/fixtures.ts and createPoolFunctions (utilities.ts)
const { koinos } = require("@koinos/proto-js");
const { KoinosVM, entryPoint, b58 } = require("../../vm/koinos-vm");
const { TestToken } = require("../../vm/token");
const { loadContract, ContractClient, signersOf } = require("./contracts");
const tc = require("./test-contracts");
const { MaxUint64, MIN_SQRT_RATIO, MAX_SQRT_RATIO } = require("./utilities");

const T = koinos.contracts.token;

// Monday, October 5, 2020 9:00:00 AM GMT-05:00
const TEST_POOL_START_TIME = 1601906400;

const CONTRACTS = {};
function contract(name) {
  if (!CONTRACTS[name]) CONTRACTS[name] = loadContract(name);
  return CONTRACTS[name];
}

class PoolClient extends ContractClient {
  constructor(vm, address, fixture) {
    super(vm, address, contract("pool"));
    this.fixture = fixture;
  }

  // view functions (Uniswap names)
  slot0() {
    const s = this.read("slot0");
    return { ...s, sqrtPriceX96: BigInt(s.sqrtPriceX96) };
  }
  liquidity() {
    return BigInt(this.read("liquidity").value);
  }
  feeGrowthGlobal0X128() {
    return BigInt(this.read("fee_growth_global").feeGrowthGlobal0X128);
  }
  feeGrowthGlobal1X128() {
    return BigInt(this.read("fee_growth_global").feeGrowthGlobal1X128);
  }
  protocolFees() {
    const p = this.read("protocol_fees");
    return { token0: BigInt(p.token0), token1: BigInt(p.token1) };
  }
  immutables() {
    return this.read("get_immutables");
  }
  ticks(tick) {
    const t = this.read("ticks", { tick });
    return {
      liquidityGross: BigInt(t.liquidityGross),
      liquidityNet: BigInt(t.liquidityNet),
      feeGrowthOutside0X128: BigInt(t.feeGrowthOutside0X128),
      feeGrowthOutside1X128: BigInt(t.feeGrowthOutside1X128),
      tickCumulativeOutside: BigInt(t.tickCumulativeOutside),
      secondsPerLiquidityOutsideX128: BigInt(t.secondsPerLiquidityOutsideX128),
      secondsOutside: t.secondsOutside,
      initialized: t.initialized,
    };
  }
  tickBitmap(wordPosition) {
    return BigInt(this.read("tick_bitmap", { wordPosition }).value);
  }
  positions(owner, tickLower, tickUpper) {
    const p = this.read("positions", { owner: typeof owner === "string" ? owner : owner.address, tickLower, tickUpper });
    return {
      liquidity: BigInt(p.liquidity),
      feeGrowthInside0LastX128: BigInt(p.feeGrowthInside0LastX128),
      feeGrowthInside1LastX128: BigInt(p.feeGrowthInside1LastX128),
      tokensOwed0: BigInt(p.tokensOwed0),
      tokensOwed1: BigInt(p.tokensOwed1),
    };
  }
  observations(index) {
    const o = this.read("observations", { index });
    return {
      blockTimestamp: o.blockTimestamp,
      tickCumulative: BigInt(o.tickCumulative),
      secondsPerLiquidityCumulativeX128: BigInt(o.secondsPerLiquidityCumulativeX128),
      initialized: o.initialized,
    };
  }
  observe(secondsAgos) {
    const o = this.read("observe", { secondsAgos });
    return {
      tickCumulatives: o.tickCumulatives.map(BigInt),
      secondsPerLiquidityCumulativeX128s: o.secondsPerLiquidityCumulativeX128s.map(BigInt),
    };
  }
  snapshotCumulativesInside(tickLower, tickUpper) {
    const s = this.read("snapshot_cumulatives_inside", { tickLower, tickUpper });
    return {
      tickCumulativeInside: BigInt(s.tickCumulativeInside),
      secondsPerLiquidityInsideX128: BigInt(s.secondsPerLiquidityInsideX128),
      secondsInside: s.secondsInside,
    };
  }

  // state changing functions, sent by `from` (default: the wallet)
  initialize(sqrtPriceX96, from = this.fixture.wallet) {
    return this.send(from, "initialize", { sqrtPriceX96: sqrtPriceX96.toString() });
  }
  burn(tickLower, tickUpper, amount, from = this.fixture.wallet) {
    return this.send(from, "burn", { tickLower, tickUpper, amount: amount.toString(), owner: from.address });
  }
  _collectArgs(recipient, tickLower, tickUpper, amount0Requested, amount1Requested, from) {
    return {
      recipient: typeof recipient === "string" ? recipient : recipient.address,
      tickLower,
      tickUpper,
      amount0Requested: amount0Requested.toString(),
      amount1Requested: amount1Requested.toString(),
      owner: from.address,
    };
  }
  collect(recipient, tickLower, tickUpper, amount0Requested, amount1Requested, from = this.fixture.wallet) {
    return this.send(from, "collect", this._collectArgs(recipient, tickLower, tickUpper, amount0Requested, amount1Requested, from));
  }
  /** Uniswap: pool.callStatic.collect, amounts as BigInt */
  collectStatic(recipient, tickLower, tickUpper, amount0Requested, amount1Requested, from = this.fixture.wallet) {
    const r = this.callStatic(from, "collect", this._collectArgs(recipient, tickLower, tickUpper, amount0Requested, amount1Requested, from));
    return { amount0: BigInt(r.amount0), amount1: BigInt(r.amount1) };
  }
  increaseObservationCardinalityNext(observationCardinalityNext, from = this.fixture.wallet) {
    return this.send(from, "increase_observation_cardinality_next", { observationCardinalityNext });
  }
  setFeeProtocol(feeProtocol0, feeProtocol1, from = this.fixture.wallet) {
    return this.send(from, "set_fee_protocol", { feeProtocol0, feeProtocol1 });
  }
  _collectProtocolArgs(recipient, amount0Requested, amount1Requested) {
    return {
      recipient: typeof recipient === "string" ? recipient : recipient.address,
      amount0Requested: amount0Requested.toString(),
      amount1Requested: amount1Requested.toString(),
    };
  }
  collectProtocol(recipient, amount0Requested, amount1Requested, from = this.fixture.wallet) {
    return this.send(from, "collect_protocol", this._collectProtocolArgs(recipient, amount0Requested, amount1Requested));
  }
  /** Uniswap: pool.callStatic.collectProtocol, amounts as BigInt */
  collectProtocolStatic(recipient, amount0Requested, amount1Requested, from = this.fixture.wallet) {
    const r = this.callStatic(from, "collect_protocol", this._collectProtocolArgs(recipient, amount0Requested, amount1Requested));
    return { amount0: BigInt(r.amount0), amount1: BigInt(r.amount1) };
  }

  // MockTimeUniswapV3Pool
  advanceTime(by) {
    this.vm.advanceTime(by);
  }
  time() {
    return Number(this.vm.time / 1000n);
  }
  _setState(field, value) {
    const codec = this.codec;
    const record = codec.type("pool.state_record");
    const raw = this.vm.getObject(this.address, 1, new Uint8Array(0));
    const state = record.toObject(record.decode(raw));
    state[field] = u256Bytes(value);
    this.vm.putObject(this.address, 1, new Uint8Array(0), record.encode(record.fromObject(state)).finish());
  }
  setFeeGrowthGlobal0X128(value) {
    this._setState("feeGrowthGlobal0X128", value);
  }
  setFeeGrowthGlobal1X128(value) {
    this._setState("feeGrowthGlobal1X128", value);
  }
}

/** U256 storage format: big endian without leading zeros */
function u256Bytes(value) {
  let hex = BigInt(value).toString(16);
  if (value === 0n || value === 0) return new Uint8Array(0);
  if (hex.length % 2) hex = "0" + hex;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function factoryFixture(vm, wallet) {
  const factoryContract = contract("factory");
  const account = vm.account("factory");
  vm.deployWasm(account.address, factoryContract.wasm, { authorizesUploadContract: true });
  const factory = new ContractClient(vm, account.address, factoryContract);
  factory.account = account;
  return factory;
}

let poolCounter = 0;

/** poolFixture of Uniswap: factory, 3 sorted tokens, test callee and router, createPool */
function poolFixture() {
  const vm = new KoinosVM({ time: BigInt(TEST_POOL_START_TIME) * 1000n });
  const wallet = vm.account("wallet");
  const other = vm.account("other");
  const factory = factoryFixture(vm, wallet);
  // Uniswap: the deployer (wallet) owns the factory (KoinDX: two-step transfer, proposed then accepted)
  factory.send(factory.account, "set_owner", { owner: wallet.address });
  factory.send(wallet, "accept_owner", {});

  const tokens = ["A", "B", "C"].map((name) => TestToken.deploy(vm, `token${name}`)).sort((a, b) => (a.address < b.address ? -1 : 1));
  const [token0, token1, token2] = tokens;
  // Uniswap mints 2^255 to the wallet: Koinos tokens are u64
  for (const token of tokens) token.mint(wallet.address, MaxUint64);

  const poolContract = contract("pool");
  const pool = { codec: poolContract.codec };
  const deploy = (name, handler) => {
    const { address } = vm.account(name);
    vm.deployNative(address, handler);
    return { address, name };
  };
  const swapTargetCallee = deploy("TestUniswapV3Callee", tc.calleeContract(pool));
  const swapTargetRouter = deploy("TestUniswapV3Router", tc.routerContract(pool));
  const deployer = deploy("MockTimeUniswapV3PoolDeployer", tc.deployerContract(pool, factory.address));

  const fixture = { vm, wallet, other, factory, token0, token1, token2, swapTargetCallee, swapTargetRouter, deployer };

  /**
   * The wallet and the other account approve `spender` for all their tokens (Uniswap:
   * token.approve(spender, MaxUint256)): Koinos tokens (KCS-4) only let a contract move the tokens
   * of an account up to its allowance
   */
  fixture.approve = (spender) => {
    const address = typeof spender === "string" ? spender : spender.address;
    for (const token of tokens) for (const owner of [wallet, other]) token.approve(owner.address, address, MaxUint64);
  };
  for (const spender of [swapTargetCallee, swapTargetRouter]) fixture.approve(spender);

  /**
   * Creates a pool. Like the deployments on Koinos, the bytecode is uploaded in the same
   * transaction: through the factory when the fee tier is enabled with this tick spacing (the
   * production flow), otherwise through the test deployer (MockTimeUniswapV3PoolDeployer).
   */
  fixture.createPool = (fee, tickSpacing, firstToken = token0, secondToken = token1) => {
    const poolAccount = vm.account(`pool:${++poolCounter}`);
    const upload = {
      upload: {
        contractId: poolAccount.address,
        bytecode: poolContract.wasm,
        authorizesCallContract: true,
        authorizesTransactionApplication: true,
        authorizesUploadContract: true,
      },
    };
    const enabled = Number(factory.read("fee_amount_tick_spacing", { fee }).value);
    let call;
    if (enabled === tickSpacing) {
      call = factory.operation("create_pool", { tokenA: firstToken.address, tokenB: secondToken.address, fee });
    } else {
      call = { call: { contractId: deployer.address, entryPoint: entryPoint("deploy"), args: tc.json({ pool: poolAccount.address, token0: firstToken.address, token1: secondToken.address, fee, tickSpacing }) } };
    }
    vm.transaction({ signers: [poolAccount.address, wallet.address], operations: [upload, call] });
    return new PoolClient(vm, poolAccount.address, fixture);
  };

  return fixture;
}

/** createPoolFunctions of Uniswap: the swaps, mints and flashes go through the test callee */
function createPoolFunctions({ fixture, swapTarget, token0, token1, pool }) {
  const { vm, wallet } = fixture;
  const callTarget = (method, args, from = wallet) =>
    vm.transaction({
      signers: signersOf(from),
      operations: [{ call: { contractId: swapTarget.address, entryPoint: entryPoint(method), args: tc.json({ ...args, pool: pool.address, payer: from.address }) } }],
    });
  const toAddress = (to) => (typeof to === "string" ? to : to.address);

  function swapToSqrtPrice(inputToken, targetPrice, to) {
    const method = inputToken === token0 ? "swapToLowerSqrtPrice" : "swapToHigherSqrtPrice";
    return callTarget(method, { sqrtPriceX96: BigInt(targetPrice), recipient: toAddress(to) });
  }

  function swap(inputToken, [amountIn, amountOut], to, sqrtPriceLimitX96) {
    const exactInput = BigInt(amountOut) === 0n;
    const method = inputToken === token0 ? (exactInput ? "swapExact0For1" : "swap0ForExact1") : exactInput ? "swapExact1For0" : "swap1ForExact0";
    if (sqrtPriceLimitX96 === undefined) {
      sqrtPriceLimitX96 = inputToken === token0 ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
    }
    return callTarget(method, { amount: BigInt(exactInput ? amountIn : amountOut), recipient: toAddress(to), sqrtPriceLimitX96: BigInt(sqrtPriceLimitX96) });
  }

  return {
    swapToLowerPrice: (sqrtPriceX96, to) => swapToSqrtPrice(token0, sqrtPriceX96, to),
    swapToHigherPrice: (sqrtPriceX96, to) => swapToSqrtPrice(token1, sqrtPriceX96, to),
    swapExact0For1: (amount, to, sqrtPriceLimitX96) => swap(token0, [amount, 0n], to, sqrtPriceLimitX96),
    swap0ForExact1: (amount, to, sqrtPriceLimitX96) => swap(token0, [0n, amount], to, sqrtPriceLimitX96),
    swapExact1For0: (amount, to, sqrtPriceLimitX96) => swap(token1, [amount, 0n], to, sqrtPriceLimitX96),
    swap1ForExact0: (amount, to, sqrtPriceLimitX96) => swap(token1, [0n, amount], to, sqrtPriceLimitX96),
    mint: (recipient, tickLower, tickUpper, liquidity, from = wallet) =>
      callTarget("mint", { recipient: toAddress(recipient), tickLower: Number(tickLower), tickUpper: Number(tickUpper), amount: BigInt(liquidity) }, from),
    flash: (amount0, amount1, to, pay0, pay1) => {
      const fee = BigInt(pool.immutables().fee);
      if (pay0 === undefined) pay0 = (BigInt(amount0) * fee + 999999n) / 1000000n + BigInt(amount0);
      if (pay1 === undefined) pay1 = (BigInt(amount1) * fee + 999999n) / 1000000n + BigInt(amount1);
      return callTarget("flash", { recipient: toAddress(to), amount0: BigInt(amount0), amount1: BigInt(amount1), pay0: BigInt(pay0), pay1: BigInt(pay1) });
    },
  };
}

/** createMultiPoolFunctions of Uniswap (TestUniswapV3Router) */
function createMultiPoolFunctions({ fixture, swapTarget, poolInput, poolOutput }) {
  const { vm, wallet } = fixture;
  const call = (method, args) =>
    vm.transaction({
      signers: [wallet.address],
      operations: [{ call: { contractId: swapTarget.address, entryPoint: entryPoint(method), args: tc.json({ ...args, poolInput: poolInput.address, poolOutput: poolOutput.address, payer: wallet.address }) } }],
    });
  const toAddress = (to) => (typeof to === "string" ? to : to.address);
  return {
    swapForExact0Multi: (amountOut, to) => call("swapForExact0Multi", { recipient: toAddress(to), amount0Out: BigInt(amountOut) }),
    swapForExact1Multi: (amountOut, to) => call("swapForExact1Multi", { recipient: toAddress(to), amount1Out: BigInt(amountOut) }),
  };
}

/** token transfers of a transaction (Uniswap: Transfer events), values as BigInt */
function transfers(events, token) {
  return events
    .filter((e) => e.source === token.address && e.name === "token.transfer_event")
    .map((e) => {
      const d = T.transfer_event.decode(e.data);
      return { from: b58(d.from), to: b58(d.to), value: BigInt(d.value.toString()) };
    });
}

/** decodes the JSON events of the test contracts */
function testEvents(events, name) {
  return events.filter((e) => e.name === name).map((e) => tc.parse(e.data));
}

module.exports = { TEST_POOL_START_TIME, poolFixture, factoryFixture, createPoolFunctions, createMultiPoolFunctions, PoolClient, contract, testEvents, transfers, u256Bytes };
