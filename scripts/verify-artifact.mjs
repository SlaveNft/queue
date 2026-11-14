#!/usr/bin/env node
/**
 * Rebuild the on-chain demo artifact from the shipped incident log and check
 * every published hash. This turns "the artifact hash matches" into a
 * reproducible computation instead of a claim.
 *
 * Run with: npm run verify:artifact
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArtifact, INCIDENT_INPUT, URGENT_SEED } from "@queue/ledger";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_FILE = path.join(ROOT, "data", "onchain-artifact.md");
const PROOF_FILE = path.join(ROOT, "data", "onchain-proof.json");
const HEX = /^[0-9a-f]{64}$/;

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// The artifact is a pure function of title + task + input; id and money do not
// appear in the markdown, so a deterministic stub is enough to rebuild it.
const job = {
  id: "J-1005",
  seq: 1005,
  title: URGENT_SEED.title,
  task: URGENT_SEED.task,
  ownerId: URGENT_SEED.ownerId,
  ownerAccount: "kestrel.queue-demo.testnet",
  brief: URGENT_SEED.brief,
  input: INCIDENT_INPUT,
  durationSec: URGENT_SEED.durationSec,
  submittedAt: 0,
  deadlineAt: 0,
  rewardYocto: "0",
  bondYocto: "0",
  askPerSecYocto: "0",
  status: "running",
  expedited: false,
  prioritySpendYocto: "0",
  movedCompensationYocto: "0",
  moves: [],
};

if (!existsSync(ARTIFACT_FILE)) {
  console.error(`verify-artifact: missing ${path.relative(ROOT, ARTIFACT_FILE)}`);
  process.exit(1);
}
if (!existsSync(PROOF_FILE)) {
  console.error(`verify-artifact: missing ${path.relative(ROOT, PROOF_FILE)}`);
  process.exit(1);
}

const artifact = buildArtifact(job);
const computed = artifact.sha256;
const published = readFileSync(ARTIFACT_FILE);
const publishedText = published.toString("utf8");
const publishedHash = sha256(publishedText);
const proof = JSON.parse(readFileSync(PROOF_FILE, "utf8"));

check("recomputed hash is 64 lowercase hex", HEX.test(computed), computed);
check(
  "artifact markdown matches data/onchain-artifact.md byte for byte",
  artifact.markdown === publishedText,
  `${artifact.markdown.length} vs ${publishedText.length} chars`,
);
check(
  "hash of data/onchain-artifact.md matches the recomputed hash",
  publishedHash === computed,
  `${publishedHash} vs ${computed}`,
);
check(
  "proof.artifact.sha256 matches the recomputed hash",
  proof?.artifact?.sha256 === computed,
  String(proof?.artifact?.sha256),
);
check(
  "proof.artifact.fileSha256 matches the recomputed hash",
  proof?.artifact?.fileSha256 === computed,
  String(proof?.artifact?.fileSha256),
);
check(
  "proof.artifact.bytes matches the file size",
  proof?.artifact?.bytes === statSync(ARTIFACT_FILE).size,
  `${proof?.artifact?.bytes} vs ${statSync(ARTIFACT_FILE).size}`,
);
if (typeof proof?.artifact_hash === "string") {
  check(
    "proof.artifact_hash (delivered on chain) matches the recomputed hash",
    proof.artifact_hash === computed,
    proof.artifact_hash,
  );
}
if (typeof proof?.finalJob?.artifact_hash === "string") {
  check(
    "proof.finalJob.artifact_hash (job record) matches the recomputed hash",
    proof.finalJob.artifact_hash === computed,
    proof.finalJob.artifact_hash,
  );
}
check(
  "proof points at data/onchain-artifact.md",
  proof?.artifact?.file === "data/onchain-artifact.md",
  String(proof?.artifact?.file),
);

let failed = 0;
for (const item of checks) {
  const mark = item.ok ? "PASS" : "FAIL";
  console.log(`verify-artifact: ${mark} ${item.name}${item.ok ? "" : ` — ${item.detail}`}`);
  if (!item.ok) failed += 1;
}

if (failed > 0) {
  console.error(`verify-artifact: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`verify-artifact: OK (${checks.length} checks, sha256 ${computed})`);
