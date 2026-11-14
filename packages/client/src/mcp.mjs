#!/usr/bin/env node
// QUEUE as tools for an AI agent: a Model Context Protocol server over stdio (JSON-RPC 2.0, one message per line).
//
//   QUEUE_ACCOUNT_ID=me.testnet QUEUE_PRIVATE_KEY=ed25519:... node packages/client/src/mcp.mjs
//
// Without a key every tool that reads works and every tool that acts says why it cannot. Give it a function-call key
// for the contract (it cannot attach NEAR, so it can spend only the balance you deposited), and set
// QUEUE_MCP_MAX_SPEND_NEAR to cap what any single tool call may commit (default 0.05 NEAR). The model proposes; this
// server checks the cap and signs.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { clientFromEnv, fromYocto, toYocto } from "./index.mjs";

export const PROTOCOL_VERSION = "2025-06-18";

const num = (description) => ({ type: "number", description });
const str = (description) => ({ type: "string", description });

/** Tool catalogue. `write` tools need a key and pass the spend cap. */
export const TOOLS = [
  { name: "queue_status", description: "The queue right now: chain time, every waiting job (position, projected start and finish, deadline, ask), the operator's stake, whether new work is accepted and whether only accounts the operator approved can submit.", inputSchema: { type: "object", properties: {} } },
  { name: "queue_job", description: "One job by id: status, owner, timing, ask, what it paid and was paid, whether it is promised.", inputSchema: { type: "object", properties: { job_id: num("job id") }, required: ["job_id"] } },
  { name: "queue_quote", description: "What it costs for a queued job to start within `start_within_secs`: the slot, every job it would pass and what each is paid, or why the contract would refuse.", inputSchema: { type: "object", properties: { job_id: num("your queued job"), start_within_secs: num("latest start, seconds from now") }, required: ["job_id", "start_within_secs"] } },
  { name: "queue_admission", description: "Where a new job of this size would finish if submitted now: at the back (FIFO) and at the front (if it bought every slot).", inputSchema: { type: "object", properties: { duration_secs: num("seconds of work"), deadline_secs: num("deadline, seconds from now") }, required: ["duration_secs", "deadline_secs"] } },
  { name: "queue_balance", description: "Your balance in the contract (spendable by submit and buy).", inputSchema: { type: "object", properties: {} } },
  { name: "queue_deposit", description: "Move NEAR from your account into your balance in the contract. Needs a full-access key: a function-call key cannot attach NEAR.", write: true, inputSchema: { type: "object", properties: { amount_near: str("how much to deposit") }, required: ["amount_near"] } },
  { name: "queue_submit", description: "Submit a job paid from your balance. Optionally buy an earlier slot in the same transaction (priority_max_spend_near > 0).", write: true, inputSchema: { type: "object", properties: { title: str("short title"), input_hash: str("sha256 of the request body (makes it a model-verified job) or any reference"), duration_secs: num("seconds of work"), deadline_secs: num("deadline, seconds from now"), ask_per_sec_near: str("your price to be moved back, NEAR per second"), reward_near: str("paid to the operator on time (default 0.002)"), bond_near: str("returned on delivery (default 0.001)"), priority_max_spend_near: str("buy a slot now, paying at most this (optional)"), priority_start_within_secs: num("latest start for the bought slot (optional; default: whatever the deadline needs)") }, required: ["title", "input_hash", "duration_secs", "deadline_secs", "ask_per_sec_near"] } },
  { name: "queue_buy_priority", description: "Buy an earlier slot for your queued job. Every job passed is paid its ask; refused if any of them would miss its deadline.", write: true, inputSchema: { type: "object", properties: { job_id: num("your queued job"), start_within_secs: num("latest start, seconds from now"), max_spend_near: str("pay at most this") }, required: ["job_id", "start_within_secs", "max_spend_near"] } },
  { name: "queue_set_ask", description: "Change your queued job's ask (NEAR per second). A cut is immediate; a raise takes effect 30 s later.", write: true, inputSchema: { type: "object", properties: { job_id: num("your queued job"), ask_per_sec_near: str("new ask") }, required: ["job_id", "ask_per_sec_near"] } },
  { name: "queue_cancel", description: "Leave the queue: reward and 75% of the bond come back (the whole bond is kept if the job bought priority).", write: true, inputSchema: { type: "object", properties: { job_id: num("your queued job") }, required: ["job_id"] } },
  { name: "queue_release", description: "Delete your finished job's record and get its storage deposit back as balance.", write: true, inputSchema: { type: "object", properties: { job_id: num("your finished job") }, required: ["job_id"] } },
  { name: "queue_withdraw", description: "Withdraw your whole balance to your account.", write: true, inputSchema: { type: "object", properties: {} } },
];

const text = (value, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });

const brief = (j, now) => ({
  id: j.id, owner: j.owner, status: j.status, position: j.position, duration_secs: j.duration_secs,
  starts_in_secs: j.projected_start_at != null ? Math.max(0, j.projected_start_at - now) : null,
  deadline_in_secs: j.deadline_at - now, slack_secs: j.projected_finish_at != null ? j.deadline_at - j.projected_finish_at : null,
  ask_per_sec_near: fromYocto(j.ask_per_sec, 8), promised: j.promised, verify: j.verify,
});

