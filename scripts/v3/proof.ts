// @ts-nocheck
/**
 * Exercise every v3 rule on NEAR testnet with real transactions and record them in data/v3/proof.json, so
 * `npm run verify:v3` can re-check each one from the chain later. No model, no NEAR AI credits.
 *
 *   npx tsx scripts/v3/proof.ts          # about 6 minutes (waits out the 30 s ask delay and the 180 s heartbeat)
 *   npx tsx scripts/v3/proof.ts --from 7 # continue an interrupted run at step 7, keeping the steps already recorded
 *                                        # (steps are independent of each other)
 *
 * Agents act through their function-call keys (balance-funded, as in a season); the operator and the owner use
 * their own keys. Steps:
 *   1  a raised ask waits 30 s: a purchase right after the raise pays the old ask
 *   2  submit_job buys its slot in the same transaction
 *   3  after the delay the raised ask is paid
 *   4  the operator rejects a job that bought priority: escrow back, priority spend back from the stake,
 *      record released with its storage refunded
 *   5  delivery on the operator's word for an operator-verified job; the owner releases it and gets storage back
 *   6  a job already projected to miss cannot block a purchase but is paid; when it then misses, the stake pays
 *      its owner the promised penalty
 *   7  a model job cannot be settled on the operator's word; failing it pays the penalty
 *   8  after 180 s without an operator call no new work is accepted; a heartbeat reopens it
 *   9  owner changes wait 24 h: an early execute is refused; the owner cancels
 *  10  unstaking waits 24 h: an early withdrawal is refused
 *  11  only accounts the operator approved can submit: a removed account is refused before anything is charged
 *  12  the stake cannot leave while a job is open: a withdrawal is refused while a job is queued
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT, loadEnv, loadKey, account, call, callExpectingRefusal, view, writeJson } from "../lib.mjs";
import { rpc } from "../season/chain.ts";

loadEnv();
const meta = JSON.parse(readFileSync(path.join(ROOT, "data/v3/market5.json"), "utf8"));
const C = meta.contractId;
const NEAR = 10n ** 24n;
const REWARD = 2n * 10n ** 21n; // 0.002 NEAR
const BOND = 10n ** 21n; // 0.001 NEAR
const ASK_OLD = 10n ** 18n; // 0.000001 NEAR per second
const ASK_NEW = 5n * 10n ** 18n;
const JOB_STORAGE = 17n * 10n ** 21n; // held per job, refunded at release
const PRIORITY_STORAGE_1 = 9n * 10n ** 21n; // held for a purchase that passes one job
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const fc = (who: string) => {
  const a = meta.agents[who];
  const k = JSON.parse(readFileSync(path.join(ROOT, a.functionCallKeyFile), "utf8"));
  return { id: a.accountId, acc: account(a.accountId, k.secretKey) };
};
const kestrel = fc("kestrel"), mira = fc("mira"), atlas = fc("atlas"), juno = fc("juno"), vale = fc("vale");
const operator = { id: meta.operatorId, acc: account(meta.operatorId, loadKey(meta.operatorId).secretKey) };
const owner = { id: meta.ownerId, acc: account(meta.ownerId, loadKey(meta.ownerId).secretKey) };

/** Chain time (latest block, optimistic), in seconds. */
async function chainNow(): Promise<number> {
  const b = await rpc("block", { finality: "optimistic" });
  return Math.floor(Number(BigInt(b.header.timestamp) / 1_000_000_000n));
}
async function waitUntil(t: number) {
  for (;;) {
    const now = await chainNow();
    if (now >= t) return now;
    await sleep(Math.min(5000, (t - now) * 1000));
  }
}

