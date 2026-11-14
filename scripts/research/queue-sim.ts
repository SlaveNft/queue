// @ts-nocheck
/**
 * QUEUE research simulator: one worker, one queue, many scheduling rules on the SAME jobs.
 *
 *   npx tsx scripts/research/queue-sim.ts [--seeds 200] [--loads 0.6,0.8,0.95,1.1,1.3,1.6] [--markup 1]
 *
 * Every rule sees identical arrivals and an identical worker (each job runs exactly its declared duration, a fixed
 * hand-off gap between jobs, and a head that can no longer finish by its deadline is dropped without using worker
 * time, as the contract does). Only the order differs. That makes every comparison paired, job by job.
 *
 * Jobs carry what the agents know privately: a value if delivered on time and a cost of waiting per second
 * (utility = value - cost x (finish - arrival) if on time, else 0).
 *
 * Rules:
 *   fifo       first come, first served.
 *   edf        earliest deadline first (a contract can enforce this; it cannot check that a deadline is true).
 *   smith      a planner who knows every waiting cost runs the highest cost per second of work first (Smith's rule).
 *   blind      a blind priority fee: a job that would be late bids its value; the highest bid runs next; nobody passed is paid.
 *   queue-v2   the deployed market4 rule: FIFO until a job buys an earlier slot; every job it passes is paid its posted
 *              ask x the buyer's duration; a purchase is refused if any passed job would miss its deadline.
 *   queue-v3   v2 plus: a job already projected to miss its deadline cannot block a purchase (it is still paid its ask).
 *
 * Market agents post their true cost of waiting x --markup as their ask, and buy the earlier slot with the highest net
 * gain in utility whenever it exceeds the price: at arrival (v3 does this in the same transaction as the submission)
 * and again every time the worker frees up.
 *
 * Output: data/research/queue-sim.json and a table on stdout.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const SEEDS = Number(opt("seeds", "200"));
const LOADS = opt("loads", "0.6,0.8,0.95,1.1,1.3,1.6").split(",").map(Number);
const MARKUP = Number(opt("markup", "1"));
const HORIZON = Number(opt("horizon", "1800")); // seconds of arrivals per season
const GAP = Number(opt("gap", "0")); // worker hand-off between jobs beyond the declared duration (the live worker settles early to absorb it)
const START_MARGIN = 2; // COMPLETE_MARGIN_SECS: a head needs this much to spare to be started
const MOVE_MARGIN = 3; // DEADLINE_MARGIN_SECS: a passed job must keep this much slack
const PER_HANDOFF = 1; // MARGIN_PER_HANDOFF_SECS
const FEE_BPS = 100;
const RULES = ["fifo", "edf", "smith", "blind", "queue-v2", "queue-v3"];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** A season's jobs. Mean duration 20 s; deadlines from 2x to 15x the duration after arrival. */
function workload(seed: number, load: number) {
  const r = rng(seed);
  const meanDur = 20;
  const rate = load / (meanDur + GAP);
  const jobs = [];
  let t = 0;
  let id = 1;
  while (true) {
    t += -Math.log(1 - r()) / rate;
    if (t > HORIZON) break;
    const duration = Math.round(8 + 24 * r());
    const window = Math.round(duration * (2 + 13 * r()));
    const value = 0.02 + 0.08 * r();
    const waitCost = (value * (0.1 + 0.8 * r())) / window;
    jobs.push({ id: id++, arrival: Math.round(t), duration, deadline: Math.round(t) + window, value, waitCost });
  }
  return jobs;
}

const utility = (j, finish, onTime) => (onTime ? j.value - j.waitCost * Math.max(0, finish - j.arrival) : 0);

/** Projected [start, finish] of each queued job, in order, from `base`. Declared durations, as the contract. */
function project(queue, base) {
  const out = [];
  let cursor = base;
  for (const j of queue) {
    out.push([cursor, cursor + j.duration]);
    cursor += j.duration;
  }
  return out;
}

