import { System, Storage, Protobuf, Crypto, Arrays, StringBytes, authority } from "@koinos/sdk-as";
import { factory } from "./proto/factory";
import { Spaces } from "./Spaces";
import { poolBytecodeHash } from "./PoolHash";
import { Contract } from "../../../utils/Contract";
import { Tokens, ADDRESS_LENGTH } from "../../../utils/Tokens";
import { Keys } from "../../../utils/Keys";

const POOL_CONFIGURE_ENTRY: u32 = 0x90d08e58; // pool.configure
const GET_ALLOWANCES_ENTRY: u32 = 0x8fa16456; // token.get_allowances (KCS-4)
// allowances read per call to get_allowances
const ALLOWANCES_PAGE: i32 = 20;
// the transaction contains the bytecode of the pool, the system buffer must be able to hold it
const SYSTEM_BUFFER_SIZE: u32 = 1048576;
const MAX_POOLS_PAGE: u32 = 100;
const MAX_FEE: u32 = 1000000;
const MAX_TICK_SPACING: i32 = 16384;

/**
 * KoinDX v3 Factory: port of UniswapV3Factory.
 *
 * Deploys KoinDX v3 pools and manages ownership and control over pool protocol fees.
 *
 * Koinos has no CREATE2: like the KoinDX v2 `create_pair`, a pool is created by a transaction
 * with two operations: the upload of the pool bytecode (to a new address) and then the call to
 * `create_pool`. The factory checks the hash of the uploaded bytecode and that the contract
 * overrides its own authority (so nobody can upgrade the pool or move its tokens), then
 * configures the pool with its immutable parameters.
 *
 * Unlike a CREATE2 address, the address of a pool has a key and can have a history: code
 * uploaded before (finding F11) and allowances on the pool tokens granted with the key (finding
 * F12). create_pool rejects both, see `uploadedPool` and `requireNoAllowances`.
 */
export class Factory {
  contractId: Uint8Array;
  ownerStore: Storage.Obj<factory.address>;
  pendingOwnerStore: Storage.Obj<factory.address>;
  feeAmounts: Storage.Map<Uint8Array, factory.fee_record>;
  pools: Storage.Map<Uint8Array, factory.pool_info>;
  poolList: Storage.Map<Uint8Array, factory.pool_info>;
  poolCount: Storage.Obj<factory.counter_record>;
  allowancesExempt: Storage.Map<Uint8Array, factory.bool_value>;

  constructor() {
    this.contractId = System.getContractId();
    this.ownerStore = new Storage.Obj(
      this.contractId,
      Spaces.OWNER_SPACE_ID,
      factory.address.decode,
      factory.address.encode,
      null
    );
    this.pendingOwnerStore = new Storage.Obj(
      this.contractId,
      Spaces.PENDING_OWNER_SPACE_ID,
      factory.address.decode,
      factory.address.encode,
      null
    );
    this.feeAmounts = new Storage.Map(
      this.contractId,
      Spaces.FEE_AMOUNTS_SPACE_ID,
      factory.fee_record.decode,
      factory.fee_record.encode,
      null
    );
    this.pools = new Storage.Map(
      this.contractId,
      Spaces.POOLS_SPACE_ID,
      factory.pool_info.decode,
      factory.pool_info.encode,
      null
    );
    this.poolList = new Storage.Map(
      this.contractId,
      Spaces.POOL_LIST_SPACE_ID,
      factory.pool_info.decode,
      factory.pool_info.encode,
      null
    );
    this.poolCount = new Storage.Obj(
      this.contractId,
      Spaces.POOL_COUNT_SPACE_ID,
      factory.counter_record.decode,
      factory.counter_record.encode,
      () => new factory.counter_record(0)
    );
    this.allowancesExempt = new Storage.Map(
      this.contractId,
      Spaces.ALLOWANCES_EXEMPT_SPACE_ID,
      factory.bool_value.decode,
      factory.bool_value.encode,
      null
    );
  }

  /**
   * The factory is deployed overriding its upload authority: its code can't be upgraded.
   * The factory account keeps the authority to call the owner functions.
   */
  authorize(args: authority.authorize_arguments): authority.authorize_result {
    return new authority.authorize_result(false);
  }

  // ---------------------------------------------------------------------------
  // read methods
  // ---------------------------------------------------------------------------

  owner(args: factory.owner_arguments): factory.address {
    return new factory.address(this.getOwner());
  }

  pending_owner(args: factory.pending_owner_arguments): factory.address {
    const pending = this.pendingOwnerStore.get();
    return new factory.address(pending ? pending.value : new Uint8Array(0));
  }

  fee_amount_tick_spacing(args: factory.fee_amount_tick_spacing_arguments): factory.int32_value {
    return new factory.int32_value(this.getTickSpacing(args.fee));
  }