const fromIdx = process.argv.indexOf("--from");
const FROM = fromIdx >= 0 ? Number(process.argv[fromIdx + 1]) : 0;
const prior = FROM > 0 ? JSON.parse(readFileSync(path.join(ROOT, "data/v3/proof.json"), "utf8")) : null;
if (prior && (prior.contractId !== C || prior.complete)) throw new Error("--from continues an unfinished proof of this contract only");
const steps: any[] = prior ? prior.steps.filter((s) => s.step < FROM) : [];
const startedAt = prior?.startedAt ?? new Date().toISOString();
/** Written after every step, so an interrupted run still leaves its transactions on record. */
const flush = (extra: object = {}) => writeJson("data/v3/proof.json", { generatedBy: "scripts/v3/proof.ts", contractId: C, wasmSha256: meta.wasmSha256, startedAt, complete: false, steps, ...extra });
/** Agents pay gas from small wallets: give each method only what it needs. */
const GAS: Record<string, bigint> = { submit_job: 60n, request_priority: 60n, set_move_ask: 15n, cancel_job: 30n, release_job: 30n, execute_proposal: 30n, heartbeat: 10n, propose: 30n, cancel_proposal: 30n, request_unstake: 30n, withdraw_unstaked: 30n, allow_clients: 30n, remove_client: 15n, start_next: 30n, complete_job: 30n };
function record(step: number, label: string, who: { id: string }, method: string, r: any, expect: Record<string, unknown>) {
  const entry = { step, label, signer: who.id, method, tx: r.tx_hash, ok: !r.error, error: r.error ?? null, events: r.events ?? [], result: r.result ?? null, expect };
  steps.push(entry);
  console.log(`${String(step).padStart(2)} ${r.error ? "refused" : "ok     "} ${label}  ${r.tx_hash}${r.error ? `  · ${r.error.slice(0, 90)}` : ""}`);
  flush();
  return entry;
}
async function ok(step: number, label: string, who, method: string, args: object, expect: Record<string, unknown> = {}, gas = GAS[method] ?? 100n, deposit = 0n) {
  const r = await call(who.acc, C, method, args, deposit, gas);
  return record(step, label, who, method, r, expect);
}
async function refused(step: number, label: string, who, method: string, args: object, expectError: string, gas = GAS[method] ?? 100n) {
  const r = await callExpectingRefusal(who.acc, C, method, args, 0n, gas);
  if (!r.error.includes(expectError)) throw new Error(`step ${step}: refused for another reason: ${r.error}`);
  return record(step, label, who, method, r, { error: expectError });
}
const ev = (entry, name: string) => entry.events.find((e) => e.event === name)?.data;
const submitArgs = (title: string, input: string, dur: number, deadline: number, ask: bigint, priority?: object) => ({
  title, input_hash: input, input_uri: "", duration_secs: dur, deadline_secs: deadline,
  reward: REWARD.toString(), ask_per_sec: ask.toString(), bond: BOND.toString(),
  require_feasible_at_back: null, verify: null, priority: priority ?? null,
});

const queue = await view(C, "get_queue", {});
if (queue.length) throw new Error(`${C} has ${queue.length} queued jobs: the proof needs an empty queue`);
const stats0 = await view(C, "get_stats", {});
if (Number(stats0.running)) throw new Error(`${C} is running a job: the proof needs an idle worker`);
await ok(FROM, "operator heartbeat", operator, "heartbeat", {});

