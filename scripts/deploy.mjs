#!/usr/bin/env node
// Deploy QUEUE to NEAR testnet. Never prints or commits secret keys.
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ROOT,
  NETWORK,
  ensureState,
  loadEnv,
  loadKey,
  account,
  deploy,
  deployCodeOnly,
  sha256,
  writeJson,
  ensureAccount,
  accountExists,
  nearBalance,
  view,
} from "./lib.mjs";

loadEnv();
ensureState();

const parentId = process.env.QUEUE_PARENT_ACCOUNT_ID;
if (!parentId) {
  console.error("Set QUEUE_PARENT_ACCOUNT_ID (a funded testnet account) before deploying.");
  process.exit(1);
}

const contractId = process.env.QUEUE_CONTRACT_ID || `market.${parentId}`;
const operatorId = process.env.QUEUE_OPERATOR_ACCOUNT_ID || `worker.${parentId}`;
const treasuryId = process.env.QUEUE_TREASURY_ACCOUNT_ID || `treasury.${parentId}`;
const buyerId = process.env.QUEUE_BUYER_ACCOUNT_ID || `kestrel.${parentId}`;
const agentIds = {
  mira: process.env.QUEUE_MIRA_ACCOUNT_ID || `mira.${parentId}`,
  atlas: process.env.QUEUE_ATLAS_ACCOUNT_ID || `atlas.${parentId}`,
  vale: process.env.QUEUE_VALE_ACCOUNT_ID || `vale.${parentId}`,
  juno: process.env.QUEUE_JUNO_ACCOUNT_ID || `juno.${parentId}`,
};

async function ensure(role, prefix, envName, balanceNear) {
  const value = await ensureAccount(role, prefix, envName, balanceNear);
  console.log(`account ${role}: ${value.accountId}`);
  return value;
}

const contract = await ensure("contract", "market", "QUEUE_CONTRACT", 2.75);
const operator = await ensure("operator", "worker", "QUEUE_OPERATOR", 0.1);
const treasury = await ensure("treasury", "treasury", "QUEUE_TREASURY", 0.05);
const buyer = await ensure("buyer", "kestrel", "QUEUE_BUYER", 0.2);
// Orion holds the tight-deadline job that the contract protects in the refusal episode.
const orion = await ensure("orion", "orion", "QUEUE_ORION", 0.06);
const agents = {
  mira: await ensure("mira", "mira", "QUEUE_MIRA", 0.1),
  atlas: await ensure("atlas", "atlas", "QUEUE_ATLAS", 0.1),
  vale: await ensure("vale", "vale", "QUEUE_VALE", 0.1),
  juno: await ensure("juno", "juno", "QUEUE_JUNO", 0.1),
};

const wasmPath = path.join(
  ROOT,
  "contracts/queue/target/wasm32-unknown-unknown/release/queue.wasm",
);
if (!existsSync(wasmPath)) {
  console.log("building wasm…");
  const build = spawnSync(
    "cargo",
    ["build", "--target", "wasm32-unknown-unknown", "--release"],
    { cwd: path.join(ROOT, "contracts/queue"), stdio: "inherit" },
  );
  if (build.status !== 0) throw new Error("cargo build failed");
}
const wasm = readFileSync(wasmPath);
const signer = account(contract.accountId, contract.secretKey);
const wasmHash = sha256(wasm);

let deployTx = null;
const exists = await accountExists(contractId);
let hasState = false;
if (exists) {
  try {
    await view(contractId, "get_config");
    hasState = true;
  } catch {
    hasState = false;
  }
}
// A freshly created account has no state yet: it always needs the code + init.
if (process.env.QUEUE_REDEPLOY === "1" || !hasState) {
  console.log(`deploying ${wasm.length} bytes to ${contractId} (sha256 ${wasmHash.slice(0, 16)}…)`);
  const result = hasState
    ? await deployCodeOnly(signer, contractId, wasm)
    : await deploy(signer, contractId, wasm, {
        owner_id: contractId,
        operator_id: operator.accountId,
        treasury_id: treasury.accountId,
        fee_bps: 100,
      });
  deployTx = result.tx_hash;
  console.log(`deploy tx ${deployTx}${hasState ? " (code only; existing state preserved)" : ""}`);
} else {
  console.log(`using existing contract ${contractId} (set QUEUE_REDEPLOY=1 to replace the code)`);
}

