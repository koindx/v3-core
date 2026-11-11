// Attacks that are specific to Koinos (they don't exist on Ethereum, so the Uniswap tests don't
// cover them): a pool is uploaded by any account, whose key must have no power over it; the
// authority of the accounts that call the pool directly (`owner`); the creation of pools from the
// upload in the transaction; token identifiers are strings and addresses are bytes.
const { utils } = require("koilib");
const { koinos } = require("@koinos/proto-js");
const { entryPoint, addressBytes, AUTHORIZE_ENTRY_POINT } = require("./vm/koinos-vm");
const { tokenContract, TestToken, TOKEN_ENTRIES, KCS4_TYPES } = require("./vm/token");
const { poolFixture, createPoolFunctions, contract } = require("./uniswap/shared/fixtures");
const { expectRevert } = require("./uniswap/shared/contracts");
const tc = require("./uniswap/shared/test-contracts");
const { encodePriceSqrt, getMinTick, getMaxTick, MaxUint64, MIN_SQRT_RATIO } = require("./uniswap/shared/utilities");

describe("Koinos security: pools", () => {
  let fixture, vm, wallet, other, pool, fns;
  const [tickLower, tickUpper] = [getMinTick(60), getMaxTick(60)];

  beforeEach(() => {
    fixture = poolFixture();
    ({ vm, wallet, other } = fixture);
    pool = fixture.createPool(3000, 60);
    fns = createPoolFunctions({ fixture, swapTarget: fixture.swapTargetCallee, token0: fixture.token0, token1: fixture.token1, pool });
    pool.initialize(encodePriceSqrt(1, 1));
    fns.mint(wallet, tickLower, tickUpper, 10n ** 12n);
    fns.swapExact0For1(10n ** 9n, wallet);
  });

  it("the account that uploaded a pool can't move its tokens", () => {
    // the pool overrides its contract call authority and its `authorize` always says no
    expectRevert(() => fixture.token0.transfer(pool.address, other.address, 1), "account 'from' has not authorized transfer");
    expectRevert(() => fixture.token1.transfer(pool.address, other.address, 1), "account 'from' has not authorized transfer");
  });

  it("the account that uploaded a pool can't upgrade its code", () => {
    expectRevert(
      () =>
        vm.transaction({
          signers: [pool.address],
          operations: [{ upload: { contractId: pool.address, bytecode: contract("factory").wasm } }],
        }),
      "account has not authorized contract upload"
    );
  });

  it("the account that uploaded a pool can't burn or collect the positions", () => {
    const burn = (from, owner) => pool.send(from, "burn", { tickLower, tickUpper, amount: "1", owner: owner.address });
    const collect = (from, owner) =>
      pool.send(from, "collect", { recipient: other.address, tickLower, tickUpper, amount0Requested: MaxUint64.toString(), amount1Requested: MaxUint64.toString(), owner: owner.address });
    const poolAccount = { address: pool.address };
    expectRevert(() => burn(poolAccount, wallet), "KOINDX: UNAUTHORIZED");
    expectRevert(() => collect(poolAccount, wallet), "KOINDX: UNAUTHORIZED");
    // nor any other account
    expectRevert(() => burn(other, wallet), "KOINDX: UNAUTHORIZED");
    expectRevert(() => collect(other, wallet), "KOINDX: UNAUTHORIZED");
  });

  it("a contract can only act on its own positions", () => {
    const attacker = vm.account("attacker contract").address;
    vm.deployNative(attacker, (ctx, entry, args) => {
      const owner = JSON.parse(Buffer.from(args).toString()).owner;
      ctx.call(pool.address, pool.codec.method("burn").entry_point, pool.encodeArgs("burn", { tickLower, tickUpper, amount: "1", owner }));
    });
    const call = (owner) => vm.transaction({ signers: [other.address], operations: [{ call: { contractId: attacker, entryPoint: 1, args: Buffer.from(JSON.stringify({ owner })) } }] });
    expectRevert(() => call(wallet.address), "KOINDX: CALLER_IS_UNAUTHORIZED");
    // with an empty owner the position is the one of the calling contract (empty here)
    expectRevert(() => call(""), "KOINDX: LIQUIDITY_SUB");
  });

  it("a pool can't be configured again, by the factory or anybody else", () => {
    const configure = { token0: { tokenAddress: fixture.token0.address }, token1: { tokenAddress: fixture.token1.address }, fee: 500, tickSpacing: 10 };
    // from a transaction (no calling contract)
    expectRevert(() => pool.send(other, "configure", configure), "KOINDX: FORBIDDEN");
    // from a contract
    expectRevert(
      () =>
        vm.transaction({
          signers: [wallet.address],
          operations: [{ call: { contractId: fixture.deployer.address, entryPoint: entryPoint("deploy"), args: Buffer.from(JSON.stringify({ pool: pool.address, token0: fixture.token1.address, token1: fixture.token0.address, fee: 500, tickSpacing: 10 })) } }],
        }),
      "KOINDX: ERROR_IN_VERIFICATION_OF_SPACES"
    );
    expect(pool.immutables().fee).toEqual(3000);
  });

  it("a payout that the token doesn't make reverts (Uniswap: TF)", () => {
    // a token that returns without moving the tokens while it is paused (the first KCS-1 tokens
    // returned `value: false`, encoded as empty bytes like a successful transfer)
    const { address } = vm.account("token:silent");
    let paused = false;
    const token = tokenContract("SIL");
    vm.deployNative(address, (ctx, entry, args) => (paused && entry === TOKEN_ENTRIES.transfer ? new Uint8Array(0) : token(ctx, entry, args)));
    const silent = new TestToken(vm, address, "SIL");
    silent.mint(wallet.address, MaxUint64);
    for (const owner of [wallet, other]) silent.approve(owner.address, fixture.swapTargetCallee.address, MaxUint64);
    const [token0, token1] = [silent, fixture.token1].sort((a, b) => (a.address < b.address ? -1 : 1));
    const silentPool = fixture.createPool(3000, 60, token0, token1);
    const silentFns = createPoolFunctions({ fixture, swapTarget: fixture.swapTargetCallee, token0, token1, pool: silentPool });
    silentPool.initialize(encodePriceSqrt(1, 1));
    silentFns.mint(wallet, tickLower, tickUpper, 10n ** 12n);
    silentPool.burn(tickLower, tickUpper, 10n ** 6n);

    paused = true;
    // the output of a swap
    const swapForSilent = silent === token0 ? silentFns.swapExact1For0 : silentFns.swapExact0For1;
    expectRevert(() => swapForSilent(1000n, other), "KOINDX: TRANSFER_FAILED");
    // the tokens owed to a position
    expectRevert(() => silentPool.collect(other, tickLower, tickUpper, MaxUint64, MaxUint64), "KOINDX: TRANSFER_FAILED");
    // and the payments to the pool (balance checks of Uniswap)
    const swapSilent = silent === token0 ? silentFns.swapExact0For1 : silentFns.swapExact1For0;
    expectRevert(() => swapSilent(1000n, other), "KOINDX: IIA");

    paused = false;
    swapForSilent(1000n, other);
    silentPool.collect(other, tickLower, tickUpper, MaxUint64, MaxUint64);
  });

  it("rejects malformed recipient addresses (bytes of any length are valid in the ABI)", () => {
    const shortAddress = utils.encodeBase58(addressBytes(other.address).subarray(0, 24));
    expectRevert(() => fns.swapExact0For1(1000n, shortAddress), "KOINDX: INVALID_RECIPIENT");
    expectRevert(() => fns.mint(shortAddress, tickLower, tickUpper, 1000n), "KOINDX: INVALID_RECIPIENT");
    expectRevert(() => fns.flash(10n, 10n, shortAddress), "KOINDX: INVALID_RECIPIENT");
    expectRevert(() => pool.collect(shortAddress, tickLower, tickUpper, MaxUint64, MaxUint64), "KOINDX: INVALID_RECIPIENT");
  });
});