/**
 * The contract's quote for moving queue[pos] so that it starts by `latest`: the latest insertion index that meets the
 * cutoff and the buyer's own deadline; infeasible if a passed job would miss (v3: unless it was already projected to).
 */
function quote(queue, base, pos, latest, rules) {
  const proj = project(queue, base);
  const u = queue[pos];
  let k = -1;
  for (let i = pos; i >= 0; i -= 1) {
    const start = proj[i][0];
    if (start > latest) continue;
    if (start + u.duration + MOVE_MARGIN > u.deadline) continue;
    k = i;
    break;
  }
  if (k < 0 || k === pos) return null;
  let comp = 0;
  const paid = [];
  for (let i = k; i < pos; i += 1) {
    const j = queue[i];
    const oldFinish = proj[i][1];
    const newFinish = oldFinish + u.duration;
    const doomed = oldFinish + START_MARGIN > j.deadline;
    // v3: a job already projected to miss its deadline has no promise left to protect, so it cannot block the jump;
    // it is still paid its ask, so every job a purchase passes is paid.
    if (!(rules === "queue-v3" && doomed) && newFinish + MOVE_MARGIN + PER_HANDOFF * (i - k) > j.deadline) return null;
    const amount = j.ask * u.duration;
    comp += amount;
    paid.push([j, amount]);
  }
  const fee = (comp * FEE_BPS) / 10_000;
  return { k, start: proj[k][0], finish: proj[k][0] + u.duration, comp, fee, paid };
}

/** The market agent's best purchase for queue[pos]: highest utility gain net of price, if positive. */
function bestBuy(queue, base, pos, rules) {
  const u = queue[pos];
  const proj = project(queue, base);
  const here = utility(u, proj[pos][1], proj[pos][1] + START_MARGIN <= u.deadline);
  let best = null;
  for (let target = pos - 1; target >= 0; target -= 1) {
    const q = quote(queue, base, pos, proj[target][0], rules);
    if (!q) continue;
    const gain = utility(u, q.finish, q.finish + START_MARGIN <= u.deadline) - here;
    const net = gain - q.comp - q.fee;
    if (net > 1e-6 && (!best || net > best.net)) best = { ...q, net };
  }
  return best;
}

function runSeason(jobs, rule) {
  const res = new Map(jobs.map((j) => [j.id, { finish: null, onTime: false, received: 0, spent: 0 }]));
  const pending = jobs.map((j) => ({ ...j, ask: j.waitCost * MARKUP }));
  let queue = [];
  let now = 0;
  let busyUntil = 0;
  let i = 0;
  const market = rule.startsWith("queue");
  let purchases = 0;
  let compensation = 0;
  const fifoLate = new Set(); // blind fee: who would be late at the back when it arrives
  const buy = (pos) => {
    const b = bestBuy(queue, Math.max(now, busyUntil), pos, rule);
    if (!b) return false;
    const u = queue[pos];
    queue.splice(pos, 1);
    queue.splice(b.k, 0, u);
    for (const [j, amount] of b.paid) res.get(j.id).received += amount;
    res.get(u.id).spent += b.comp + b.fee;
    purchases += 1;
    compensation += b.comp;
    return true;
  };
  while (i < pending.length || queue.length) {
    // Next event: an arrival, or the worker freeing up.
    const nextArrival = i < pending.length ? pending[i].arrival : Infinity;
    const workerFree = queue.length ? Math.max(busyUntil, now) : Infinity;
    if (nextArrival <= workerFree) {
      now = nextArrival;
      const j = pending[i++];
      // Admission: the contract refuses only a job that could not finish even at the front.
      if (Math.max(now, busyUntil) + j.duration + START_MARGIN > j.deadline) continue;
      queue.push(j);
      if (rule === "blind") {
        const back = project(queue, Math.max(now, busyUntil)).at(-1)[1];
        if (back + START_MARGIN > j.deadline) fifoLate.add(j.id);
      }
      if (market) buy(queue.length - 1); // v3: submit and buy in one transaction; v2: the agent's next action
      continue;
    }
    now = workerFree;
    if (market) {
      // Every queued agent may buy before the next start (in queue order from the back: the most delayed first).
      let budget = 4 * queue.length; // every purchase raises the buyer's utility; the cap only guards the loop
      for (let p = queue.length - 1; p > 0 && budget > 0; p -= 1) if (buy(p)) { budget -= 1; p = Math.min(p + 1, queue.length); }
    }
    // Pick the next job.
    let idx = 0;
    if (rule === "edf") idx = argBest(queue, (a, b) => a.deadline < b.deadline || (a.deadline === b.deadline && a.arrival < b.arrival));
    if (rule === "smith") idx = argBest(queue, (a, b) => a.waitCost / a.duration > b.waitCost / b.duration);
    if (rule === "blind") idx = argBest(queue, (a, b) => bidOf(a, fifoLate) > bidOf(b, fifoLate));
    const j = queue.splice(idx, 1)[0];
    if (now + j.duration + START_MARGIN > j.deadline) {
      res.get(j.id).finish = now; // dropped: the contract settles it as missed without starting it
      continue;
    }
    if (rule === "blind" && bidOf(j, fifoLate) > 0 && idx > 0) res.get(j.id).spent += j.value;
    const finish = now + j.duration;
    Object.assign(res.get(j.id), { finish, onTime: finish <= j.deadline });
    busyUntil = finish + GAP;
    now = finish;
  }
  return { res, purchases, compensation };
}

