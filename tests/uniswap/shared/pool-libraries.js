// The pool libraries that use the storage (tests/harness/pool-libraries.ts, compiled to
// tests/build/pool-libraries.wasm) run in the Koinos VM emulator: the equivalent of the Uniswap
// test contracts TickTest, TickBitmapTest and OracleTest
const fs = require("fs");
const path = require("path");

const WASM = path.join(__dirname, "..", "..", "build", "pool-libraries.wasm");
let MODULE = null;

class PoolLibraries {
  constructor(vm, name = "pool libraries test") {
    if (!MODULE) {
      if (!fs.existsSync(WASM)) throw new Error("tests/build/pool-libraries.wasm is not built: run yarn build:test-harness");
      MODULE = new WebAssembly.Module(fs.readFileSync(WASM));
    }
    this.vm = vm;
    this.contractId = vm.account(name).address;
  }

  /** calls an exported function, the strings and bigints are passed as AssemblyScript strings */
  call(name, ...args) {
    return this._call(false, name, args);
  }

  /** calls an exported function without keeping the state changes (Uniswap: callStatic) */
  callStatic(name, ...args) {
    return this._call(true, name, args);
  }

  _call(dryRun, name, args) {
    return this.vm.callModule(this.contractId, MODULE, (exp) => {
      const wasmArgs = args.map((a) => {
        if (typeof a === "string" || typeof a === "bigint") return exp.__newString(a.toString());
        if (typeof a === "boolean") return a ? 1 : 0;
        return a;
      });
      return { exp, res: exp[name](...wasmArgs) };
    }, { dryRun });
  }

  callString(name, ...args) {
    const { exp, res } = this.call(name, ...args);
    return exp.__getString(res);
  }

  callVoid(name, ...args) {
    this.call(name, ...args);
  }
}

module.exports = { PoolLibraries };