describe("Koinos security: calls to other contracts while the pool state is loaded", () => {
  // On Koinos the authority check of an account can run code: the `authorize` of a smart wallet
  // (a contract account), and every call is writable (no `staticcall`, a token `balance_of` can
  // call back). Uniswap's `lock` reverts any reentry (LOK); here a pool operation that runs during
  // such a call must not be lost, i.e. the pool never saves a state loaded before it.
  let fixture, vm, wallet, pool, fns, smartWallet, onAuthorize;
  const [tickLower, tickUpper] = [getMinTick(60), getMaxTick(60)];

  beforeEach(() => {
    fixture = poolFixture();
    ({ vm, wallet } = fixture);
    pool = fixture.createPool(3000, 60);
    fns = createPoolFunctions({ fixture, swapTarget: fixture.swapTargetCallee, token0: fixture.token0, token1: fixture.token1, pool });
    pool.initialize(encodePriceSqrt(1, 1));
    fns.mint(wallet, tickLower, tickUpper, 10n ** 12n);
    // a smart wallet (it overrides its contract call authority) that runs `onAuthorize` once
    smartWallet = vm.account("smart wallet").address;
    onAuthorize = null;
    vm.deployNative(
      smartWallet,
      (ctx, entry) => {
        if (entry !== AUTHORIZE_ENTRY_POINT) ctx.revert("unknown entry point");
        const hook = onAuthorize;
        onAuthorize = null;
        if (hook) hook(ctx);
        return koinos.chain.authorize_result.encode({ value: true }).finish();
      },
      { authorizesCallContract: true }
    );
    fns.mint(smartWallet, tickLower, tickUpper, 10n ** 9n);
    fns.swapExact0For1(10n ** 6n, wallet);
  });

  /** a swap of the wallet made from `ctx` (a contract called during the operation) */
  const swapFrom = (ctx) => {
    const args = { amount: 10n ** 8n, recipient: wallet.address, sqrtPriceLimitX96: MIN_SQRT_RATIO + 1n, pool: pool.address, payer: wallet.address };
    ctx.call(fixture.swapTargetCallee.address, entryPoint("swapExact0For1"), tc.json(args));
    const s = pool.decodeResult("slot0", ctx.call(pool.address, pool.codec.method("slot0").entry_point, pool.encodeArgs("slot0")));
    return { ...s, sqrtPriceX96: BigInt(s.sqrtPriceX96) };
  };

  it("burn and collect: a swap made during the authorize of the owner is kept", () => {
    for (const operation of [
      () => pool.send(wallet, "burn", { tickLower, tickUpper, amount: "1000", owner: smartWallet }),
      () => pool.send(wallet, "collect", { recipient: smartWallet, tickLower, tickUpper, amount0Requested: "1", amount1Requested: "1", owner: smartWallet }),
    ]) {
      let afterSwap;
      onAuthorize = (ctx) => (afterSwap = swapFrom(ctx));
      operation();
      expect(afterSwap.unlocked).toBe(true);
      expect(pool.slot0()).toEqual(afterSwap);
    }
  });

  it("set_fee_protocol and collect_protocol: the pool is locked during the authorize of the factory owner", () => {
    pool.setFeeProtocol(4, 4);
    fns.swapExact0For1(10n ** 8n, wallet);
    fixture.factory.send(wallet, "set_owner", { owner: smartWallet });
    // the smart wallet accepts the ownership (its authorize returns true, anybody can send it)
    fixture.factory.send(wallet, "accept_owner", {});
    const setFeeProtocol = () => pool.send(wallet, "set_fee_protocol", { feeProtocol0: 5, feeProtocol1: 5 });
    const collectProtocol = () =>
      pool.send(wallet, "collect_protocol", { recipient: wallet.address, amount0Requested: MaxUint64.toString(), amount1Requested: MaxUint64.toString() });
    // Uniswap: lock, then onlyFactoryOwner (LOK)
    for (const operation of [setFeeProtocol, collectProtocol]) {
      const before = pool.slot0();
      onAuthorize = swapFrom;
      expectRevert(operation, "KOINDX: LOCKED");
      expect(pool.slot0()).toEqual(before);
    }
    setFeeProtocol();
    collectProtocol();
    expect(pool.slot0().feeProtocol).toEqual(5 + (5 << 4));
    expect(pool.protocolFees().token0).toEqual(1n);
  });

  it("flash: the token balances are read with the pool locked", () => {
    // a token whose `balance_of` calls the pool back
    const { address } = vm.account("token:callback");
    const token = tokenContract("CBK");
    let onBalanceOf = null;
    vm.deployNative(address, (ctx, entry, args) => {
      if (entry === TOKEN_ENTRIES.balance_of && onBalanceOf) {
        const hook = onBalanceOf;
        onBalanceOf = null;
        hook(ctx);
      }
      return token(ctx, entry, args);
    });
    const callback = new TestToken(vm, address, "CBK");
    callback.mint(wallet.address, MaxUint64);
    callback.approve(wallet.address, fixture.swapTargetCallee.address, MaxUint64);
    const [token0, token1] = [callback, fixture.token1].sort((a, b) => (a.address < b.address ? -1 : 1));
    const callbackPool = fixture.createPool(3000, 60, token0, token1);
    const callbackFns = createPoolFunctions({ fixture, swapTarget: fixture.swapTargetCallee, token0, token1, pool: callbackPool });
    callbackPool.initialize(encodePriceSqrt(1, 1));
    callbackFns.mint(wallet, tickLower, tickUpper, 10n ** 12n);

    onBalanceOf = (ctx) => ctx.call(callbackPool.address, callbackPool.codec.method("increase_observation_cardinality_next").entry_point, callbackPool.encodeArgs("increase_observation_cardinality_next", { observationCardinalityNext: 10 }));
    expectRevert(() => callbackFns.flash(1000n, 1000n, wallet.address), "KOINDX: LOCKED");
    expect(callbackPool.slot0().observationCardinalityNext).toEqual(1);
    callbackFns.flash(1000n, 1000n, wallet.address);
  });
});