function argBest(queue, better) {
  let best = 0;
  for (let k = 1; k < queue.length; k += 1) if (better(queue[k], queue[best])) best = k;
  return best;
}
const bidOf = (j, late) => (late.has(j.id) ? j.value : 0);

// ---------------------------------------------------------------------------

let br = rng(20261114);
function ci95(xs) {
  const draws = [];
  for (let d = 0; d < 2000; d += 1) {
    let s = 0;
    for (let k = 0; k < xs.length; k += 1) s += xs[Math.floor(br() * xs.length)];
    draws.push(s / xs.length);
  }
  draws.sort((a, b) => a - b);
  return [draws[50], draws[1949]];
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const results = {};
for (const load of LOADS) {
  const perRule = Object.fromEntries(RULES.map((r) => [r, { onTime: [], welfare: [], worseOff: [], broken: [], gainVsFifo: [], purchases: 0, compensation: 0, jobs: 0 }]));
  for (let s = 0; s < SEEDS; s += 1) {
    const jobs = workload(1000 + s, load);
    const runs = Object.fromEntries(RULES.map((r) => [r, runSeason(jobs, r)]));
    const fifoU = new Map(jobs.map((j) => [j.id, utility(j, runs.fifo.res.get(j.id).finish, runs.fifo.res.get(j.id).onTime)]));
    const fifoW = [...fifoU.values()].reduce((a, b) => a + b, 0);
    for (const r of RULES) {
      const { res, purchases, compensation } = runs[r];
      const u = jobs.map((j) => utility(j, res.get(j.id).finish, res.get(j.id).onTime));
      const welfare = u.reduce((a, b) => a + b, 0);
      const withPay = jobs.map((j, k) => u[k] + res.get(j.id).received - res.get(j.id).spent);
      const P = perRule[r];
      P.onTime.push(jobs.filter((j) => res.get(j.id).onTime).length / Math.max(1, jobs.length));
      P.welfare.push(welfare);
      P.gainVsFifo.push(welfare - fifoW);
      P.worseOff.push(jobs.filter((j, k) => withPay[k] < fifoU.get(j.id) - 1e-9).length / Math.max(1, jobs.length));
      P.broken.push(jobs.filter((j) => runs.fifo.res.get(j.id).onTime && !res.get(j.id).onTime).length / Math.max(1, jobs.length));
      P.purchases += purchases;
      P.compensation += compensation;
      P.jobs += jobs.length;
    }
  }
  results[load] = Object.fromEntries(
    RULES.map((r) => {
      const P = perRule[r];
      const planner = mean(perRule.smith.gainVsFifo);
      return [
        r,
        {
          onTimeShare: mean(P.onTime),
          welfareMean: mean(P.welfare),
          welfareGainVsFifo: mean(P.gainVsFifo),
          welfareGainVsFifoCi95: ci95(P.gainVsFifo),
          shareOfPlannerGain: planner > 0 ? mean(P.gainVsFifo) / planner : null,
          worseOffThanFifoShare: mean(P.worseOff),
          fifoOnTimeMadeLateShare: mean(P.broken),
          purchasesPerSeason: P.purchases / SEEDS,
          compensationPerSeasonNear: P.compensation / SEEDS,
          jobsPerSeason: P.jobs / SEEDS,
        },
      ];
    }),
  );
}

const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
console.log(`QUEUE research simulator: ${SEEDS} seeds per load, markup ${MARKUP}, ${HORIZON}s of arrivals, paired by job`);
for (const load of LOADS) {
  console.log(`\nload ${load}`);
  console.log("rule       on time   welfare gain vs FIFO (95% CI)      of planner's gain   worse off than FIFO   FIFO-on-time made late   purchases");
  for (const r of RULES) {
    const x = results[load][r];
    console.log(
      `${r.padEnd(10)} ${pct(x.onTimeShare).padStart(7)}   ${x.welfareGainVsFifo.toFixed(3).padStart(7)} (${x.welfareGainVsFifoCi95.map((v) => v.toFixed(3)).join(" .. ")})`.padEnd(64) +
        `${pct(x.shareOfPlannerGain).padStart(8)}            ${pct(x.worseOffThanFifoShare).padStart(6)}                ${pct(x.fifoOnTimeMadeLateShare).padStart(6)}             ${x.purchasesPerSeason.toFixed(1)}`,
    );
  }
}
mkdirSync(path.join(ROOT, "data/research"), { recursive: true });
writeFileSync(
  path.join(ROOT, "data/research/queue-sim.json"),
  JSON.stringify({ what: "paired discrete-event simulation of one worker under six rules", command: `npx tsx scripts/research/queue-sim.ts --seeds ${SEEDS} --loads ${LOADS.join(",")} --markup ${MARKUP}`, assumptions: { meanDurationSecs: 20, durationSecs: [8, 32], deadlineWindow: "2x-15x duration", valueNear: [0.02, 0.1], waitCost: "value x U(0.1, 0.9) / deadline window, per second", gapSecs: GAP, startMarginSecs: START_MARGIN, moveMarginSecs: MOVE_MARGIN, feeBps: FEE_BPS, horizonSecs: HORIZON, asks: `true waiting cost x ${MARKUP}` }, results }, null, 2),
);

if (argv.includes("--debug")) {
  const jobs = workload(1000, LOADS[0]);
  const f = runSeason(jobs, "fifo").res;
  const q = runSeason(jobs, "queue-v2").res;
  for (const j of jobs) {
    const uf = utility(j, f.get(j.id).finish, f.get(j.id).onTime);
    const r = q.get(j.id);
    const uq = utility(j, r.finish, r.onTime) + r.received - r.spent;
    if (uq < uf - 1e-9) console.log(`job ${j.id} arr ${j.arrival} d ${j.duration} dl ${j.deadline} | fifo fin ${f.get(j.id).finish} ${f.get(j.id).onTime} | q fin ${r.finish} ${r.onTime} recv ${r.received.toFixed(5)} spent ${r.spent.toFixed(5)} | uF ${uf.toFixed(4)} uQ ${uq.toFixed(4)} delay ${r.finish - f.get(j.id).finish} c ${j.waitCost.toFixed(6)}`);
  }
}
