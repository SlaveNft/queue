#!/usr/bin/env node
// Planted bugs: break one rule of the v2 contract at a time, in a temporary copy, and check that each of the
// three test suites notices on its own: the unit tests, the random-history invariants, and the differential
// test against the TypeScript rules.
//
//   node scripts/planted-bugs.mjs            (about 3 minutes once the crate is built; no network, no keys)
//
// The contract in the repository is never modified. Output: data/season/planted-bugs.json. Exits 1 if any
// suite misses any bug.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./lib.mjs";

const CRATE = path.join(ROOT, "contracts/queue-v2");
const BUGS = [
  {
    name: "a passed job's safety margin is dropped",
    from: "if checked_add_u64(new_finish, margin) > displaced_job.deadline_at && first_bad.is_none() {",
    to: "if new_finish > displaced_job.deadline_at && first_bad.is_none() {",
  },
  {
    name: "a passed job's deadline is not checked at all",
    from: "if checked_add_u64(new_finish, margin) > displaced_job.deadline_at && first_bad.is_none() {",
    to: "if false && checked_add_u64(new_finish, margin) > displaced_job.deadline_at && first_bad.is_none() {",
  },
  {
    name: "the extra margin per hand-off is dropped",
    from: "let margin = checked_add_u64(DEADLINE_MARGIN_SECS, MARGIN_PER_HANDOFF_SECS * handoffs);",
    to: "let margin = checked_add_u64(DEADLINE_MARGIN_SECS, 0 * handoffs);",
  },
  {
    name: "the buyer's own margin is dropped when the slot is chosen",
    from: "if start <= latest_start_at && checked_add_u64(finish, DEADLINE_MARGIN_SECS) <= job.deadline_at {",
    to: "if start <= latest_start_at && finish <= job.deadline_at {",
  },
  {
    name: "compensation uses the passed job's duration, not the buyer's",
    from: "let amount = checked_mul_u128(displaced_job.ask_per_sec, job.duration_secs as u128);",
    to: "let amount = checked_mul_u128(displaced_job.ask_per_sec, displaced_job.duration_secs as u128);",
  },
  {
    name: "the fee is rounded up by one yocto",
    from: "(amount / BPS_DENOMINATOR) * bps + ((amount % BPS_DENOMINATOR) * bps) / BPS_DENOMINATOR\n}",
    to: "(amount / BPS_DENOMINATOR) * bps + ((amount % BPS_DENOMINATOR) * bps) / BPS_DENOMINATOR + 1\n}",
  },
  {
    name: "the worker may start a job that can no longer finish",
    from: "let cannot_finish = checked_add_u64(checked_add_u64(now, job.duration_secs as u64), COMPLETE_MARGIN_SECS) > job.deadline_at;",
    to: "let cannot_finish = now > job.deadline_at;",
  },
  {
    name: "a late delivery is paid as if it were on time",
    from: "        if now > job.deadline_at {\n",
    to: "        if false && now > job.deadline_at {\n",
  },
];
const SUITES = [
  { name: "unit", args: ["--", "--skip", "invariants", "--skip", "sim_parity"] },
  { name: "invariants", args: ["invariants"] },
  { name: "differential", args: ["sim_parity"] },
];

const source = readFileSync(path.join(CRATE, "src/lib.rs"), "utf8");
const split = source.indexOf("\nmod tests {");
const contract = source.slice(0, split);
// The first failing history is enough here; shrinking it to a minimal one only costs time.
const tests = source.slice(split).replace("max_shrink_iters: 300", "max_shrink_iters: 0");

const tmp = mkdtempSync(path.join(os.tmpdir(), "queue-planted-bugs-"));
const work = path.join(tmp, "crate");
const env = { ...process.env, CARGO_TARGET_DIR: path.join(tmp, "target") };
const rows = [];
try {
  for (const bug of BUGS) {
    if (contract.split(bug.from).length !== 2) throw new Error(`the line for "${bug.name}" was not found exactly once; update scripts/planted-bugs.mjs`);
    rmSync(work, { recursive: true, force: true });
    cpSync(CRATE, work, { recursive: true, filter: (src) => path.basename(src) !== "target" && path.basename(src) !== "mutants.out" });
    writeFileSync(path.join(work, "src/lib.rs"), contract.replace(bug.from, bug.to) + tests);
    const row = { bug: bug.name };
    for (const suite of SUITES) {
      const r = spawnSync("cargo", ["test", "--quiet", ...suite.args], { cwd: work, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const result = /test result: (\w+)\. (\d+) passed; (\d+) failed/.exec(`${r.stdout}${r.stderr}`);
      row[suite.name] = result?.[1] === "FAILED" ? "caught" : result && r.status === 0 ? "missed" : "did not build";
    }
    rows.push(row);
    console.log(`  ${row.bug}: ${SUITES.map((s) => `${s.name} ${row[s.name]}`).join(", ")}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const caught = Object.fromEntries(SUITES.map((s) => [s.name, rows.filter((r) => r[s.name] === "caught").length]));
const ok = SUITES.every((s) => caught[s.name] === BUGS.length);
const out = {
  what: "each bug is planted alone in a temporary copy of contracts/queue-v2; a suite catches it when at least one of its tests fails",
  command: "node scripts/planted-bugs.mjs",
  bugs: BUGS.length,
  caught,
  ok,
  rows,
};
writeFileSync(path.join(ROOT, "data/season/planted-bugs.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`planted-bugs: ${SUITES.map((s) => `${s.name} ${caught[s.name]}/${BUGS.length}`).join(", ")}`);
process.exit(ok ? 0 : 1);
