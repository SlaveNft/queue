#!/usr/bin/env node
// Payout recovery on the live season contract (testnet): a job's owner account is deleted while the job runs,
// so the bond transfer at settlement has nowhere to go. The contract's callback must restore it as a credit.
//
//   node scripts/season/payout-recovery.mjs
//
// Needs the testnet keys in .testnet/ (parent and operator). Spends about 0.05 testnet NEAR. Writes the
// transactions to data/season/payout-recovery.json. Prints no key material.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT, loadEnv, loadKey, account, call, view, createSubaccount, accountExists } from "../lib.mjs";

loadEnv();
const net = JSON.parse(readFileSync(path.join(ROOT, "data/season/testnet.json"), "utf8"));
const contract = net.contractId;
const parent = "queue-demo.testnet";
const who = `payout-${Date.now().toString(36)}.${parent}`;
const NEAR = 10n ** 24n;
const REWARD = NEAR / 100n;
const BOND = NEAR / 200n;
const tx = (r) => r?.tx_hash ?? r?.transaction?.hash ?? r?.transaction_outcome?.id ?? null;
const credit = async () => BigInt(await view(contract, "get_credit", { account_id: who }));

const queue = await view(contract, "get_queue", {});
const stats = await view(contract, "get_stats", {});
if (queue.length || Number(stats.running)) throw new Error("the contract is busy; run this when the queue is empty");

const created = await createSubaccount(parent, loadKey(parent).secretKey, who, 0.3);
const owner = account(who, created.secretKey);
const operator = account(net.operatorId, loadKey(net.operatorId).secretKey);

const deposit = await call(owner, contract, "deposit", {}, NEAR / 10n);
const submit = await call(owner, contract, "submit_job", {
  title: "Payout recovery check",
  input_hash: `payout-recovery-${Date.now()}`,
  input_uri: "",
  duration_secs: 5,
  deadline_secs: 900,
  reward: REWARD.toString(),
  ask_per_sec: "0",
  bond: BOND.toString(),
});
const start = await call(operator, contract, "start_next", {}, 0n, 50n);
const jobId = (await view(contract, "get_stats", {})).submitted;
const before = await credit();

// The owner's account disappears while its job is running.
const removed = await owner.deleteAccount(parent);
// The deletion is final a few blocks later; wait for it instead of failing with a running job.
for (let i = 0; i < 20 && (await accountExists(who)); i += 1) await new Promise((r) => setTimeout(r, 1500));
if (await accountExists(who)) console.error("warning: the owner account still exists; the payout will succeed and nothing is restored");

const complete = await call(operator, contract, "complete_job", { job_id: jobId, artifact_hash: "payout-recovery" }, 0n, 80n);
const job = await view(contract, "get_job", { job_id: jobId });
const after = await credit();
const out = {
  contractId: contract,
  jobId,
  owner: who,
  what: "the owner's account was deleted while its job ran; the bond transfer failed and the contract's callback restored it as a credit",
  status: job.status,
  bondYocto: BOND.toString(),
  creditBeforeYocto: before.toString(),
  creditAfterYocto: after.toString(),
  restoredYocto: (after - before).toString(),
  ok: job.status === "DONE" && after - before === BOND,
  tx: { createAccount: created.tx_hash, deposit: tx(deposit), submit: tx(submit), start: tx(start), deleteAccount: tx(removed), complete: tx(complete) },
};
writeFileSync(path.join(ROOT, "data/season/payout-recovery.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
