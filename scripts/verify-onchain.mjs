#!/usr/bin/env node
// Re-check the public testnet proof against the live chain. Read-only: no keys, no wallet,
// no dependencies beyond Node. Every claim in data/onchain-proof.json is compared with what
// the NEAR RPC returns right now.
//
//   npm run verify:onchain
//
// Exit 0 = every check passed · 1 = a check failed · 2 = the RPC could not be reached.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TX_RPCS, Unreachable, VIEW_RPCS, call, txOutcome, view as viewAt } from "./near-rpc.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));

const proof = read("data/onchain-proof.json");
const deploy = read("data/deploy.json");
const contractId = proof.contractId;

async function rpc(method, params) {
  return call(VIEW_RPCS, method, params);
}

const view = (method, args = {}) => viewAt(contractId, method, args);

function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

const near = (yocto) => `${(Number(BigInt(yocto) / 10n ** 15n) / 1e9).toFixed(7)} NEAR`;

let failed = 0;
function check(ok, label, detail = "") {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ·  ${detail}` : ""}`);
}

/** A missing local file is a failed check unless the caller opts out: a silent skip would read as a pass. */
const ALLOW_MISSING = process.argv.includes("--allow-missing");
function fileCheck(file, what) {
  if (existsSync(file)) return true;
  check(ALLOW_MISSING, `${what}: file present`, ALLOW_MISSING ? `missing, skipped (--allow-missing): ${path.relative(ROOT, file)}` : `missing: ${path.relative(ROOT, file)}`);
  return false;
}

/** The contract method each proof transaction must call, derived from its label. */
function methodOf(label) {
  if (/^submit /.test(label)) return "submit_job";
  if (/^withdraw /.test(label)) return "withdraw_credit";
  if (/^start /.test(label)) return "start_next";
  if (/^deliver /.test(label)) return "complete_job";
  return "request_priority"; // the priority purchase and the refused jump
}

/** Who signed each proof transaction, derived from its label and the public role list. */
function signerOf(label) {
  const roles = { ...Object.fromEntries(Object.entries(deploy.agents).map(([name, a]) => [name, a.accountId])) };
  roles.kestrel = deploy.buyerId;
  roles.orion = deploy.orionId;
  const named = label.match(/^(?:submit|withdraw) (\w+)/);
  if (named) return roles[named[1]];
  if (/^(start|deliver)/.test(label)) return deploy.operatorId;
  return deploy.buyerId; // the priority purchase and the refused jump
}

const txStatus = (hash, signer) => txOutcome(hash, signer);

