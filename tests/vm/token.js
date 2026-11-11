// Test token for the Koinos VM emulator, with the rules of the Koinos token standard (KCS-4) as
// implemented by the KOIN contract (koinos-contracts-as, contracts/koin/assembly/Koin.ts):
// - u64 balances and supply
// - `approve` / `allowance` / `get_allowances`: a spender can move up to its allowance (decremented
//   by each transfer), an allowance of 0 is removed
// - `transfer` checks `_check_authority(from, value)`: the allowance of the calling contract, or
//   `System.checkAccountAuthority(from)` (koinos-sdk-as): a contract can move its own tokens, and
//   the tokens of a smart wallet that authorizes it, never the tokens of a regular account without
//   an allowance (the signature of the account is only accepted when it calls the token directly)
// - a transfer to the same account is rejected
// The mana of KOIN is not emulated. `mint` is free (tests).
const protobuf = require("protobufjs");
const { koinos } = require("@koinos/proto-js");
const { entryPoint, addressBytes, b58 } = require("./koinos-vm");

const T = koinos.contracts.token;
// KCS-4 messages that are not in @koinos/proto-js (koinos-proto: koinos/standards/kcs4.proto)
const KCS4 = protobuf.Root.fromJSON({
  nested: {
    allowance_arguments: { fields: { owner: { type: "bytes", id: 1 }, spender: { type: "bytes", id: 2 } } },
    allowance_result: { fields: { value: { type: "uint64", id: 1 } } },
    approve_arguments: {
      fields: { owner: { type: "bytes", id: 1 }, spender: { type: "bytes", id: 2 }, value: { type: "uint64", id: 3 }, memo: { type: "string", id: 4 } },
    },
    approve_result: { fields: {} },
    get_allowances_arguments: {
      fields: { owner: { type: "bytes", id: 1 }, start: { type: "bytes", id: 2 }, limit: { type: "int32", id: 3 }, descending: { type: "bool", id: 4 } },
    },
    spender_value: { fields: { spender: { type: "bytes", id: 1 }, value: { type: "uint64", id: 2 } } },
    get_allowances_result: { fields: { owner: { type: "bytes", id: 1 }, allowances: { rule: "repeated", type: "spender_value", id: 2 } } },
  },
});
const A = {
  allowance_arguments: KCS4.lookupType("allowance_arguments"),
  allowance_result: KCS4.lookupType("allowance_result"),
  approve_arguments: KCS4.lookupType("approve_arguments"),
  approve_result: KCS4.lookupType("approve_result"),
  get_allowances_arguments: KCS4.lookupType("get_allowances_arguments"),
  get_allowances_result: KCS4.lookupType("get_allowances_result"),
};

const U64_MAX = (1n << 64n) - 1n;
const SUPPLY = 0;
const BALANCES = 1;
const ALLOWANCES = 2;
const ENTRIES = {
  name: entryPoint("name"),
  symbol: entryPoint("symbol"),
  decimals: entryPoint("decimals"),
  total_supply: entryPoint("total_supply"),
  balance_of: entryPoint("balance_of"),
  allowance: entryPoint("allowance"),
  get_allowances: entryPoint("get_allowances"),
  transfer: entryPoint("transfer"),
  mint: entryPoint("mint"),
  burn: entryPoint("burn"),
  approve: entryPoint("approve"),
};

function readU64(bytes) {
  return bytes ? BigInt(T.balance_object.decode(bytes).value.toString()) : 0n;
}

function writeU64(value) {
  return T.balance_object.encode({ value: value.toString() }).finish();
}

const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

/** owner (25 bytes) + spender (25 bytes) */
const allowanceKey = (owner, spender) => Buffer.concat([Buffer.from(owner), Buffer.from(spender)]);

/** System.checkAccountAuthority of koinos-sdk-as */
function checkAccountAuthority(ctx, account) {
  const caller = ctx.caller.caller;
  if (caller && caller.length > 0) {
    if (same(caller, account)) return true;
    if (!ctx.contractAuthorizes(account)) return false;
  }
  return ctx.checkAuthority(Buffer.from(account));
}