if (FROM <= 1) {
// 1-2. Raise pending; an atomic purchase right after it pays the old ask.
const m1 = await ok(1, "mira submits M1 (40 s, ask 1e18/s)", mira, "submit_job", submitArgs("M1 report", "proof:m1", 40, 900, ASK_OLD));
const M1 = m1.result;
const raise = await ok(1, "mira raises M1's ask to 5e18/s (takes effect in 30 s)", mira, "set_move_ask", { job_id: M1, ask_per_sec: ASK_NEW.toString() }, { effective_after_secs: 30 });
let now = await chainNow();
const k1 = await ok(2, "kestrel submits K1 and buys the front in the same call", kestrel, "submit_job",
  submitArgs("K1 urgent brief", "proof:k1", 10, 120, 0n, { latest_start_at: now + 6, max_spend: (NEAR / 1000n).toString(), required: true }),
  { compensation: (ASK_OLD * 10n).toString(), displaced: [M1] });
const K1 = k1.result;

// 3. After the delay, the raised ask is what a purchase pays.
await waitUntil(ev(raise, "ask_updated").effective_at + 1);
const a1 = await ok(3, "atlas submits A1", atlas, "submit_job", submitArgs("A1 audit", "proof:a1", 10, 300, 0n));
const A1 = a1.result;
now = await chainNow();
const buyA1 = await ok(3, "atlas buys the front for A1: M1's raised ask has landed", atlas, "request_priority",
  { job_id: A1, latest_start_at: now + 6, max_spend: (NEAR / 1000n).toString() },
  { compensation: (ASK_NEW * 10n).toString(), displaced: [K1, M1] });

// 4. Reject: the operator refuses A1; priority spend comes back from the stake, storage comes back as credit.
const total = ev(buyA1, "priority_purchased").total;
await ok(4, "operator rejects A1 before it starts", operator, "reject_job", { job_id: A1, reason: "unsupported input" },
  { priority_refund: total, released: true });

// 5. Delivery on the operator's word (operator-verified job), then the owner releases the record.
await ok(5, "operator starts K1", operator, "start_next", {}, { job: K1 });
await sleep(10_500);
await ok(5, "operator delivers K1 (operator-verified job)", operator, "complete_job", { job_id: K1, artifact_hash: sha("K1 artifact") }, { on_time: true });
// Both deposits come back whole: the job's and its purchase's (every account involved already has a balance key).
await ok(5, "kestrel releases K1 and gets its whole storage deposit back", kestrel, "release_job", { job_id: K1 }, { storage_refund: (JOB_STORAGE + PRIORITY_STORAGE_1).toString() });
// M1 runs normally so the queue is empty for step 6.
await ok(5, "operator starts M1", operator, "start_next", {}, { job: M1 });
await sleep(40_500);
await ok(5, "operator delivers M1", operator, "complete_job", { job_id: M1, artifact_hash: sha("M1 artifact") }, { on_time: true });

// 6. Doomed job: D1 is promised at admission, then the worker stays idle until it can no longer finish.
const d1 = await ok(6, "juno submits D1 (20 s, deadline 30 s) on an empty queue: promised", juno, "submit_job", submitArgs("D1 tight job", "proof:d1", 20, 30, ASK_OLD));
const D1 = d1.result;
const k2 = await ok(6, "kestrel submits K2 behind it", kestrel, "submit_job", submitArgs("K2 follow-up", "proof:k2", 5, 300, 0n));
const K2 = k2.result;
const d1Sub = ev(d1, "job_submitted");
await waitUntil(d1Sub.submitted_at + 11);
now = await chainNow();
await ok(6, "kestrel buys past D1, which can no longer finish in time: D1 does not block and is paid", kestrel, "request_priority",
  { job_id: K2, latest_start_at: now + 6, max_spend: (NEAR / 1000n).toString() },
  { compensation: (ASK_OLD * 5n).toString(), displaced: [D1] });
await ok(6, "operator starts K2", operator, "start_next", {}, { job: K2 });
await sleep(5_500);
await ok(6, "operator delivers K2", operator, "complete_job", { job_id: K2, artifact_hash: sha("K2 artifact") }, { on_time: true });
await ok(6, "operator reaches D1 too late: missed, and the stake pays the broken promise", operator, "start_next", {},
  { job: D1, missed: true, penalty: REWARD.toString() });

}

if (FROM <= 7) {
// 7. A model job (its input is a request sha256 and a model key is pinned) cannot be settled on the operator's word.
// A request hash can be claimed by one job only (a signed answer settles one job), so each run asks afresh.
const body = JSON.stringify({ messages: [{ role: "user", content: `QUEUE v3 proof ${startedAt}: summarize the queue rules in one line.` }] });
const j1 = await ok(7, "juno submits J1 naming its request by sha256: a model job", juno, "submit_job", submitArgs("J1 model job", sha(body), 10, 600, 0n), { verify: "model" });
const J1 = j1.result;
await ok(7, "operator starts J1", operator, "start_next", {}, { job: J1 });
await refused(7, "operator tries to settle J1 on its own word: refused", operator, "complete_job", { job_id: J1, artifact_hash: sha("not a model answer") }, "asked for a model answer");
await ok(7, "operator fails J1: escrow back, and the stake pays the promise", operator, "fail_job", { job_id: J1, reason_hash: sha("no model answer in this proof") },
  { penalty: REWARD.toString() });

}

