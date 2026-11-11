// In-process emulator of the Koinos VM used to unit test the compiled contracts (the same wasm that
// is deployed). It implements the system calls used by the KoinDX contracts with the semantics of
// koinos-chain (src/koinos/chain/system_calls.cpp, host_api.cpp):
// - every call runs a fresh instance of the contract module, `_start` is the entry point
// - a system call that fails with a code >= 1 (reversion, e.g. System.require) reverts the whole
//   transaction, a failure (code <= -1) is returned to the calling contract
// - get_caller returns the calling contract (empty for an operation of the transaction)
// - check_authority calls the `authorize` entry point of the account when it overrides that
//   authority, otherwise it checks the signatures of the transaction
// - a contract can only access its own object spaces, read only calls can't write
// - contracts uploaded overriding their authority can only be upgraded through `authorize`
// - the block time is controlled by the tests (like Uniswap's MockTimeUniswapV3Pool)
// Contracts can also be implemented in JavaScript ("native" contracts: test tokens and the test
// callees of the Uniswap test suites).
const crypto = require("crypto");
const { koinos } = require("@koinos/proto-js");
const { Signer, utils } = require("koilib");

const SID = koinos.chain.system_call_id;
const ERR = koinos.chain.error_code;
const KERNEL = koinos.chain.privilege.kernel_mode;
const USER = koinos.chain.privilege.user_mode;
const AUTH = koinos.chain.authorization_type;
const AUTHORIZE_ENTRY_POINT = 0x4a2dbd90;
const MEMORY_LIMIT = 512 * 65536; // fizzy backend: 512 pages

class KoinosError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** thrown by the exit system call to unwind the contract */
class ExitSignal {
  constructor(code, res) {
    this.code = code;
    this.res = res;
  }
}

/** a transaction (or read only call) that didn't succeed */
class TransactionError extends Error {
  constructor(code, message, logs) {
    super(message);
    this.code = code;
    this.logs = logs;
  }
}

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const toBuffer = (bytes) => Buffer.from(bytes);
const b58 = (bytes) => utils.encodeBase58(Uint8Array.from(bytes));
const addressBytes = (address) => (typeof address === "string" ? Buffer.from(utils.decodeBase58(address)) : Buffer.from(address));

/** first 4 bytes of the sha256 of the method name */
function entryPoint(name) {
  return crypto.createHash("sha256").update(name).digest().readUInt32BE(0);
}

function multihashSha256(bytes) {
  return Buffer.concat([Buffer.from([0x12, 0x20]), crypto.createHash("sha256").update(bytes).digest()]);
}

class KoinosVM {
  constructor({ time = 1601906400000n } = {}) {
    this.time = BigInt(time); // block timestamp in milliseconds
    this.height = 1n;
    this.contracts = new Map(); // address hex -> contract
    this.modules = new Map(); // bytecode hash hex -> WebAssembly.Module
    this.db = new Map(); // space key -> Map(key hex -> { key: Buffer, value: Buffer })
    this.names = new Map(); // name service
    this.frames = [];
    this.tx = null;
    this.events = [];
    this.logs = [];
  }

  // ---------------------------------------------------------------------------
  // accounts, contracts and time
  // ---------------------------------------------------------------------------

  /** deterministic account (signer) for a name */
  account(name) {
    const signer = Signer.fromSeed(`koinos-vm:${name}`);
    return { name, address: signer.address, bytes: addressBytes(signer.address) };
  }

  setName(name, address) {
    this.names.set(name, addressBytes(address));
  }

  advanceTime(seconds) {
    this.time += BigInt(seconds) * 1000n;
    this.height += 1n;
  }

  /** deploys a wasm contract outside of a transaction (test setup) */
  deployWasm(address, bytecode, overrides = {}) {
    this._storeContract(addressBytes(address), { bytecode: Buffer.from(bytecode), ...overrides });
  }

  /** deploys a JavaScript contract: handler(ctx, entryPoint, args) -> result bytes */
  deployNative(address, handler, overrides = {}) {
    this.contracts.set(hex(addressBytes(address)), {
      native: handler,
      authorizesCallContract: !!overrides.authorizesCallContract,
      authorizesTransactionApplication: !!overrides.authorizesTransactionApplication,
      authorizesUploadContract: !!overrides.authorizesUploadContract,
    });
  }