/** Koin._check_authority: consumes the allowance of the calling contract, if it is enough */
function checkAuthority(ctx, account, amount) {
  const caller = ctx.caller.caller;
  if (caller && caller.length > 0) {
    const key = allowanceKey(account, caller);
    const allowance = readU64(ctx.get(ALLOWANCES, key));
    if (allowance === amount) {
      ctx.remove(ALLOWANCES, key);
      return true;
    } else if (allowance > amount) {
      ctx.put(ALLOWANCES, key, writeU64(allowance - amount));
      return true;
    }
  }
  return checkAccountAuthority(ctx, account);
}

function tokenContract(symbol, decimals = 8) {
  return (ctx, entry, args) => {
    const balanceOf = (owner) => readU64(ctx.get(BALANCES, Buffer.from(owner)));
    switch (entry) {
      case ENTRIES.name:
        return T.name_result.encode({ value: `${symbol} test token` }).finish();
      case ENTRIES.symbol:
        return T.symbol_result.encode({ value: symbol }).finish();
      case ENTRIES.decimals:
        return T.decimals_result.encode({ value: decimals }).finish();
      case ENTRIES.total_supply:
        return T.total_supply_result.encode({ value: readU64(ctx.get(SUPPLY, Buffer.alloc(0))).toString() }).finish();
      case ENTRIES.balance_of: {
        const { owner } = T.balance_of_arguments.decode(args);
        return T.balance_of_result.encode({ value: balanceOf(owner).toString() }).finish();
      }
      case ENTRIES.allowance: {
        const { owner, spender } = A.allowance_arguments.decode(args);
        return A.allowance_result.encode({ value: readU64(ctx.get(ALLOWANCES, allowanceKey(owner, spender))).toString() }).finish();
      }
      case ENTRIES.get_allowances: {
        // Koin.get_allowances: the allowances of `owner` after the spender `start`
        const { owner, start, limit, descending } = A.get_allowances_arguments.decode(args);
        ctx.require(owner && owner.length > 0, "account 'owner' cannot be null");
        let key = Buffer.alloc(50);
        Buffer.from(owner).copy(key, 0);
        if (start && start.length > 0) Buffer.from(start).copy(key, 25);
        const allowances = [];
        for (let i = 0; i < limit; i++) {
          const next = ctx.neighbour(ALLOWANCES, key, !descending);
          if (!next || !same(next.key.subarray(0, 25), owner)) break;
          allowances.push({ spender: next.key.subarray(25), value: readU64(next.value).toString() });
          key = next.key;
        }
        return A.get_allowances_result.encode({ owner, allowances }).finish();
      }
      case ENTRIES.transfer: {
        const { from, to, value } = T.transfer_arguments.decode(args);
        const amount = BigInt(value.toString());
        ctx.require(!same(from, to), "cannot transfer to yourself");
        ctx.require(checkAuthority(ctx, from, amount), "account 'from' has not authorized transfer");
        const fromBalance = balanceOf(from);
        ctx.require(fromBalance >= amount, "account 'from' has insufficient balance");
        ctx.put(BALANCES, Buffer.from(from), writeU64(fromBalance - amount));
        ctx.put(BALANCES, Buffer.from(to), writeU64(balanceOf(to) + amount));
        ctx.event("token.transfer_event", args, [to, from]);
        return T.transfer_result.encode({}).finish();
      }
      case ENTRIES.mint: {
        const { to, value } = T.mint_arguments.decode(args);
        const amount = BigInt(value.toString());
        const supply = readU64(ctx.get(SUPPLY, Buffer.alloc(0)));
        ctx.require(supply <= U64_MAX - amount, "mint would overflow supply");
        ctx.put(SUPPLY, Buffer.alloc(0), writeU64(supply + amount));
        ctx.put(BALANCES, Buffer.from(to), writeU64(balanceOf(to) + amount));
        ctx.event("token.mint_event", args, [to]);
        return T.mint_result.encode({}).finish();
      }
      case ENTRIES.burn: {
        const { from, value } = T.burn_arguments.decode(args);
        const amount = BigInt(value.toString());
        ctx.require(checkAuthority(ctx, from, amount), "account 'from' has not authorized burn");
        const fromBalance = balanceOf(from);
        ctx.require(fromBalance >= amount, "account 'from' has insufficient balance");
        ctx.put(SUPPLY, Buffer.alloc(0), writeU64(readU64(ctx.get(SUPPLY, Buffer.alloc(0))) - amount));
        ctx.put(BALANCES, Buffer.from(from), writeU64(fromBalance - amount));
        ctx.event("token.burn_event", args, [from]);
        return T.burn_result.encode({}).finish();
      }
      case ENTRIES.approve: {
        const { owner, spender, value } = A.approve_arguments.decode(args);
        // System.requireAuthority (enhanced security: System.checkAccountAuthority)
        ctx.require(checkAccountAuthority(ctx, owner), `account '${b58(owner)}' authorization failed`);
        const amount = BigInt(value.toString());
        const key = allowanceKey(owner, spender);
        if (amount === 0n) ctx.remove(ALLOWANCES, key);
        else ctx.put(ALLOWANCES, key, writeU64(amount));
        ctx.event("token.approve_event", args, [owner, spender]);
        return A.approve_result.encode({}).finish();
      }
      default:
        ctx.revert("unknown entry point");
    }
  };
}

