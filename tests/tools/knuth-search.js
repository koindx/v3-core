// Generates tests/fixtures/knuth-addback.json: inputs that execute the rarely used "add back"
// correction step of the Knuth division (algorithm D) used by U256.div/mod/mulDiv.
// usage: node tests/tools/knuth-search.js
// JS model of the digit loop of U256 divideProduct (Knuth D, 32-bit digits) that reports
// whether the "add back" correction step and the qhat adjustment loop are executed.
const B = 1n << 32n;
function digits(x, n) { const d = []; for (let i = 0; i < n; i++) { d.push(x & (B - 1n)); x >>= 32n; } return d; }
function run(u, v) {
  let n = 8; const dv = digits(v, 8); while (n > 0 && dv[n - 1] === 0n) n--;
  let m = 16; const du = digits(u, 16); while (m > 0 && du[m - 1] === 0n) m--;
  if (m < n || n === 1) return { addBack: false, adjust: false };
  const s = BigInt(Math.clz32(Number(dv[n - 1])));
  const vn = digits((v << s), 8), un = digits((u << s), 17);
  let addBack = false, adjust = false;
  for (let j = m - n; j >= 0; j--) {
    const num = (un[j + n] << 32n) | un[j + n - 1];
    let qhat = num / vn[n - 1], rhat = num - qhat * vn[n - 1];
    while (qhat >= B || qhat * vn[n - 2] > ((rhat << 32n) | un[j + n - 2])) { adjust = true; qhat--; rhat += vn[n - 1]; if (rhat >= B) break; }
    // multiply-subtract on the big integer slice
    let slice = 0n; for (let i = n; i >= 0; i--) slice = (slice << 32n) | un[j + i];
    let vv = 0n; for (let i = n - 1; i >= 0; i--) vv = (vv << 32n) | vn[i];
    let rem = slice - qhat * vv;
    if (rem < 0n) { addBack = true; qhat--; rem += vv; }
    const nd = digits(rem, n + 1); for (let i = 0; i <= n; i++) un[j + i] = nd[i];
  }
  return { addBack, adjust };
}

let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
const patterns = [0x80000000n, 0xFFFFFFFFn, 0x80000001n, 0x7FFFFFFFn, 0x00000001n, 0xFFFFFFFEn, 0n];
const digit = () => (rnd() % 3 === 0 ? ((BigInt(rnd()) << 1n) | BigInt(rnd() & 1)) & (B - 1n) : patterns[rnd() % patterns.length]);
const num = (len) => { let x = 0n; for (let i = 0; i < len; i++) x = (x << 32n) | digit(); return x; };
const divCases = [];
for (let iter = 0; iter < 3000000 && divCases.length < 30; iter++) {
  const v = num(2 + (rnd() % 7));
  if (v === 0n) continue;
  const u = num(3 + (rnd() % 6));
  if (u < (1n << 256n) && run(u, v).addBack) divCases.push([u, v]);
}
const str = (arr) => arr.map((t) => t.map(String));

// derive 512-bit mulDiv cases: mulDiv(u, 2^(32k), v * 2^(32k)) has the same digit structure
const md = [];
for (const [u, v] of divCases) {
  for (let k = 1; k < 8; k++) {
    const sh = 1n << BigInt(32 * k);
    if (v * sh >= (1n << 256n)) break;
    if (run(u * sh, v * sh).addBack) md.push([u, sh, v * sh]);
  }
}
console.error('derived mulDiv add-back cases (512-bit dividends: ' + md.filter(([u, s]) => u * s >= (1n << 256n)).length + '):', md.length);
require('fs').writeFileSync(require('path').join(__dirname, '..', 'fixtures', 'knuth-addback.json'), JSON.stringify({ div: str(divCases), mulDiv: str(md) }, null, 1));
