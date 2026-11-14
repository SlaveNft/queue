// @ts-nocheck
/**
 * Prepare a QUEUE v2 season on NEAR testnet. Idempotent; never prints secret keys.
 *
 *   npx tsx scripts/season/setup.ts               # deploy v2 + agents + function-call keys (needs testnet NEAR)
 *   npx tsx scripts/season/setup.ts --pin         # also pin NEAR AI's TEE signing keys (needs NEAR_AI_API_KEY)
 *   npx tsx scripts/season/setup.ts --lock        # IRREVERSIBLE: delete the contract account's full-access key
 *
 * What it builds (parent = QUEUE_SEASON_PARENT, default queue-demo.testnet):
 *   market4.<parent>   the v2 contract. Owner is a separate account, not the contract itself.
 *   owner2.<parent>    owner: pins TEE signers, pauses. Holds no escrow.
 *   worker./treasury.  reused operator and treasury.
 *   8 agents           kestrel, mira, atlas, vale, juno, orion, lyra, sable.
 *                      Each deposits a balance into the contract with its full key, then gets a function-call
 *                      key for that contract limited to submit_job, set_move_ask, request_priority, cancel_job,
 *                      withdraw_credit. The season runtime loads ONLY that key: it cannot transfer NEAR,
 *                      call any other contract, or attach a deposit, so an agent can lose at most its balance.
 * The v1 contract (market.queue-demo.testnet) and its proof are not touched.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { KeyPair, PublicKey, actions } from "near-api-js";
import { ROOT, loadEnv, loadKey, account, accountExists, createSubaccount, deploy, call, view, nearBalance, sha256, writeJson, STATE, TGAS } from "../lib.mjs";
import { PERSONAS, near } from "./agents.ts";
import { nearAiConfig, attestedSigners } from "./nearai.ts";

loadEnv();
const argv = process.argv.slice(2);
const parent = process.env.QUEUE_SEASON_PARENT || "queue-demo.testnet";
const contractId = process.env.QUEUE_SEASON_CONTRACT || `market4.${parent}`;
const ownerId = `owner2.${parent}`;
const operatorId = process.env.QUEUE_OPERATOR_ACCOUNT_ID || `worker.${parent}`;
const treasuryId = process.env.QUEUE_TREASURY_ACCOUNT_ID || `treasury.${parent}`;
const DEPOSIT = near(process.env.QUEUE_SEASON_DEPOSIT || "0.5");
const FC_ALLOWANCE = near("0.25");
const METHODS = ["submit_job", "set_move_ask", "request_priority", "cancel_job", "withdraw_credit"];
const FC_DIR = path.join(STATE, "season");
mkdirSync(FC_DIR, { recursive: true, mode: 0o700 });

const wasmPath = path.join(ROOT, "contracts/queue-v2/target/wasm32-unknown-unknown/release/queue.wasm");
if (!existsSync(wasmPath)) throw new Error("build v2 first: npm run build:contract-v2");
const wasm = readFileSync(wasmPath);
const wasmSha256 = sha256(wasm);

// One public metadata file per contract; data/season/testnet.json points at the current season contract.
const metaFile = `data/season/${contractId.split(".")[0]}.json`;
const prev = existsSync(path.join(ROOT, metaFile)) ? JSON.parse(readFileSync(path.join(ROOT, metaFile), "utf8")) : {};
const out = prev.contractId === contractId ? prev : {};
const save = () => {
  writeJson(metaFile, out);
  writeJson("data/season/testnet.json", out);
};

const parentKey = loadKey(parent);
const need = async (id: string, near_: number) => {
  if (await accountExists(id)) {
    // Existing account: top it up from the parent to at least `near_` NEAR.
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

// 0. Funds check, before anything irreversible.
const parentBal = Number(await nearBalance(parent)) / 1e24;
console.log(`parent ${parent}: ${parentBal.toFixed(3)} NEAR`);

// 1. Accounts.
const contractKey = await need(contractId, 3.5);
const ownerKey = await need(ownerId, 0.1);
const agentIds: Record<string, string> = {};
for (const p of PERSONAS) {
  const envId = process.env[`QUEUE_${p.id.toUpperCase()}_ACCOUNT_ID`] || (p.id === "kestrel" ? process.env.QUEUE_BUYER_ACCOUNT_ID : undefined);
  agentIds[p.id] = envId || `${p.id}.${parent}`;
}
for (const p of PERSONAS) {
  // Already deposited into this contract: the wallet only needs gas.
  let deposited = 0n;
  try {
    deposited = BigInt(await view(contractId, "get_credit", { account_id: agentIds[p.id] }));
  } catch {
    deposited = 0n; // contract not deployed yet
  }
  await need(agentIds[p.id], deposited >= DEPOSIT / 2n ? 0.1 : Number(DEPOSIT / 10n ** 21n) / 1000 + 0.12);
}
await need(operatorId, 0.45); // gas for ~150 start/complete transactions

// 2. Deploy v2 once.
if (out.wasmSha256 !== wasmSha256 || out.contractId !== contractId) {
  const state = await (await fetch(process.env.QUEUE_RPC_URL || "https://rpc.testnet.fastnear.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: contractId } }) })).json();
  const hasCode = state.result?.code_hash && state.result.code_hash !== "11111111111111111111111111111111";
  if (hasCode) throw new Error(`${contractId} already has code that is not this build; refusing to redeploy over live state`);
  console.log(`deploy v2 (${wasm.length} bytes, sha256 ${wasmSha256.slice(0, 12)}…) to ${contractId}`);
  const d = await deploy(account(contractId, contractKey.secretKey), contractId, wasm, { owner_id: ownerId, operator_id: operatorId, treasury_id: treasuryId, fee_bps: 100 });
  Object.assign(out, { network: "testnet", contractId, ownerId, operatorId, treasuryId, wasmSha256, wasmBytes: wasm.length, deployTx: d.tx_hash, deployedAt: new Date().toISOString(), version: "v2" });
  save();
}

// 3. Agents: deposit + function-call key.
out.agents = out.agents || {};
for (const p of PERSONAS) {
  const id = agentIds[p.id];
  const full = account(id, loadKey(id).secretKey);
  const a = (out.agents[p.id] = out.agents[p.id] || { accountId: id });
  const bal = BigInt(await view(contractId, "get_credit", { account_id: id }));
  if (bal < DEPOSIT / 2n) {
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

// 4. Pin NEAR AI's TEE signing keys (owner).
if (argv.includes("--pin")) {
  const ai = nearAiConfig();
  const { signers, raw } = await attestedSigners(ai);
  if (!signers.length) throw new Error("attestation report lists no signing_address");
  writeJson(`data/season/attestation-${ai.model.replace(/[^\w.-]/g, "_")}.json`, raw);
  const owner = account(ownerId, ownerKey.secretKey);
  const r = await call(owner, contractId, "set_tee_signers", { signers: signers.slice(0, 16) }, 0n, 30n);
  const rm = await call(owner, contractId, "set_tee_model", { model: ai.model }, 0n, 30n);
  Object.assign(out, { teeModel: ai.model, teeSigners: signers.slice(0, 16), pinTx: r.tx_hash, pinModelTx: rm.tx_hash, teeSignerSource: "model_attestations[].signing_address for this model (gateway key excluded); hardware quotes saved, not verified by this script" });
  save();
  console.log(`pinned ${signers.length} TEE signer(s) for ${ai.model}`);
}

// 5. Lock: remove every full-access key from the contract account (irreversible).
if (argv.includes("--lock")) {
  const keys = await (await fetch(process.env.QUEUE_RPC_URL || "https://rpc.testnet.fastnear.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: contractId } }) })).json();
  const fulls = (keys.result?.keys ?? []).filter((k) => k.access_key.permission === "FullAccess").map((k) => k.public_key);
  const acc = account(contractId, contractKey.secretKey);
  const signed = await acc.createSignedTransaction({ receiverId: contractId, actions: fulls.map((k) => actions.deleteKey(PublicKey.fromString(k))) });
  const o = await acc.provider.sendTransactionUntil(signed, "FINAL");
  Object.assign(out, { lockTx: o.transaction.hash, lockedAt: new Date().toISOString(), fullAccessKeysRemoved: fulls.length });
  save();
  console.log(`${contractId}: ${fulls.length} full-access key(s) deleted; code can no longer be changed`);
}

console.log(`ready: data/season/testnet.json (${contractId})`);
void TGAS;
