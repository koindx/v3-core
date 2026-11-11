// Creates a KoinDX v3 pool.
//
// Koinos has no CREATE2: the pool bytecode is uploaded to a new random address in the same
// transaction that calls `factory.create_pool`. The pool overrides its own authority, so the
// key of the new address has no power over the pool after the transaction (it is discarded).
// Optionally, the initial price is set in the same transaction.
//
// usage:
//   PRIVATE_KEY=<payer wif> RPC_URL=<rpc> FACTORY=<factory address> \
//   TOKEN_A=<koin | vhp | token address> TOKEN_B=<...> FEE=<100 | 500 | 3000 | 10000> \
//   [SQRT_PRICE_X96=<initial sqrt price Q64.96 of token1/token0>] node scripts/create-pool.js
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Signer, Provider, Contract } = require("koilib");
require("dotenv").config();

const { PRIVATE_KEY, RPC_URL, FACTORY, TOKEN_A, TOKEN_B, FEE, SQRT_PRICE_X96 } = process.env;

/** the DEBUG_ABORT builds are only for local debugging */
function requireDeployableBuild(root, contract) {
  const file = path.join(root, "contracts", contract, "build", "release", "build.json");
  if (!fs.existsSync(file)) throw new Error(`${contract} is not built, run: yarn build:release`);
  if (JSON.parse(fs.readFileSync(file, "utf8")).debugAbort) {
    throw new Error(`${contract} was built with DEBUG_ABORT=1, rebuild it without it`);
  }
}

function loadAbi(root, name) {
  const abi = JSON.parse(fs.readFileSync(path.join(root, `contracts/${name}/abi/${name}-abi.json`), "utf8"));
  abi.koilib_types = abi.types;
  return abi;
}

async function main() {
  if (!PRIVATE_KEY || !RPC_URL || !FACTORY || !TOKEN_A || !TOKEN_B || !FEE) {
    throw new Error("PRIVATE_KEY, RPC_URL, FACTORY, TOKEN_A, TOKEN_B and FEE are required");
  }
  const root = path.resolve(__dirname, "..");
  requireDeployableBuild(root, "pool");
  const provider = new Provider(RPC_URL);
  const payer = Signer.fromWif(PRIVATE_KEY);
  payer.provider = provider;
  const poolSigner = Signer.fromSeed(crypto.randomBytes(32).toString("hex"));
  poolSigner.provider = provider;

  const poolAbi = loadAbi(root, "pool");
  const pool = new Contract({
    id: poolSigner.address,
    abi: poolAbi,
    provider,
    signer: poolSigner,
    bytecode: fs.readFileSync(path.join(root, "contracts/pool/build/release/contract.wasm")),
  });
  const factory = new Contract({ id: FACTORY, abi: loadAbi(root, "factory"), provider, signer: payer });

  const operations = [];
  const { operation: upload } = await pool.deploy({
    abi: fs.readFileSync(path.join(root, "contracts/pool/abi/pool.abi"), "utf8"),
    authorizesCallContract: true,
    authorizesTransactionApplication: true,
    authorizesUploadContract: true,
    onlyOperation: true,
  });
  operations.push(upload);
  operations.push(
    (await factory.functions.create_pool({ tokenA: TOKEN_A, tokenB: TOKEN_B, fee: Number(FEE) }, { onlyOperation: true })).operation
  );
  if (SQRT_PRICE_X96) {
    operations.push((await pool.functions.initialize({ sqrtPriceX96: SQRT_PRICE_X96 }, { onlyOperation: true })).operation);
  }

  const transaction = await payer.prepareTransaction({ operations, header: { payer: payer.address } });
  await poolSigner.signTransaction(transaction);
  await payer.signTransaction(transaction);

  console.log(`Creating the pool ${TOKEN_A} / ${TOKEN_B} (fee ${FEE}) at ${poolSigner.address}...`);
  const { receipt, transaction: tx } = await provider.sendTransaction(transaction);
  console.log(receipt);
  await tx.wait();
  console.log(`Pool created at ${poolSigner.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
