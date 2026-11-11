// Loads tests/build/harness.wasm and exposes its exports as plain JS functions taking/returning
// strings. Any Koinos system call (System.require/revert → exit) is turned into a thrown Revert
// with the error message.
const fs = require("fs");
const path = require("path");
const loader = require("@assemblyscript/loader");

class Revert extends Error {}

/** fields of a protobuf message: field number → varint (BigInt) or bytes */
function protobufFields(buf) {
  const fields = {};
  let i = 0;
  const varint = () => {
    let value = 0n;
    let shift = 0n;
    let b;
    do {
      b = buf[i++];
      value |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while (b & 0x80);
    return value;
  };
  while (i < buf.length) {
    const key = Number(varint());
    const wireType = key & 7;
    if (wireType === 0) fields[key >> 3] = varint();
    else if (wireType === 2) {
      const length = Number(varint());
      fields[key >> 3] = buf.subarray(i, i + length);
      i += length;
    } else break;
  }
  return fields;
}

/** the error message of koinos.chain.exit_arguments { code = 1; res = 2 { error = 2 { message = 1 } } } */
function exitMessage(args) {
  const res = protobufFields(args)[2];
  const error = res && protobufFields(res)[2];
  const message = error && protobufFields(error)[1];
  return message ? Buffer.from(message).toString() : "revert";
}

const wasmModule = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, "build", "harness.wasm")));

let instance = null;

function instantiate() {
  instance = loader.instantiateSync(wasmModule, {
    wasi_snapshot_preview1: {
      fd_write() {
        return 0;
      },
      proc_exit() {
        throw new Revert("abort");
      },
    },
    env: {
      invoke_system_call(sid, retPtr, retLen, argPtr, argLen) {
        // the only system call used by the math libraries is `exit` (System.require / revert)
        throw new Revert(exitMessage(new Uint8Array(instance.exports.memory.buffer, argPtr, argLen)));
      },
    },
  });
  // WASI style modules defer the top-level initialization (static data, runtime) to `_start`
  if (instance.exports._start) instance.exports._start();
}

instantiate();

function call(name, ...args) {
  const exp = instance.exports;
  const pinned = [];
  const wasmArgs = args.map((a) => {
    if (typeof a === "string") {
      const ptr = exp.__pin(exp.__newString(a));
      pinned.push(ptr);
      return ptr;
    }
    if (typeof a === "bigint") {
      const ptr = exp.__pin(exp.__newString(a.toString()));
      pinned.push(ptr);
      return ptr;
    }
    if (typeof a === "boolean") return a ? 1 : 0;
    return a;
  });
  try {
    const res = exp[name](...wasmArgs);
    pinned.forEach((p) => exp.__unpin(p));
    return res;
  } catch (e) {
    // the shadow stack is left in an inconsistent state after a trap, start from scratch
    instantiate();
    if (e instanceof Revert) throw e;
    throw new Revert(e.message);
  }
}

function callString(name, ...args) {
  const ptr = call(name, ...args);
  return instance.exports.__getString(ptr);
}

module.exports = { call, callString, Revert };
