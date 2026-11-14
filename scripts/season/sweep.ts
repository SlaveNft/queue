// @ts-nocheck
/**
 * Monte Carlo sweep: many seeded seasons of the simulator (the same rules as the contract, see the `sim_parity`
 * test), each compared with FIFO and a blind priority fee on the same jobs.
 *
 *   npx tsx scripts/season/sweep.ts [--seeds 100] [--rates 1,1.25,1.5] [--minutes 30] [--jobs 8]
 *
 * Agents use the deterministic policy (no model, no keys, no network). Output: data/season/sweep.json.
 *
 * What it measures, for every season and in aggregate:
 *   safety      how many jobs that a purchase moved back end late;
 *   throughput  on-time deliveries of the market against FIFO, as a paired difference per season with a
 *               bootstrap 95% confidence interval;
 *   fairness    jobs that FIFO delivers and a rule makes late, for the market and for a blind priority fee.
 *               For the market these are split into jobs a purchase moved back (the rule protects these) and
 *               jobs that were never moved and wait behind a buyer whom FIFO would have dropped as late.
 */
import { spawn } from "node:child_process";
import { readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT } from "../lib.mjs";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const SEEDS = Number(opt("seeds", "100"));
const RATES = opt("rates", "1,1.25,1.5").split(",").map(Number);
const MINUTES = Number(opt("minutes", "30"));
const JOBS = Number(opt("jobs", String(Math.max(2, Math.min(8, os.cpus().length - 2)))));

const run = (args: string[]) =>
  new Promise<number>((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: ROOT, stdio: "ignore", env: { ...process.env, NEAR_AI_API_KEY: "" } });
    p.on("close", (code) => resolve(code ?? 1));
  });