describe("Koinos security: factory ownership with smart wallets", () => {
  // the two-step ownership transfer reads the owner / the proposal, then checks an authority, which
  // can run the code of a smart wallet: the owner and the proposal are checked again after it
  let fixture, vm, wallet, factory, hooks;

  const EXECUTE = 1;
  /**
   * a smart wallet that runs hooks[address] once when its authority is checked, and whose entry
   * point EXECUTE calls a factory method (JSON { method, args }) as this wallet (the caller)
   */
  const smartWallet = (name) => {
    const { address } = vm.account(name);
    vm.deployNative(
      address,
      (ctx, entry, args) => {
        if (entry === EXECUTE) {
          const { method, args: methodArgs } = JSON.parse(Buffer.from(args).toString());
          ctx.call(factory.address, factory.codec.method(method).entry_point, factory.encodeArgs(method, methodArgs));
          return new Uint8Array(0);
        }
        if (entry !== AUTHORIZE_ENTRY_POINT) ctx.revert("unknown entry point");
        const hook = hooks[address];
        delete hooks[address];
        if (hook) hook(ctx);
        return koinos.chain.authorize_result.encode({ value: true }).finish();
      },
      { authorizesCallContract: true }
    );
    return address;
  };
  /** makes `wallet` (a smart wallet) call the factory method from `ctx` */
  const callFactoryAs = (ctx, wallet, method, args) => ctx.call(wallet, EXECUTE, Buffer.from(JSON.stringify({ method, args })));

  beforeEach(() => {
    fixture = poolFixture();
    ({ vm, wallet, factory } = fixture);
    hooks = {};
  });

  it("accept_owner reverts if the proposal changes during the authorize of the proposed owner", () => {
    const owner = smartWallet("owner wallet");
    const proposed = smartWallet("proposed wallet");
    const other = smartWallet("other wallet");
    factory.send(wallet, "set_owner", { owner });
    factory.send(wallet, "accept_owner", {});
    factory.send(wallet, "set_owner", { owner: proposed });
    // while the proposed owner authorizes accept_owner, a new proposal replaces it (the owner, a
    // smart wallet, authorizes set_owner)
    hooks[proposed] = (ctx) => callFactoryAs(ctx, owner, "set_owner", { owner: other });
    expectRevert(() => factory.send(wallet, "accept_owner", {}), "KOINDX: NO_PENDING_OWNER");
    expect(factory.read("owner").value).toEqual(owner);
    expect(factory.read("pending_owner").value).toEqual(proposed);
    // without the hook the proposed owner accepts
    factory.send(wallet, "accept_owner", {});
    expect(factory.read("owner").value).toEqual(proposed);
  });

  it("set_owner reverts if the owner changes during its authorize", () => {
    const owner = smartWallet("owner wallet");
    const next = smartWallet("next wallet");
    factory.send(wallet, "set_owner", { owner });
    factory.send(wallet, "accept_owner", {});
    factory.send(wallet, "set_owner", { owner: next });
    // while the owner authorizes a new proposal, the pending owner accepts: the owner changed
    hooks[owner] = (ctx) => callFactoryAs(ctx, next, "accept_owner", {});
    expectRevert(() => factory.send(wallet, "set_owner", { owner: wallet.address }), "KOINDX: FORBIDDEN");
    expect(factory.read("owner").value).toEqual(owner);
    expect(factory.read("pending_owner").value).toEqual(next);
    // the smart wallet can call the factory as itself (what the hook does)
    vm.transaction({ signers: [wallet.address], operations: [{ call: { contractId: next, entryPoint: EXECUTE, args: Buffer.from(JSON.stringify({ method: "accept_owner", args: {} })) } }] });
    expect(factory.read("owner").value).toEqual(next);
  });
});

