#!/usr/bin/env node
// One job through the public client (packages/client), end to end on testnet: an agent with a function-call key
// submits through the same tool calls the CLI and the MCP server use, the operator starts and settles it, the agent
// releases the record and gets its storage deposit back. Writes data/v3/client-e2e.json (public data, no keys).
//
//   node scripts/v3/client-e2e.mjs [agent]        (default agent: mira; ~30 s, six transactions)
//
// Needs the season key files in .testnet/ (the agent's function-call key for the contract and the operator's key).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QueueClient } from "../../packages/client/src/index.mjs";
import { callTool, limitsFromEnv } from "../../packages/client/src/mcp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const meta = JSON.parse(readFileSync(path.join(ROOT, "data/v3/market5.json"), "utf8"));
const C = meta.contractId;
const agentName = process.argv[2] ?? "mira";
const key = (file) => JSON.parse(readFileSync(path.join(ROOT, ".testnet", file), "utf8"));
const agentKey = key(`season/${agentName}.queue-demo.testnet.${C}.fc.json`);
const operatorKey = key("worker.queue-demo.testnet.json");
const secret = (k) => k.secretKey ?? k.private_key ?? k.privateKey;
const agent = new QueueClient({ contractId: C, accountId: agentKey.accountId, secretKey: secret(agentKey) });
const operator = new QueueClient({ contractId: C, accountId: operatorKey.accountId ?? operatorKey.account_id, secretKey: secret(operatorKey) });
const limits = limitsFromEnv({});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = [];
function record(label, signer, method, r, extra = {}) {
  steps.push({ step: steps.length, label, signer, method, tx: r.tx ?? null, ok: r.ok, error: r.error ?? r.refused ?? null, events: (r.events ?? []).map((e) => e.event ?? e), ...extra });
  console.log(`${r.ok ? "ok  " : "FAIL"} ${label}${r.tx ? `  ${r.tx}` : ""}${r.ok ? "" : `  ${r.error ?? r.refused}`}`);
  if (!r.ok) throw new Error(`step failed: ${label}`);
}
/** A tool call exactly as the CLI and the MCP server make it. */
async function tool(name, args) {
  const out = await callTool(name, args, agent, limits);
  const body = JSON.parse(out.content[0].text);
  return { ...body, ok: !out.isError && body.ok !== false };
}

const startedAt = new Date().toISOString();
record("operator heartbeat (the contract takes no work while the worker is silent)", operator.accountId, "heartbeat", await operator.call("heartbeat", {}, { gasTgas: 15n }));
const before = BigInt(await agent.credit());

const reference = `ref:client-e2e-${Date.now()}`;
const submitted = await tool("queue_submit", { title: "client end-to-end check", input_hash: reference, duration_secs: 5, deadline_secs: 120, ask_per_sec_near: "0.0001" });
const jobId = submitted.result;
record("agent submits through the client (function-call key, paid from its balance)", agent.accountId, "submit_job", submitted, { job_id: jobId });

record("operator starts the head of the queue", operator.accountId, "start_next", await operator.call("start_next", {}, { gasTgas: 30n }));
await sleep(5500);
const artifact = createHash("sha256").update(`${reference}:done`).digest("hex");
record("operator settles it on time", operator.accountId, "complete_job", await operator.call("complete_job", { job_id: jobId, artifact_hash: `sha256:${artifact}` }, { gasTgas: 30n }), { job_id: jobId });

const job = await agent.job(jobId);
if (job.status !== "DONE") throw new Error(`job ${jobId} is ${job.status}, expected DONE`);
const released = await tool("queue_release", { job_id: jobId });
record("agent releases the finished record (storage deposit back)", agent.accountId, "release_job", released, { job_id: jobId });
const after = BigInt(await agent.credit());

const out = {
  generatedBy: "scripts/v3/client-e2e.mjs",
  contractId: C,
  agent: agent.accountId,
  operator: operator.accountId,
  startedAt,
  finishedAt: new Date().toISOString(),
  jobId,
  jobStatus: job.status,
  // What the round trip cost the agent: the reward it chose to pay. The storage deposit came back to its balance
  // at release; the bond left its balance and was sent back to its account by the settlement transaction.
  balanceBeforeYocto: before.toString(),
  balanceAfterYocto: after.toString(),
  spentFromBalanceYocto: (before - after).toString(),
  bondYocto: job.bond,
  rewardYocto: job.reward,
  costYocto: (before - after - BigInt(job.bond)).toString(),
  complete: true,
  steps,
};
writeFileSync(path.join(ROOT, "data/v3/client-e2e.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`job ${jobId} ${job.status}; balance spent ${before - after} yocto = reward ${job.reward} + bond ${job.bond} (bond sent back to the account); wrote data/v3/client-e2e.json`);
process.exit(0);