if (FROM <= 8) {
// 8. Liveness: no operator call for 180 s, no new work; a heartbeat reopens it.
const lastSeen = (await view(C, "get_config", {})).operator_last_seen;
await waitUntil(lastSeen + 181);
await refused(8, "vale submits while the worker has been silent for 180 s: refused, nothing charged", vale, "submit_job", submitArgs("V1", "proof:v1", 5, 300, 0n), "the worker is offline");
await ok(8, "operator heartbeat", operator, "heartbeat", {});
const v1 = await ok(8, "vale submits again: accepted", vale, "submit_job", submitArgs("V1", "proof:v1b", 5, 300, 0n));
await ok(8, "vale cancels V1 (exits always work)", vale, "cancel_job", { job_id: v1.result });
await ok(8, "vale releases V1 and gets its whole storage deposit back", vale, "release_job", { job_id: v1.result }, { storage_refund: JOB_STORAGE.toString() });

}

if (FROM <= 9) {
// 9. Governance: a fee change waits 24 h; executing early is refused; the owner cancels it.
const prop = await ok(9, "owner proposes fee 0.5% (runs in 24 h at the earliest)", owner, "propose", { proposal: { kind: "set_fee_bps", fee_bps: 50 } }, { timelock_secs: 86400 });
const pid = prop.result.id;
// Anyone may execute a proposal (agents' function-call keys do not include it, so a full-access account does).
const anyone = { id: kestrel.id, acc: account(kestrel.id, loadKey(kestrel.id).secretKey) };
await refused(9, "anyone executes it now: refused, still timelocked", anyone, "execute_proposal", { id: pid }, "timelocked");
await ok(9, "owner cancels the proposal", owner, "cancel_proposal", { id: pid });

}

// 10. Stake: an unstake waits 24 h.
await ok(10, "operator asks to unstake 0.1 NEAR (withdrawable in 24 h)", operator, "request_unstake", { amount: (NEAR / 10n).toString() }, { timelock_secs: 86400 });
await refused(10, "operator withdraws at once: refused, still timelocked", operator, "withdraw_unstaked", {}, "timelocked");

// 11. A closed queue: where a stake backs promises, only accounts the operator approved can submit.
await ok(11, "operator removes juno from its approved clients", operator, "remove_client", { account_id: juno.id });
await refused(11, "juno submits: refused before escrow, storage or a purchase", juno, "submit_job", submitArgs("X1", "proof:x1", 5, 300, 0n), "not an approved client");
await ok(11, "operator approves juno again", operator, "allow_clients", { accounts: [juno.id] }, { clients: [juno.id] }, GAS.allow_clients, NEAR / 100n);

// 12. The stake answers for every open job: it cannot be withdrawn while one is queued or running.
const s1 = await ok(12, "mira submits S1", mira, "submit_job", submitArgs("S1 short job", "proof:s1", 5, 300, 0n));
await refused(12, "operator withdraws its unstake while S1 is queued: refused", operator, "withdraw_unstaked", {}, "while a job is queued or running");
await ok(12, "operator starts S1", operator, "start_next", {}, { job: s1.result });
await sleep(5_500);
await ok(12, "operator delivers S1", operator, "complete_job", { job_id: s1.result, artifact_hash: sha("S1 artifact") }, { on_time: true });
await ok(12, "mira releases S1 and gets its whole storage deposit back", mira, "release_job", { job_id: s1.result }, { storage_refund: JOB_STORAGE.toString() });

const stats = await view(C, "get_stats", {});
const config = await view(C, "get_config", {});
flush({ complete: true, finishedAt: new Date().toISOString(), statsAfter: stats, configAfter: config });
console.log(`proof: ${steps.length} transactions -> data/v3/proof.json`);