  hasContract(address) {
    return this.contracts.has(hex(addressBytes(address)));
  }

  _storeContract(id, upload) {
    const hash = multihashSha256(upload.bytecode);
    const key = hex(hash);
    if (!this.modules.has(key)) this.modules.set(key, new WebAssembly.Module(upload.bytecode));
    this.contracts.set(hex(id), {
      module: this.modules.get(key),
      hash,
      authorizesCallContract: !!upload.authorizesCallContract,
      authorizesTransactionApplication: !!upload.authorizesTransactionApplication,
      authorizesUploadContract: !!upload.authorizesUploadContract,
    });
  }

  // ---------------------------------------------------------------------------
  // transactions
  // ---------------------------------------------------------------------------

  /**
   * Applies a transaction: operations are { upload: { contractId, bytecode, authorizes... } } or
   * { call: { contractId, entryPoint, args } }. Everything is reverted if an operation fails, or
   * after the execution with `dryRun` (Uniswap's callStatic).
   * Returns { results, events, logs }.
   */
  transaction({ signers = [], payer, operations, dryRun = false }) {
    const snapshot = this._snapshot();
    const signerSet = new Set(signers.map((s) => hex(addressBytes(typeof s === "object" && s.address ? s.address : s))));
    const payerBytes = payer ? addressBytes(payer) : signerSet.size ? Buffer.from([...signerSet][0], "hex") : Buffer.alloc(0);
    this.tx = {
      signers: signerSet,
      protocol: this._protocolTransaction(payerBytes, operations),
    };
    this.events = [];
    this.logs = [];
    const results = [];
    try {
      this.frames = [{ contractId: Buffer.alloc(0), privilege: KERNEL, readOnly: false }];
      for (const op of operations) {
        this.operation = op;
        if (op.upload) {
          this._applyUpload(op.upload);
          results.push(null);
        } else {
          results.push(this._call(addressBytes(op.call.contractId), op.call.entryPoint, op.call.args || new Uint8Array(0)));
        }
      }
      // dry run (Uniswap tests: callStatic): the results without the state changes
      if (dryRun) this._restore(snapshot);
      return { results, events: this.events, logs: this.logs };
    } catch (e) {
      this._restore(snapshot);
      if (e instanceof KoinosError) throw new TransactionError(e.code, e.message, this.logs);
      throw e;
    } finally {
      this.tx = null;
      this.operation = null;
      this.frames = [];
      this.height += 1n;
    }
  }

  /** read only call (like the read_contract RPC) */
  /**
   * Runs `fn` with the exports (@assemblyscript/loader) of a fresh instance of a wasm module that
   * is not a contract (a test module of the libraries), in the context of the contract
   * `contractId`: its system calls use the storage of this contract. A revert throws a
   * TransactionError and reverts the state changes, a dry run (Uniswap: callStatic) reverts them
   * in all cases.
   */
  callModule(contractId, module, fn, { dryRun = false } = {}) {
    const snapshot = this._snapshot();
    this.frames = [
      { contractId: Buffer.alloc(0), privilege: KERNEL, readOnly: false },
      { contractId: addressBytes(contractId), entryPoint: 0, args: Buffer.alloc(0), privilege: USER, readOnly: false },
    ];
    this.events = [];
    this.logs = [];
    let loaded;
    try {
      loaded = require("@assemblyscript/loader").instantiateSync(module, {
        env: {
          invoke_system_call: (sid, retPtr, retLen, argPtr, argLen, bytesWrittenPtr) =>
            this._invokeSystemCall(loaded, sid, retPtr, retLen, argPtr, argLen, bytesWrittenPtr),
        },
        wasi_snapshot_preview1: {
          fd_write: () => 0,
          proc_exit: () => {
            throw new KoinosError(ERR.reversion, "abort");
          },
        },
      });
      if (loaded.exports._start) loaded.exports._start();
      const result = fn(loaded.exports);
      if (dryRun) this._restore(snapshot);
      return result;
    } catch (e) {
      this._restore(snapshot);
      if (e instanceof ExitSignal) {
        const res = this._exitResult(e);
        throw new TransactionError(res.code, res.message, this.logs);
      }
      if (e instanceof KoinosError) throw new TransactionError(e.code, e.message, this.logs);
      if (e instanceof WebAssembly.RuntimeError) throw new TransactionError(ERR.reversion, `module exited due to trap (${e.message})`, this.logs);
      throw e;
    } finally {
      this.frames = [];
    }
  }

