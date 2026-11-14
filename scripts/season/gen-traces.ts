// @ts-nocheck
/**
 * Differential testing: record what the TypeScript rules (SimChain) do on seeded random histories, so a Rust
 * test can replay the same histories against the contract and compare every step.
 *
 *   npx tsx scripts/season/gen-traces.ts [traces=30] [steps=70]
 *
 * Output: contracts/queue-v2/src/sim_traces.json (read by the `sim_parity` test in the contract crate).
 * With QUEUE_SIM_RULES=v3 the simulator follows the v3 rules and writes contracts/queue-v3/src/sim_traces.json.
 * No network, no keys, no model.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../lib.mjs";
import { SIM_RULES, SimChain } from "./chain.ts";

const TRACES = Number(process.argv[2] ?? 30);
const STEPS = Number(process.argv[3] ?? 70);
const NEAR = 10n ** 24n;
const REWARD = NEAR / 100n;
const BOND = NEAR / 200n;
const AGENTS = ["kestrel.sim", "mira.sim", "atlas.sim", "vale.sim", "juno.sim"];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const traces = [];
for (let n = 0; n < TRACES; n += 1) {
  const rand = rng(20261114 + n * 7919);
  const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const sim = new SimChain();
  const steps = [];
  const snapshot = () => ({
    order: [...sim.order],
    running: sim.running,
    credits: Object.fromEntries([...AGENTS, sim.treasuryId].map((a) => [a, (sim.credits.get(a) ?? 0n).toString()])),
    status: Object.fromEntries([...sim.jobs.values()].map((j) => [j.id, j.status])),
  });
  const push = (step: Record<string, unknown>) => steps.push({ t: sim.clock, ...step, state: snapshot() });

  for (const a of AGENTS) {
    sim.fund(a, 5n * NEAR);
    push({ op: "deposit", who: a, amount: (5n * NEAR).toString() });
  }
  for (let i = 0; i < STEPS; i += 1) {
    const roll = rand();
    const queued = sim.order.map((id) => sim.jobs.get(id));
    if (roll < 0.1 && queued.length < 12) {
      // Boundary probe: random deadlines almost never land within a few seconds of a safety margin, so build
      // the case on purpose. A job joins the back with a deadline a few seconds either side of the margin it
      // needs to be passed by the next job; that job then asks for its slot, or for one up to three places
      // further ahead, where the margin is one second wider per hand-off.
      const who = AGENTS[int(0, AGENTS.length - 1)];
      const buyer = AGENTS[int(0, AGENTS.length - 1)];
      const view = await sim.queue();
      const running = sim.running == null ? null : sim.jobs.get(sim.running);
      const backStart = view.length ? view[view.length - 1].projected_finish_at : running ? Math.max(sim.clock, running.started_at + running.duration_secs) : sim.clock;
      const dPassed = int(2, 20);
      const dBuyer = int(3, 20);
      const ahead = view.length && rand() < 0.5 ? int(1, Math.min(3, view.length)) : 0;
      const slotStart = ahead ? view[view.length - ahead].projected_start_at : backStart;
      const passedDeadline = backStart + dPassed + dBuyer + 3 + ahead + int(-4, 3) - sim.clock;
      const ask = BigInt(int(0, 2000)) * 10n ** 18n;
      const a = await sim.submit(who, { title: "job", input_hash: `t${n}s${i}a`, input_uri: "", duration_secs: dPassed, deadline_secs: passedDeadline, reward: REWARD, bond: BOND, ask_per_sec: ask });
      push({ op: "submit", who, duration: dPassed, deadline: passedDeadline, ask: ask.toString(), ok: a.ok, job: a.jobId ?? null });
      if (a.ok) {
        // Half the time the buyer's own deadline sits on its margin too.
        const buyerDeadline = (rand() < 0.5 ? slotStart + dBuyer + 3 + int(-2, 3) : backStart + dPassed + dBuyer + 60 + int(0, 100)) - sim.clock;
        const b = await sim.submit(buyer, { title: "job", input_hash: `t${n}s${i}b`, input_uri: "", duration_secs: dBuyer, deadline_secs: buyerDeadline, reward: REWARD, bond: BOND, ask_per_sec: 0n });
        push({ op: "submit", who: buyer, duration: dBuyer, deadline: buyerDeadline, ask: "0", ok: b.ok, job: b.jobId ?? null });
        if (b.ok) {
          const latest = slotStart + int(0, 1);
          const q = sim.quoteSync(b.jobId, latest);
          const quote = { feasible: q.feasible, safety: /^displaced job/.test(q.reason), insert: q.insert_index, total: q.total, displaced: q.displaced.map((d) => ({ job: d.job_id, amount: d.amount, finish: d.new_finish_at })) };
          if (q.feasible && q.displaced.length) {
            const r = await sim.buy(buyer, b.jobId, latest, BigInt(q.total));
            push({ op: "buy", who: buyer, job: b.jobId, latest, quote, ok: r.ok });
          } else {
            push({ op: "quote", job: b.jobId, latest, quote });
          }
        }
      }
    } else if (roll < 0.14 && sim.running == null && queued.length) {
      // Boundary probe: start the head a second or two either side of the last moment it can still finish.
      const head = queued[0];
      const edge = head.deadline_at - head.duration_secs - 2 + int(-2, 2);
      if (edge > sim.clock) {
        sim.advance(edge - sim.clock);
        push({ op: "wait" });
      }
      const r = await sim.startNext();
      push({ op: "start", job: r.jobId, started: sim.running === r.jobId });
    } else if (roll < 0.36) {
      const who = AGENTS[int(0, AGENTS.length - 1)];
      const duration = int(2, 30);
      // Mostly feasible, sometimes hopeless on purpose: both sides must agree on which is which.
      const deadline = rand() < 0.12 ? int(1, duration + 3) : duration + 2 + int(0, 220);
      const ask = BigInt(int(0, 2000)) * 10n ** 18n;
      const r = await sim.submit(who, { title: "job", input_hash: `t${n}s${i}`, input_uri: "", duration_secs: duration, deadline_secs: deadline, reward: REWARD, bond: BOND, ask_per_sec: ask });
      push({ op: "submit", who, duration, deadline, ask: ask.toString(), ok: r.ok, job: r.jobId ?? null });
    } else if (roll < 0.58 && queued.length >= 2) {
      const job = queued[int(0, queued.length - 1)];
      const latest = sim.clock + int(-2, 70);
      const q = sim.quoteSync(job.id, latest);
      const quote = {
        feasible: q.feasible,
        safety: /^displaced job/.test(q.reason),
        insert: q.insert_index,
        total: q.total,
        displaced: q.displaced.map((d) => ({ job: d.job_id, amount: d.amount, finish: d.new_finish_at })),
      };
      if (q.feasible && q.displaced.length) {
        const r = await sim.buy(job.owner, job.id, latest, BigInt(q.total));
        push({ op: "buy", who: job.owner, job: job.id, latest, quote, ok: r.ok });
      } else {
        push({ op: "quote", job: job.id, latest, quote });
      }
    } else if (roll < 0.7) {
      if (sim.running == null && sim.order.length) {
        const r = await sim.startNext();
        push({ op: "start", job: r.jobId, started: sim.running === r.jobId });
      }
    } else if (roll < 0.82) {
      if (sim.running != null) {
        const job = sim.jobs.get(sim.running);
        const earliest = Math.max(sim.clock, job.started_at + job.duration_secs);
        const pick = rand();
        // Usually on time, sometimes late, sometimes within a second of the deadline.
        sim.clock = pick < 0.2 ? earliest + int(1, 40) : pick < 0.4 ? Math.max(earliest, job.deadline_at + int(-1, 1)) : earliest;
        await sim.complete(job.id, "artifact");
        push({ op: "complete", job: job.id });
      }
    } else if (roll < 0.86 && queued.length) {
      const job = queued[int(0, queued.length - 1)];
      await sim.cancel(job.owner, job.id);
      push({ op: "cancel", who: job.owner, job: job.id });
    } else if (roll < 0.905 && queued.length) {
      const job = queued[int(0, queued.length - 1)];
      const ask = BigInt(int(0, 2000)) * 10n ** 18n;
      await sim.setAsk(job.owner, job.id, ask);
      push({ op: "ask", who: job.owner, job: job.id, ask: ask.toString() });
    } else if (roll < 0.94) {
      const late = [...sim.jobs.values()].filter((j) => (j.status === "QUEUED" || j.status === "RUNNING") && sim.clock > j.deadline_at);
      if (late.length) {
        const job = late[int(0, late.length - 1)];
        await sim.claimTimeout(AGENTS[0], job.id);
        push({ op: "timeout", job: job.id });
      }
    } else {
      sim.advance(int(1, 25));
      push({ op: "wait" });
    }
  }
  traces.push({ seed: n, start: 1_800_000_000, operator: sim.operatorId, treasury: sim.treasuryId, agents: AGENTS, reward: REWARD.toString(), bond: BOND.toString(), steps });
}
const out = path.join(ROOT, SIM_RULES === "v3" ? "contracts/queue-v3/src/sim_traces.json" : "contracts/queue-v2/src/sim_traces.json");
writeFileSync(out, JSON.stringify({ generatedBy: "scripts/season/gen-traces.ts", traces }));
const total = traces.reduce((s, t) => s + t.steps.length, 0);
const count = (op: string) => traces.reduce((s, t) => s + t.steps.filter((x) => x.op === op).length, 0);
console.log(`gen-traces: ${traces.length} histories, ${total} steps (${count("submit")} submits, ${count("buy")} purchases, ${count("quote")} refused or empty quotes, ${count("start")} starts, ${count("complete")} completions) -> ${path.relative(ROOT, out)}`);
