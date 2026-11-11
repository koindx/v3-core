// Port of Uniswap v3-core test/UniswapV3Factory.spec.ts
//
// Koinos differences:
// - the owner of the factory is the factory account (the deployer of a Koinos contract is its
//   account), it signs the owner functions
// - there is no CREATE2: the pool bytecode is uploaded to a new address in the same transaction as
//   create_pool, the factory checks the bytecode hash and the authority overrides
// - the 100 (0.01%) fee tier with tick spacing 1 is enabled by default (Uniswap enabled it later
//   on mainnet), so the tests that enable a new fee tier use 200 instead of 100
// - tokens are identified by strings (base58 addresses here), sorted by the factory
// Not applicable: bytecode size and gas snapshots (EVM specific).
const { KoinosVM } = require("../vm/koinos-vm");
const { tokenContract } = require("../vm/token");
const { factoryFixture, contract, PoolClient } = require("./shared/fixtures");
const { expectRevert } = require("./shared/contracts");
const { FeeAmount, TICK_SPACINGS } = require("./shared/utilities");

describe("UniswapV3Factory", () => {
  let vm, wallet, other, owner, factory;
  let TEST_ADDRESSES;
  let poolCount = 0;

  beforeEach(() => {
    vm = new KoinosVM();
    wallet = vm.account("wallet");
    other = vm.account("other");
    factory = factoryFixture(vm, wallet);
    owner = factory.account;
    TEST_ADDRESSES = [vm.account("test address 1").address, vm.account("test address 2").address].sort();
    // KoinDX: create_pool asks the tokens for the allowances of the new pool (finding F12, Uniswap's
    // createPool doesn't call the tokens): the test addresses are KCS-4 tokens
    for (const address of TEST_ADDRESSES) vm.deployNative(address, tokenContract("TEST"));
  });

  /** factory.createPool: uploads the pool and calls create_pool in the same transaction */
  function createPool(tokenA, tokenB, fee, from = wallet) {
    const poolAccount = vm.account(`factory test pool ${++poolCount}`);
    const res = vm.transaction({
      signers: [poolAccount.address, from.address],
      operations: [
        {
          upload: {
            contractId: poolAccount.address,
            bytecode: contract("pool").wasm,
            authorizesCallContract: true,
            authorizesTransactionApplication: true,
            authorizesUploadContract: true,
          },
        },
        factory.operation("create_pool", { tokenA, tokenB, fee }),
      ],
    });
    return { address: poolAccount.address, events: res.events };
  }

  it("owner is deployer", () => {
    expect(factory.read("owner").value).toEqual(owner.address);
  });

  it("initial enabled fee amounts", () => {
    expect(factory.read("fee_amount_tick_spacing", { fee: FeeAmount.LOW }).value).toEqual(TICK_SPACINGS[FeeAmount.LOW]);
    expect(factory.read("fee_amount_tick_spacing", { fee: FeeAmount.MEDIUM }).value).toEqual(TICK_SPACINGS[FeeAmount.MEDIUM]);
    expect(factory.read("fee_amount_tick_spacing", { fee: FeeAmount.HIGH }).value).toEqual(TICK_SPACINGS[FeeAmount.HIGH]);
    // KoinDX: also enabled by default
    expect(factory.read("fee_amount_tick_spacing", { fee: 100 }).value).toEqual(1);
  });

  function createAndCheckPool(tokens, feeAmount, tickSpacing = TICK_SPACINGS[feeAmount]) {
    const { address, events } = createPool(tokens[0], tokens[1], feeAmount);

    expect(factory.events(events, "factory.pool_created_event").map((e) => e.args)).toEqual([
      { token0: TEST_ADDRESSES[0], token1: TEST_ADDRESSES[1], fee: feeAmount, tickSpacing, pool: address },
    ]);

    expectRevert(() => createPool(tokens[0], tokens[1], feeAmount), "KOINDX: POOL_EXISTS");
    expectRevert(() => createPool(tokens[1], tokens[0], feeAmount), "KOINDX: POOL_EXISTS");
    expect(factory.read("get_pool", { tokenA: tokens[0], tokenB: tokens[1], fee: feeAmount }).value).toEqual(address); // getPool in order
    expect(factory.read("get_pool", { tokenA: tokens[1], tokenB: tokens[0], fee: feeAmount }).value).toEqual(address); // getPool in reverse

    const pool = new PoolClient(vm, address, { wallet }).immutables();
    expect(pool.factory).toEqual(factory.address); // pool factory address
    expect(pool.token0).toEqual(TEST_ADDRESSES[0]);
    expect(pool.token1).toEqual(TEST_ADDRESSES[1]);
    expect(pool.fee).toEqual(feeAmount);
    expect(pool.tickSpacing).toEqual(tickSpacing);
  }

  describe("#createPool", () => {
    it("succeeds for low fee pool", () => {
      createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW);
    });

    it("succeeds for medium fee pool", () => {
      createAndCheckPool(TEST_ADDRESSES, FeeAmount.MEDIUM);
    });

    it("succeeds for high fee pool", () => {
      createAndCheckPool(TEST_ADDRESSES, FeeAmount.HIGH);
    });

    it("succeeds if tokens are passed in reverse", () => {
      createAndCheckPool([TEST_ADDRESSES[1], TEST_ADDRESSES[0]], FeeAmount.MEDIUM);
    });

    it("fails if token a == token b", () => {
      expectRevert(() => createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[0], FeeAmount.LOW), "KOINDX: TOKENS_MUST_BE_DIFFERENT");
    });

    it("fails if token a is 0 or token b is 0", () => {
      // Koinos: an empty or invalid token identifier
      expectRevert(() => createPool(TEST_ADDRESSES[0], "", FeeAmount.LOW), "KOINDX: INVALID_TOKEN");
      expectRevert(() => createPool("", TEST_ADDRESSES[0], FeeAmount.LOW), "KOINDX: INVALID_TOKEN");
      expectRevert(() => createPool("", "", FeeAmount.LOW));
    });

    it("fails if a token identifier is not the canonical base58 of an address", () => {
      // KoinDX: the base58 decoder of the SDK accepts several strings for the same address, they
      // would create several pools for the same pair and fee
      const [a, b] = TEST_ADDRESSES;
      for (const variant of [a + " ", " " + a, "1" + a, a + "0", a + "!", a + "\n"]) {
        expectRevert(() => createPool(variant, b, FeeAmount.MEDIUM), "KOINDX: INVALID_TOKEN");
        expectRevert(() => createPool(b, variant, FeeAmount.MEDIUM), "KOINDX: INVALID_TOKEN");
      }
      expectRevert(() => createPool("not a token", b, FeeAmount.MEDIUM), "KOINDX: INVALID_TOKEN");
      // a single pool, with the canonical identifiers
      createAndCheckPool(TEST_ADDRESSES, FeeAmount.MEDIUM);
      expect(factory.read("get_pools", { start: "0", limit: 10 }).pools.length).toEqual(1);
    });

    it("fails if fee amount is not enabled", () => {
      expectRevert(() => createPool(TEST_ADDRESSES[0], TEST_ADDRESSES[1], 250), "KOINDX: FEE_NOT_ENABLED");
    });
  });

  describe("#setOwner", () => {
    it("fails if caller is not owner", () => {
      expectRevert(() => factory.send(other, "set_owner", { owner: wallet.address }), "KOINDX: FORBIDDEN");
    });

    // KoinDX transfers the ownership in two steps: set_owner proposes, the new owner accepts
    const transferOwnership = (to) => {
      factory.send(owner, "set_owner", { owner: to.address });
      return factory.send(to, "accept_owner", {});
    };

    it("updates owner", () => {
      factory.send(owner, "set_owner", { owner: other.address });
      // proposed, not yet the owner
      expect(factory.read("owner").value).toEqual(owner.address);
      expect(factory.read("pending_owner").value).toEqual(other.address);
      factory.send(other, "accept_owner", {});
      expect(factory.read("owner").value).toEqual(other.address);
      expect(factory.read("pending_owner").value || "").toEqual("");
    });

    it("emits event", () => {
      const proposed = factory.send(owner, "set_owner", { owner: other.address });
      expect(factory.events(proposed.events, "factory.owner_proposed_event").map((e) => e.args)).toEqual([{ owner: owner.address, pendingOwner: other.address }]);
      const { events } = factory.send(other, "accept_owner", {});
      expect(factory.events(events, "factory.owner_changed_event").map((e) => e.args)).toEqual([{ oldOwner: owner.address, newOwner: other.address }]);
    });

    it("cannot be called by original owner", () => {
      transferOwnership(other);
      expectRevert(() => factory.send(owner, "set_owner", { owner: wallet.address }), "KOINDX: FORBIDDEN");
    });

    it("only the proposed owner can accept", () => {
      expectRevert(() => factory.send(other, "accept_owner", {}), "KOINDX: NO_PENDING_OWNER");
      factory.send(owner, "set_owner", { owner: other.address });
      expectRevert(() => factory.send(wallet, "accept_owner", {}), "KOINDX: FORBIDDEN");
      expectRevert(() => factory.send(owner, "accept_owner", {}), "KOINDX: FORBIDDEN");
      // a new proposal replaces the pending one
      factory.send(owner, "set_owner", { owner: wallet.address });
      expectRevert(() => factory.send(other, "accept_owner", {}), "KOINDX: FORBIDDEN");
      factory.send(wallet, "accept_owner", {});
      expect(factory.read("owner").value).toEqual(wallet.address);
      // accepted once: nothing pending anymore
      expectRevert(() => factory.send(wallet, "accept_owner", {}), "KOINDX: NO_PENDING_OWNER");
    });

    it("a proposal to an account that can't sign doesn't lock the owner functions", () => {
      // e.g. a typo: an address nobody has the key of
      const unusable = vm.account("nobody has this key");
      factory.send(owner, "set_owner", { owner: unusable.address });
      expect(factory.read("owner").value).toEqual(owner.address);
      factory.send(owner, "enable_fee_amount", { fee: 200, tickSpacing: 2 });
      transferOwnership(other);
      expect(factory.read("owner").value).toEqual(other.address);
    });
  });

  describe("#enableFeeAmount", () => {
    it("fails if caller is not owner", () => {
      expectRevert(() => factory.send(other, "enable_fee_amount", { fee: 200, tickSpacing: 2 }), "KOINDX: FORBIDDEN");
    });
    it("fails if fee is too great", () => {
      expectRevert(() => factory.send(owner, "enable_fee_amount", { fee: 1000000, tickSpacing: 10 }), "KOINDX: INVALID_FEE");
    });
    it("fails if tick spacing is too small", () => {
      expectRevert(() => factory.send(owner, "enable_fee_amount", { fee: 500, tickSpacing: 0 }), "KOINDX: INVALID_TICK_SPACING");
    });
    it("fails if tick spacing is too large", () => {
      expectRevert(() => factory.send(owner, "enable_fee_amount", { fee: 500, tickSpacing: 16834 }), "KOINDX: INVALID_TICK_SPACING");
    });
    it("fails if already initialized", () => {
      factory.send(owner, "enable_fee_amount", { fee: 200, tickSpacing: 5 });
      expectRevert(() => factory.send(owner, "enable_fee_amount", { fee: 200, tickSpacing: 10 }), "KOINDX: FEE_ALREADY_ENABLED");
    });
    it("sets the fee amount in the mapping", () => {
      factory.send(owner, "enable_fee_amount", { fee: 200, tickSpacing: 5 });
      expect(factory.read("fee_amount_tick_spacing", { fee: 200 }).value).toEqual(5);
    });
    it("emits an event", () => {
      const { events } = factory.send(owner, "enable_fee_amount", { fee: 200, tickSpacing: 5 });
      expect(factory.events(events, "factory.fee_amount_enabled_event").map((e) => e.args)).toEqual([{ fee: 200, tickSpacing: 5 }]);
    });
    it("enables pool creation", () => {
      factory.send(owner, "enable_fee_amount", { fee: 250, tickSpacing: 15 });
      createAndCheckPool([TEST_ADDRESSES[0], TEST_ADDRESSES[1]], 250, 15);
    });
  });
});