  read(contractId, entry, args = new Uint8Array(0)) {
    this.frames = [{ contractId: Buffer.alloc(0), privilege: KERNEL, readOnly: true }];
    this.logs = [];
    try {
      return this._call(addressBytes(contractId), entry, args, true);
    } catch (e) {
      if (e instanceof KoinosError) throw new TransactionError(e.code, e.message, this.logs);
      throw e;
    } finally {
      this.frames = [];
    }
  }

  _protocolTransaction(payer, operations) {
    return {
      id: crypto.randomBytes(34),
      header: { payer, rc_limit: "1000000000" },
      operations: operations.map((op) =>
        op.upload
          ? {
              upload_contract: {
                contract_id: addressBytes(op.upload.contractId),
                bytecode: Buffer.from(op.upload.bytecode),
                abi: op.upload.abi || "",
                authorizes_call_contract: !!op.upload.authorizesCallContract,
                authorizes_transaction_application: !!op.upload.authorizesTransactionApplication,
                authorizes_upload_contract: !!op.upload.authorizesUploadContract,
              },
            }
          : { call_contract: { contract_id: addressBytes(op.call.contractId), entry_point: op.call.entryPoint, args: Buffer.from(op.call.args || []) } }
      ),
      signatures: [],
    };
  }

  _applyUpload(upload) {
    const id = addressBytes(upload.contractId);
    // apply_upload_contract_operation: the account (or its authorize override) must authorize it
    const existing = this.contracts.get(hex(id));
    let authorized;
    if (existing && existing.authorizesUploadContract) {
      authorized = this._authorizeCall(id, AUTH.contract_upload, null);
    } else {
      authorized = this.tx.signers.has(hex(id));
    }
    if (!authorized) throw new KoinosError(ERR.authorization_failure, "account has not authorized contract upload");
    this._storeContract(id, upload);
  }

  // ---------------------------------------------------------------------------
  // execution
  // ---------------------------------------------------------------------------

  get frame() {
    return this.frames[this.frames.length - 1];
  }

  /** call thunk: runs a contract, returns the result object bytes or throws a KoinosError */
  _call(contractId, entry, args, readOnly = false) {
    const contract = this.contracts.get(hex(contractId));
    if (!contract) throw new KoinosError(ERR.invalid_contract, "contract does not exist");
    if (entry === AUTHORIZE_ENTRY_POINT && this.frame.privilege !== KERNEL) {
      throw new KoinosError(ERR.insufficient_privileges, "calling privileged thunk from non-privileged code");
    }
    const parent = this.frame;
    this.frames.push({ contractId: toBuffer(contractId), entryPoint: entry, args: toBuffer(args), privilege: USER, readOnly: readOnly || parent.readOnly });
    let result;
    try {
      result = contract.native ? this._runNative(contract, entry, args) : this._runWasm(contract);
    } finally {
      this.frames.pop();
    }
    if (result.code !== 0) throw new KoinosError(result.code, result.message);
    return result.object;
  }

  _runNative(contract, entry, args) {
    const ctx = new NativeContext(this);
    try {
      const object = contract.native(ctx, entry, Buffer.from(args));
      return { code: 0, object: Buffer.from(object || []) };
    } catch (e) {
      if (e instanceof ExitSignal) return this._exitResult(e);
      throw e;
    }
  }

  _runWasm(contract) {
    let instance;
    const imports = {
      env: {
        invoke_system_call: (sid, retPtr, retLen, argPtr, argLen, bytesWrittenPtr) =>
          this._invokeSystemCall(instance, sid, retPtr, retLen, argPtr, argLen, bytesWrittenPtr),
      },
    };
    instance = new WebAssembly.Instance(contract.module, imports);
    try {
      instance.exports._start();
      this._checkMemory(instance);
      return { code: 0, object: Buffer.alloc(0) };
    } catch (e) {
      if (e instanceof ExitSignal) {
        this._checkMemory(instance);
        return this._exitResult(e);
      }
      if (e instanceof WebAssembly.RuntimeError) return { code: ERR.reversion, message: `module exited due to trap (${e.message})` };
      throw e;
    }
  }

