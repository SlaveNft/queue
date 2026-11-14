#!/usr/bin/env node
// Rewrite the proof table in docs/V3.md from data/v3/proof.json (between the two proof-table markers).
//
//   node scripts/v3/proof-table.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const proof = JSON.parse(readFileSync(path.join(ROOT, "data/v3/proof.json"), "utf8"));
const RULE = {
  1: "G2 delayed raise", 2: "G4 atomic purchase", 3: "G2 raise landed", 4: "G8 rejection", 5: "G9 release",
  6: "G3 + G5 late job passed, then paid from the stake", 7: "G7 + G5 model job", 8: "G6 liveness", 9: "G10 timelock",
  10: "G11 unstake", 11: "G12 approved clients", 12: "G11 the stake stays while a job is open",
};
const rows = proof.steps.filter((s) => s.method !== "heartbeat").map((s) => {
  const outcome = s.ok ? "ok" : `refused: ${String(s.error).replace(/\s+/g, " ").slice(0, 90)}`;
  return `| ${s.step} | ${RULE[s.step] ?? ""} | [\`${s.tx.slice(0, 8)}…\`](https://testnet.nearblocks.io/txns/${s.tx}) ${s.label} | ${outcome} |`;
});
const table = ["| Step | Rule | Transaction | Outcome |", "| ---: | --- | --- | --- |", ...rows].join("\n");
const file = path.join(ROOT, "docs/V3.md");
const doc = readFileSync(file, "utf8");
const [START, END] = ["<!-- proof-table -->", "<!-- /proof-table -->"];
const a = doc.indexOf(START), b = doc.indexOf(END);
if (a < 0 || b < 0) throw new Error("docs/V3.md: proof-table markers not found");
let next = `${doc.slice(0, a + START.length)}\n${table}\n${doc.slice(b)}`;
next = next.replace(/(### On-chain proof \(`data\/v3\/proof\.json`, )\d+( transactions)/, `$1${proof.steps.length}$2`);
writeFileSync(file, next);
console.log(`docs/V3.md: ${rows.length} rows, ${proof.steps.length} transactions`);
