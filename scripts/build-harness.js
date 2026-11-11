// Compiles tests/harness/index.ts (pure math libraries) into a standalone wasm module used by
// the differential tests in tests/*.test.js
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "tests", "build");
fs.mkdirSync(outDir, { recursive: true });

const cmd = [
  "node",
  path.join(root, "node_modules", "assemblyscript", "bin", "asc"),
  path.join(root, "tests", "harness", "index.ts"),
  "--binaryFile", path.join(outDir, "harness.wasm"),
  "--optimizeLevel", "3",
  "--shrinkLevel", "0",
  "--runtime", "incremental",
  "--exportRuntime",
  "--use", "BUILD_FOR_TESTING=0",
  "--disable", "sign-extension",
].join(" ");

console.log(cmd);
execSync(cmd, { stdio: "inherit", cwd: root });

// tests/harness/pool-libraries.ts (v3-core): the pool libraries that use the storage (run in the
// Koinos VM emulator). Needs the generated pool proto (scripts/build.js). Stub runtime like the
// contracts.
const poolLibraries = path.join(root, "tests", "harness", "pool-libraries.ts");
const poolLibrariesCmd = [
  "node",
  path.join(root, "node_modules", "assemblyscript", "bin", "asc"),
  poolLibraries,
  "--binaryFile", path.join(outDir, "pool-libraries.wasm"),
  "--optimizeLevel", "3",
  "--shrinkLevel", "0",
  "--runtime", "stub",
  "--exportRuntime",
  "--use", "BUILD_FOR_TESTING=0",
  "--disable", "sign-extension",
].join(" ");

if (fs.existsSync(poolLibraries)) {
  console.log(poolLibrariesCmd);
  execSync(poolLibrariesCmd, { stdio: "inherit", cwd: root });
}