  _checkMemory(instance) {
    if (instance.exports.memory.buffer.byteLength > MEMORY_LIMIT) {
      throw new KoinosError(ERR.reversion, "memory limit exceeded");
    }
  }

  _exitResult(signal) {
    if (signal.code === 0) return { code: 0, object: Buffer.from((signal.res && signal.res.object) || []) };
    if (!signal.res || !signal.res.error) return { code: ERR.reversion, message: "exit error did not contain error data" };
    return { code: signal.code, message: signal.res.error.message || "" };
  }

  _invokeSystemCall(instance, sid, retPtr, retLen, argPtr, argLen, bytesWrittenPtr) {
    const memory = instance.exports.memory;
    const args = Buffer.from(new Uint8Array(memory.buffer, argPtr, argLen));
    let code = 0;
    let message = "";
    let ret = null;
    try {
      ret = this._systemCall(sid, args);
    } catch (e) {
      if (e instanceof ExitSignal) throw e;
      if (!(e instanceof KoinosError)) throw e;
      code = e.code;
      message = e.message;
    }
    // host_api::invoke_system_call: reversions unwind the user contract
    if (code >= ERR.reversion) throw new KoinosError(code, message);
    let out = ret ? Buffer.from(ret) : Buffer.alloc(0);
    if (code !== 0) out = Buffer.from(koinos.chain.error_data.encode({ message }).finish());
    if (out.length > retLen) throw new KoinosError(ERR.insufficient_return_buffer, "return buffer too small");
    new Uint8Array(memory.buffer, retPtr, out.length).set(out);
    new DataView(memory.buffer).setUint32(bytesWrittenPtr, out.length, true);
    return code;
  }