describe("Koinos security: pool creation", () => {
  let fixture, vm, wallet, other, factory;
  let counter = 0;

  beforeEach(() => {
    fixture = poolFixture();
    ({ vm, wallet, other, factory } = fixture);
  });

  /** the upload of the pool bytecode to `account`, with the 3 authority overrides */
  const poolUpload = (account) => ({
    upload: { contractId: account.address, bytecode: contract("pool").wasm, authorizesCallContract: true, authorizesTransactionApplication: true, authorizesUploadContract: true },
  });
  const createPoolOp = (tokenA = fixture.token0.address, tokenB = fixture.token1.address) => factory.operation("create_pool", { tokenA, tokenB, fee: 3000 });
  const registered = (tokenA = fixture.token0.address, tokenB = fixture.token1.address) => factory.read("get_pool", { tokenA, tokenB, fee: 3000 }).value || "";
  const SEED = 1;

  /**
   * An account with code uploaded before the pool (the key of an address can upload any code): it
   * answers `configure` and SEED by writing a record in the storage space of the pool positions,
   * and runs `onAuthorize` when its authority is checked (if it overrides it)
   */
  function accountWithPreviousCode(name, { onAuthorize = null, overrides = {} } = {}) {
    const account = vm.account(name);
    const configure = contract("pool").codec.method("configure").entry_point;
    vm.deployNative(
      account.address,
      (ctx, entry) => {
        if (entry === AUTHORIZE_ENTRY_POINT) {
          if (onAuthorize) onAuthorize(ctx);
          return koinos.chain.authorize_result.encode({ value: true }).finish();
        }
        if (entry !== configure && entry !== SEED) ctx.revert("unknown entry point");
        ctx.put(4, Buffer.from("a position owed all the tokens"), Buffer.from("seeded"));
        return new Uint8Array(0);
      },
      overrides
    );
    return account;
  }

  it("F11: the pool must be uploaded before create_pool (configure must run the pool code)", () => {
    const account = accountWithPreviousCode("previous code, upload after create_pool");
    // configure would run the previous code of the address, which seeds the storage of the pool
    expectRevert(() => vm.transaction({ signers: [account.address, wallet.address], operations: [createPoolOp(), poolUpload(account)] }), "KOINDX: POOL_UPLOAD_MUST_COME_FIRST");
    // every call to the factory must come after the upload
    expectRevert(
      () => vm.transaction({ signers: [account.address, wallet.address], operations: [factory.operation("owner"), poolUpload(account), createPoolOp()] }),
      "KOINDX: POOL_UPLOAD_MUST_COME_FIRST"
    );
    expect(registered()).toEqual("");
  });

  it("F11: create_pool can't be called by a contract (e.g. from the authorize of the upload)", () => {
    // the previous code overrides its upload authority: Koinos runs its authorize to check the
    // upload, before the new code is stored, and it calls create_pool from there
    const callCreatePool = (ctx) => {
      const op = createPoolOp().call;
      ctx.call(factory.address, op.entryPoint, op.args);
    };
    const account = accountWithPreviousCode("previous code, create_pool from authorize", { onAuthorize: callCreatePool, overrides: { authorizesUploadContract: true } });
    expectRevert(() => vm.transaction({ signers: [wallet.address], operations: [poolUpload(account)] }), "KOINDX: CREATE_POOL_MUST_BE_AN_OPERATION");
    expectRevert(() => vm.transaction({ signers: [wallet.address], operations: [poolUpload(account), createPoolOp()] }), "KOINDX: CREATE_POOL_MUST_BE_AN_OPERATION");
    // nor by any other contract, even after the upload
    const creator = vm.account("pool creator contract").address;
    vm.deployNative(creator, (ctx) => {
      callCreatePool(ctx);
      return new Uint8Array(0);
    });
    const fresh = vm.account("fresh pool address");
    expectRevert(
      () => vm.transaction({ signers: [fresh.address, wallet.address], operations: [poolUpload(fresh), { call: { contractId: creator, entryPoint: 1, args: new Uint8Array(0) } }] }),
      "KOINDX: CREATE_POOL_MUST_BE_AN_OPERATION"
    );
    expect(registered()).toEqual("");
  });

  it("F11: storage written by the previous code of the address is rejected by the pool", () => {
    const account = accountWithPreviousCode("previous code, seeded before");
    vm.transaction({ signers: [wallet.address], operations: [{ call: { contractId: account.address, entryPoint: SEED, args: new Uint8Array(0) } }] });
    // a normal creation: configure runs the pool code, which finds the seeded storage
    expectRevert(() => vm.transaction({ signers: [account.address, wallet.address], operations: [poolUpload(account), createPoolOp()] }), "KOINDX: ERROR_IN_VERIFICATION_OF_SPACES");
    expect(registered()).toEqual("");
  });

  it("F12: rejects a pool address that approved spenders of the pool tokens", () => {
    const thief = vm.account("thief").address;
    // in the creation transaction, before the upload
    const a = vm.account("approves in the creation transaction");
    expectRevert(
      () => vm.transaction({ signers: [a.address, wallet.address], operations: [fixture.token0.approveOperation(a.address, thief, MaxUint64), poolUpload(a), createPoolOp()] }),
      "KOINDX: POOL_HAS_ALLOWANCES"
    );
    // in an earlier transaction, on either token
    const b = vm.account("approved before");
    fixture.token1.approve(b.address, thief, 1n);
    expectRevert(() => vm.transaction({ signers: [b.address, wallet.address], operations: [poolUpload(b), createPoolOp()] }), "KOINDX: POOL_HAS_ALLOWANCES");
    // once revoked, the pool can be created
    fixture.token1.approve(b.address, thief, 0n);
    vm.transaction({ signers: [b.address, wallet.address], operations: [poolUpload(b), createPoolOp()] });
    expect(registered()).toEqual(b.address);
  });

  it("F12: reads every page of the allowances of the pool", () => {
    // a token that lists 20 allowances of 0 (a full page), then `last` on the second page
    let last = null;
    const { address } = vm.account("token:paged allowances");
    const token = tokenContract("PGD");
    const spender = (i) => addressBytes(vm.account(`paged spender ${i}`).address);
    const zeros = Array.from({ length: 20 }, (_, i) => ({ spender: spender(i), value: "0" }));
    vm.deployNative(address, (ctx, entry, args) => {
      if (entry !== TOKEN_ENTRIES.get_allowances) return token(ctx, entry, args);
      const { owner, start, limit } = KCS4_TYPES.get_allowances_arguments.decode(args);
      expect(limit).toEqual(20);
      const firstPage = !start || start.length === 0;
      if (!firstPage) expect(Buffer.from(start)).toEqual(Buffer.from(zeros[19].spender));
      const allowances = firstPage ? zeros : last ? [last] : [];
      return KCS4_TYPES.get_allowances_result.encode({ owner, allowances }).finish();
    });
    const create = (name) => {
      const account = vm.account(name);
      return () => vm.transaction({ signers: [account.address, wallet.address], operations: [poolUpload(account), createPoolOp(address, fixture.token1.address)] });
    };
    last = { spender: spender(20), value: "1" };
    expectRevert(create("paged pool 1"), "KOINDX: POOL_HAS_ALLOWANCES");
    last = null;
    create("paged pool 2")();
    expect(registered(address, fixture.token1.address)).not.toEqual("");
  });

  it("F12: a token without allowances needs an exemption of the factory owner", () => {
    // a KCS-1 token: no approve, allowance or get_allowances
    const { address } = vm.account("token:kcs1");
    const token = tokenContract("OLD");
    const noAllowances = [TOKEN_ENTRIES.approve, TOKEN_ENTRIES.allowance, TOKEN_ENTRIES.get_allowances];
    vm.deployNative(address, (ctx, entry, args) => (noAllowances.includes(entry) ? ctx.revert("unknown entry point") : token(ctx, entry, args)));
    const create = (name) => {
      const account = vm.account(name);
      return () => vm.transaction({ signers: [account.address, wallet.address], operations: [poolUpload(account), createPoolOp(address, fixture.token1.address)] });
    };
    // Koinos: asking a contract for an entry point it doesn't have reverts the whole transaction
    expectRevert(create("kcs1 pool 1"), "unknown entry point");
    expectRevert(() => factory.send(other, "set_allowances_exempt", { token: address, exempt: true }), "KOINDX: FORBIDDEN");
    expectRevert(() => factory.send(wallet, "set_allowances_exempt", { token: "not a token", exempt: true }), "KOINDX: INVALID_TOKEN");
    const { events } = factory.send(wallet, "set_allowances_exempt", { token: address, exempt: true });
    expect(factory.events(events, "factory.allowances_exempt_event").map((e) => e.args)).toEqual([{ token: address, tokenAddress: address, exempt: true }]);
    expect(factory.read("allowances_exempt", { token: address }).value).toBe(true);
    expect(factory.read("allowances_exempt", { token: fixture.token1.address }).value || false).toBe(false);
    create("kcs1 pool 2")();
    expect(registered(address, fixture.token1.address)).not.toEqual("");
    // the exemption can be removed
    factory.send(wallet, "set_allowances_exempt", { token: address, exempt: false });
    expect(factory.read("allowances_exempt", { token: address }).value || false).toBe(false);
  });

  /** a transaction with `uploads` (overrides of the default upload) and create_pool */
  function createPool(uploads) {
    const operations = uploads.map((u) => {
      const account = vm.account(`creation test ${++counter}`);
      return {
        account,
        upload: {
          contractId: account.address,
          bytecode: contract("pool").wasm,
          authorizesCallContract: true,
          authorizesTransactionApplication: true,
          authorizesUploadContract: true,
          ...u,
        },
      };
    });
    return vm.transaction({
      signers: [wallet.address, ...operations.map((o) => o.account.address)],
      operations: [...operations.map(({ upload }) => ({ upload })), factory.operation("create_pool", { tokenA: fixture.token0.address, tokenB: fixture.token1.address, fee: 3000 })],
    });
  }

  it("only registers the KoinDX v3 pool bytecode", () => {
    expectRevert(() => createPool([{ bytecode: contract("factory").wasm }]), "KOINDX: INVALID_HASH");
  });

  it("only registers a pool that overrides its authority (its key can't control it)", () => {
    for (const flag of ["authorizesCallContract", "authorizesTransactionApplication", "authorizesUploadContract"]) {
      expectRevert(() => createPool([{ [flag]: false }]), "KOINDX: FAIL_AUTHORITY_OVERRIDES");
    }
  });

  it("needs exactly one upload in the transaction", () => {
    expectRevert(() => createPool([]), "KOINDX: POOL_UPLOAD_NOT_FOUND");
    expectRevert(() => createPool([{}, {}]), "KOINDX: POOL_UPLOAD_NOT_FOUND");
    createPool([{}]);
    expect(factory.read("get_pools", { start: "0", limit: 10 }).pools.length).toEqual(1);
  });
});