async function main() {
  console.log(`QUEUE on-chain verification\n  contract  ${contractId}\n  state     ${VIEW_RPCS[0]} (+${VIEW_RPCS.length - 1} fallback)\n  history   ${TX_RPCS.join(", ")} (archival: old transactions)\n`);

  // 1. The deployed code is the code in this repository.
  console.log("Deployed code");
  const account = await rpc("query", { request_type: "view_account", finality: "final", account_id: contractId });
  check(Boolean(account.result), "contract account exists on NEAR testnet");
  const onChainHash = account.result?.code_hash;
  const recorded = base58(Buffer.from(proof.wasmSha256 ?? deploy.wasmSha256, "hex"));
  check(onChainHash === recorded, "code hash on chain equals the hash recorded in the proof", onChainHash);
  // The reproducible build (`npm run verify:v1-deployed`) matches on the deployer's platform (macOS/Apple silicon) under any cargo home. A plain `cargo build` matches only
  // under the deployer's cargo home, because the wasm keeps dependency source paths; a difference there is a note.
  const reproPath = path.join(ROOT, "contracts/queue/target/repro/wasm32-unknown-unknown/release/queue.wasm");
  const wasmPath = path.join(ROOT, "contracts/queue/target/wasm32-unknown-unknown/release/queue.wasm");
  if (existsSync(reproPath)) {
    const local = base58(createHash("sha256").update(readFileSync(reproPath)).digest());
    if (local === onChainHash || (process.platform === "darwin" && process.arch === "arm64")) {
      check(local === onChainHash, "code hash on chain equals your reproducible build (`npm run verify:v1-deployed`)", local);
    } else {
      console.log(`  note  your build (${process.platform}/${process.arch}) differs from the deployed code, which was built on macOS/arm64; the compiled wasm is host-dependent`);
    }
  } else if (existsSync(wasmPath) && base58(createHash("sha256").update(readFileSync(wasmPath)).digest()) === onChainHash) {
    check(true, "code hash on chain equals your local build", onChainHash);
  } else {
    console.log("  note  run `npm run verify:v1-deployed` to rebuild the contract and compare it with the code on chain");
  }

  // 2. The priority purchase: who was passed, what each was paid.
  console.log("\nPriority purchase");
  const urgent = await view("get_job", { job_id: proof.jobId });
  check(urgent.status === "DONE" && urgent.expedited === true, `urgent job ${proof.jobId} is DONE and expedited`);
  check(urgent.priority_spend === proof.quote.total, "amount the buyer paid matches the quote", near(urgent.priority_spend));
  check(Number(urgent.finished_at) <= Number(urgent.deadline_at), "urgent job was delivered before its deadline",
    `${Number(urgent.deadline_at) - Number(urgent.finished_at)}s early`);
  check(urgent.artifact_hash === proof.artifact.sha256, "delivered artifact hash matches the proof");
  const artifactFile = path.join(ROOT, proof.artifact.file);
  if (fileCheck(artifactFile, "urgent artifact")) {
    const fileHash = createHash("sha256").update(readFileSync(artifactFile)).digest("hex");
    check(fileHash === proof.artifact.fileSha256, "artifact file in the repo matches its recorded hash");
  }
  const priority = await view("get_priority", { priority_id: urgent.priority_id });
  const paid = Object.fromEntries(priority.displaced.map((entry) => [entry.job_id, entry.amount]));
  check(priority.displaced.length === proof.quote.displaced.length, `${priority.displaced.length} agents were passed`);
  for (const expected of proof.quote.displaced) {
    check(paid[expected.job_id] === expected.amount, `job ${expected.job_id} (${expected.owner}) was paid its own ask`, near(expected.amount));
  }
  check(priority.total === proof.quote.total && priority.fee === proof.quote.fee, "compensation + 1% fee equals the total", near(priority.total));

  // 3. The promise was kept: every agent that sold its slot still delivered on time.
  console.log("\nEvery crossed promise kept");
  const deliveries = [...(proof.displacedDeliveries ?? []), ...(proof.refusalDeliveries ?? [])];
  for (const item of deliveries) {
    const job = await view("get_job", { job_id: item.jobId });
    const early = Number(job.deadline_at) - Number(job.finished_at);
    check(job.status === "DONE" && early >= 0 && job.artifact_hash === item.artifactSha256,
      `job ${item.jobId} (${item.owner}) is DONE before its deadline`, `${early}s early`);
    const file = path.join(ROOT, item.artifactFile);
    if (fileCheck(file, `job ${item.jobId} artifact`)) {
      const fileHash = createHash("sha256").update(readFileSync(file)).digest("hex");
      check(fileHash === item.artifactSha256, `job ${item.jobId} artifact file matches the hash on chain`);
    }
  }
  for (const item of proof.withdrawals ?? []) {
    const accountId = deploy.agents[item.owner].accountId;
    // The withdrawal transaction itself: right method, right signer, and it paid out exactly the recorded amount.
    const st = item.tx ? await txStatus(item.tx, accountId) : { found: false };
    check(st.found && !st.failure && st.method === "withdraw_credit" && st.signer === accountId && String(st.returned) === item.amount,
      `${item.owner} withdrew its pay from the contract`, `${near(item.amount)} in ${item.tx ?? "no tx recorded"}`);
    const credit = await view("get_credit", { account_id: accountId });
    check(credit === "0", `${item.owner} has no credit left in the contract`);
  }

  // 4. The refusal: a jump that would break a deadline fails on chain and moves nothing.
  console.log("\nThe refusal");
  const refusal = proof.refusal;
  const refused = await txStatus(refusal.tx, deploy.buyerId);
  check(refused.found && refused.method === "request_priority" && refused.receiver === contractId,
    "the refused purchase is a real request_priority transaction", refusal.tx);
  check(Boolean(refused.failure) && /priority infeasible: displaced job/.test(refused.failure ?? ""),
    "the contract itself rejected it", (refused.failure?.match(/priority infeasible: [^"\\]+/) ?? [""])[0]);
  const tight = await view("get_job", { job_id: refusal.tightJob.id });
  const jumper = await view("get_job", { job_id: refusal.jumpingJob.id });
  check(tight.moved_compensation === "0" && tight.move_count === 0, `protected job ${tight.id} was never moved or paid`);
  check(jumper.expedited === false && jumper.priority_spend === "0", `refused job ${jumper.id} bought nothing`);
  check(tight.status === "DONE" && Number(tight.finished_at) <= Number(tight.deadline_at),
    `protected job ${tight.id} still delivered on time`, `${Number(tight.deadline_at) - Number(tight.finished_at)}s early`);

  // 5. Every transaction in the proof exists, was signed by the role it names, and has the stated outcome.
  console.log("\nTransactions");
  let okTx = 0;
  const problems = [];
  for (const entry of proof.transactions) {
    const status = await txStatus(entry.hash, signerOf(entry.label));
    const expectFailure = entry.hash === refusal.tx;
    const good = status.found && status.receiver === contractId && status.signer === signerOf(entry.label) &&
      status.method === methodOf(entry.label) && Boolean(status.failure) === expectFailure;
    if (good) okTx += 1;
    else problems.push(`${entry.label} ${entry.hash} ${JSON.stringify(status).slice(0, 160)}`);
  }
  check(problems.length === 0, `${okTx} of ${proof.transactions.length} proof transactions found with the stated signer, method and outcome`);
  for (const line of problems) console.log(`        ${line}`);
  if (deploy.deployTx) {
    const deployed = await txStatus(deploy.deployTx, contractId);
    check(deployed.found && !deployed.failure, "deploy transaction found", deploy.deployTx);
  }

  // 6. Contract-wide counters, for context (anyone can use a public testnet contract after us).
  const stats = await view("get_stats");
  console.log(`\nContract counters now: submitted ${stats.submitted}, completed ${stats.completed}, missed ${stats.missed}, ` +
    `priority purchases moved ${stats.moves} jobs, escrow held ${near(stats.total_escrow)}`);
  check(stats.completed >= proof.verification.jobsCompleted, "the contract has completed at least the proof's jobs");

  console.log(failed === 0
    ? "\nverify:onchain: all checks passed — the proof file matches the live chain"
    : `\nverify:onchain: ${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  if (error instanceof Unreachable) {
    console.error(`\nverify:onchain: SKIPPED — cannot reach the NEAR RPC (${error.message}).`);
    console.error("Retry in a minute, or set QUEUE_RPC_URLS / QUEUE_ARCHIVAL_RPC_URLS to other testnet RPCs.");
    process.exit(2);
  }
  console.error(`\nverify:onchain: ${error.message}`);
  process.exit(1);
});