  /** executes a system call for the current frame, returns the encoded result */
  _systemCall(sid, args) {
    const C = koinos.chain;
    switch (sid) {
      case SID.get_arguments:
        return C.get_arguments_result.encode({ value: { entry_point: this.frame.entryPoint, arguments: this.frame.args } }).finish();

      case SID.exit: {
        const { code, res } = C.exit_arguments.decode(args);
        throw new ExitSignal(code, res);
      }

      case SID.get_contract_id:
        return C.get_contract_id_result.encode({ value: this.frame.contractId }).finish();

      case SID.get_caller:
        return C.get_caller_result.encode({ value: this.caller() }).finish();

      case SID.call: {
        const { contract_id, entry_point, args: callArgs } = C.call_arguments.decode(args);
        const object = this._call(Buffer.from(contract_id), entry_point, Buffer.from(callArgs));
        return C.call_result.encode({ value: object }).finish();
      }

      case SID.check_authority: {
        const { type, account, data } = C.check_authority_arguments.decode(args);
        return C.check_authority_result.encode({ value: this.checkAuthority(type, Buffer.from(account), Buffer.from(data || [])) }).finish();
      }

      case SID.get_contract_address: {
        const { name } = koinos.contracts.name_service.get_address_arguments.decode(args);
        const address = this.names.get(name) || Buffer.alloc(0);
        return koinos.contracts.name_service.get_address_result.encode({ value: { address } }).finish();
      }

      case SID.get_contract_name: {
        const { address } = koinos.contracts.name_service.get_name_arguments.decode(args);
        let name = "";
        for (const [n, a] of this.names) if (a.equals(Buffer.from(address))) name = n;
        return koinos.contracts.name_service.get_name_result.encode({ value: { name } }).finish();
      }

      case SID.get_block_field: {
        const { field } = C.get_block_field_arguments.decode(args);
        if (field === "header.timestamp") return C.get_block_field_result.encode({ value: { uint64_value: this.time.toString() } }).finish();
        if (field === "header.height") return C.get_block_field_result.encode({ value: { uint64_value: this.height.toString() } }).finish();
        throw new KoinosError(ERR.field_not_found, `unknown block field ${field}`);
      }

      case SID.get_head_info:
        return C.get_head_info_result.encode({ value: { head_block_time: this.time.toString(), head_topology: { height: this.height.toString() } } }).finish();

      case SID.get_transaction: {
        if (!this.tx) throw new KoinosError(ERR.internal_error, "transaction does not exist");
        return C.get_transaction_result.encode({ value: this.tx.protocol }).finish();
      }

      case SID.hash: {
        const { code, obj } = C.hash_arguments.decode(args);
        if (Number(code.toString()) !== 0x12) throw new KoinosError(ERR.unknown_hash_code, "unknown hash code");
        return C.hash_result.encode({ value: multihashSha256(obj) }).finish();
      }

      case SID.put_object: {
        const { space, key, obj } = C.put_object_arguments.decode(args);
        this._writable();
        this._spaceMap(space, true).set(hex(key), { key: Buffer.from(key), value: Buffer.from(obj) });
        return null;
      }

      case SID.remove_object: {
        const { space, key } = C.remove_object_arguments.decode(args);
        this._writable();
        const map = this._spaceMap(space, false);
        if (map) map.delete(hex(key));
        return null;
      }

      case SID.get_object: {
        const { space, key } = C.get_object_arguments.decode(args);
        const map = this._spaceMap(space, false);
        const found = map && map.get(hex(key));
        if (!found) return C.get_object_result.encode({}).finish();
        return C.get_object_result.encode({ value: { exists: true, value: found.value } }).finish();
      }

      case SID.get_next_object:
      case SID.get_prev_object: {
        const next = sid === SID.get_next_object;
        const { space, key } = (next ? C.get_next_object_arguments : C.get_prev_object_arguments).decode(args);
        const map = this._spaceMap(space, false);
        let best = null;
        const k = Buffer.from(key);
        for (const entry of map ? map.values() : []) {
          const cmp = Buffer.compare(entry.key, k);
          if (next ? cmp <= 0 : cmp >= 0) continue;
          if (!best || (next ? Buffer.compare(entry.key, best.key) < 0 : Buffer.compare(entry.key, best.key) > 0)) best = entry;
        }
        const type = next ? C.get_next_object_result : C.get_prev_object_result;
        if (!best) return type.encode({}).finish();
        return type.encode({ value: { exists: true, value: best.value, key: best.key } }).finish();
      }

      case SID.event: {
        const { name, data, impacted } = C.event_arguments.decode(args);
        this._writable();
        this.events.push({
          sequence: this.events.length,
          source: b58(this.frame.contractId),
          name,
          data: Buffer.from(data),
          impacted: impacted.map((a) => b58(a)),
        });
        return null;
      }

      case SID.log: {
        const { message } = C.log_arguments.decode(args);
        this.logs.push(message);
        return null;
      }

      default:
        throw new KoinosError(ERR.unknown_system_call, `system call ${sid} not supported by the emulator`);
    }
  }

  /** caller of the current contract frame (get_caller) */
  caller() {
    const callerFrame = this.frames[this.frames.length - 2];
    return { caller: callerFrame.contractId, caller_privilege: callerFrame.privilege };
  }

  /** check_authority thunk, for the contract of the current frame */
  checkAuthority(type, account, data) {
    if (this.frame.readOnly) throw new KoinosError(ERR.read_only_context, "unable to perform action while context is read only");
    const contract = this.contracts.get(hex(account));
    const override = contract && contract.authorizesCallContract;
    if (override) return this._authorizeCall(account, AUTH.contract_call, data);
    return this.tx.signers.has(hex(account));
  }

  /** calls the authorize entry point of an account (in kernel mode) */
  _authorizeCall(account, type, data) {
    const args = { type };
    if (type === AUTH.contract_call) {
      args.call = {
        contract_id: this.frame.contractId,
        entry_point: this.frame.entryPoint,
        caller: this.caller().caller,
        data: data || Buffer.alloc(0),
      };
    }
    const encoded = koinos.chain.authorize_arguments.encode(args).finish();
    // the system calls authorize: kernel frame
    this.frames.push({ contractId: Buffer.alloc(0), privilege: KERNEL, readOnly: false, entryPoint: 0, args: Buffer.alloc(0) });
    try {
      const result = this._call(account, AUTHORIZE_ENTRY_POINT, encoded);
      return !!koinos.chain.authorize_result.decode(result).value;
    } finally {
      this.frames.pop();
    }
  }

  _writable() {
    if (this.frame.readOnly) throw new KoinosError(ERR.read_only_context, "cannot write during read only call");
  }

