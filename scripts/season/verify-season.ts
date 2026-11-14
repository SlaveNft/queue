// @ts-nocheck
/**
 * Recompute a season's headline from the chain, and compare it with two counterfactuals run on the
 * same arrivals: plain FIFO, and a blind priority fee (highest bid runs next, nobody who is passed is
 * paid, no deadline check).
 *
 *   npx tsx scripts/season/verify-season.ts [run-dir-name]      # default: latest testnet run
 *
 * On-chain facts (status, times, deadlines, attestation, payments, refused transactions) are read from
 * NEAR RPC for testnet runs. Private task values exist only in the agents' logs and are labelled so.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { ROOT } from "../lib.mjs";
import { view, rpc } from "./chain.ts";
import { txOutcome } from "../near-rpc.mjs";

const dirArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const base = path.join(ROOT, "data/season");
const runs = readdirSync(base).filter((d) => existsSync(path.join(base, d, "summary.json"))).sort();
const run = dirArg ?? runs.filter((r) => r.startsWith("testnet")).pop() ?? runs.pop();
if (!run) throw new Error("no finished season in data/season");
const dir = path.join(base, run);
const config = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"));
const events = readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const onchain = config.mode === "testnet";
const contractId = onchain ? config.contractId ?? JSON.parse(readFileSync(path.join(base, "testnet.json"), "utf8")).contractId : null;
// The deployment record of the contract this run used: data/season/<contract prefix>.json (testnet.json points at
// whichever contract is current, which may be a later one).
const deployRecord = (() => {
  if (!contractId) return {};
  for (const f of [`${contractId.split(".")[0]}.json`, "testnet.json"]) {
    const file = path.join(base, f);
    if (!existsSync(file)) continue;
    const d = JSON.parse(readFileSync(file, "utf8"));
    if (d.contractId === contractId) return { ...d, file: f };
  }
  return {};
})();
console.log(`season verify: run=${run} mode=${config.mode}${onchain ? "" : " (sim; on-chain checks skipped; pass a testnet run name for chain verification)"}`);

let failures = 0;
const check = (ok: boolean, what: string, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

// 1. Jobs: from the chain (testnet) or the run's own snapshot (sim).
const snapshot = JSON.parse(readFileSync(path.join(dir, "jobs.json"), "utf8"));
const jobs = [];
for (const s of snapshot) {
  if (onchain) {
    const j = await view(contractId, "get_job", { job_id: s.id }).catch(() => null);
    if (j) jobs.push(j);
  } else jobs.push(s);
}
if (onchain) {
  const byId = new Map(snapshot.map((x) => [x.id, x]));
  const same = jobs.length === snapshot.length && jobs.every((j) => j.status === byId.get(j.id)?.status && j.artifact_hash === byId.get(j.id)?.artifact_hash);
  check(same, "every job's status and artifact hash on chain equals the run's snapshot", `${jobs.length} jobs`);
  try {
    const code = await rpc("query", { request_type: "view_code", finality: "final", account_id: contractId });
    const wasm = Buffer.from(code.code_base64, "base64");
    const sha = createHash("sha256").update(wasm).digest("hex");
    // Runs before this field existed recorded no hash; fall back to the deployment record (testnet.json).
    const expected = config.wasmSha256 ?? deployRecord.wasmSha256;
    check(!!expected && sha === expected, "contract code hash equals the deployed wasm", `${sha.slice(0, 12)}… vs ${config.wasmSha256 ? "run config" : deployRecord.file ?? "no record"}`);
  } catch (e) {
    check(false, "contract code hash is readable", String((e as Error).message ?? e).slice(0, 80));
  }
  try {
    const cfg = await view(contractId, "get_config", {});
    check(Array.isArray(cfg.tee_signers) && cfg.tee_signers.length > 0, "owner has pinned at least one NEAR AI signing key", `${cfg.tee_signers?.length ?? 0} keys`);
    // The key the run says it pinned must be the one the contract holds, and it must be the model's key from
    // NEAR AI's attestation report saved with the season (not just "some key").
    const pinnedNow = (cfg.tee_signers ?? []).map((k) => String(k).toLowerCase());
    const runPinned = (config.pinnedSigners ?? []).map((k) => String(k).toLowerCase());
    check(runPinned.length > 0 && runPinned.every((k) => pinnedNow.includes(k)), "the run's pinned signer is pinned in the contract", runPinned.map((k) => k.slice(0, 12) + "…").join(", "));
    const attFile = readdirSync(base).find((f) => f.startsWith("attestation-") && f.endsWith(".json"));
    if (attFile) {
      const att = JSON.parse(readFileSync(path.join(base, attFile), "utf8"));
      const reported = (att.model_attestations ?? []).filter((m) => m.model_name === config.model).map((m) => String(m.signing_address ?? "").replace(/^0x/i, "").toLowerCase());
      check(runPinned.some((k) => reported.includes(k)), "the pinned signer is the model's key in the saved NEAR AI attestation report", attFile);
    }
    try {
      const model = await view(contractId, "get_tee_model", {});
      check(!config.model || model === config.model, "the contract's pinned model is the run's model", String(model));
    } catch (e) {
      check(false, "the contract's pinned model is readable", String((e as Error).message ?? e).slice(0, 80));
    }
  } catch (e) {
    check(false, "contract config is readable", String((e as Error).message ?? e).slice(0, 80));
  }
}

// 2. Refused transactions really failed on chain.
const refused = events.filter((e) => e.ok === false && e.layer === "contract" && e.tx);
let refusedOnChain = 0;
if (onchain) {
  for (const e of refused) {
    const sender = config.agents[e.who];
    // Archival nodes: a regular node forgets a transaction after about two days.
    const r = await txOutcome(e.tx, sender).catch(() => null);
    const st = r?.raw?.receipts_outcome?.[0]?.outcome?.status;
    if (st && "Failure" in st) refusedOnChain += 1;
  }
  check(refusedOnChain === refused.length, "every refusal in the log is a failed transaction on chain", `${refusedOnChain}/${refused.length}`);
} else refusedOnChain = refused.length;

// 3. Private values (agents' logs only).
const valueOf = new Map<number, number>();
for (const e of events) if (e.action === "submit" && e.ok && typeof e.job === "number" && e.valueNear) valueOf.set(e.job, Number(e.valueNear));
// Strategic-deadline runs (season.ts --shade): the deadline an agent really needed, from its private log. Every
// rule is scored against it; the claimed deadline (on chain) is what the contract and a contract-enforced EDF see.
const trueDeadlineOf = new Map<number, number>();
const shadedJobs = new Set<number>();
for (const e of events) {
  if (e.action !== "submit" || !e.ok || typeof e.job !== "number") continue;
  if (typeof e.trueDeadlineAt === "number") trueDeadlineOf.set(e.job, e.trueDeadlineAt);
  if (e.claimedTighter) shadedJobs.add(e.job);
}
// Patience runs (season.ts --policy patience): each task's private cost of waiting and its arrival time.
const waitCostOf = new Map<number, number>();
const arrivedOf = new Map<number, number>();
for (const e of events) {
  if (e.action !== "submit" || !e.ok || typeof e.job !== "number" || typeof e.waitCostNear !== "number") continue;
  waitCostOf.set(e.job, e.waitCostNear);
  arrivedOf.set(e.job, e.arrivedAt);
}
const shading = events.find((e) => e.kind === "strategic-deadlines");
const shaders = new Set<string>(shading?.agents ?? []);
const trueDl = (j) => trueDeadlineOf.get(j.id) ?? j.deadline_at;

// 4. Market outcome (what actually happened). Only jobs submitted during this run count: an agent
//    can name an older job id in a refused action, which puts that job in the snapshot.
const seasonJobs = config.startedAt ? jobs.filter((j) => j.submitted_at >= config.startedAt) : jobs;
if (seasonJobs.length < jobs.length) console.log(`  INFO  ${jobs.length - seasonJobs.length} job(s) in the snapshot predate this run (named in a refused action) and are left out of the numbers`);
const ran = seasonJobs.filter((j) => j.status !== "CANCELLED");
const onTime = (j) => j.status === "DONE";
const market = {
  jobs: ran.length,
  onTime: ran.filter(onTime).length,
  valueOnTime: ran.filter(onTime).reduce((s, j) => s + (valueOf.get(j.id) ?? 0), 0),
  attested: ran.filter((j) => j.attested).length,
  paidToMovedNear: seasonJobs.reduce((s, j) => s + Number(BigInt(j.moved_compensation)) / 1e24, 0),
  movedJobs: ran.filter((j) => Number(BigInt(j.moved_compensation)) > 0).length,
  purchases: ran.filter((j) => j.expedited).length,
  jumpedAndLate: ran.filter((j) => Number(BigInt(j.moved_compensation)) > 0 && j.status !== "DONE").length,
};
// The contract also has an unsigned `complete_job` path (the operator's word). Each job's record on chain says
// which path settled it, so this is checkable: in this season no delivered job was paid without a verified signature.
const unattested = ran.filter((j) => j.status === "DONE" && !j.attested);
check(unattested.length === 0, "every delivered job was settled with a model signature the contract verified (none on the operator's word)", `${market.attested} signed, ${unattested.length} unsigned`);

// 5. Counterfactuals on the same arrivals. Each job keeps its real service time (finished - started)
//    and the real gap between jobs; only the order changes.
//    A job that never started (missed in the queue) has no real service time. Charging it the full declared
//    duration would make the counterfactual worker slower than the real one (which settles early), so it gets
//    the run's mean real/declared ratio instead.
const realRatios = ran.filter((j) => j.started_at && j.finished_at && j.duration_secs > 0).map((j) => Math.max(1, j.finished_at - j.started_at) / j.duration_secs);
const ratio = realRatios.length ? realRatios.reduce((a, b) => a + b, 0) / realRatios.length : 1;
const service = (j) => (j.started_at && j.finished_at ? Math.max(1, j.finished_at - j.started_at) : Math.max(1, Math.round(j.duration_secs * ratio)));
const runs_ = ran.filter((j) => j.started_at).sort((a, b) => a.started_at - b.started_at);
// The gap is the worker's overhead between two jobs. Only pairs where the next job was already waiting
// count: if the queue was empty, start - previous finish is idle time, not overhead, and counting it
// made the counterfactual worker slower than the real one (FIFO came out late with zero purchases).
const gaps = [];
for (let i = 1; i < runs_.length; i += 1) {
  const g = runs_[i].started_at - runs_[i - 1].finished_at;
  if (g >= 0 && g < 30 && runs_[i].submitted_at <= runs_[i - 1].finished_at) gaps.push(g);
}
const gap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 2;

// The contract's start rule (COMPLETE_MARGIN_SECS = 2): a head that cannot finish by its deadline is settled as
// missed, not started. The counterfactuals use the same rule as the market they are compared to.
const COMPLETE_MARGIN_SECS = 2;
const cannotStart = (j, now) => now + j.duration_secs + COMPLETE_MARGIN_SECS > j.deadline_at;

function simulate(pick: (ready, now) => number, g = gap) {
  const pending = [...ran].sort((a, b) => a.submitted_at - b.submitted_at || a.id - b.id);
  let now = pending.length ? pending[0].submitted_at : 0;
  const ready = [];
  const out = new Map<number, { onTime: boolean; finish: number }>();
  while (pending.length || ready.length) {
    while (pending.length && pending[0].submitted_at <= now) ready.push(pending.shift());
    if (!ready.length) {
      now = pending[0].submitted_at;
      continue;
    }
    const i = pick(ready, now);
    const j = ready.splice(i, 1)[0];
    if (cannotStart(j, now)) {
      out.set(j.id, { onTime: false, finish: now }); // the contract never starts such a job
      continue;
    }
    const finish = now + service(j);
    out.set(j.id, { onTime: finish <= trueDl(j), finish });
    now = finish + g;
  }
  return out;
}
const fifo = simulate(() => 0);
// Calibration: replay the order that really ran under the same timing model. If the model is fair, this
// reproduces the real on-time count; the difference is the error bar on both counterfactuals.
const realOrder = (j) => j.started_at ?? j.finished_at ?? Number.MAX_SAFE_INTEGER;
const replay = simulate((ready) => {
  let best = 0;
  for (let i = 1; i < ready.length; i += 1) if (realOrder(ready[i]) < realOrder(ready[best])) best = i;
  return best;
});
// Blind fee: an agent whose job would be late in FIFO order bids its full private value; the worker
// runs the highest bid next. Nobody who is passed is paid, and nothing checks their deadlines.
const fifoLate = new Set([...fifo].filter(([, r]) => !r.onTime).map(([id]) => id));
const bid = (j) => (fifoLate.has(j.id) ? valueOf.get(j.id) ?? 0.05 : 0);
const blind = simulate((ready) => {
  let best = 0;
  for (let i = 1; i < ready.length; i += 1) if (bid(ready[i]) > bid(ready[best])) best = i;
  return best;
});
// EDF: the job with the earliest claimed deadline runs next. A contract can enforce this order as easily as FIFO;
// what it cannot check is whether a claimed deadline is true. Scored, like every rule, on true deadlines.
const edfPick = (ready) => {
  let best = 0;
  for (let i = 1; i < ready.length; i += 1) {
    const a = ready[i], b = ready[best];
    if (a.deadline_at < b.deadline_at || (a.deadline_at === b.deadline_at && a.submitted_at < b.submitted_at)) best = i;
  }
  return best;
};
const edf = simulate(edfPick);
const ownerOf = new Map(ran.map((j) => [j.id, String(j.owner).split(".")[0]]));
const honest = (j) => !shaders.has(ownerOf.get(j.id));
const summarize = (m) => {
  const ok = ran.filter((j) => m.get(j.id)?.onTime);
  return {
    onTime: ok.length,
    valueOnTime: ok.reduce((s, j) => s + (valueOf.get(j.id) ?? 0), 0),
    honestJobs: ran.filter(honest).length,
    honestOnTime: ok.filter(honest).length,
  };
};
const E = summarize(edf);
// Welfare with waiting costs: a job on time is worth its value minus its cost of waiting since arrival; a late job 0.
// Transfers (compensation, priority prices, fees, blind bids) move money between agents and are left out of welfare,
// but they count for "worse off than under FIFO": a moved agent whose pay covers its waiting cost is not worse off.
let welfare = null;
if (waitCostOf.size) {
  const util = (j, finish, onTime) => (onTime ? (valueOf.get(j.id) ?? 0) - (waitCostOf.get(j.id) ?? 0) * Math.max(0, finish - (arrivedOf.get(j.id) ?? j.submitted_at)) : 0);
  // Smith's rule: a planner who knew every waiting cost runs the highest cost per second of work first. Nobody is paid.
  const wspt = simulate((ready) => {
    let best = 0;
    const w = (j) => (waitCostOf.get(j.id) ?? 0) / Math.max(1, j.duration_secs);
    for (let i = 1; i < ready.length; i += 1) if (w(ready[i]) > w(ready[best])) best = i;
    return best;
  });
  const fifoU = new Map(ran.map((j) => [j.id, util(j, fifo.get(j.id)?.finish ?? 0, !!fifo.get(j.id)?.onTime)]));
  const yocto = (x) => Number(BigInt(x ?? "0")) / 1e24;
  const marketU = new Map(ran.map((j) => [j.id, util(j, j.finished_at ?? 0, j.status === "DONE")]));
  const marketWithPay = new Map(ran.map((j) => [j.id, marketU.get(j.id) + yocto(j.moved_compensation) - yocto(j.priority_spend)]));
  const replayU = (m) => new Map(ran.map((j) => [j.id, util(j, m.get(j.id)?.finish ?? 0, !!m.get(j.id)?.onTime)]));
  const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const worse = (m) => ran.filter((j) => m.get(j.id) < fifoU.get(j.id) - 1e-9).length;
  const eU = replayU(edf), wU = replayU(wspt), bU = replayU(blind);
  const bWithPay = new Map(ran.map((j) => [j.id, bU.get(j.id) - bid(j)]));
  welfare = {
    note: "utility = value - waiting cost x (finish - arrival) if on time, else 0; NEAR; transfers excluded from the totals",
    total: { market: sum(marketU), fifo: sum(fifoU), edf: sum(eU), smithsRule: sum(wU), blindFee: sum(bU) },
    worseOffThanFifo: { market: worse(marketWithPay), edf: worse(eU), smithsRule: worse(wU), blindFee: worse(bWithPay) },
    jobs: ran.length,
  };
  console.log(`  INFO  welfare (value minus waiting cost, NEAR): market ${welfare.total.market.toFixed(3)} · FIFO ${welfare.total.fifo.toFixed(3)} · EDF ${welfare.total.edf.toFixed(3)} · Smith's rule (planner) ${welfare.total.smithsRule.toFixed(3)} · blind fee ${welfare.total.blindFee.toFixed(3)}`);
  console.log(`  INFO  jobs worse off than under FIFO (pay included): market ${welfare.worseOffThanFifo.market} · EDF ${welfare.worseOffThanFifo.edf} · Smith's rule ${welfare.worseOffThanFifo.smithsRule} · blind fee ${welfare.worseOffThanFifo.blindFee} of ${ran.length}`);
}
const marketHonestOnTime = ran.filter((j) => j.status === "DONE" && honest(j)).length;
const brokenByEdf = ran.filter((j) => fifo.get(j.id)?.onTime && !edf.get(j.id)?.onTime).length;
const F = summarize(fifo);
const BL = summarize(blind);
const RP = summarize(replay);
const calibrationError = RP.onTime - ran.filter(onTime).length;
console.log(`  INFO  timing model check: replaying the real order gives ${RP.onTime} on time, the chain says ${ran.filter(onTime).length} (error ${calibrationError >= 0 ? "+" : ""}${calibrationError} jobs); read FIFO and blind fee with that error bar`);
const brokenByBlind = ran.filter((j) => fifo.get(j.id)?.onTime && !blind.get(j.id)?.onTime).length;
const blindPaidToOperator = ran.filter((j) => bid(j) > 0).reduce((s, j) => s + bid(j), 0);
// The blind fee's "promises broken" applied to the market too, so both rows use one definition and one timing
// model: jobs FIFO delivers that the market's own order, replayed the same way, makes late.
const brokenByMarketJobs = ran.filter((j) => fifo.get(j.id)?.onTime && !replay.get(j.id)?.onTime);
const brokenByMarket = brokenByMarketJobs.length;
// Split them: a job a purchase moved back (the rule protects these), or a job that was never moved and waits
// behind a buyer whom FIFO would have dropped as late (the rule does not cover these).
const brokenMoved = brokenByMarketJobs.filter((j) => Number(BigInt(j.moved_compensation)) > 0).length;
const brokenMovedReallyLate = brokenByMarketJobs.filter((j) => Number(BigInt(j.moved_compensation)) > 0 && j.status !== "DONE").length;
// Buyers who paid for priority and still missed: their price bought nothing.
const boughtAndMissed = ran.filter((j) => j.expedited && j.status !== "DONE");
if (boughtAndMissed.length) console.log(`  INFO  ${boughtAndMissed.length} buyer(s) paid for priority and still missed: ${boughtAndMissed.map((j) => `#${j.id} (${(Number(BigInt(j.priority_spend ?? "0")) / 1e24).toFixed(4)} NEAR)`).join(", ")}`);

// Sensitivity: the counterfactuals rest on one worker-gap value. Re-run all three across ±1 s of it,
// so a reader sees how much of the gap between market and FIFO is timing-model noise.
const sensitivity = [];
for (let g = Math.max(0, gap - 1); g <= gap + 1.0001; g += 0.25) {
  const f = simulate(() => 0, g);
  const late = new Set([...f].filter(([, r]) => !r.onTime).map(([id]) => id));
  const b = (j) => (late.has(j.id) ? valueOf.get(j.id) ?? 0.05 : 0);
  const bl = simulate((ready) => {
    let best = 0;
    for (let i = 1; i < ready.length; i += 1) if (b(ready[i]) > b(ready[best])) best = i;
    return best;
  }, g);
  const rp = simulate((ready) => {
    let best = 0;
    for (let i = 1; i < ready.length; i += 1) if (realOrder(ready[i]) < realOrder(ready[best])) best = i;
    return best;
  }, g);
  const count = (m) => ran.filter((j) => m.get(j.id)?.onTime).length;
  sensitivity.push({ gapSecs: Number(g.toFixed(2)), replayOfMarket: count(rp), fifo: count(f), blindFee: count(bl), edf: count(simulate(edfPick, g)) });
}
console.log(`  INFO  gap sensitivity (replay of the market's order / FIFO / blind fee / EDF): ${sensitivity.map((r) => `${r.gapSecs}s ${r.replayOfMarket}/${r.fifo}/${r.blindFee}/${r.edf}`).join(" · ")}`);
console.log(`  INFO  EDF on the same jobs: ${E.onTime} of ${ran.length} on time${shaders.size ? `; agents that claimed tighter deadlines than they needed: ${[...shaders].join(", ")} (${shadedJobs.size} jobs); honest agents' jobs on time: market ${marketHonestOnTime}/${E.honestJobs}, EDF ${E.honestOnTime}/${E.honestJobs}, FIFO ${F.honestOnTime}/${F.honestJobs}` : ""}`);

// Not an integrity check: the contract guarantees the deadline against the projection at purchase time; the
// operator is trusted to keep to declared durations. Report it, with the cause, instead of failing the run.
const lateMoved = ran.filter((j) => Number(BigInt(j.moved_compensation)) > 0 && j.status !== "DONE");
const overruns = runs_.filter((j) => j.finished_at - j.started_at > j.duration_secs).length;
console.log(`  INFO  ${lateMoved.length} of ${ran.filter((j) => Number(BigInt(j.moved_compensation)) > 0).length} paid-to-move jobs ended late${lateMoved.length ? ` (${lateMoved.map((j) => `#${j.id} started ${j.deadline_at - j.started_at}s before its deadline with ${j.duration_secs}s of work`).join("; ")}); the worker overran its declared duration on ${overruns} of ${runs_.length} jobs` : ""}`);

// Paid to moved agents: summed from this run's own job records. The contract's counters are lifetime
// totals, so they only equal this number when the contract has run nothing else.
const paid = market.paidToMovedNear;
// Refusals by reason: only "displaced job ... would" protects someone else's deadline; the rest are other rules.
const kind = (err: string) => (/priority infeasible: displaced job/.test(err) ? "protected a moved job's deadline" : /priority infeasible/.test(err) ? "buyer's own cutoff or deadline unreachable" : /balance too low/.test(err) ? "balance" : /max_spend/.test(err) ? "price moved" : /nothing to buy/.test(err) ? "nothing to buy" : /cannot finish by its deadline even at the front/.test(err) ? "hopeless job refused at submission" : /only queued jobs/.test(err) ? "job already started" : "other");
const refusalKinds: Record<string, number> = {};
for (const e of refused) refusalKinds[kind(String(e.error ?? ""))] = (refusalKinds[kind(String(e.error ?? ""))] ?? 0) + 1;
const line = `market ${market.onTime} of ${market.jobs} on time, FIFO ${F.onTime} of ${market.jobs}, EDF ${E.onTime} of ${market.jobs}, blind fee ${BL.onTime} of ${market.jobs} (${brokenByBlind} promises broken); ${paid.toFixed(5)} NEAR paid to agents who moved back; ${refusedOnChain} refused by the contract (${Object.entries(refusalKinds).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}); ${market.attested} jobs settled with an answer signed by the pinned NEAR AI model key (${ran.filter((j) => j.attested && j.status === "DONE").length} of them on time)`;

const result = {
  run,
  mode: config.mode,
  contractId,
  line,
  market: { ...market, onTimeUnderFifoButLate: brokenByMarket, ofThoseMovedByAPurchase: brokenMoved, ofThoseMovedAndLateOnChain: brokenMovedReallyLate, ofThoseNeverMoved: brokenByMarket - brokenMoved, boughtAndMissed: boughtAndMissed.map((j) => j.id) },
  fifo: F,
  edf: { ...E, promisesBroken: brokenByEdf, paidToMovedNear: 0, note: "earliest claimed deadline runs next; nobody who is passed is paid; scored on true deadlines" },
  welfare,
  strategicDeadlines: shaders.size ? { agents: [...shaders], shadedJobs: shadedJobs.size, honestJobs: E.honestJobs, honestOnTime: { market: marketHonestOnTime, edf: E.honestOnTime, fifo: F.honestOnTime, blindFee: BL.honestOnTime } } : null,
  blindFee: { ...BL, promisesBroken: brokenByBlind, paidToOperatorNear: blindPaidToOperator, paidToMovedNear: 0 },
  assumptions: {
    serviceTime: "each job keeps its real service time (finished_at - started_at on chain)",
    gapSecs: Number(gap.toFixed(2)),
    gap: "mean worker overhead between two jobs, measured only when the next job was already waiting",
    unstartedServiceRatio: Number(ratio.toFixed(3)),
    startRule: "a head that cannot finish by its deadline (2 s margin) is settled as missed, as in the contract",
    unstartedService: "a job that never started is charged its declared duration x the run's mean real/declared service ratio",
    replayOfRealOrder: { onTime: RP.onTime, realOnTime: ran.filter(onTime).length, errorJobs: calibrationError },
    blindBid: "full private value if the job would be late under FIFO, else 0; highest bid runs next",
    values: "private task values come from the agents' logs, not the chain",
    sensitivity,
    sensitivityNote: "FIFO and blind fee are replays with one constant worker gap; the band shows them, and a replay of the market's real order, across ±1 s of the measured mean",
  },
  refusalKinds,
  checksFailed: failures,
};
// Compare with the committed numbers; `--write` records a new baseline.
const committedFile = path.join(dir, "comparison.json");
writeFileSync(path.join(dir, "comparison.recomputed.json"), JSON.stringify(result, null, 2));
if (process.argv.includes("--write") || !existsSync(committedFile)) {
  writeFileSync(committedFile, JSON.stringify(result, null, 2));
  console.log(`  INFO  wrote ${path.relative(ROOT, committedFile)}`);
} else {
  const c = JSON.parse(readFileSync(committedFile, "utf8"));
  const pick = (r) => ({
    jobs: r.market?.jobs,
    marketOnTime: r.market?.onTime,
    attested: r.market?.attested,
    paidToMoved: Number((r.market?.paidToMovedNear ?? 0).toFixed(6)),
    fifoOnTime: r.fifo?.onTime,
    blindOnTime: r.blindFee?.onTime,
    blindBroken: r.blindFee?.promisesBroken,
    refusalKinds: JSON.stringify(Object.fromEntries(Object.entries(r.refusalKinds ?? {}).sort())),
  });
  const want = pick(c);
  const got = pick(result);
  const diff = Object.keys(want).filter((k) => want[k] !== got[k]);
  check(!diff.length, "recomputed headline equals the committed comparison.json", diff.length ? diff.map((k) => `${k}: committed ${want[k]}, now ${got[k]}`).join("; ") : "jobs, on-time counts, payments, refusals");
}
console.log(`\n${run}\n${line}`);
console.log(`value delivered on time (agents' private values): market ${market.valueOnTime.toFixed(3)} · FIFO ${F.valueOnTime.toFixed(3)} · EDF ${E.valueOnTime.toFixed(3)} · blind fee ${BL.valueOnTime.toFixed(3)} NEAR`);
process.exit(failures ? 1 : 0);