/** Run one tool. `client` is a QueueClient; `limits.maxSpendYocto` caps what one call may commit. */
export async function callTool(name, args, client, limits) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return text(`unknown tool ${name}`, true);
  if (tool.write && !client.canAct) return text("this server has no key: set QUEUE_ACCOUNT_ID and QUEUE_PRIVATE_KEY (a function-call key for the contract is enough)", true);
  const over = (yocto, what) => (yocto > limits.maxSpendYocto ? text(`${what} ${fromYocto(yocto)} NEAR is above this server's cap of ${fromYocto(limits.maxSpendYocto)} NEAR per call (QUEUE_MCP_MAX_SPEND_NEAR)`, true) : null);
  const now = async () => client.now();
  const done = (r) => (r.ok ? text({ ok: true, tx: r.tx, result: r.result, events: r.events?.map((e) => e.event) }) : text({ ok: false, tx: r.tx, refused: r.error }, true));
  switch (name) {
    case "queue_status": {
      const [t, q, cfg] = await Promise.all([now(), client.queue(), client.config()]);
      return text({ now: t, accepting_work: cfg.accepting_work, operator_stake_near: fromYocto(cfg.operator_stake), fee_bps: cfg.fee_bps, approved_clients_only: cfg.clients_only ?? false, waiting: q.map((j) => brief(j, t)) });
    }
    case "queue_job": {
      const [t, j] = await Promise.all([now(), client.job(args.job_id)]);
      return text({ ...brief(j, t), priority_spend_near: fromYocto(j.priority_spend), paid_for_moving_near: fromYocto(j.moved_compensation), penalty_paid_near: fromYocto(j.penalty_paid ?? 0) });
    }
    case "queue_quote": {
      const t = await now();
      const q = await client.quote(args.job_id, t + Number(args.start_within_secs));
      return text({ feasible: q.feasible, reason: q.reason, total_near: fromYocto(q.total), slot: q.insert_index, passes: q.displaced.map((d) => ({ job: d.job_id, owner: d.owner, paid_near: fromYocto(d.amount), slack_after_secs: d.slack_secs })) });
    }
    case "queue_admission":
      return text(await client.admission(args.duration_secs, args.deadline_secs));
    case "queue_balance":
      if (!client.accountId) return text("no account configured", true);
      return text({ account: client.accountId, balance_near: fromYocto(await client.credit()) });
    case "queue_deposit": {
      const capped = over(toYocto(args.amount_near), "this deposit of");
      if (capped) return capped;
      return done(await client.deposit(String(args.amount_near)));
    }
    case "queue_submit": {
      const deposits = await client.storageDeposits();
      const reward = toYocto(args.reward_near ?? "0.002");
      const bond = toYocto(args.bond_near ?? "0.001");
      const prio = args.priority_max_spend_near ? toYocto(args.priority_max_spend_near) : 0n;
      const prioStorage = prio > 0n ? BigInt(deposits.priority_base) + BigInt(deposits.priority_per_displaced) * 4n : 0n;
      const capped = over(reward + bond + BigInt(deposits.job) + prio + prioStorage, "this submission commits up to");
      if (capped) return capped;
      const t = prio > 0n && args.priority_start_within_secs != null ? await now() : null;
      return done(await client.submit({
        title: String(args.title).slice(0, 80), inputHash: String(args.input_hash), durationSecs: args.duration_secs, deadlineSecs: args.deadline_secs,
        askPerSecNear: String(args.ask_per_sec_near), rewardNear: args.reward_near ?? "0.002", bondNear: args.bond_near ?? "0.001",
        priority: prio > 0n ? { maxSpendNear: String(args.priority_max_spend_near), latestStartAt: t != null ? t + Number(args.priority_start_within_secs) : undefined, required: false } : null,
      }));
    }
    case "queue_buy_priority": {
      const capped = over(toYocto(args.max_spend_near), "max_spend");
      if (capped) return capped;
      return done(await client.buy(args.job_id, (await now()) + Number(args.start_within_secs), String(args.max_spend_near)));
    }
    case "queue_set_ask":
      return done(await client.setAsk(args.job_id, String(args.ask_per_sec_near)));
    case "queue_cancel":
      return done(await client.cancel(args.job_id));
    case "queue_release":
      return done(await client.release(args.job_id));
    case "queue_withdraw":
      return done(await client.withdraw());
  }
  return text(`unhandled tool ${name}`, true);
}

/** Answer one JSON-RPC message (null for notifications). */
export async function handle(msg, client, limits) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null; // notification (e.g. notifications/initialized)
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "queue", version: "1.0.0" }, instructions: `QUEUE slot market on ${client.contractId}. Times are seconds; amounts are NEAR strings. ${client.canAct ? `Acting as ${client.accountId}, at most ${fromYocto(limits.maxSpendYocto)} NEAR per call.` : "Read-only (no key)."}` });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ write, ...t }) => t) });
    case "tools/call":
      try {
        return reply(await callTool(msg.params?.name, msg.params?.arguments ?? {}, client, limits));
      } catch (e) {
        return reply(text(String(e?.message ?? e).slice(0, 300), true));
      }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

export function limitsFromEnv(env = process.env) {
  return { maxSpendYocto: toYocto(env.QUEUE_MCP_MAX_SPEND_NEAR || "0.05") };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const client = clientFromEnv();
  const limits = limitsFromEnv();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      return;
    }
    const out = await handle(msg, client, limits);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  });
}