  /** object spaces: a user contract can only access its own spaces (state::assert_permissions) */
  _spaceMap(space, create) {
    const zone = Buffer.from(space.zone || []);
    if (space.system || !zone.equals(this.frame.contractId)) {
      throw new KoinosError(ERR.insufficient_privileges, "privileged object space");
    }
    const key = `${space.system ? 1 : 0}:${hex(zone)}:${space.id || 0}`;
    let map = this.db.get(key);
    if (!map && create) {
      map = new Map();
      this.db.set(key, map);
    }
    return map;
  }

  /** direct access to the state of a contract (test only, like Uniswap's MockTimeUniswapV3Pool setters) */
  getObject(contractId, spaceId, key) {
    const map = this.db.get(`0:${hex(addressBytes(contractId))}:${spaceId}`);
    const found = map && map.get(hex(key));
    return found ? found.value : null;
  }

  putObject(contractId, spaceId, key, value) {
    const spaceKey = `0:${hex(addressBytes(contractId))}:${spaceId}`;
    if (!this.db.has(spaceKey)) this.db.set(spaceKey, new Map());
    this.db.get(spaceKey).set(hex(key), { key: Buffer.from(key), value: Buffer.from(value) });
  }

  _snapshot() {
    const copy = new Map();
    for (const [space, map] of this.db) copy.set(space, new Map(map));
    return { db: copy, contracts: new Map(this.contracts) };
  }

  _restore(snapshot) {
    this.db = snapshot.db;
    this.contracts = snapshot.contracts;
  }
}

/** API of the JavaScript contracts, with the same semantics as the system calls */
class NativeContext {
  constructor(vm) {
    this.vm = vm;
  }

  get contractId() {
    return this.vm.frame.contractId;
  }

  get caller() {
    return this.vm.caller();
  }

  call(contractId, entry, args) {
    return this.vm._call(addressBytes(contractId), entry, args);
  }

  /** the arguments of the call are given to a smart wallet (System.checkAccountAuthority of the SDK) */
  checkAuthority(account, data = this.vm.frame.args) {
    return this.vm.checkAuthority(AUTH.contract_call, addressBytes(account), data);
  }

  /** the account is a contract that overrides the contract call authority (smart wallet) */
  contractAuthorizes(account) {
    const contract = this.vm.contracts.get(hex(addressBytes(account)));
    return !!(contract && contract.authorizesCallContract);
  }

  event(name, data, impacted = []) {
    this.vm._writable();
    this.vm.events.push({ sequence: this.vm.events.length, source: b58(this.contractId), name, data: Buffer.from(data), impacted: impacted.map((a) => (typeof a === "string" ? a : b58(a))) });
  }

  get(spaceId, key) {
    const map = this.vm._spaceMap({ system: false, zone: this.contractId, id: spaceId }, false);
    const found = map && map.get(hex(key));
    return found ? found.value : null;
  }

  put(spaceId, key, value) {
    this.vm._writable();
    this.vm._spaceMap({ system: false, zone: this.contractId, id: spaceId }, true).set(hex(key), { key: Buffer.from(key), value: Buffer.from(value) });
  }

  remove(spaceId, key) {
    this.vm._writable();
    const map = this.vm._spaceMap({ system: false, zone: this.contractId, id: spaceId }, false);
    if (map) map.delete(hex(key));
  }

  /** the object after (next) or before `key` in the space, or null (get_next_object / get_prev_object) */
  neighbour(spaceId, key, next = true) {
    const map = this.vm._spaceMap({ system: false, zone: this.contractId, id: spaceId }, false);
    const k = Buffer.from(key);
    let best = null;
    for (const entry of map ? map.values() : []) {
      const cmp = Buffer.compare(entry.key, k);
      if (next ? cmp <= 0 : cmp >= 0) continue;
      if (!best || (next ? Buffer.compare(entry.key, best.key) < 0 : Buffer.compare(entry.key, best.key) > 0)) best = entry;
    }
    return best ? { key: best.key, value: best.value } : null;
  }

  revert(message) {
    throw new ExitSignal(ERR.reversion, { error: { message } });
  }

  require(condition, message) {
    if (!condition) this.revert(message);
  }
}

module.exports = { KoinosVM, KoinosError, TransactionError, entryPoint, addressBytes, multihashSha256, b58, AUTHORIZE_ENTRY_POINT };
