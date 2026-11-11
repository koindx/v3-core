// The Uniswap v3 reference: the factory and pool bytecode published in @uniswap/v3-core (the
// contracts deployed on Ethereum) run in an EVM (@ethereumjs/evm), with the same API as the KoinDX
// pool client of the Koinos VM emulator. Used to compare KoinDX with Uniswap on the same
// scenarios (differential tests), in particular where the Uniswap tests can't be ported as is
// (Koinos token amounts are u64).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EVM } = require("@ethereumjs/evm");
const { Address, hexToBytes, bytesToHex, setLengthLeft, bigIntToBytes } = require("@ethereumjs/util");
const { Interface, defaultAbiCoder } = require("@ethersproject/abi");
const { keccak256 } = require("@ethersproject/keccak256");

const ARTIFACTS = path.dirname(require.resolve("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json"));
const FACTORY = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const POOL = require(path.join(ARTIFACTS, "UniswapV3Pool.json"));

const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const MaxUint256 = (1n << 256n) - 1n;

// storage slots of UniswapV3Pool and UniswapV3Factory
const POOL_SLOTS = { feeGrowthGlobal0X128: 1n, feeGrowthGlobal1X128: 2n };
const FACTORY_FEE_AMOUNT_TICK_SPACING_SLOT = 4n;

