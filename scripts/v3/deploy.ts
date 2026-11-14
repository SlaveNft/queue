// @ts-nocheck
/**
 * Deploy the v3 contract (contracts/queue-v3) to NEAR testnet. Idempotent; never prints secret keys.
 *
 *   npm run build:contract-v3 && npx tsx scripts/v3/deploy.ts
 *   npx tsx scripts/v3/deploy.ts --redeploy-code   # replace the code of our own deployment (state layout must
 *                                                   # not change); works only while the contract account still
 *                                                   # holds its full-access key
 *
 * What it builds (parent = QUEUE_SEASON_PARENT, default queue-demo.testnet):
 *   market5.<parent>   the v3 contract: 24 h owner timelock, minimum operator stake 0.5 NEAR, the model key and
 *                      model id already pinned for the v2 season copied in at init (before anyone deposits).
 *   owner2.<parent>    owner (proposals, pause). Reused from v2.
 *   worker./treasury.  reused operator and treasury. The operator posts a 1 NEAR stake.
 *   8 agents           a balance in the contract and a function-call key limited to the agent methods
 *                      (the v2 five plus release_job), as in v2.
 * Writes data/v3/market5.json. The v2 season contract (market4) is not touched.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { KeyPair, actions } from "near-api-js";
import { ROOT, loadEnv, loadKey, account, accountExists, createSubaccount, deploy, deployCodeOnly, call, view, nearBalance, sha256, writeJson, STATE } from "../lib.mjs";
import { PERSONAS, near } from "../season/agents.ts";

loadEnv();
const parent = process.env.QUEUE_SEASON_PARENT || "queue-demo.testnet";
const contractId = process.env.QUEUE_V3_CONTRACT || `market5.${parent}`;
const ownerId = `owner2.${parent}`;
const operatorId = process.env.QUEUE_OPERATOR_ACCOUNT_ID || `worker.${parent}`;
const treasuryId = process.env.QUEUE_TREASURY_ACCOUNT_ID || `treasury.${parent}`;
const TIMELOCK_SECS = 86_400;
const MIN_STAKE = near("0.5");
const STAKE = near("1");
const DEPOSIT = near(process.env.QUEUE_V3_DEPOSIT || "0.12");
const FC_ALLOWANCE = near("0.25");
const METHODS = ["submit_job", "set_move_ask", "request_priority", "cancel_job", "withdraw_credit", "release_job"];
const FC_DIR = path.join(STATE, "season");
mkdirSync(FC_DIR, { recursive: true, mode: 0o700 });

const wasmPath = path.join(ROOT, "contracts/queue-v3/target/wasm32-unknown-unknown/release/queue.wasm");
if (!existsSync(wasmPath)) throw new Error("build v3 first: npm run build:contract-v3");
const wasm = readFileSync(wasmPath);
const wasmSha256 = sha256(wasm);
// Contract account: code storage (10^19 yocto per byte) plus room for state.
const contractNear = Math.ceil((wasm.length * 1e19) / 1e24 * 100 + 50) / 100;

const metaFile = `data/v3/${contractId.split(".")[0]}.json`;
const out = existsSync(path.join(ROOT, metaFile)) ? JSON.parse(readFileSync(path.join(ROOT, metaFile), "utf8")) : {};
const save = () => writeJson(metaFile, out);

const parentKey = loadKey(parent);
const need = async (id: string, near_: number) => {
  if (await accountExists(id)) {
    const have = BigInt(await nearBalance(id));
    const want = near(String(near_));
    if (have + near("0.02") < want) {
      const r = await account(parent, parentKey.secretKey).transfer({ receiverId: id, amount: want - have });
      console.log(`top up ${id} by ${(Number(want - have) / 1e24).toFixed(3)} NEAR (${r.transaction?.hash ?? "?"})`);
    }
    return loadKey(id);
  }
  console.log(`create ${id} with ${near_} NEAR`);
  return createSubaccount(parent, parentKey.secretKey, id, near_);
};

console.log(`parent ${parent}: ${(Number(await nearBalance(parent)) / 1e24).toFixed(3)} NEAR; contract needs ${contractNear} NEAR`);

// 1. Accounts.
const contractKey = await need(contractId, contractNear);
await need(ownerId, 0.1);

// 2. Deploy once (refuse to overwrite foreign code).
const season = JSON.parse(readFileSync(path.join(ROOT, "data/season/testnet.json"), "utf8"));
if (out.wasmSha256 !== wasmSha256) {
  const { rpc } = await import("../season/chain.ts");
  const state = await rpc("query", { request_type: "view_account", finality: "final", account_id: contractId });
  const hasCode = state?.code_hash && state.code_hash !== "11111111111111111111111111111111";
  if (hasCode && !out.deployTx) throw new Error(`${contractId} already has code that this script did not deploy; refusing`);
  const init = {
    owner_id: ownerId, operator_id: operatorId, treasury_id: treasuryId, fee_bps: 100,
    timelock_secs: TIMELOCK_SECS, min_operator_stake: MIN_STAKE.toString(),
    tee_signers: season.teeSigners ?? [], tee_model: season.teeModel ?? null,
  };
  if (hasCode) {
    if (!process.argv.includes("--redeploy-code")) throw new Error(`${contractId} runs an earlier build (${out.wasmSha256?.slice(0, 12)}…): pass --redeploy-code, or upgrade it through the timelock`);
    const d = await deployCodeOnly(account(contractId, contractKey.secretKey), contractId, wasm);
    out.redeploys = [...(out.redeploys ?? []), { from: out.wasmSha256, to: wasmSha256, tx: d.tx_hash, at: new Date().toISOString() }];
    Object.assign(out, { wasmSha256, wasmBytes: wasm.length });
    save();
    console.log(`redeployed code ${wasmSha256.slice(0, 12)}… (${d.tx_hash})`);
  } else {
  console.log(`deploy v3 (${wasm.length} bytes, sha256 ${wasmSha256.slice(0, 12)}…) to ${contractId}`);
  const d = await deploy(account(contractId, contractKey.secretKey), contractId, wasm, init);
  Object.assign(out, { network: "testnet", version: "v3", contractId, ownerId, operatorId, treasuryId, wasmSha256, wasmBytes: wasm.length, deployTx: d.tx_hash, deployedAt: new Date().toISOString(), init });
  save();
  }
}

// 3. Operator stake.
const operator = account(operatorId, loadKey(operatorId).secretKey);
const cfg = await view(contractId, "get_config", {});
if (BigInt(cfg.operator_stake) < STAKE) {
  const r = await call(operator, contractId, "stake", {}, STAKE - BigInt(cfg.operator_stake), 30n);
  out.stakeTx = r.tx_hash;
  console.log(`operator staked ${(Number(STAKE - BigInt(cfg.operator_stake)) / 1e24).toFixed(3)} NEAR`);
  save();
}

// 3b. The operator approves the agents: where a stake backs the queue, only approved accounts can submit.
{
  const ids = PERSONAS.map((p) => `${p.id}.${parent}`);
  const missing = [];
  for (const id of ids) if (!(await view(contractId, "is_client", { account_id: id }))) missing.push(id);
  if (missing.length) {
    // The attached NEAR covers the new entries' storage; the contract sends the rest back.
    const r = await call(operator, contractId, "allow_clients", { accounts: missing }, near("0.02"), 30n);
    out.clientsTx = r.tx_hash;
    out.clients = ids;
    console.log(`operator approved ${missing.length} client(s) (${r.tx_hash})`);
    save();
  }
}

// 4. Agents: deposit + function-call key.
out.agents = out.agents || {};
for (const p of PERSONAS) {
  const id = `${p.id}.${parent}`;
  const full = account(id, loadKey(id).secretKey);
  const a = (out.agents[p.id] = out.agents[p.id] || { accountId: id });
  const bal = BigInt(await view(contractId, "get_credit", { account_id: id }));
  if (bal < DEPOSIT / 2n) {
    await need(id, Number(DEPOSIT / 10n ** 21n) / 1000 + 0.08);
    const r = await call(full, contractId, "deposit", {}, DEPOSIT, 30n);
    a.depositTx = r.tx_hash;
    console.log(`${p.id}: deposited ${Number(DEPOSIT) / 1e24} NEAR`);
  }
  const fcFile = path.join(FC_DIR, `${id}.${contractId}.fc.json`);
  if (!existsSync(fcFile)) {
    const kp = KeyPair.fromRandom("ed25519");
    const signed = await full.createSignedTransaction({ receiverId: id, actions: [actions.addFunctionCallAccessKey(kp.getPublicKey(), contractId, METHODS, FC_ALLOWANCE)] });
    const o = await full.provider.sendTransactionUntil(signed, "FINAL");
    writeFileSync(fcFile, JSON.stringify({ accountId: id, publicKey: kp.getPublicKey().toString(), secretKey: kp.toString(), receiverId: contractId, methods: METHODS }, null, 2), { mode: 0o600 });
    chmodSync(fcFile, 0o600);
    a.functionCallKey = kp.getPublicKey().toString();
    a.addKeyTx = o.transaction.hash;
    console.log(`${p.id}: function-call key added (${METHODS.length} methods on ${contractId})`);
  }
  a.functionCallKeyFile = path.relative(ROOT, fcFile);
  a.methods = METHODS;
  save();
}
out.operatorKeyFile = path.relative(ROOT, path.join(STATE, `${operatorId}.json`));
save();
console.log(`ready: ${metaFile} (${contractId})`);