// A run that reuses the live contract keeps the recorded deploy transaction.
if (!deployTx && existsSync(path.join(ROOT, "data", "deploy.json"))) {
  const previous = JSON.parse(readFileSync(path.join(ROOT, "data", "deploy.json"), "utf8"));
  if (previous.contractId === contractId) deployTx = previous.deployTx ?? null;
}

const balance = await nearBalance(contractId);
const publicAgents = Object.fromEntries(
  Object.entries(agents).map(([name, value]) => [
    name,
    { accountId: value.accountId, publicKey: value.publicKey },
  ]),
);
const proof = {
  network: NETWORK,
  contractId,
  ownerId: contractId,
  operatorId: operator.accountId,
  treasuryId: treasury.accountId,
  buyerId: buyer.accountId,
  orionId: orion.accountId,
  agents: publicAgents,
  feeBps: 100,
  wasmSha256: wasmHash,
  wasmBytes: wasm.length,
  deployTx,
  deployedAt: new Date().toISOString(),
  contractBalanceYocto: balance.toString(),
  explorer: `https://testnet.nearblocks.io/address/${contractId}`,
  rpc: process.env.QUEUE_RPC_URL || "https://rpc.testnet.fastnear.com",
};
writeJson("data/deploy.json", proof);
writeJson(".testnet/roles.json", proof);

const envLines = [
  "QUEUE_PORT=8789",
  "QUEUE_DB_PATH=./data/queue.db",
  "QUEUE_NETWORK=testnet",
  `QUEUE_RPC_URL=${proof.rpc}`,
  `QUEUE_CONTRACT_ID=${contractId}`,
  `QUEUE_OPERATOR_ACCOUNT_ID=${operator.accountId}`,
  `QUEUE_OPERATOR_PRIVATE_KEY=${operator.secretKey}`,
  `QUEUE_TREASURY_ACCOUNT_ID=${treasury.accountId}`,
  `QUEUE_TREASURY_PRIVATE_KEY=${treasury.secretKey}`,
  `QUEUE_BUYER_ACCOUNT_ID=${buyer.accountId}`,
  `QUEUE_BUYER_PRIVATE_KEY=${buyer.secretKey}`,
  `QUEUE_ORION_ACCOUNT_ID=${orion.accountId}`,
  `QUEUE_ORION_PRIVATE_KEY=${orion.secretKey}`,
  ...Object.entries(agents).flatMap(([name, value]) => [
    `QUEUE_${name.toUpperCase()}_ACCOUNT_ID=${value.accountId}`,
    `QUEUE_${name.toUpperCase()}_PRIVATE_KEY=${value.secretKey}`,
  ]),
];
const envFile = path.join(ROOT, ".env");
const existing = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
const keep = existing
  .split(/\r?\n/)
  .filter((line) => line && !/^QUEUE_(PORT|DB_PATH|NETWORK|RPC_URL|CONTRACT_ID|OPERATOR_|TREASURY_|BUYER_|ORION_|MIRA_|ATLAS_|VALE_|JUNO_)/.test(line));
writeFileSync(envFile, `${[...keep, ...envLines].join("\n")}\n`, { mode: 0o600 });
chmodSync(envFile, 0o600);

console.log("\nQUEUE testnet deployment");
console.log(`  contract   ${contractId}`);
console.log(`  operator   ${operator.accountId}`);
console.log(`  buyer      ${buyer.accountId}`);
console.log(`  wasm sha   ${wasmHash}`);
console.log(`  balance    ${(Number(balance) / 1e24).toFixed(4)} NEAR`);
console.log(`  explorer   ${proof.explorer}`);
console.log("\nProof written to data/deploy.json. Secrets are in .env and .testnet/ (ignored).");