/** compiles TestHelpers.sol with solc 0.7.6 (cached in tests/build) */
function helpers() {
  const source = fs.readFileSync(path.join(__dirname, "TestHelpers.sol"), "utf8");
  const solcVersion = require("solc/package.json").version;
  const hash = crypto.createHash("sha256").update(source).update(solcVersion).digest("hex");
  const cache = path.join(__dirname, "..", "..", "build", "evm-test-helpers.json");
  if (fs.existsSync(cache)) {
    const cached = JSON.parse(fs.readFileSync(cache, "utf8"));
    if (cached.hash === hash) return cached.contracts;
  }
  const solc = require("solc");
  const input = {
    language: "Solidity",
    sources: { "TestHelpers.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const contracts = {};
  for (const [name, c] of Object.entries(output.contracts["TestHelpers.sol"])) {
    contracts[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
  }
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify({ hash, contracts }));
  return contracts;
}

class EvmRevert extends Error {}

const toBig = (v) => (v && v._isBigNumber ? BigInt(v.toString()) : typeof v === "number" ? BigInt(v) : v);
const addressOf = (a) => (typeof a === "string" ? a : a.address);
const word = (v) => setLengthLeft(bigIntToBytes(BigInt(v)), 32);

/** decodes the revert reason (Error(string)) of a failed call */
function revertReason(returnValue) {
  const hex = bytesToHex(returnValue);
  if (hex.startsWith("0x08c379a0")) return defaultAbiCoder.decode(["string"], "0x" + hex.slice(10))[0];
  return hex === "0x" ? "reverted without a reason" : hex;
}

class UniswapEVM {
  constructor(gasLimit) {
    this.evm = new EVM({ allowUnlimitedContractSize: true });
    this.gasLimit = BigInt(gasLimit);
    this.time = 0n;
    this.contracts = {};
    this.interfaces = {};
    this.wallet = { address: this._account("wallet") };
    this.other = { address: this._account("other") };
  }

  /**
   * a fresh EVM with the factory, 3 sorted tokens and the test callee (Uniswap: poolFixture);
   * gasLimit: of every call (the Ethereum block gas limit by default)
   */
  static async create({ time = 1601906400, tokenSupply = MaxUint256, gasLimit = 30000000n } = {}) {
    const uni = new UniswapEVM(gasLimit);
    uni.time = BigInt(time);
    const h = helpers();
    uni.factory = await uni.deploy("UniswapV3Factory", FACTORY.abi, FACTORY.bytecode);
    const tokens = [];
    for (let i = 0; i < 3; i++) tokens.push(await uni.deploy("TestToken", h.TestToken.abi, h.TestToken.bytecode, [tokenSupply]));
    tokens.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    [uni.token0, uni.token1, uni.token2] = tokens;
    uni.callee = await uni.deploy("TestCallee", h.TestCallee.abi, h.TestCallee.bytecode);
    for (const token of tokens) await token.send("approve", [uni.callee.address, MaxUint256]);
    return uni;
  }

  _account(name) {
    return "0x" + crypto.createHash("sha256").update(`uniswap-evm:${name}`).digest("hex").slice(0, 40);
  }

  _block() {
    return {
      header: {
        number: 1n,
        cliqueSigner: () => Address.zero(),
        coinbase: Address.zero(),
        timestamp: this.time,
        difficulty: 0n,
        prevRandao: new Uint8Array(32),
        gasLimit: 30000000n,
        baseFeePerGas: undefined,
        getBlobGasPrice: () => undefined,
      },
    };
  }

  advanceTime(seconds) {
    this.time += BigInt(seconds);
  }

  async _run(from, to, data) {
    const res = await this.evm.runCall({
      caller: Address.fromString(addressOf(from)),
      to: to ? Address.fromString(to) : undefined,
      data: hexToBytes(data),
      gasLimit: this.gasLimit,
      skipBalance: true,
      block: this._block(),
    });
    if (res.execResult.exceptionError) {
      // a nested call out of gas makes the caller revert without a reason, with (almost) all the gas used
      if (res.execResult.executionGasUsed >= (this.gasLimit * 63n) / 64n) throw new EvmRevert("out of gas");
      throw new EvmRevert(revertReason(res.execResult.returnValue));
    }
    return res;
  }

  _decodeLogs(logs) {
    const events = [];
    for (const [address, topics, data] of logs || []) {
      const contract = this.contracts[bytesToHex(address).toLowerCase()];
      if (!contract) continue;
      try {
        const parsed = contract.iface.parseLog({ topics: topics.map(bytesToHex), data: bytesToHex(data) });
        const args = {};
        parsed.eventFragment.inputs.forEach((input, i) => (args[input.name] = toBig(parsed.args[i])));
        events.push({ address: contract.address, contract: contract.name, name: parsed.name, args });
      } catch (e) {
        // not an event of this contract
      }
    }
    return events;
  }

  async deploy(name, abi, bytecode, args = []) {
    const iface = new Interface(abi);
    const res = await this._run(this.wallet, undefined, bytecode + iface.encodeDeploy(args).slice(2));
    return this.at(name, abi, res.createdAddress.toString());
  }

  at(name, abi, address) {
    const iface = new Interface(abi);
    const contract = new EvmContract(this, name, iface, address);
    this.contracts[address.toLowerCase()] = contract;
    return contract;
  }

  async getStorage(address, slot) {
    const value = await this.evm.stateManager.getContractStorage(Address.fromString(address), word(slot));
    return value.length ? BigInt(bytesToHex(value)) : 0n;
  }

  async setStorage(address, slot, value) {
    await this.evm.stateManager.putContractStorage(Address.fromString(address), word(slot), word(value));
  }

  /** factory.createPool; a tick spacing other than the enabled one is set in the factory storage */
  async createPool(fee, tickSpacing, firstToken = this.token0, secondToken = this.token1) {
    const slot = BigInt(keccak256(defaultAbiCoder.encode(["uint256", "uint256"], [fee, FACTORY_FEE_AMOUNT_TICK_SPACING_SLOT])));
    const enabled = await this.getStorage(this.factory.address, slot);
    await this.setStorage(this.factory.address, slot, BigInt(tickSpacing));
    await this.factory.send("createPool", [firstToken.address, secondToken.address, fee]);
    await this.setStorage(this.factory.address, slot, enabled);
    const address = await this.factory.call("getPool", [firstToken.address, secondToken.address, fee]);
    const pool = new EvmPool(this, this.at("UniswapV3Pool", POOL.abi, address));
    return pool;
  }

  /** token transfers (Transfer events) of a token in a list of events */
  transfers(events, token) {
    return events
      .filter((e) => e.address === token.address && e.name === "Transfer")
      .map((e) => ({ from: e.args.from, to: e.args.to, value: e.args.value }));
  }
}

class EvmContract {
  constructor(uni, name, iface, address) {
    this.uni = uni;
    this.name = name;
    this.iface = iface;
    this.address = address;
  }

  async call(method, args = []) {
    const res = await this.uni._run(this.uni.wallet, this.address, this.iface.encodeFunctionData(method, args));
    const decoded = this.iface.decodeFunctionResult(method, bytesToHex(res.execResult.returnValue));
    return decoded.length === 1 ? toBig(decoded[0]) : decoded;
  }

  async send(method, args = [], from = this.uni.wallet) {
    const res = await this.uni._run(from, this.address, this.iface.encodeFunctionData(method, args));
    const result = this.iface.decodeFunctionResult(method, bytesToHex(res.execResult.returnValue));
    return { result, events: this.uni._decodeLogs(res.execResult.logs) };
  }

  /** executes without committing the state changes (ethers: callStatic) */
  async callStatic(method, args = [], from = this.uni.wallet) {
    const sm = this.uni.evm.stateManager;
    await sm.checkpoint();
    try {
      return (await this.send(method, args, from)).result;
    } finally {
      await sm.revert();
    }
  }

  async balanceOf(account) {
    return this.call("balanceOf", [addressOf(account)]);
  }
}

/** the Uniswap pool with the API of the KoinDX PoolClient (fixtures.js) and createPoolFunctions */
class EvmPool {
  constructor(uni, contract) {
    this.uni = uni;
    this.contract = contract;
    this.address = contract.address;
  }

  async slot0() {
    const s = await this.contract.call("slot0");
    return {
      sqrtPriceX96: toBig(s.sqrtPriceX96),
      tick: s.tick,
      observationIndex: s.observationIndex,
      observationCardinality: s.observationCardinality,
      observationCardinalityNext: s.observationCardinalityNext,
      feeProtocol: s.feeProtocol,
      unlocked: s.unlocked,
    };
  }
  liquidity() {
    return this.contract.call("liquidity");
  }
  feeGrowthGlobal0X128() {
    return this.contract.call("feeGrowthGlobal0X128");
  }
  feeGrowthGlobal1X128() {
    return this.contract.call("feeGrowthGlobal1X128");
  }
  async protocolFees() {
    const p = await this.contract.call("protocolFees");
    return { token0: toBig(p.token0), token1: toBig(p.token1) };
  }
  async ticks(tick) {
    const t = await this.contract.call("ticks", [tick]);
    return {
      liquidityGross: toBig(t.liquidityGross),
      liquidityNet: toBig(t.liquidityNet),
      feeGrowthOutside0X128: toBig(t.feeGrowthOutside0X128),
      feeGrowthOutside1X128: toBig(t.feeGrowthOutside1X128),
      tickCumulativeOutside: toBig(t.tickCumulativeOutside),
      secondsPerLiquidityOutsideX128: toBig(t.secondsPerLiquidityOutsideX128),
      secondsOutside: t.secondsOutside,
      initialized: t.initialized,
    };
  }
  async positions(owner, tickLower, tickUpper) {
    // keccak256(abi.encodePacked(owner, tickLower, tickUpper))
    const int24 = (t) => (BigInt(t) & 0xffffffn).toString(16).padStart(6, "0");
    const key = keccak256("0x" + addressOf(owner).slice(2).toLowerCase() + int24(tickLower) + int24(tickUpper));
    const p = await this.contract.call("positions", [key]);
    return {
      liquidity: toBig(p.liquidity),
      feeGrowthInside0LastX128: toBig(p.feeGrowthInside0LastX128),
      feeGrowthInside1LastX128: toBig(p.feeGrowthInside1LastX128),
      tokensOwed0: toBig(p.tokensOwed0),
      tokensOwed1: toBig(p.tokensOwed1),
    };
  }
  async observations(index) {
    const o = await this.contract.call("observations", [index]);
    return {
      blockTimestamp: o.blockTimestamp,
      tickCumulative: toBig(o.tickCumulative),
      secondsPerLiquidityCumulativeX128: toBig(o.secondsPerLiquidityCumulativeX128),
      initialized: o.initialized,
    };
  }
  async snapshotCumulativesInside(tickLower, tickUpper) {
    const s = await this.contract.call("snapshotCumulativesInside", [tickLower, tickUpper]);
    return { tickCumulativeInside: toBig(s.tickCumulativeInside), secondsPerLiquidityInsideX128: toBig(s.secondsPerLiquidityInsideX128), secondsInside: s.secondsInside };
  }
  async observe(secondsAgos) {
    const o = await this.contract.call("observe", [secondsAgos]);
    return { tickCumulatives: o.tickCumulatives.map(toBig), secondsPerLiquidityCumulativeX128s: o.secondsPerLiquidityCumulativeX128s.map(toBig) };
  }

  initialize(sqrtPriceX96) {
    return this.contract.send("initialize", [sqrtPriceX96]);
  }
  burn(tickLower, tickUpper, amount, from = this.uni.wallet) {
    return this.contract.send("burn", [tickLower, tickUpper, amount], from);
  }
  collect(recipient, tickLower, tickUpper, amount0Requested, amount1Requested, from = this.uni.wallet) {
    return this.contract.send("collect", [addressOf(recipient), tickLower, tickUpper, amount0Requested, amount1Requested], from);
  }
  async collectStatic(recipient, tickLower, tickUpper, amount0Requested, amount1Requested, from = this.uni.wallet) {
    const r = await this.contract.callStatic("collect", [addressOf(recipient), tickLower, tickUpper, amount0Requested, amount1Requested], from);
    return { amount0: toBig(r.amount0), amount1: toBig(r.amount1) };
  }
  increaseObservationCardinalityNext(next) {
    return this.contract.send("increaseObservationCardinalityNext", [next]);
  }
  setFeeProtocol(feeProtocol0, feeProtocol1, from = this.uni.wallet) {
    return this.contract.send("setFeeProtocol", [feeProtocol0, feeProtocol1], from);
  }
  collectProtocol(recipient, amount0Requested, amount1Requested, from = this.uni.wallet) {
    return this.contract.send("collectProtocol", [addressOf(recipient), amount0Requested, amount1Requested], from);
  }
  async collectProtocolStatic(recipient, amount0Requested, amount1Requested, from = this.uni.wallet) {
    const r = await this.contract.callStatic("collectProtocol", [addressOf(recipient), amount0Requested, amount1Requested], from);
    return { amount0: toBig(r.amount0), amount1: toBig(r.amount1) };
  }
  advanceTime(seconds) {
    this.uni.advanceTime(seconds);
  }
  setFeeGrowthGlobal0X128(value) {
    return this.uni.setStorage(this.address, POOL_SLOTS.feeGrowthGlobal0X128, value);
  }
  setFeeGrowthGlobal1X128(value) {
    return this.uni.setStorage(this.address, POOL_SLOTS.feeGrowthGlobal1X128, value);
  }

  // createPoolFunctions (through the test callee, paid by `from`)
  mint(recipient, tickLower, tickUpper, liquidity, from = this.uni.wallet) {
    return this.uni.callee.send("mint", [this.address, addressOf(recipient), tickLower, tickUpper, liquidity], from);
  }
  swap(zeroForOne, amountSpecified, to, sqrtPriceLimitX96, from = this.uni.wallet) {
    if (sqrtPriceLimitX96 === undefined) sqrtPriceLimitX96 = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
    return this.uni.callee.send("swap", [this.address, addressOf(to), zeroForOne, amountSpecified, sqrtPriceLimitX96], from);
  }
  swapExact0For1(amount, to, sqrtPriceLimitX96) {
    return this.swap(true, BigInt(amount), to, sqrtPriceLimitX96);
  }
  swap0ForExact1(amount, to, sqrtPriceLimitX96) {
    return this.swap(true, -BigInt(amount), to, sqrtPriceLimitX96);
  }
  swapExact1For0(amount, to, sqrtPriceLimitX96) {
    return this.swap(false, BigInt(amount), to, sqrtPriceLimitX96);
  }
  swap1ForExact0(amount, to, sqrtPriceLimitX96) {
    return this.swap(false, -BigInt(amount), to, sqrtPriceLimitX96);
  }
  /** Uniswap swaps to a price with amountSpecified = type(int256).max */
  swapToLowerPrice(sqrtPriceX96, to, amountSpecified = (1n << 255n) - 1n) {
    return this.swap(true, amountSpecified, to, sqrtPriceX96);
  }
  swapToHigherPrice(sqrtPriceX96, to, amountSpecified = (1n << 255n) - 1n) {
    return this.swap(false, amountSpecified, to, sqrtPriceX96);
  }
  async flash(amount0, amount1, to, pay0, pay1) {
    const fee = BigInt(await this.contract.call("fee"));
    if (pay0 === undefined) pay0 = (BigInt(amount0) * fee + 999999n) / 1000000n + BigInt(amount0);
    if (pay1 === undefined) pay1 = (BigInt(amount1) * fee + 999999n) / 1000000n + BigInt(amount1);
    return this.uni.callee.send("flash", [this.address, addressOf(to), amount0, amount1, pay0, pay1]);
  }
}

module.exports = { UniswapEVM, EvmPool, EvmRevert, MIN_SQRT_RATIO, MAX_SQRT_RATIO };
