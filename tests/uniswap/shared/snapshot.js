// Reads the jest snapshots recorded by Uniswap (vendored in tests/uniswap/fixtures, the Uniswap
// v3 repositories are GPL-2.0-or-later): test name → expected value
const fs = require("fs");
const path = require("path");

function loadUniswapSnapshot(file) {
  const text = fs.readFileSync(path.join(__dirname, "..", "fixtures", file), "utf8");
  const snapshot = {};
  const re = /exports\[`(.*?)`\] = `([\s\S]*?)`;\n/g;
  let m;
  while ((m = re.exec(text))) {
    // pretty-format → JSON
    const json = m[2]
      .trim()
      .replace(/Object \{/g, "{")
      .replace(/Array \[/g, "[")
      .replace(/,(\s*[}\]])/g, "$1");
    snapshot[m[1]] = JSON.parse(json);
  }
  return snapshot;
}

module.exports = { loadUniswapSnapshot };
