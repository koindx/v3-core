// Deploys the KoinDX v3 factory (release build) to the account of PRIVATE_KEY.
//
// The factory is uploaded with `authorizes_upload_contract`, so its code can't be modified
// after the deployment. The factory account keeps the ownership of the factory (owner
// functions: set_owner, enable_fee_amount, protocol fees of the pools), it can be transferred
// later (e.g. to a governance contract) in two steps: `set_owner` proposes, the new owner calls `accept_owner`.
//
// usage: PRIVATE_KEY=<factory account wif> RPC_URL=<rpc> node scripts/deploy-factory.js
const path = require("path");
const fs = require("fs");
const { Signer, Provider, Contract } = require("koilib");
require("dotenv").config();

const { PRIVATE_KEY, RPC_URL } = process.env;

/** the DEBUG_ABORT builds are only for local debugging */
function requireDeployableBuild(root, contract) {
  const file = path.join(root, "contracts", contract, "build", "release", "build.json");
  if (!fs.existsSync(file)) throw new Error(`${contract} is not built, run: yarn build:release`);
  if (JSON.parse(fs.readFileSync(file, "utf8")).debugAbort) {
    throw new Error(`${contract} was built with DEBUG_ABORT=1, rebuild it without it`);
  }
}

async function main() {
  if (!PRIVATE_KEY || !RPC_URL) throw new Error("PRIVATE_KEY and RPC_URL are required");
  const root = path.resolve(__dirname, "..");
  requireDeployableBuild(root, "pool");
  requireDeployableBuild(root, "factory");
  const abi = JSON.parse(fs.readFileSync(path.join(root, "contracts/factory/abi/factory-abi.json"), "utf8"));
  abi.koilib_types = abi.types;

  const provider = new Provider(RPC_URL);
  const signer = Signer.fromWif(PRIVATE_KEY);
  signer.provider = provider;

  const bytecode = fs.readFileSync(path.join(root, "contracts/factory/build/release/contract.wasm"));
  const factory = new Contract({ id: signer.address, abi, provider, signer, bytecode });

  console.log(`Deploying the factory to ${signer.address}...`);
  const { transaction, receipt } = await factory.deploy({
    abi: fs.readFileSync(path.join(root, "contracts/factory/abi/factory.abi"), "utf8"),
    authorizesUploadContract: true,
  });
  console.log(receipt);
  await transaction.wait();
  console.log(`Factory deployed at ${signer.address}`);
  console.log("Set this address as the factory of the network in v3-periphery/networks.json");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