async function season(rate: number, seed: number) {
  const name = `sweep-r${String(rate).replace(".", "_")}-s${seed}`;
  const dir = path.join(ROOT, "data/season", name);
  try {
    await run(["scripts/season/season.ts", "--sim", "--no-llm", "--minutes", String(MINUTES), "--rate", String(rate), "--seed", String(seed), "--run", name]);
    await run(["scripts/season/verify-season.ts", name, "--write"]);
    if (!existsSync(path.join(dir, "comparison.json"))) return null;
    const c = JSON.parse(readFileSync(path.join(dir, "comparison.json"), "utf8"));
    const s = JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8"));
    return {
      rate,
      seed,
      jobs: c.market.jobs,
      market: c.market.onTime,
      fifo: c.fifo.onTime,
      blind: c.blindFee.onTime,
      purchases: s.priorityPurchases,
      moved: c.market.movedJobs,
      movedLate: c.market.jumpedAndLate,
      marketBroken: c.market.onTimeUnderFifoButLate,
      marketBrokenMoved: c.market.ofThoseMovedByAPurchase,
      marketBrokenNeverMoved: c.market.ofThoseNeverMoved,
      blindBroken: c.blindFee.promisesBroken,
      valueMarket: c.market.valueOnTime,
      valueFifo: c.fifo.valueOnTime,
      paidToMoved: c.market.paidToMovedNear,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A small seeded generator so the bootstrap itself is reproducible.
let rs = 20261114;
const rand = () => ((rs = (rs * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
function bootstrap(xs: number[], draws = 4000): [number, number] {
  const means = [];
  for (let d = 0; d < draws; d += 1) {
    let sum = 0;
    for (let i = 0; i < xs.length; i += 1) sum += xs[Math.floor(rand() * xs.length)];
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(draws * 0.025)], means[Math.floor(draws * 0.975)]];
}

const todo: Array<[number, number]> = [];
for (const rate of RATES) for (let i = 0; i < SEEDS; i += 1) todo.push([rate, 1000 + i]);
const rows = [];
let next = 0;
await Promise.all(
  Array.from({ length: JOBS }, async () => {
    while (next < todo.length) {
      const [rate, seed] = todo[next];
      next += 1;
      const row = await season(rate, seed);
      if (row) rows.push(row);
      if (rows.length % 25 === 0) console.log(`  ${rows.length}/${todo.length} seasons`);
    }
  }),
);
rows.sort((a, b) => a.rate - b.rate || a.seed - b.seed);

const summarize = (set: typeof rows) => {
  const diff = set.map((r) => r.market - r.fifo);
  const share = set.map((r) => (r.market - r.fifo) / r.jobs);
  const ci = bootstrap(share);
  return {
    seasons: set.length,
    jobs: set.reduce((s, r) => s + r.jobs, 0),
    purchases: set.reduce((s, r) => s + r.purchases, 0),
    movedJobs: set.reduce((s, r) => s + r.moved, 0),
    movedJobsLate: set.reduce((s, r) => s + r.movedLate, 0),
    onTimeShare: { market: mean(set.map((r) => r.market / r.jobs)), fifo: mean(set.map((r) => r.fifo / r.jobs)), blindFee: mean(set.map((r) => r.blind / r.jobs)) },
    marketMinusFifo: { meanJobs: mean(diff), meanShare: mean(share), ci95Share: ci, seasonsAhead: diff.filter((d) => d > 0).length, seasonsLevel: diff.filter((d) => d === 0).length, seasonsBehind: diff.filter((d) => d < 0).length },
    promisesBroken: { market: set.reduce((s, r) => s + r.marketBroken, 0), marketOfThoseMovedByAPurchase: set.reduce((s, r) => s + r.marketBrokenMoved, 0), marketOfThoseNeverMoved: set.reduce((s, r) => s + r.marketBrokenNeverMoved, 0), blindFee: set.reduce((s, r) => s + r.blindBroken, 0), seasonsWhereBlindFeeBreaksOne: set.filter((r) => r.blindBroken > 0).length },
    valueMarketMinusFifoNear: { mean: mean(set.map((r) => r.valueMarket - r.valueFifo)), ci95: bootstrap(set.map((r) => r.valueMarket - r.valueFifo)) },
  };
};
const all = summarize(rows);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const findings = {
  safety: `${all.movedJobsLate} of ${all.movedJobs} jobs moved back by a purchase ended late, in ${all.seasons} seasons`,
  throughput: `the market delivered ${pct(all.marketMinusFifo.meanShare)} more jobs on time than FIFO (95% CI ${pct(all.marketMinusFifo.ci95Share[0])} to ${pct(all.marketMinusFifo.ci95Share[1])}); ahead in ${all.marketMinusFifo.seasonsAhead} seasons, level in ${all.marketMinusFifo.seasonsLevel}, behind in ${all.marketMinusFifo.seasonsBehind}`,
  fairness: `jobs FIFO delivers that the rule makes late: market ${all.promisesBroken.marketOfThoseNeverMoved} (${pct(all.promisesBroken.marketOfThoseNeverMoved / all.jobs)} of jobs, none of them moved by a purchase), blind fee ${all.promisesBroken.blindFee} (${pct(all.promisesBroken.blindFee / all.jobs)})`,
};
const out = {
  what: "Monte Carlo sweep of the simulator (deterministic agent policy, no model), paired with FIFO and a blind fee on the same jobs",
  command: `npx tsx scripts/season/sweep.ts --seeds ${SEEDS} --rates ${RATES.join(",")} --minutes ${MINUTES}`,
  findings,
  all,
  byRate: Object.fromEntries(RATES.map((r) => [r, summarize(rows.filter((x) => x.rate === r))])),
  rows,
};
writeFileSync(path.join(ROOT, "data/season/sweep.json"), JSON.stringify(out, null, 2));
console.log(`sweep: ${all.seasons} seasons, ${all.jobs} jobs, ${all.purchases} purchases`);
for (const [k, v] of Object.entries(findings)) console.log(`  ${k}: ${v}`);