  get_pool(args: factory.get_pool_arguments): factory.address {
    const sorted = Tokens.sort(args.token_a, args.token_b);
    const info = this.pools.get(poolKey(sorted[0], sorted[1], args.fee));
    return new factory.address(info ? info.pool : new Uint8Array(0));
  }

  allowances_exempt(args: factory.allowances_exempt_arguments): factory.bool_value {
    return new factory.bool_value(this.isAllowancesExempt(Tokens.address(args.token)));
  }

  get_pools(args: factory.get_pools_arguments): factory.get_pools_result {
    let limit = args.limit == 0 ? MAX_POOLS_PAGE : args.limit;
    if (limit > MAX_POOLS_PAGE) limit = MAX_POOLS_PAGE;
    const total = this.poolCount.get()!.value;
    const result = new factory.get_pools_result([], total);
    for (let i = args.start; i < total && <u32>result.pools.length < limit; i++) {
      const info = this.poolList.get(Keys.uint64(i));
      if (info) result.pools.push(info);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // write methods
  // ---------------------------------------------------------------------------

  create_pool(args: factory.create_pool_arguments): factory.address {
    // finding F11: create_pool must be an operation of the transaction, after the upload of the
    // pool (see uploadedPool), so the pool code is installed when `configure` runs. A contract
    // could call it before the upload is applied: from the `authorize` of the previous code of
    // the pool address, which Koinos runs to check the authority of the upload.
    System.require(System.getCaller().caller.length == 0, "KOINDX: CREATE_POOL_MUST_BE_AN_OPERATION");
    System.require(args.token_a != args.token_b, "KOINDX: TOKENS_MUST_BE_DIFFERENT");
    const sorted = Tokens.sort(args.token_a, args.token_b);
    const token0 = sorted[0];
    const token1 = sorted[1];
    System.require(token0.length > 0, "KOINDX: INVALID_TOKEN");

    const tickSpacing = this.getTickSpacing(args.fee);
    System.require(tickSpacing != 0, "KOINDX: FEE_NOT_ENABLED");

    const key = poolKey(token0, token1, args.fee);
    System.require(!this.pools.has(key), "KOINDX: POOL_EXISTS");

    const token0Object = tokenObject(token0);
    const token1Object = tokenObject(token1);
    System.require(
      !Arrays.equal(Tokens.address(token0), Tokens.address(token1)),
      "KOINDX: TOKENS_MUST_BE_DIFFERENT"
    );

    const pool = this.uploadedPool();
    this.requireNoAllowances(Tokens.address(token0), pool);
    this.requireNoAllowances(Tokens.address(token1), pool);

    Contract.call(
      pool,
      POOL_CONFIGURE_ENTRY,
      Protobuf.encode(
        new factory.pool_configure_args(token0Object, token1Object, args.fee, tickSpacing),
        factory.pool_configure_args.encode
      ),
      "KOINDX: COULD_NOT_CONFIGURE_THE_POOL"
    );

    const info = new factory.pool_info(pool, token0, token1, args.fee, tickSpacing);
    this.pools.put(key, info);
    const count = this.poolCount.get()!;
    this.poolList.put(Keys.uint64(count.value), info);
    count.value += 1;
    this.poolCount.put(count);

    System.event(
      "factory.pool_created_event",
      Protobuf.encode(
        new factory.pool_created_event(token0, token1, args.fee, tickSpacing, pool),
        factory.pool_created_event.encode
      ),
      [pool, this.contractId]
    );
    return new factory.address(pool);
  }

  /**
   * Two-step ownership transfer (Uniswap changes the owner in one step): the owner proposes the new
   * owner, which becomes the owner only when it calls accept_owner. Proposing an account that can't
   * sign (a typo) doesn't lock the owner functions, it can be replaced by another proposal.
   */
  set_owner(args: factory.set_owner_arguments): factory.empty_object {
    const currentOwner = this.getOwner();
    Contract.requireAuthority(currentOwner);
    // the authority check can run the code of a smart wallet: the owner must not have changed
    System.require(Arrays.equal(this.getOwner(), currentOwner), "KOINDX: FORBIDDEN");
    System.require(args.owner.length == ADDRESS_LENGTH, "KOINDX: INVALID_OWNER");
    this.pendingOwnerStore.put(new factory.address(args.owner));
    System.event(
      "factory.owner_proposed_event",
      Protobuf.encode(new factory.owner_proposed_event(currentOwner, args.owner), factory.owner_proposed_event.encode),
      [args.owner, currentOwner]
    );
    return new factory.empty_object();
  }

  accept_owner(args: factory.accept_owner_arguments): factory.empty_object {
    const pending = this.pendingOwnerStore.get();
    System.require(pending != null && pending.value.length == ADDRESS_LENGTH, "KOINDX: NO_PENDING_OWNER");
    const newOwner = pending!.value;
    Contract.requireAuthority(newOwner);
    // the authority check can run the code of a smart wallet: the proposal must not have changed
    const current = this.pendingOwnerStore.get();
    System.require(current != null && Arrays.equal(current.value, newOwner), "KOINDX: NO_PENDING_OWNER");
    const oldOwner = this.getOwner();
    this.ownerStore.put(new factory.address(newOwner));
    this.pendingOwnerStore.remove();
    System.event(
      "factory.owner_changed_event",
      Protobuf.encode(new factory.owner_changed_event(oldOwner, newOwner), factory.owner_changed_event.encode),
      [newOwner, oldOwner]
    );
    return new factory.empty_object();
  }

  /**
   * Exempts a token from the allowance check of create_pool (finding F12), or removes the
   * exemption. Only for tokens that have no allowances (no `approve`, e.g. KCS-1 tokens): they
   * can't answer get_allowances, so create_pool reverts for them unless they are exempt. Exempting
   * a token that has allowances would let its pools be created with allowances of the pool.
   */
  set_allowances_exempt(args: factory.set_allowances_exempt_arguments): factory.empty_object {
    Contract.requireAuthority(this.getOwner());
    const tokenAddress = Tokens.address(args.token);
    if (args.exempt) this.allowancesExempt.put(tokenAddress, new factory.bool_value(true));
    else this.allowancesExempt.remove(tokenAddress);
    System.event(
      "factory.allowances_exempt_event",
      Protobuf.encode(new factory.allowances_exempt_event(args.token, tokenAddress, args.exempt), factory.allowances_exempt_event.encode),
      [tokenAddress, this.contractId]
    );
    return new factory.empty_object();
  }

  enable_fee_amount(args: factory.enable_fee_amount_arguments): factory.empty_object {
    Contract.requireAuthority(this.getOwner());
    System.require(args.fee < MAX_FEE, "KOINDX: INVALID_FEE");
    // tick spacing is capped at 16384 to prevent the situation where tickSpacing is so large that
    // TickBitmap#nextInitializedTickWithinOneWord overflows int24 container from a valid tick
    // 16384 ticks represents a >5x price change with ticks of 1 bips
    System.require(args.tick_spacing > 0 && args.tick_spacing < MAX_TICK_SPACING, "KOINDX: INVALID_TICK_SPACING");
    System.require(this.getTickSpacing(args.fee) == 0, "KOINDX: FEE_ALREADY_ENABLED");

    this.feeAmounts.put(feeKey(args.fee), new factory.fee_record(args.tick_spacing));
    System.event(
      "factory.fee_amount_enabled_event",
      Protobuf.encode(new factory.fee_amount_enabled_event(args.fee, args.tick_spacing), factory.fee_amount_enabled_event.encode),
      [this.contractId]
    );
    return new factory.empty_object();
  }

  // ---------------------------------------------------------------------------
  // internal
  // ---------------------------------------------------------------------------

  /** the owner defaults to the factory account itself until a new owner accepts the ownership */
  private getOwner(): Uint8Array {
    const owner = this.ownerStore.get();
    if (owner && owner.value.length > 0) return owner.value;
    return this.contractId;
  }

  /**
   * Uniswap enables 500 (0.05%), 3000 (0.3%) and 10000 (1%) in the factory constructor and later
   * enabled 100 (0.01%) through governance. Koinos contracts have no constructor, so these
   * defaults are part of the code.
   */
  private getTickSpacing(fee: u32): i32 {
    const record = this.feeAmounts.get(feeKey(fee));
    if (record) return record.tick_spacing;
    if (fee == 100) return 1;
    if (fee == 500) return 10;
    if (fee == 3000) return 60;
    if (fee == 10000) return 200;
    return 0;
  }

  /**
   * Finds the pool uploaded in the current transaction and validates it.
   *
   * Finding F11: the code at the pool address when `configure` runs must be the uploaded pool,
   * otherwise the previous code of the address could answer `configure` and write records (e.g. a
   * position owed all the tokens of the pool) that the pool code finds after the upload (the
   * storage of a contract survives a new upload). The upload must come before every call to the
   * factory in the transaction: create_pool is one of them (it must be an operation of the
   * transaction), so the upload has been applied when it runs, and `configure` runs the pool code,
   * which checks that its storage is empty.
   */
  private uploadedPool(): Uint8Array {
    System.setSystemBufferSize(SYSTEM_BUFFER_SIZE);
    const transaction = System.getTransaction();

    let uploads = 0;
    let uploadIndex = -1;
    let firstFactoryCall = -1;
    let pool = new Uint8Array(0);
    let hash = new Uint8Array(0);
    let authorityOverrides = true;
    for (let i = 0; i < transaction.operations.length; i++) {
      const op = transaction.operations[i];
      if (op.upload_contract != null) {
        const upload = op.upload_contract!;
        uploads++;
        uploadIndex = i;
        pool = upload.contract_id;
        hash = System.hash(Crypto.multicodec.sha2_256, upload.bytecode)!;
        if (!upload.authorizes_call_contract) authorityOverrides = false;
        if (!upload.authorizes_transaction_application) authorityOverrides = false;
        if (!upload.authorizes_upload_contract) authorityOverrides = false;
      } else if (op.call_contract != null && firstFactoryCall < 0 && Arrays.equal(op.call_contract!.contract_id, this.contractId)) {
        firstFactoryCall = i;
      }
    }

    System.require(uploads == 1, "KOINDX: POOL_UPLOAD_NOT_FOUND");
    System.require(firstFactoryCall > uploadIndex, "KOINDX: POOL_UPLOAD_MUST_COME_FIRST");
    System.require(Arrays.equal(hash, poolBytecodeHash()), "KOINDX: INVALID_HASH");
    System.require(authorityOverrides, "KOINDX: FAIL_AUTHORITY_OVERRIDES");
    System.require(pool.length == ADDRESS_LENGTH, "KOINDX: POOL_INVALID");
    System.require(!Arrays.equal(pool, this.contractId), "KOINDX: POOL_INVALID");
    return pool;
  }

  /**
   * Finding F12: the key of the pool address could approve spenders of the pool tokens before the
   * pool was uploaded. KCS-4 allowances survive the upload and let a spender move the tokens of the
   * pool without its authority, so the pool must have none (get_allowances, KCS-4). Tokens without
   * allowances can't answer get_allowances (create_pool reverts): the owner exempts them.
   */
  private requireNoAllowances(token: Uint8Array, pool: Uint8Array): void {
    if (this.isAllowancesExempt(token)) return;
    let start = new Uint8Array(0);
    while (true) {
      const res = Contract.call(
        token,
        GET_ALLOWANCES_ENTRY,
        Protobuf.encode(
          new factory.token_get_allowances_args(pool, start, ALLOWANCES_PAGE, false),
          factory.token_get_allowances_args.encode
        ),
        "KOINDX: GET_ALLOWANCES_FAILED"
      );
      const page = Protobuf.decode<factory.token_allowances_page>(res, factory.token_allowances_page.decode);
      for (let i = 0; i < page.allowances.length; i++) {
        System.require(page.allowances[i].value == 0, "KOINDX: POOL_HAS_ALLOWANCES");
      }
      if (page.allowances.length < ALLOWANCES_PAGE) return;
      start = page.allowances[page.allowances.length - 1].spender;
    }
  }

  private isAllowancesExempt(token: Uint8Array): bool {
    const exempt = this.allowancesExempt.get(token);
    return exempt != null && exempt.value;
  }
}

function poolKey(token0: string, token1: string, fee: u32): Uint8Array {
  const t0 = StringBytes.stringToBytes(token0);
  const t1 = StringBytes.stringToBytes(token1);
  const key = new Uint8Array(t0.length + t1.length + 6);
  key.set(t0, 0);
  key[t0.length] = 0;
  key.set(t1, t0.length + 1);
  key[t0.length + 1 + t1.length] = 0;
  key.set(feeKey(fee), t0.length + t1.length + 2);
  return key;
}

function feeKey(fee: u32): Uint8Array {
  const key = new Uint8Array(4);
  key[0] = <u8>(fee >> 24);
  key[1] = <u8>(fee >> 16);
  key[2] = <u8>(fee >> 8);
  key[3] = <u8>fee;
  return key;
}

/**
 * Builds the token object stored by the pool. System tokens must be referenced by their name
 * (e.g. "koin") and not by their current address, otherwise two pools could exist for the same token
 */
function tokenObject(token: string): factory.token_object {
  if (Tokens.isNameService(token)) {
    System.require(System.getContractAddress(token).length == ADDRESS_LENGTH, "KOINDX: INVALID_TOKEN");
    return new factory.token_object(true, token, new Uint8Array(0));
  }
  const address = Tokens.address(token);
  for (let i = 0; i < Tokens.NAME_SERVICE_TOKENS.length; i++) {
    System.require(
      !Arrays.equal(address, System.getContractAddress(Tokens.NAME_SERVICE_TOKENS[i])),
      "KOINDX: USE_NAME_SERVICE_TOKEN"
    );
  }
  return new factory.token_object(false, "", address);
}
