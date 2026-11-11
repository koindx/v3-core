// Clients of the compiled KoinDX contracts running in the Koinos VM emulator
const fs = require("fs");
const path = require("path");
const { Codec } = require("../../vm/codec");
const { TransactionError } = require("../../vm/koinos-vm");

/** loads the release build and the ABI of a contract of this package */
function loadContract(name, root = path.resolve(__dirname, "..", "..", "..")) {
  const wasmPath = path.join(root, "contracts", name, "build", "release", "contract.wasm");
  const abiPath = path.join(root, "contracts", name, "abi", `${name}-abi.json`);
  if (!fs.existsSync(wasmPath) || !fs.existsSync(abiPath)) {
    throw new Error(`${name} is not built: run yarn build:release`);
  }
  const abi = JSON.parse(fs.readFileSync(abiPath, "utf8"));
  return { name, abi, codec: new Codec(abi), wasm: fs.readFileSync(wasmPath) };
}

const signersOf = (from) => (Array.isArray(from) ? from : [from]).map((a) => (typeof a === "string" ? a : a.address));

class ContractClient {
  constructor(vm, address, contract) {
    this.vm = vm;
    this.address = address;
    this.contract = contract;
    this.codec = contract.codec;
  }

  encodeArgs(method, args = {}) {
    const m = this.codec.method(method);
    return m.argument ? this.codec.encode(m.argument, args) : new Uint8Array(0);
  }

  decodeResult(method, bytes) {
    const m = this.codec.method(method);
    return m.return ? this.codec.decode(m.return, bytes) : {};
  }

  read(method, args = {}) {
    const m = this.codec.method(method);
    return this.decodeResult(method, this.vm.read(this.address, m.entry_point, this.encodeArgs(method, args)));
  }

  operation(method, args = {}) {
    return { call: { contractId: this.address, entryPoint: this.codec.method(method).entry_point, args: this.encodeArgs(method, args) } };
  }

  /** sends a transaction signed by `from` (account or list of accounts) */
  send(from, method, args = {}) {
    const res = this.vm.transaction({ signers: signersOf(from), operations: [this.operation(method, args)] });
    return { result: this.decodeResult(method, res.results[0]), events: res.events };
  }

  /** executes a transaction without committing it (Uniswap: callStatic) */
  callStatic(from, method, args = {}) {
    const res = this.vm.transaction({ signers: signersOf(from), operations: [this.operation(method, args)], dryRun: true });
    return this.decodeResult(method, res.results[0]);
  }

  /** decodes the events emitted by this contract */
  events(events, name) {
    return events
      .filter((e) => e.source === this.address && (!name || e.name === name))
      .map((e) => ({ name: e.name, args: this.codec.decode(e.name, e.data) }));
  }
}

/** expects a transaction to revert, with a message containing `reason` when given */
function expectRevert(fn, reason) {
  let error = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error(`expected a revert${reason ? ` (${reason})` : ""} but the transaction succeeded`);
  if (!(error instanceof TransactionError)) throw error;
  if (reason !== undefined && !error.message.includes(reason)) {
    throw new Error(`expected revert "${reason}", got "${error.message}"`);
  }
  return error;
}

module.exports = { loadContract, ContractClient, expectRevert, signersOf };