/** helpers for the tests (outside of contracts) */
class TestToken {
  constructor(vm, address, symbol) {
    this.vm = vm;
    this.address = address;
    this.symbol = symbol;
  }

  static deploy(vm, name, symbol = name) {
    const { address } = vm.account(`token:${name}`);
    vm.deployNative(address, tokenContract(symbol));
    return new TestToken(vm, address, symbol);
  }

  balanceOf(owner) {
    const res = this.vm.read(this.address, ENTRIES.balance_of, T.balance_of_arguments.encode({ owner: addressBytes(owner) }).finish());
    return BigInt(T.balance_of_result.decode(res).value.toString());
  }

  /** KCS-4 get_allowances */
  allowances(owner, start = Buffer.alloc(0), limit = 100, descending = false) {
    const args = A.get_allowances_arguments.encode({ owner: addressBytes(owner), start: start.length ? addressBytes(start) : start, limit, descending }).finish();
    return A.get_allowances_result.decode(this.vm.read(this.address, ENTRIES.get_allowances, args)).allowances.map((a) => ({ spender: b58(a.spender), value: BigInt(a.value.toString()) }));
  }

  allowance(owner, spender) {
    const res = this.vm.read(this.address, ENTRIES.allowance, A.allowance_arguments.encode({ owner: addressBytes(owner), spender: addressBytes(spender) }).finish());
    return BigInt(A.allowance_result.decode(res).value.toString());
  }

  mint(to, value) {
    this.vm.transaction({
      signers: [],
      operations: [{ call: { contractId: this.address, entryPoint: ENTRIES.mint, args: T.mint_arguments.encode({ to: addressBytes(to), value: value.toString() }).finish() } }],
    });
  }

  /** the operation of a transaction that approves `spender` (Uniswap: token.approve) */
  approveOperation(owner, spender, value) {
    const args = A.approve_arguments.encode({ owner: addressBytes(owner), spender: addressBytes(spender), value: value.toString() }).finish();
    return { call: { contractId: this.address, entryPoint: ENTRIES.approve, args } };
  }

  /** `owner` (an address, signs the transaction) approves `spender` */
  approve(owner, spender, value) {
    return this.vm.transaction({ signers: [owner], operations: [this.approveOperation(owner, spender, value)] });
  }

  transfer(from, to, value) {
    return this.vm.transaction({
      signers: [from],
      operations: [{ call: { contractId: this.address, entryPoint: ENTRIES.transfer, args: T.transfer_arguments.encode({ from: addressBytes(from), to: addressBytes(to), value: value.toString() }).finish() } }],
    });
  }

  totalSupply() {
    return BigInt(T.total_supply_result.decode(this.vm.read(this.address, ENTRIES.total_supply)).value.toString());
  }
}

module.exports = { tokenContract, TestToken, TOKEN_ENTRIES: ENTRIES, KCS4_TYPES: A, b58 };
