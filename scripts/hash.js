// Prints the sha256 multihash of the pool bytecode accepted by the factory
// (the value embedded in contracts/factory/assembly/PoolHash.ts by scripts/build.js).
// usage: node scripts/hash.js [debug|release]
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const mode = process.argv[2] || "release";
const wasm = fs.readFileSync(path.join(__dirname, "..", "contracts", "pool", "build", mode, "contract.wasm"));
const digest = crypto.createHash("sha256").update(wasm).digest();
const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), digest]);
console.log(`Pool bytecode hash (${mode}): 0x${multihash.toString("hex")}`);
console.log(`Bytes: [${[...multihash].join(", ")}]`);
